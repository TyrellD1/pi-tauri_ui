// pi-tauri_ui — Rust backend: a small pool of `pi --mode rpc` processes,
// one per live chat. Switching chats never disturbs a running turn: every
// command carries its scope (cwd + optional session file) and is routed to
// the process holding that session, spawning (and switching/new_session
// inside that process) on demand. Idle processes are reaped lazily on pool
// access — no timers, so idle = 0% CPU.
//
// Protocol notes (see AGENTS.md + pi docs/rpc.md):
// - JSONL over stdin/stdout, LF (\n) only delimiter, strip trailing \r.
// - Never split on U+2028/U+2029. We use read_until(b'\n') only.
// - Commands with `id` get a correlated `response`. Events stream otherwise.
// - Every emitted event is tagged with `instance`, `session`, `cwd` so the
//   UI can route it to the right chat.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant, UNIX_EPOCH},
    io::BufRead,
};

use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{oneshot, Mutex},
};

/// Cap + idle reaping keep the pool near terminal-pi costs: a handful of
/// processes for a handful of chats, never a runaway.
const MAX_LIVE: usize = 6;
const IDLE_SECS: u64 = 15 * 60;

struct Instance {
    id: u64,
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    cwd: String,
    session_file: Mutex<Option<String>>,
    streaming: AtomicBool,
    retired: AtomicBool,
    last_active: Mutex<Instant>,
}

struct Pool {
    instances: Mutex<HashMap<u64, Arc<Instance>>>,
    recent: Mutex<HashMap<String, String>>,
    next_id: AtomicU64,
    default_model: Mutex<Option<(String, String)>>,
    default_thinking: Mutex<Option<String>>,
    pi_bin: Mutex<Option<PathBuf>>,
    /// Scope of the visible chat. Its process is exempt from reaping — the
    /// tab you are looking at stays connected (CodeG's active-tab rule).
    visible: Mutex<(String, Option<String>)>,
}

impl Pool {
    fn new() -> Self {
        Self {
            instances: Mutex::new(HashMap::new()),
            recent: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            default_model: Mutex::new(None),
            default_thinking: Mutex::new(None),
            pi_bin: Mutex::new(None),
            visible: Mutex::new((String::new(), None)),
        }
    }
}

/// Does this instance hold the visible chat? Pure (unit-tested).
fn matches_scope(file: Option<&str>, cwd: &str, vis_cwd: &str, vis_sess: Option<&str>) -> bool {
    match vis_sess {
        Some(p) => file == Some(p),
        None => file.is_none() && cwd == vis_cwd,
    }
}

/// Locate the `pi` CLI. Finder/Dock launches carry a skeletal PATH (no nvm,
/// no Homebrew), so PATH lookup alone strands /Applications installs.
/// Resolved once per app run, then cached.
async fn resolve_pi(pool: &Arc<Pool>) -> Result<PathBuf, String> {
    if let Some(bin) = pool.pi_bin.lock().await.clone() {
        return Ok(bin);
    }
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            cands.push(dir.join("pi"));
        }
    }
    if let Some(home) = dirs::home_dir() {
        for extra in [".npm-global/bin/pi", "bin/pi"] {
            cands.push(home.join(extra));
        }
        // Whatever nvm node version is (or becomes) active.
        if let Ok(vers) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            for v in vers.flatten() {
                cands.push(v.path().join("bin/pi"));
            }
        }
    }
    for sys in ["/opt/homebrew/bin/pi", "/usr/local/bin/pi", "/opt/local/bin/pi"] {
        cands.push(PathBuf::from(sys));
    }
    for c in cands {
        if c.is_file() {
            *pool.pi_bin.lock().await = Some(c.clone());
            return Ok(c);
        }
    }
    // Last resort: a login shell sources nvm/rbenv-style shims (~0.5s, cached).
    let out = tokio::process::Command::new("/bin/sh")
        .arg("-lc")
        .arg("command -v pi")
        .output()
        .await
        .map_err(|e| format!("shell probe failed: {}", e))?;
    let found = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let bin = PathBuf::from(&found);
    if !found.is_empty() && bin.is_file() {
        *pool.pi_bin.lock().await = Some(bin.clone());
        return Ok(bin);
    }
    Err("couldn't find the pi CLI — install it (npm i -g @earendil-works/pi-coding-agent) or launch the app once from a terminal".to_string())
}

// ---------- helpers ----------

fn checked_response(v: Value) -> Result<Value, String> {
    if v.get("success").and_then(Value::as_bool) == Some(false) {
        return Err(v.get("error").and_then(Value::as_str).unwrap_or("pi rejected the request").to_string());
    }
    Ok(v)
}

