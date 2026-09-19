// pi-tauri_ui — Rust backend: single long-lived `pi --mode rpc` harness.
//
// Protocol notes (see AGENTS.md + pi docs/rpc.md):
// - JSONL over stdin/stdout, LF (\n) only delimiter, strip trailing \r.
// - Never split on U+2028/U+2029. We use read_until(b'\n') only.
// - Commands with `id` get a correlated `response`. Events stream otherwise.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, atomic::{AtomicU64, Ordering}},
    time::UNIX_EPOCH,
    io::BufRead,
};

use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex},
};

struct PiInner {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    cwd: String,
}

struct PiManager {
    inner: Mutex<PiInner>,
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    generation: AtomicU64,
}

impl PiManager {
    fn new() -> Self {
        let cwd = std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| "/tmp".to_string());
        Self {
            inner: Mutex::new(PiInner { child: None, stdin: None, cwd }),
            pending: Mutex::new(HashMap::new()),
            generation: AtomicU64::new(0),
        }
    }
}

// ---------- helpers ----------

fn checked_response(v: Value) -> Result<Value, String> {
    if v.get("success").and_then(Value::as_bool) == Some(false) {
        return Err(v.get("error").and_then(Value::as_str).unwrap_or("pi rejected the request").to_string());
    }
    Ok(v)
}

async fn write_line(state: &State<'_, Arc<PiManager>>, line: &str) -> Result<(), String> {
    let mut inner = state.inner.lock().await;
    let stdin = inner.stdin.as_mut().ok_or("pi process not running")?;
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("stdin write failed: {}", e))?;
    stdin.write_all(b"\n").await.map_err(|e| format!("stdin write failed: {}", e))?;
    stdin.flush().await.map_err(|e| format!("stdin flush failed: {}", e))?;
    Ok(())
}

/// Send a command and wait for the correlated `response` (30s timeout).
async fn request(state: &State<'_, Arc<PiManager>>, mut cmd: Value) -> Result<Value, String> {
    let id = uuid::Uuid::new_v4().to_string();
    cmd["id"] = Value::String(id.clone());
    let (tx, rx) = oneshot::channel();
    {
        let mut p = state.pending.lock().await;
        p.insert(id.clone(), tx);
    }
    let line = serde_json::to_string(&cmd).map_err(|e| format!("encode failed: {}", e))?;
    if let Err(e) = write_line(state, &line).await {
        state.pending.lock().await.remove(&id);
        return Err(e);
    }
    match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
        Ok(Ok(v)) => checked_response(v),
        Ok(Err(_)) => Err("request cancelled".to_string()),
        Err(_) => {
            state.pending.lock().await.remove(&id);
            Err("pi timed out (30s)".to_string())
        }
    }
}

/// Map frontend attachments ([{data: base64, mimeType}]) to RPC ImageContent blocks.
fn attach_images(cmd: &mut Value, images: Option<Vec<Value>>) {
    let imgs: Vec<Value> = images
        .unwrap_or_default()
        .into_iter()
        .filter_map(|im| {
            let data = im.get("data")?.as_str()?;
            let mime = im.get("mimeType").and_then(|m| m.as_str()).unwrap_or("image/png");
            if data.is_empty() {
                return None;
            }
            Some(serde_json::json!({ "type": "image", "data": data, "mimeType": mime }))
        })
        .collect();
    if !imgs.is_empty() {
        cmd["images"] = Value::Array(imgs);
    }
}

async fn fire(state: &State<'_, Arc<PiManager>>, cmd: Value) -> Result<(), String> {
    let line = serde_json::to_string(&cmd).map_err(|e| format!("encode failed: {}", e))?;
    write_line(state, &line).await
}

