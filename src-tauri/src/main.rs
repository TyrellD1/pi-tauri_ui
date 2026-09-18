// pi-tauri_ui — Rust backend: single long-lived `pi --mode rpc` harness.
//
// Protocol notes (see AGENTS.md + pi docs/rpc.md):
// - JSONL over stdin/stdout, LF (\n) only delimiter, strip trailing \r.
// - Never split on U+2028/U+2029. We use read_until(b'\n') only.
// - Commands with `id` get a correlated `response`. Events stream otherwise.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
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
    app: Mutex<Option<AppHandle>>,
}

impl PiManager {
    fn new() -> Self {
        let cwd = std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| "/tmp".to_string());
        Self {
            inner: Mutex::new(PiInner { child: None, stdin: None, cwd }),
            pending: Mutex::new(HashMap::new()),
            app: Mutex::new(None),
        }
    }
}

// ---------- helpers ----------

fn session_slug(cwd: &str) -> String {
    let mid = cwd.replace('/', "-");
    let mid = mid.trim_matches('-');
    format!("--{}--", mid)
}

fn sessions_dir_for(cwd: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    Some(home.join(".pi").join("agent").join("sessions").join(session_slug(cwd)))
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
        Ok(Ok(v)) => Ok(v),
        Ok(Err(_)) => Err("request cancelled".to_string()),
        Err(_) => {
            state.pending.lock().await.remove(&id);
            Err("pi timed out (30s)".to_string())
        }
    }
}

async fn fire(state: &State<'_, Arc<PiManager>>, cmd: Value) -> Result<(), String> {
    let line = serde_json::to_string(&cmd).map_err(|e| format!("encode failed: {}", e))?;
    write_line(state, &line).await
}

fn spawn_reader(app: AppHandle, state: Arc<PiManager>, mut stdout: tokio::process::ChildStdout) {
    tokio::spawn(async move {
        let mut reader = BufReader::new(&mut stdout);
        let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) => break, // EOF
                Ok(_) => {
                    // strip trailing \n and optional \r — nothing else
                    while buf.last() == Some(&b'\n') || buf.last() == Some(&b'\r') {
                        buf.pop();
                    }
                    if buf.is_empty() {
                        continue;
                    }
                    let line = String::from_utf8_lossy(&buf).to_string();
                    let v: Value = match serde_json::from_str(&line) {
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
        kill_child(&mut inner).await;
        let mut child = Command::new("pi")
            .arg("--mode")
            .arg("rpc")
            .current_dir(&target)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("failed to spawn `pi --mode rpc`: {} (is pi on PATH?)", e))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        inner.child = Some(child);
        inner.stdin = Some(stdin);
        inner.cwd = target.clone();
        drop(inner);
        let mgr = state.inner();
        spawn_reader(app.clone(), mgr.clone(), stdout);
    }
    {
        let mut a = state.app.lock().await;
        *a = Some(app);
    }
    // give pi a beat, then best-effort get_state (ignore errors)
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    Ok(serde_json::json!({ "ok": true, "cwd": target }))
}

#[tauri::command]
async fn pi_prompt(message: String, state: State<'_, Arc<PiManager>>) -> Result<Value, String> {
    // fire-and-accept: response only means accepted/queued, events stream after
    let cmd = serde_json::json!({ "type": "prompt", "message": message });
    match request(&state, cmd).await {
        Ok(r) => {
            if r.get("success").and_then(|s| s.as_bool()) == Some(true) {
                Ok(serde_json::json!({ "accepted": true }))
            } else {
                Ok(serde_json::json!({ "accepted": false, "error": r.get("error").and_then(|e| e.as_str()).unwrap_or("rejected") }))
            }
        }
        Err(e) => Ok(serde_json::json!({ "accepted": false, "error": e })),
    }
}

#[tauri::command]
async fn pi_steer(message: String, state: State<'_, Arc<PiManager>>) -> Result<Value, String> {
    let r = request(&state, serde_json::json!({ "type": "steer", "message": message })).await?;
    Ok(r)
}

#[tauri::command]
async fn pi_abort(state: State<'_, Arc<PiManager>>) -> Result<Value, String> {
    // clear queue first (Esc semantics), then abort
    let _ = request(&state, serde_json::json!({ "type": "clear_queue" })).await;
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
    let cwd = state.inner.lock().await.cwd.clone();
    let active: Option<String> = match request(&state, serde_json::json!({ "type": "get_state" })).await {
        Ok(r) => r.pointer("/data/sessionFile").and_then(|v| v.as_str()).map(|s| s.to_string()),
        Err(_) => None,
    };
    let dir = sessions_dir_for(&cwd);
    let mut out: Vec<Value> = Vec::new();
    if let Some(d) = dir {
        if let Ok(entries) = std::fs::read_dir(&d) {
            for e in entries.flatten() {
                let p = e.path();
                if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                    continue;
                }
                let mtime = e
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                // light parse: first user text + count
                let (preview, count) = parse_session_preview(&p);
                let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("session").to_string();
                // id = uuid suffix after last '_' if present
                let id = stem.rsplit('_').next().unwrap_or(&stem).to_string();
                out.push(serde_json::json!({
                    "path": p.to_string_lossy(),
                    "id": id,
                    "name": null,
                    "preview": preview,
                    "mtime": mtime,
                    "messageCount": count,
                }));
            }
        }
    }
    out.sort_by(|a, b| {
        let am = a.get("mtime").and_then(|v| v.as_u64()).unwrap_or(0);
        let bm = b.get("mtime").and_then(|v| v.as_u64()).unwrap_or(0);
        bm.cmp(&am)
    });
    // cap for perf: newest 200
    out.truncate(200);
    // enrich name if active session has a name
    Ok(serde_json::json!({ "sessions": out, "active": active }))
}

fn parse_session_preview(path: &PathBuf) -> (String, usize) {
    let Ok(content) = std::fs::read_to_string(path) else {
        return ("".to_string(), 0);
    };
    let mut preview = String::new();
    let mut count = 0;
    for line in content.lines().take(400) {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("message") {
            continue;
        }
        count += 1;
        if preview.is_empty() {
            if let Some(msg) = v.get("message") {
                if msg.get("role").and_then(|r| r.as_str()) == Some("user") {
                    if let Some(c) = msg.get("content") {
                        if let Some(s) = c.as_str() {
                            preview = s.chars().take(120).collect();
                        } else if let Some(arr) = c.as_array() {
                            for b in arr {
                                if let Some(t) = b.get("text").and_then(|x| x.as_str()) {
                                    preview = t.chars().take(120).collect();
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    // fallback: file mtime label
    if preview.is_empty() {
        if let Ok(meta) = std::fs::metadata(path) {
            if let Ok(mt) = meta.modified() {
                if let Ok(d) = mt.duration_since(UNIX_EPOCH) {
                    let _ = d;
                }
            }
        }
        preview = "Untitled session".to_string();
    }
    // also count remaining lines cheaply
    let total_lines = content.lines().count();
    let _ = SystemTime::now();
    let _ = UNIX_EPOCH;
    (preview, count.max(total_lines.min(9999)))
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