/// Pure victim selection for the lazy reaper (unit-tested): expired idle
/// first, then oldest idle beyond the cap. Streaming instances are immortal.
fn sweep_plan(states: &[(u64, bool, Instant)], now: Instant, max_live: usize, idle: Duration) -> Vec<u64> {
    let mut kill = Vec::new();
    let mut idle_survivors: Vec<(u64, Instant)> = Vec::new();
    let mut streaming = 0usize;
    for (id, is_streaming, last) in states {
        if *is_streaming {
            streaming += 1;
        } else if now.duration_since(*last) > idle {
            kill.push(*id);
        } else {
            idle_survivors.push((*id, *last));
        }
    }
    idle_survivors.sort_by_key(|(_, t)| *t);
    let allowed_idle = max_live.saturating_sub(streaming);
    while idle_survivors.len() > allowed_idle {
        kill.push(idle_survivors.remove(0).0);
    }
    kill
}

async fn touch(inst: &Instance) {
    *inst.last_active.lock().await = Instant::now();
}

/// Send a command to one instance and wait for its correlated `response`.
/// The write itself is bounded: a child that stops draining stdin must never
/// wedge a send forever. On write stall the instance is retired so the next
/// command respawns fresh instead of queueing behind a dead pipe.
async fn inst_request(pool: &Arc<Pool>, inst: &Instance, mut cmd: Value) -> Result<Value, String> {
    let id = uuid::Uuid::new_v4().to_string();
    cmd["id"] = Value::String(id.clone());
    let (tx, rx) = oneshot::channel();
    inst.pending.lock().await.insert(id.clone(), tx);
    let line = serde_json::to_string(&cmd).map_err(|e| format!("encode failed: {}", e))?;
    let write_ok = tokio::time::timeout(Duration::from_secs(30), async {
        let mut stdin = inst.stdin.lock().await;
        stdin.write_all(line.as_bytes()).await.map_err(|e| format!("stdin write failed: {}", e))?;
        stdin.write_all(b"\n").await.map_err(|e| format!("stdin write failed: {}", e))?;
        stdin.flush().await.map_err(|e| format!("stdin flush failed: {}", e))?;
        Ok::<(), String>(())
    })
    .await;
    match write_ok {
        Err(_) => {
            inst.pending.lock().await.remove(&id);
            retire(pool, inst).await;
            return Err("pi stopped responding (stale process retired) — retry the send".to_string());
        }
        Ok(Err(e)) => {
            inst.pending.lock().await.remove(&id);
            return Err(e);
        }
        Ok(Ok(())) => {}
    }
    touch(inst).await;
    match tokio::time::timeout(Duration::from_secs(30), rx).await {
        Ok(Ok(v)) => checked_response(v),
        Ok(Err(_)) => Err("request cancelled".to_string()),
        Err(_) => {
            inst.pending.lock().await.remove(&id);
            Err("pi timed out (30s)".to_string())
        }
    }
}

async fn fire_inst(pool: &Arc<Pool>, inst: &Instance, cmd: Value) -> Result<(), String> {
    let line = serde_json::to_string(&cmd).map_err(|e| format!("encode failed: {}", e))?;
    let write_ok = tokio::time::timeout(Duration::from_secs(30), async {
        let mut stdin = inst.stdin.lock().await;
        stdin.write_all(line.as_bytes()).await.map_err(|e| format!("stdin write failed: {}", e))?;
        stdin.write_all(b"\n").await.map_err(|e| format!("stdin write failed: {}", e))?;
        stdin.flush().await.map_err(|e| format!("stdin flush failed: {}", e))?;
        Ok::<(), String>(())
    })
    .await;
    match write_ok {
        Err(_) => {
            retire(pool, inst).await;
            return Err("pi stopped responding (stale process retired)".to_string());
        }
        Ok(Err(e)) => return Err(e),
        Ok(Ok(())) => {}
    }
    touch(inst).await;
    Ok(())
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

fn spawn_reader(app: AppHandle, pool: Arc<Pool>, inst: Arc<Instance>, mut stdout: ChildStdout) {
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
                    let mut v: Value = match serde_json::from_slice(&buf) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    // correlated response?
                    if v.get("type").and_then(|t| t.as_str()) == Some("response") {
                        if let Some(id) = v.get("id").and_then(|i| i.as_str()) {
                            let tx = inst.pending.lock().await.remove(id);
                            if let Some(tx) = tx {
                                let _ = tx.send(v);
                                continue;
                            }
                        }
                    }
                    // Snoop run state for the reaper; tag the event for routing.
                    match v.get("type").and_then(|t| t.as_str()) {
                        Some("agent_start") => inst.streaming.store(true, Ordering::SeqCst),
                        Some("agent_settled") => inst.streaming.store(false, Ordering::SeqCst),
                        _ => {}
                    }
                    touch(&inst).await;
                    if let Value::Object(map) = &mut v {
                        map.insert("instance".to_string(), Value::from(inst.id));
                        map.insert("cwd".to_string(), Value::String(inst.cwd.clone()));
                        if let Some(f) = inst.session_file.lock().await.clone() {
                            map.insert("session".to_string(), Value::String(f));
                        }
                    }
                    let _ = app.emit("pi-event", v);
                }
                Err(_) => break,
            }
        }
        inst.pending.lock().await.clear();
        if !inst.retired.load(Ordering::SeqCst) {
            pool.instances.lock().await.remove(&inst.id);
            let mut disc = serde_json::json!({"type": "instance_disconnected", "instance": inst.id, "cwd": inst.cwd});
            if let Some(f) = inst.session_file.lock().await.clone() {
                disc["session"] = Value::String(f);
            }
            let _ = app.emit("pi-event", disc);
        }
    });
}