fn spawn_reader(app: AppHandle, state: Arc<PiManager>, mut stdout: tokio::process::ChildStdout, generation: u64) {
    tokio::spawn(async move {
        let mut reader = BufReader::new(&mut stdout);
        let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) => break, // EOF
                Ok(_) => {
                    if state.generation.load(Ordering::SeqCst) != generation { return; }
                    // strip trailing \n and optional \r — nothing else
                    while buf.last() == Some(&b'\n') || buf.last() == Some(&b'\r') {
                        buf.pop();
                    }
                    if buf.is_empty() {
                        continue;
                    }
                    let v: Value = match serde_json::from_slice(&buf) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    // correlated response?
                    if v.get("type").and_then(|t| t.as_str()) == Some("response") {
                        if let Some(id) = v.get("id").and_then(|i| i.as_str()) {
                            let tx = { state.pending.lock().await.remove(id) };
                            if let Some(tx) = tx {
                                let _ = tx.send(v);
                                continue;
                            }
                        }
                    }
                    let _ = app.emit("pi-event", v);
                }
                Err(_) => break,
            }
        }
        if state.generation.load(Ordering::SeqCst) == generation {
            state.pending.lock().await.clear();
            let _ = app.emit("pi-event", serde_json::json!({"type": "process_disconnected"}));
        }
    });
}

async fn kill_child(inner: &mut PiInner) {
    if let Some(mut child) = inner.child.take() {
        let _ = child.kill().await;
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), child.wait()).await;
    }
    inner.stdin = None;
}

// ---------- commands ----------

#[tauri::command]
async fn pi_spawn(cwd: Option<String>, app: AppHandle, state: State<'_, Arc<PiManager>>) -> Result<Value, String> {
    let target = match cwd {
        Some(c) if !c.trim().is_empty() => c.trim().to_string(),
        _ => state.inner.lock().await.cwd.clone(),
    };
    // validate dir exists
    let p = PathBuf::from(&target);
    if !p.is_dir() {
        return Err(format!("not a directory: {}", target));
    }
    {
        let mut inner = state.inner.lock().await;
        let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
        state.pending.lock().await.clear();
        kill_child(&mut inner).await;
        let mut child = Command::new("pi")
            .arg("--mode")
            .arg("rpc")
            .current_dir(&target)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("failed to spawn `pi --mode rpc`: {} (is pi on PATH?)", e))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        inner.child = Some(child);
        inner.stdin = Some(stdin);
        inner.cwd = target.clone();
        drop(inner);
        let mgr = state.inner();
        spawn_reader(app.clone(), mgr.clone(), stdout, generation);
    }
    Ok(serde_json::json!({ "ok": true, "cwd": target }))
}

#[tauri::command]
async fn pi_prompt(message: String, images: Option<Vec<Value>>, state: State<'_, Arc<PiManager>>) -> Result<Value, String> {
    // fire-and-accept: response only means accepted/queued, events stream after
    let mut cmd = serde_json::json!({ "type": "prompt", "message": message });
    attach_images(&mut cmd, images);
    request(&state, cmd).await?;
    Ok(serde_json::json!({ "accepted": true }))
}

#[tauri::command]
async fn pi_steer(message: String, images: Option<Vec<Value>>, state: State<'_, Arc<PiManager>>) -> Result<Value, String> {
    let mut cmd = serde_json::json!({ "type": "steer", "message": message });
    attach_images(&mut cmd, images);
    let r = request(&state, cmd).await?;
    Ok(r)
}

#[tauri::command]
async fn pi_follow_up(message: String, images: Option<Vec<Value>>, state: State<'_, Arc<PiManager>>) -> Result<Value, String> {
    // exact RPC `follow_up`: queued, delivered only when the agent finishes
    let mut cmd = serde_json::json!({ "type": "follow_up", "message": message });
    attach_images(&mut cmd, images);
    let r = request(&state, cmd).await?;
    Ok(r)
}

#[tauri::command]
async fn pi_clear_queue(state: State<'_, Arc<PiManager>>) -> Result<Value, String> {
    // explicit user action only — Esc/Stop must not silently clear queued items
    let r = request(&state, serde_json::json!({ "type": "clear_queue" })).await?;
    Ok(r)
}

#[tauri::command]
async fn pi_abort(state: State<'_, Arc<PiManager>>) -> Result<Value, String> {
    // Stop only. Queued steering/follow-up messages are preserved (abort
    // continues them when they remain); the UI offers an explicit Clear.
    let r = request(&state, serde_json::json!({ "type": "abort" })).await?;
    Ok(r)
}