async fn spawn_instance(app: &AppHandle, pool: &Arc<Pool>, cwd: &str) -> Result<Arc<Instance>, String> {
    let target = if cwd.trim().is_empty() {
        std::env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|_| "/tmp".to_string())
    } else {
        cwd.trim().to_string()
    };
    if !PathBuf::from(&target).is_dir() {
        return Err(format!("not a directory: {}", target));
    }
    let bin = resolve_pi(pool).await?;
    // The nvm shim is a node script (`#!/usr/bin/env node`): with Finder's
    // skeletal PATH, `node` would not resolve either — so the shim's own
    // directory leads the child's PATH.
    let mut child_path = std::env::var_os("PATH").unwrap_or_default();
    if let Some(dir) = bin.parent() {
        let mut prefixed = std::ffi::OsString::from(dir);
        if !child_path.is_empty() {
            prefixed.push(":");
            prefixed.push(&child_path);
        }
        child_path = prefixed;
    }
    let mut child = Command::new(&bin)
        .arg("--mode")
        .arg("rpc")
        .env("PATH", child_path)
        .current_dir(&target)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("failed to spawn `pi --mode rpc`: {} (is pi on PATH?)", e))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let id = pool.next_id.fetch_add(1, Ordering::SeqCst);
    let inst = Arc::new(Instance {
        id,
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
        pending: Mutex::new(HashMap::new()),
        cwd: target,
        session_file: Mutex::new(None),
        streaming: AtomicBool::new(false),
        retired: AtomicBool::new(false),
        last_active: Mutex::new(Instant::now()),
    });
    spawn_reader(app.clone(), pool.clone(), inst.clone(), stdout);
    // New processes inherit the UI's chosen model/thinking so chats never diverge.
    if let Some((p, m)) = pool.default_model.lock().await.clone() {
        let _ = inst_request(&pool, &inst, serde_json::json!({"type": "set_model", "provider": p, "modelId": m})).await;
    }
    if let Some(l) = pool.default_thinking.lock().await.clone() {
        let _ = inst_request(&pool, &inst, serde_json::json!({"type": "set_thinking_level", "level": l})).await;
    }
    pool.instances.lock().await.insert(id, inst.clone());
    Ok(inst)
}

/// Re-read which session file an instance holds (created on first prompt,
/// changed by switch/new_session). Keeps scope→instance routing exact.
async fn learn_file(pool: &Arc<Pool>, inst: &Instance) {
    if let Ok(r) = inst_request(&pool, inst, serde_json::json!({"type": "get_state"})).await {
        if let Some(f) = r.pointer("/data/sessionFile").and_then(Value::as_str) {
            *inst.session_file.lock().await = Some(f.to_string());
            pool.recent.lock().await.insert(inst.cwd.clone(), f.to_string());
        }
    }
}

/// Retire one instance: mark silent (no disconnect event), kill, drop.
/// Used by the reaper and by the write-stall path in inst_request/fire_inst.
async fn retire(pool: &Arc<Pool>, inst: &Instance) {
    inst.retired.store(true, Ordering::SeqCst);
    {
        let mut child = inst.child.lock().await;
        let _ = child.kill().await;
        let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    }
    pool.instances.lock().await.remove(&inst.id);
    inst.pending.lock().await.clear();
}

async fn kill_instance(pool: &Arc<Pool>, inst: &Arc<Instance>) {
    retire(pool, inst).await;
}

/// Lazy reaper: runs on pool access, never on a timer (idle = 0% CPU).
/// The visible chat's process is exempt — the tab you are looking at stays
/// connected no matter how long it idles.
async fn sweep(pool: &Arc<Pool>) {
    let insts: Vec<Arc<Instance>> = pool.instances.lock().await.values().cloned().collect();
    let mut states = Vec::with_capacity(insts.len());
    for i in &insts {
        states.push((i.id, i.streaming.load(Ordering::SeqCst), *i.last_active.lock().await));
    }
    let victims = sweep_plan(&states, Instant::now(), MAX_LIVE, Duration::from_secs(IDLE_SECS));
    if victims.is_empty() {
        return;
    }
    let (vis_cwd, vis_sess) = pool.visible.lock().await.clone();
    for id in victims {
        let Some(inst) = insts.iter().find(|i| i.id == id).cloned() else { continue };
        if inst.streaming.load(Ordering::SeqCst) {
            continue;
        }
        let file = inst.session_file.lock().await.clone();
        if matches_scope(file.as_deref(), &inst.cwd, &vis_cwd, vis_sess.as_deref()) {
            continue;
        }
        if pool.instances.lock().await.contains_key(&id) {
            kill_instance(pool, &inst).await;
        }
    }
}

/// Single matcher for every scope lookup. `session: Some` pins an exact
/// session (any run state); `None` prefers the live run in that cwd (a
/// fresh composer attaching to its own just-sent turn), else a never-run
/// instance, else nothing.
async fn match_instance(pool: &Arc<Pool>, cwd: &str, session: Option<&str>) -> Option<Arc<Instance>> {
    let map = pool.instances.lock().await;
    let mut fallback: Option<Arc<Instance>> = None;
    let mut hit: Option<Arc<Instance>> = None;
    for inst in map.values() {
        if inst.cwd != cwd {
            continue;
        }
        let file = match inst.session_file.try_lock() {
            Ok(f) => f.clone(),
            Err(_) => continue,
        };
        match session {
            Some(p) => {
                if file.as_deref() == Some(p) {
                    hit = Some(inst.clone());
                    break;
                }
            }
            None => {
                if inst.streaming.load(Ordering::SeqCst) {
                    hit = Some(inst.clone());
                    break;
                }
                if file.is_none() && fallback.is_none() {
                    fallback = Some(inst.clone());
                }
            }
        }
    }
    drop(map);
    let inst = hit.or(fallback)?;
    touch(&inst).await;
    Some(inst)
}

/// Lookup only: runs that must address a live process (abort, dialog
/// responses, queue clears) fail instead of spawning a stranger.
async fn find(pool: &Arc<Pool>, cwd: &str, session: Option<&str>) -> Option<Arc<Instance>> {
    *pool.visible.lock().await = (cwd.to_string(), session.map(String::from));
    sweep(pool).await;
    match_instance(pool, cwd, session).await
}

/// Route a scope to its process, spawning (and switching/new_session inside
/// that process) on demand. `pristine` = a fresh empty session is required
/// (new chat, or the first prompt of a chat with no session yet). Pristine
/// reuse only ever touches never-run idle instances — live sessions are
/// never disturbed.
async fn ensure(app: &AppHandle, pool: &Arc<Pool>, cwd: &str, session: Option<String>, pristine: bool) -> Result<Arc<Instance>, String> {
    *pool.visible.lock().await = (cwd.to_string(), session.clone());
    sweep(pool).await;
    if pristine && session.is_none() {
        let cand = {
            let map = pool.instances.lock().await;
            let mut found: Option<Arc<Instance>> = None;
            for inst in map.values() {
                if inst.cwd != cwd || inst.streaming.load(Ordering::SeqCst) {
                    continue;
                }
                if inst.session_file.try_lock().map(|f| f.is_none()).unwrap_or(false) {
                    found = Some(inst.clone());
                    break;
                }
            }
            found
        };
        if let Some(inst) = cand {
            touch(&inst).await;
            inst_request(&pool, &inst, serde_json::json!({"type": "new_session"})).await?;
            learn_file(pool, &inst).await;
            return Ok(inst);
        }
    } else if let Some(inst) = match_instance(pool, cwd, session.as_deref()).await {
        // Folder-open default: no session requested — prefer the cwd's
        // most recent live session over whatever this one holds.
        if session.is_none() {
            if let Some(recent) = pool.recent.lock().await.get(cwd).cloned() {
                if let Some(live) = match_instance(pool, cwd, Some(&recent)).await {
                    return Ok(live);
                }
            }
        }
        return Ok(inst);
    } else if session.is_none() {
        if let Some(recent) = pool.recent.lock().await.get(cwd).cloned() {
            if let Some(live) = match_instance(pool, cwd, Some(&recent)).await {
                return Ok(live);
            }
        }
    }
    let inst = spawn_instance(app, pool, cwd).await?;
    if let Some(p) = session {
        inst_request(&pool, &inst, serde_json::json!({"type": "switch_session", "sessionPath": p})).await?;
        learn_file(pool, &inst).await;
    } else if pristine {
        inst_request(&pool, &inst, serde_json::json!({"type": "new_session"})).await?;
        learn_file(pool, &inst).await;
    } else {
        learn_file(pool, &inst).await;
    }
    Ok(inst)
}

// ---------- commands ----------

// NOTE: no pi_spawn / pi_set_cwd commands — spawning is lazy inside
// `ensure`. Switching folders never respawns anything; each chat's process
// lives until the lazy reaper retires it.

#[tauri::command]
async fn pi_prompt(cwd: String, session: Option<String>, message: String, images: Option<Vec<Value>>, app: AppHandle, pool: State<'_, Arc<Pool>>) -> Result<Value, String> {
    // fire-and-accept: response only means accepted/queued, events stream after.
    // No session yet = this chat's first turn: pristine routing guarantees an
    // empty session (never another chat's live one).
    let inst = ensure(&app, &pool, &cwd, session, true).await?;
    let mut cmd = serde_json::json!({ "type": "prompt", "message": message });
    attach_images(&mut cmd, images);
    inst_request(&pool, &inst, cmd).await?;
    learn_file(&pool, &inst).await;
    Ok(serde_json::json!({ "accepted": true }))
}