#[tauri::command]
async fn pi_new_session(state: State<'_, Arc<PiManager>>) -> Result<Value, String> {
    let r = request(&state, serde_json::json!({ "type": "new_session" })).await?;
    Ok(r)
}

#[tauri::command]
async fn pi_switch_session(path: String, state: State<'_, Arc<PiManager>>) -> Result<Value, String> {
    let r = request(&state, serde_json::json!({ "type": "switch_session", "sessionPath": path })).await?;
    Ok(r)
}

#[tauri::command]
async fn pi_get_messages(state: State<'_, Arc<PiManager>>) -> Result<Value, String> {
    let r = request(&state, serde_json::json!({ "type": "get_messages" })).await?;
    let msgs = r.pointer("/data/messages").cloned().unwrap_or(Value::Null);
    Ok(serde_json::json!({ "messages": msgs }))
}

#[tauri::command]
async fn pi_get_state(state: State<'_, Arc<PiManager>>) -> Result<Value, String> {
    let r = request(&state, serde_json::json!({ "type": "get_state" })).await?;
    let mut data = r.pointer("/data").cloned().unwrap_or(serde_json::json!({}));
    let cwd = state.inner.lock().await.cwd.clone();
    data["cwd"] = Value::String(cwd);
    Ok(data)
}

#[tauri::command]
async fn pi_get_stats(state: State<'_, Arc<PiManager>>) -> Result<Value, String> {
    let r = request(&state, serde_json::json!({ "type": "get_session_stats" })).await?;
    Ok(r.pointer("/data").cloned().unwrap_or(Value::Null))
}

#[tauri::command]
async fn pi_get_models(state: State<'_, Arc<PiManager>>) -> Result<Value, String> {
    let models_r = request(&state, serde_json::json!({ "type": "get_available_models" })).await?;
    let state_r = request(&state, serde_json::json!({ "type": "get_state" })).await?;
    let models = models_r.pointer("/data/models").cloned().unwrap_or(Value::Null);
    let cur = state_r
        .pointer("/data/model")
        .map(|m| {
            let p = m.get("provider").and_then(|x| x.as_str()).unwrap_or("");
            let id = m.get("id").and_then(|x| x.as_str()).unwrap_or("");
            format!("{}/{}", p, id)
        })
        .unwrap_or_default();
    Ok(serde_json::json!({ "models": models, "current": cur }))
}

#[tauri::command]
async fn pi_set_model(provider: String, model_id: String, state: State<'_, Arc<PiManager>>) -> Result<Value, String> {
    let r = request(
        &state,
        serde_json::json!({ "type": "set_model", "provider": provider, "modelId": model_id }),
    )
    .await?;
    if r.get("success").and_then(|s| s.as_bool()) == Some(true) {
        Ok(r)
    } else {
        Err(r.get("error").and_then(|e| e.as_str()).unwrap_or("set_model failed").to_string())
    }
}

#[tauri::command]
async fn pi_set_thinking(level: String, state: State<'_, Arc<PiManager>>) -> Result<Value, String> {
    let r = request(&state, serde_json::json!({ "type": "set_thinking_level", "level": level })).await?;
    Ok(r)
}

#[tauri::command]
async fn pi_compact(state: State<'_, Arc<PiManager>>) -> Result<Value, String> {
    let r = request(&state, serde_json::json!({ "type": "compact" })).await?;
    Ok(r)
}

#[tauri::command]
async fn pi_export(state: State<'_, Arc<PiManager>>) -> Result<Value, String> {
    let r = request(&state, serde_json::json!({ "type": "export_html" })).await?;
    Ok(r.pointer("/data").cloned().unwrap_or(Value::Null))
}

#[tauri::command]
async fn pi_set_cwd(cwd: String, app: AppHandle, state: State<'_, Arc<PiManager>>) -> Result<Value, String> {
    pi_spawn(Some(cwd), app, state).await
}

#[tauri::command]
async fn pi_set_name(name: String, state: State<'_, Arc<PiManager>>) -> Result<Value, String> {
    let r = request(&state, serde_json::json!({ "type": "set_session_name", "name": name })).await?;
    Ok(r)
}