#[tauri::command]
async fn pi_steer(cwd: String, session: Option<String>, message: String, images: Option<Vec<Value>>, app: AppHandle, pool: State<'_, Arc<Pool>>) -> Result<Value, String> {
    let inst = ensure(&app, &pool, &cwd, session, false).await?;
    let mut cmd = serde_json::json!({ "type": "steer", "message": message });
    attach_images(&mut cmd, images);
    let r = inst_request(&pool, &inst, cmd).await?;
    Ok(r)
}

#[tauri::command]
async fn pi_follow_up(cwd: String, session: Option<String>, message: String, images: Option<Vec<Value>>, app: AppHandle, pool: State<'_, Arc<Pool>>) -> Result<Value, String> {
    // exact RPC `follow_up`: queued, delivered only when the agent finishes
    let inst = ensure(&app, &pool, &cwd, session, false).await?;
    let mut cmd = serde_json::json!({ "type": "follow_up", "message": message });
    attach_images(&mut cmd, images);
    let r = inst_request(&pool, &inst, cmd).await?;
    Ok(r)
}

#[tauri::command]
async fn pi_clear_queue(cwd: String, session: Option<String>, pool: State<'_, Arc<Pool>>) -> Result<Value, String> {
    // explicit user action only — Esc/Stop must not silently clear queued items.
    // Lookup only: never spawn a stranger just to clear its (empty) queue.
    let inst = find(&pool, &cwd, session.as_deref()).await.ok_or("chat process is gone; reopen the chat")?;
    let r = inst_request(&pool, &inst, serde_json::json!({ "type": "clear_queue" })).await?;
    Ok(r)
}

#[tauri::command]
async fn pi_abort(cwd: String, session: Option<String>, pool: State<'_, Arc<Pool>>) -> Result<Value, String> {
    // Stop only. Queued steering/follow-up messages are preserved (abort
    // continues them when they remain); the UI offers an explicit Clear.
    // Lookup only: a missing process means nothing is running.
    let inst = find(&pool, &cwd, session.as_deref()).await.ok_or("chat process is gone; reopen the chat")?;
    let r = inst_request(&pool, &inst, serde_json::json!({ "type": "abort" })).await?;
    Ok(r)
}

#[tauri::command]
async fn pi_new_chat(cwd: String, app: AppHandle, pool: State<'_, Arc<Pool>>) -> Result<Value, String> {
    // A guaranteed-empty session in its own (or a safely reused) process.
    // Never disturbs running chats — the old new_session-on-the-only-process
    // is exactly what this pool retires.
    let inst = ensure(&app, &pool, &cwd, None, true).await?;
    learn_file(&pool, &inst).await;
    let path = inst.session_file.lock().await.clone().ok_or("couldn't create session")?;
    Ok(serde_json::json!({ "path": path }))
}

#[tauri::command]
async fn pi_get_messages(cwd: String, session: Option<String>, app: AppHandle, pool: State<'_, Arc<Pool>>) -> Result<Value, String> {
    let inst = ensure(&app, &pool, &cwd, session, false).await?;
    let r = inst_request(&pool, &inst, serde_json::json!({ "type": "get_messages" })).await?;
    let msgs = r.pointer("/data/messages").cloned().unwrap_or(Value::Null);
    Ok(serde_json::json!({ "messages": msgs }))
}

#[tauri::command]
async fn pi_get_state(cwd: String, session: Option<String>, app: AppHandle, pool: State<'_, Arc<Pool>>) -> Result<Value, String> {
    let inst = ensure(&app, &pool, &cwd, session, false).await?;
    let r = inst_request(&pool, &inst, serde_json::json!({ "type": "get_state" })).await?;
    let mut data = r.pointer("/data").cloned().unwrap_or(serde_json::json!({}));
    data["cwd"] = Value::String(inst.cwd.clone());
    // Free affirmation: every state read keeps scope routing exact.
    if let Some(f) = data.get("sessionFile").and_then(Value::as_str) {
        *inst.session_file.lock().await = Some(f.to_string());
        pool.recent.lock().await.insert(inst.cwd.clone(), f.to_string());
    }
    Ok(data)
}

#[tauri::command]
async fn pi_get_stats(cwd: String, session: Option<String>, app: AppHandle, pool: State<'_, Arc<Pool>>) -> Result<Value, String> {
    let inst = ensure(&app, &pool, &cwd, session, false).await?;
    let r = inst_request(&pool, &inst, serde_json::json!({ "type": "get_session_stats" })).await?;
    Ok(r.pointer("/data").cloned().unwrap_or(Value::Null))
}

#[tauri::command]
async fn pi_get_commands(cwd: String, session: Option<String>, app: AppHandle, pool: State<'_, Arc<Pool>>) -> Result<Value, String> {
    // Skills (+ prompt templates / extension commands) differ per project,
    // so this is scoped like everything else; the UI caches per cwd.
    let inst = ensure(&app, &pool, &cwd, session, false).await?;
    let r = inst_request(&pool, &inst, serde_json::json!({ "type": "get_commands" })).await?;
    Ok(serde_json::json!({ "commands": r.pointer("/data/commands").cloned().unwrap_or(Value::Null) }))
}

#[tauri::command]
async fn pi_get_models(cwd: String, session: Option<String>, app: AppHandle, pool: State<'_, Arc<Pool>>) -> Result<Value, String> {
    let inst = ensure(&app, &pool, &cwd, session, false).await?;
    let models_r = inst_request(&pool, &inst, serde_json::json!({ "type": "get_available_models" })).await?;
    let state_r = inst_request(&pool, &inst, serde_json::json!({ "type": "get_state" })).await?;
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
async fn pi_set_model(provider: String, model_id: String, pool: State<'_, Arc<Pool>>) -> Result<Value, String> {
    // Fan-out: every live chat follows, and future spawns inherit.
    *pool.default_model.lock().await = Some((provider.clone(), model_id.clone()));
    let insts: Vec<Arc<Instance>> = pool.instances.lock().await.values().cloned().collect();
    for inst in &insts {
        let _ = inst_request(&pool, inst, serde_json::json!({ "type": "set_model", "provider": provider, "modelId": model_id })).await;
    }
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
async fn pi_set_thinking(level: String, pool: State<'_, Arc<Pool>>) -> Result<Value, String> {
    *pool.default_thinking.lock().await = Some(level.clone());
    let insts: Vec<Arc<Instance>> = pool.instances.lock().await.values().cloned().collect();
    for inst in &insts {
        let _ = inst_request(&pool, inst, serde_json::json!({ "type": "set_thinking_level", "level": level })).await;
    }
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
async fn pi_compact(cwd: String, session: Option<String>, app: AppHandle, pool: State<'_, Arc<Pool>>) -> Result<Value, String> {
    let inst = ensure(&app, &pool, &cwd, session, false).await?;
    let r = inst_request(&pool, &inst, serde_json::json!({ "type": "compact" })).await?;
    Ok(r)
}

#[tauri::command]
async fn pi_export(cwd: String, session: Option<String>, app: AppHandle, pool: State<'_, Arc<Pool>>) -> Result<Value, String> {
    let inst = ensure(&app, &pool, &cwd, session, false).await?;
    let r = inst_request(&pool, &inst, serde_json::json!({ "type": "export_html" })).await?;
    Ok(r.pointer("/data").cloned().unwrap_or(Value::Null))
}

#[tauri::command]
async fn pi_set_name(cwd: String, session: Option<String>, name: String, app: AppHandle, pool: State<'_, Arc<Pool>>) -> Result<Value, String> {
    let inst = ensure(&app, &pool, &cwd, session, false).await?;
    let r = inst_request(&pool, &inst, serde_json::json!({ "type": "set_session_name", "name": name })).await?;
    Ok(r)
}

#[tauri::command]
async fn pi_ui_response(cwd: String, session: Option<String>, id: String, payload: Value, pool: State<'_, Arc<Pool>>) -> Result<Value, String> {
    let mut cmd = serde_json::json!({ "type": "extension_ui_response", "id": id });
    if let Value::Object(map) = payload {
        if let Value::Object(cmd_map) = &mut cmd {
            for (k, v) in map {
                cmd_map.insert(k, v);
            }
        }
    }
    let inst = find(&pool, &cwd, session.as_deref()).await.ok_or("chat process is gone; reopen the chat")?;
    fire_inst(&pool, &inst, cmd).await?;
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
async fn pi_list_sessions(cwd: String, session: Option<String>, app: AppHandle, pool: State<'_, Arc<Pool>>) -> Result<Value, String> {
    let inst = ensure(&app, &pool, &cwd, session, false).await?;
    let r = inst_request(&pool, &inst, serde_json::json!({ "type": "get_state" })).await?;
    let active = r.pointer("/data/sessionFile").and_then(Value::as_str).map(String::from);
    // Respect the harness' actual session directory, including custom settings.
    let dir = active.as_ref().and_then(|p| PathBuf::from(p).parent().map(|p| p.to_path_buf()));
    let out = tokio::task::spawn_blocking(move || list_sessions(dir)).await.map_err(|e| e.to_string())??;
    Ok(serde_json::json!({"sessions": out, "active": active}))
}

/// Reverse a pi session slug (`--Users-name-workspace_a-projects-foo--`) back to
/// its folder. Each `-` may have been a `/` or a literal hyphen, so enumerate
/// every assignment and keep the ones that exist on disk, preferring fewer
/// separators. Typical slugs need dozens of stat calls; cap pathological ones.
fn resolve_slug(slug: &str) -> Option<String> {
    let inner = slug.strip_prefix("--")?.strip_suffix("--")?;
    if inner.is_empty() {
        return None;
    }
    let tokens: Vec<&str> = inner.split('-').collect();
    let gaps = tokens.len().saturating_sub(1);
    if gaps > 20 {
        let guess = format!("/{}", inner.replace('-', "/"));
        return std::path::Path::new(&guess).is_dir().then(|| guess);
    }
    let mut best: Option<String> = None;
    let mut best_seps = usize::MAX;
    for mask in 0..(1u64 << gaps) {
        let seps = mask.count_ones() as usize;
        if seps >= best_seps {
            continue;
        }
        let mut s = String::from("/");
        for (i, t) in tokens.iter().enumerate() {
            if i > 0 {
                s.push(if (mask >> (i - 1)) & 1 == 1 { '/' } else { '-' });
            }
            s.push_str(t);
        }
        if std::path::Path::new(&s).is_dir() {
            best_seps = seps;
            best = Some(s);
            if seps == 0 {
                break;
            }
        }
    }
    best
}

/// Every project pi has touched on this machine: each session dir resolved to
/// its folder (`cwd: null` when the folder is gone) with its chats inside.
/// The sidebar renders this directly — no manual registration needed.
#[tauri::command]
fn pi_list_dirs(path: String) -> Result<Value, String> {
    // Universal folder picker backend: child directories of any path.
    // Synchronous std::fs read — one directory level, capped, no recursion.
    let canon = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| format!("Cannot open {}: {}", path, e))?;
    if (!canon.is_dir()) {
        return Err(format!("Not a folder: {}", path));
    }
    let entries = std::fs::read_dir(&canon).map_err(|e| format!("Cannot list {}: {}", path, e))?;
    let mut dirs: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        if (dirs.len() >= 1000) {
            break;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if (name.starts_with('.')) {
            continue;
        }
        if (entry.file_type().map(|t| t.is_dir()).unwrap_or(false)) {
            dirs.push(entry.path().to_string_lossy().into_owned());
        }
    }
    dirs.sort_by_key(|s| s.to_lowercase());
    Ok(serde_json::json!({
        "path": canon.to_string_lossy(),
        "parent": canon.parent().map(|p| p.to_string_lossy().into_owned()),
        "home": dirs::home_dir().map(|h| h.to_string_lossy().into_owned()).unwrap_or_else(|| "/".to_string()),
        "dirs": dirs,
    }))
}

#[tauri::command]
fn pi_read_image(path: String) -> Result<Value, String> {
    // Render markdown-referenced images: allowlisted raster/vector types only,
    // resolved path must exist, 10MB cap. Returned as base64 (no asset-protocol
    // scope or extra capabilities needed).
    use base64::Engine as _;
    let canon = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| format!("Cannot open {}: {}", path, e))?;
    if (!canon.is_file()) {
        return Err(format!("Not a file: {}", path));
    }
    let mime = match canon
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("svg") => "image/svg+xml",
        _ => return Err(format!("Not a supported image: {}", path)),
    };
    const MAX: u64 = 10 * 1024 * 1024;
    let bytes = std::fs::read(&canon).map_err(|e| format!("Cannot read {}: {}", path, e))?;
    if (bytes.len() as u64 > MAX) {
        return Err("Image is larger than 10MB".to_string());
    }
    Ok(serde_json::json!({
        "path": canon.to_string_lossy(),
        "mime": mime,
        "data": base64::engine::general_purpose::STANDARD.encode(&bytes),
    }))
}

#[tauri::command]
async fn pi_all_projects() -> Result<Value, String> {
    let base = dirs::home_dir().map(|h| h.join(".pi").join("agent").join("sessions"));
    let projects = tokio::task::spawn_blocking(move || {
        let mut out: Vec<Value> = Vec::new();
        let Some(base) = base else { return out; };
        let Ok(entries) = std::fs::read_dir(&base) else { return out; };
        for e in entries.flatten() {
            let dir = e.path();
            if !dir.is_dir() {
                continue;
            }
            let Some(slug) = dir.file_name().and_then(|s| s.to_str()).map(String::from) else { continue };
            let Ok(sessions) = list_sessions(Some(dir)) else { continue };
            let cwd = resolve_slug(&slug);
            if cwd.is_none() && sessions.is_empty() {
                continue; // degenerate slug dir, nothing to show
            }
            let latest = sessions.iter().filter_map(|s| s["mtime"].as_u64()).max().unwrap_or(0);
            out.push(serde_json::json!({"slug": slug, "cwd": cwd, "latest": latest, "sessions": sessions}));
        }
        out.sort_by_key(|v| std::cmp::Reverse(v["latest"].as_u64().unwrap_or(0)));
        out
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({"projects": projects}))
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
    fn sweep_plan_reaps_expired_then_oldest_idle_never_streaming() {
        let now = Instant::now();
        let ago = |s: u64| now - Duration::from_secs(s);
        let states = vec![
            (1, false, ago(2000)), // expired idle
            (2, true, ago(2000)),  // streaming even if old: immortal
            (3, false, ago(10)),
            (4, false, ago(20)),
            (5, false, ago(30)),
        ];
        let mut kill = sweep_plan(&states, now, 6, Duration::from_secs(900));
        kill.sort_unstable();
        assert_eq!(kill, vec![1]);
        let mut kill = sweep_plan(&states, now, 2, Duration::from_secs(900));
        kill.sort_unstable();
        // expired 1 plus oldest idle (5, then 4) down to cap 2 (2 streaming + 3)
        assert_eq!(kill, vec![1, 4, 5]);
        // streaming alone past the cap still overflows rather than killing work
        let states = vec![(1, true, ago(1)), (2, true, ago(1))];
        assert!(sweep_plan(&states, now, 1, Duration::from_secs(900)).is_empty());
    }
    #[test]
    fn visible_chat_matches_for_reaper_exemption() {
        assert!(matches_scope(Some("/a/b.jsonl"), "/a", "/a", Some("/a/b.jsonl")));
        assert!(!matches_scope(Some("/a/c.jsonl"), "/a", "/a", Some("/a/b.jsonl")));
        assert!(matches_scope(None, "/a", "/a", None));
        assert!(!matches_scope(Some("/a/b.jsonl"), "/a", "/a", None));
        assert!(!matches_scope(None, "/b", "/a", None));
    }
    #[test]
    fn list_dirs_lists_only_visible_subdirs() {
        let base = std::env::temp_dir().join("pi-ui-picker-test");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("b-sub")).unwrap();
        std::fs::create_dir_all(base.join(".hidden")).unwrap();
        std::fs::create_dir_all(base.join("a-sub")).unwrap();
        std::fs::write(base.join("file.txt"), "x").unwrap();
        let out = pi_list_dirs(base.to_string_lossy().into_owned()).unwrap();
        let dirs = out.pointer("/dirs").unwrap().as_array().unwrap();
        assert_eq!(dirs.len(), 2);
        assert!(dirs[0].as_str().unwrap().ends_with("a-sub"));
        assert!(dirs[1].as_str().unwrap().ends_with("b-sub"));
        assert!(out.pointer("/parent").unwrap().as_str().is_some());
        assert!(pi_list_dirs(base.join("nope").to_string_lossy().into_owned()).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }
    #[test]
    fn read_image_round_trips_png_and_rejects_non_images() {
        let base = std::env::temp_dir().join("pi-ui-img-test");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        // Minimal 1x1 PNG (signature + IHDR + IDAT + IEND).
        let png: Vec<u8> = vec![
            137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
            8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 1, 99, 96, 0, 1,
            0, 0, 5, 0, 1, 13, 10, 45, 180, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
        ];
        std::fs::write(base.join("a.png"), &png).unwrap();
        std::fs::write(base.join("b.txt"), "nope").unwrap();
        let out = pi_read_image(base.join("a.png").to_string_lossy().into_owned()).unwrap();
        assert_eq!(out.pointer("/mime").unwrap().as_str(), Some("image/png"));
        assert!(!out.pointer("/data").unwrap().as_str().unwrap().is_empty());
        assert!(pi_read_image(base.join("b.txt").to_string_lossy().into_owned()).is_err());
        assert!(pi_read_image(base.join("missing.png").to_string_lossy().into_owned()).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }
    #[test]
    fn rejection_is_an_error() {
        assert_eq!(checked_response(serde_json::json!({"success":false,"error":"denied"})).unwrap_err(), "denied");
        assert!(checked_response(serde_json::json!({"success":true})).is_ok());
    }
    #[test]
    fn slug_round_trips_through_real_directories() {
        let root = std::env::temp_dir().join(format!("pi-ui-slug-{}", uuid::Uuid::new_v4()));
        let nested = root.join("my-proj").join("sub_dir");
        std::fs::create_dir_all(&nested).unwrap();
        let slug = format!("--{}--", nested.to_string_lossy().replace('/', "-").trim_matches('-'));
        assert_eq!(resolve_slug(&slug).as_deref(), Some(nested.to_string_lossy().as_ref()));
        assert_eq!(resolve_slug("--no-such-dir-anywhere--"), None);
        std::fs::remove_dir_all(root).unwrap();
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
    let pool = Arc::new(Pool::new());
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(pool)
        .invoke_handler(tauri::generate_handler![
            pi_prompt,
            pi_steer,
            pi_follow_up,
            pi_clear_queue,
            pi_abort,
            pi_new_chat,
            pi_get_messages,
            pi_get_state,
            pi_get_stats,
            pi_get_commands,
            pi_get_models,
            pi_set_model,
            pi_set_thinking,
            pi_compact,
            pi_export,
            pi_set_name,
            pi_ui_response,
            pi_list_sessions,
            pi_all_projects,
            pi_list_dirs,
            pi_read_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