#[tauri::command]
async fn pi_ui_response(id: String, payload: Value, state: State<'_, Arc<PiManager>>) -> Result<Value, String> {
    let mut cmd = serde_json::json!({ "type": "extension_ui_response", "id": id });
    if let Value::Object(map) = payload {
        if let Value::Object(cmd_map) = &mut cmd {
            for (k, v) in map {
                cmd_map.insert(k, v);
            }
        }
    }
    fire(&state, cmd).await?;
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
async fn pi_list_sessions(state: State<'_, Arc<PiManager>>) -> Result<Value, String> {
    let r = request(&state, serde_json::json!({ "type": "get_state" })).await?;
    let active = r.pointer("/data/sessionFile").and_then(Value::as_str).map(String::from);
    // Respect the harness' actual session directory, including custom settings.
    let dir = active.as_ref().and_then(|p| PathBuf::from(p).parent().map(|p| p.to_path_buf()));
    let out = tokio::task::spawn_blocking(move || list_sessions(dir)).await.map_err(|e| e.to_string())??;
    Ok(serde_json::json!({"sessions": out, "active": active}))
}

fn list_sessions(dir: Option<PathBuf>) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    let Some(dir) = dir else { return Ok(out); };
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(format!("Couldn't read chats: {}", e)),
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("jsonl") { continue; }
        let mtime = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
        let (preview, name, count) = parse_session_preview(&p);
        let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("session");
        out.push(serde_json::json!({"path": p.to_string_lossy(), "id": stem, "name": name, "preview": preview, "mtime": mtime, "messageCount": count}));
    }
    out.sort_by_key(|v| std::cmp::Reverse(v["mtime"].as_u64().unwrap_or(0)));
    Ok(out)
}

fn parse_session_preview(path: &PathBuf) -> (String, Option<String>, usize) {
    let Ok(file) = std::fs::File::open(path) else { return ("Unreadable session".into(), None, 0); };
    let mut reader = std::io::BufReader::new(file);
    let mut line = String::new();
    let mut preview = String::new(); let mut name = None; let mut count = 0;
    // Read one record at a time instead of retaining entire histories in memory.
    while { line.clear(); reader.read_line(&mut line).unwrap_or(0) > 0 } {
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue; };
        if v["type"] == "session_info" { name = v["name"].as_str().map(String::from); }
        if v["type"] != "message" { continue; }
        count += 1;
        if preview.is_empty() && v["message"]["role"] == "user" {
            let c = &v["message"]["content"];
            let text = c.as_str().or_else(|| c.as_array().and_then(|a| a.iter().find_map(|b| b["text"].as_str())));
            preview = text.unwrap_or("Image attachment").chars().take(120).collect();
        }
    }
    if preview.is_empty() { preview = "Untitled session".into(); }
    (preview, name, count)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejection_is_an_error() {
        assert_eq!(checked_response(serde_json::json!({"success":false,"error":"denied"})).unwrap_err(), "denied");
        assert!(checked_response(serde_json::json!({"success":true})).is_ok());
    }
    #[test]
    fn all_sessions_remain_available_and_names_are_read() {
        let dir = std::env::temp_dir().join(format!("pi-ui-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        for i in 0..205 { std::fs::write(dir.join(format!("{}.jsonl",i)), "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"hello\"}}\n{\"type\":\"session_info\",\"name\":\"Renamed\"}\n").unwrap(); }
        let sessions = list_sessions(Some(dir.clone())).unwrap();
        assert_eq!(sessions.len(),205); assert_eq!(sessions[0]["name"], "Renamed"); assert_eq!(sessions[0]["messageCount"],1);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

fn main() {
    let manager = Arc::new(PiManager::new());
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(manager)
        .invoke_handler(tauri::generate_handler![
            pi_spawn,
            pi_prompt,
            pi_steer,
            pi_follow_up,
            pi_clear_queue,
            pi_abort,
            pi_new_session,
            pi_switch_session,
            pi_get_messages,
            pi_get_state,
            pi_get_stats,
            pi_get_models,
            pi_set_model,
            pi_set_thinking,
            pi_compact,
            pi_export,
            pi_set_cwd,
            pi_set_name,
            pi_ui_response,
            pi_list_sessions
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
