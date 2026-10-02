// pi-agent storage: recommended models, config, agent registry, and the
// machine-wide run queue. Plain JSON files under one root so the CLI, the
// Tauri app, and humans can all read them. Zero dependencies.
//
// Root: $PI_AGENT_HOME or ~/.pi/agent/pi-tauri-ui
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_MODEL = "opencode-go/muse-spark-1.3-contributor";
export const DEFAULT_MAX_CONCURRENT = 12;
export const TERMINAL = new Set(["done", "failed", "cancelled", "lost"]);
const KEEP_RECORDS = 200;

/** Bad input from the caller (exit code 2), as opposed to a failed run. */
export class InputError extends Error {}

export function home() {
  return process.env.PI_AGENT_HOME || path.join(os.homedir(), ".pi", "agent", "pi-tauri-ui");
}
export const paths = {
  models: () => path.join(home(), "models.json"),
  config: () => path.join(home(), "config.json"),
  agents: () => path.join(home(), "agents"),
  queue: () => path.join(home(), "queue"),
  slots: () => path.join(home(), "slots"),
  socket: () => path.join(home(), "ui.sock"),
};

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
/** Atomic write: readers (the app, `wait`) never see a half-written file. */
export function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

// ---------- recommended models ----------
export function seedModels() {
  return {
    default: DEFAULT_MODEL,
    models: [
      {
        id: DEFAULT_MODEL,
        use: "Default for delegated coding work: reading code, scoped edits, running tests, and reporting back. Cheap and fast enough to run many agents in parallel.",
        avoid: "Skip it for ambiguous architecture or product calls, or long open-ended investigations where a stronger reasoning model is worth the cost.",
      },
    ],
  };
}
export function loadModels() {
  const m = readJson(paths.models(), null);
  if (!m || typeof m !== "object" || !Array.isArray(m.models)) return seedModels();
  const models = m.models.filter((x) => x && typeof x.id === "string" && x.id.includes("/"));
  const def = typeof m.default === "string" && m.default ? m.default : models[0]?.id ?? DEFAULT_MODEL;
  return { default: def, models };
}
export function saveModels(m) {
  writeJson(paths.models(), m);
}
export function setModel(id, { use, avoid, makeDefault } = {}) {
  if (!/^[^/\s]+\/\S+$/.test(id)) throw new InputError(`model id must look like provider/id, got "${id}"`);
  const m = loadModels();
  const existing = m.models.find((x) => x.id === id);
  if (existing) {
    if (use !== undefined) existing.use = use;
    if (avoid !== undefined) existing.avoid = avoid;
  } else {
    if (!use || !avoid) throw new InputError("a new recommendation needs both --use and --avoid (one to two sentences each)");
    m.models.push({ id, use, avoid });
  }
  if (makeDefault) m.default = id;
  saveModels(m);
  return m;
}
export function setDefaultModel(id) {
  const m = loadModels();
  if (!m.models.some((x) => x.id === id)) throw new InputError(`${id} isn't recommended yet — add it with: pi-agent models set ${id} --use "…" --avoid "…"`);
  m.default = id;
  saveModels(m);
  return m;
}
export function removeModel(id) {
  const m = loadModels();
  const before = m.models.length;
  m.models = m.models.filter((x) => x.id !== id);
  if (m.models.length === before) throw new InputError(`${id} isn't in the recommended list`);
  if (m.default === id) m.default = m.models[0]?.id ?? DEFAULT_MODEL;
  saveModels(m);
  return m;
}

// ---------- config ----------
export function loadConfig() {
  const c = readJson(paths.config(), {});
  const env = Number(process.env.PI_AGENT_MAX_CONCURRENT);
  const n = Number.isInteger(env) && env > 0 ? env : Number(c.maxConcurrent);
  return { maxConcurrent: Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_CONCURRENT };
}
export function setConfig(key, value) {
  const c = readJson(paths.config(), {});
  if (key === "max-concurrent" || key === "maxConcurrent") {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 64) throw new InputError("max-concurrent must be a whole number from 1 to 64");
    c.maxConcurrent = n;
  } else throw new InputError(`unknown setting "${key}" (known: max-concurrent)`);
  writeJson(paths.config(), c);
  return loadConfig();
}

// ---------- agent registry ----------
export function newAgentId(now = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `ag-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}
const recordFile = (id) => path.join(paths.agents(), `${id}.json`);
export const resultFile = (id) => path.join(paths.agents(), `${id}.out.md`);
export function readAgent(id) {
  if (!/^[\w.-]+$/.test(id)) return null;
  return readJson(recordFile(id), null);
}
export function writeAgent(rec) {
  writeJson(recordFile(rec.id), rec);
  return rec;
}
export function updateAgent(id, patch) {
  const rec = readAgent(id);
  if (!rec) return null;
  return writeAgent({ ...rec, ...patch });
}
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
/** Newest first. Runners that died without finishing read as `lost`. */
export function listAgents() {
  let files = [];
  try {
    files = fs.readdirSync(paths.agents()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const r = readJson(path.join(paths.agents(), f), null);
    if (!r || typeof r.id !== "string") continue;
    if (!TERMINAL.has(r.status) && !pidAlive(r.pid)) r.status = "lost";
    out.push(r);
  }
  out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return out;
}
/** Keep the registry small: drop the oldest finished records past KEEP_RECORDS. */
export function pruneAgents() {
  const all = listAgents();
  const finished = all.filter((r) => TERMINAL.has(r.status));
  for (const r of finished.slice(Math.max(0, KEEP_RECORDS - (all.length - finished.length)))) {
    try { fs.unlinkSync(recordFile(r.id)); } catch { /* gone */ }
    try { fs.unlinkSync(resultFile(r.id)); } catch { /* none */ }
  }
}
export function clearFinished() {
  let n = 0;
  for (const r of listAgents()) {
    if (!TERMINAL.has(r.status)) continue;
    try { fs.unlinkSync(recordFile(r.id)); n++; } catch { /* gone */ }
    try { fs.unlinkSync(resultFile(r.id)); } catch { /* none */ }
  }
  return n;
}

// ---------- queue ----------
// Cross-process FIFO semaphore built on plain files: a waiter holds a ticket
// in queue/, a runner holds a slot in slots/. A waiter may take a slot when
// (slots in use) + (its position among tickets) < max. The slot is written
// BEFORE the ticket is removed, so two waiters can never both take the last
// slot. Entries whose pid is dead are swept by any waiter.
function liveEntries(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => !n.endsWith(".tmp"));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    const full = path.join(dir, n);
    let pid = NaN;
    try {
      pid = Number(fs.readFileSync(full, "utf8").trim());
    } catch {
      continue;
    }
    if (!pidAlive(pid)) {
      try { fs.unlinkSync(full); } catch { /* raced */ }
      continue;
    }
    out.push(n);
  }
  return out.sort();
}
/**
 * Tickets are read BEFORE slots. A runner writes its slot before it deletes
 * its ticket, so with this order a waiter can never see the stale slot count
 * together with a ticket list the runner ahead of it has already left
 * (which would let two waiters take the last slot).
 */
export function queueSnapshot() {
  const tickets = liveEntries(paths.queue());
  const slots = liveEntries(paths.slots());
  return { slots, tickets };
}
/** Create a pid file atomically: a sweeping reader never sees it empty. */
function writePidFile(file) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, String(process.pid));
  fs.renameSync(tmp, file);
}

/**
 * Wait for a run slot. Resolves with a release() function.
 * onPosition(n) reports the 1-based queue position whenever it changes.
 * signal (AbortSignal) cancels the wait.
 */
export function acquireSlot(id, { onPosition, signal } = {}) {
  ensureDir(paths.queue());
  ensureDir(paths.slots());
  const ticketName = `${String(Date.now()).padStart(15, "0")}-${id}`;
  const ticket = path.join(paths.queue(), ticketName);
  const slot = path.join(paths.slots(), id);
  writePidFile(ticket);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try { fs.unlinkSync(slot); } catch { /* not held */ }
    try { fs.unlinkSync(ticket); } catch { /* already taken */ }
  };
  return new Promise((resolve, reject) => {
    let watcher = null, timer = null, lastPos = -1, done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      watcher?.close();
      if (timer) clearInterval(timer);
      signal?.removeEventListener("abort", onAbort);
      if (err) { release(); reject(err); } else resolve(release);
    };
    const onAbort = () => finish(new Error("cancelled while queued"));
    const tryTake = () => {
      if (done) return;
      const max = loadConfig().maxConcurrent;
      const { slots, tickets } = queueSnapshot();
      const pos = tickets.indexOf(ticketName);
      if (pos < 0) { finish(new Error("queue ticket vanished")); return; }
      if (slots.length + pos < max) {
        writePidFile(slot);
        try { fs.unlinkSync(ticket); } catch { /* ok */ }
        finish(null);
        return;
      }
      const ahead = pos + 1;
      if (ahead !== lastPos) { lastPos = ahead; onPosition?.(ahead); }
    };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort);
    try {
      watcher = fs.watch(paths.slots(), () => tryTake());
    } catch { /* fall back to the interval alone */ }
    // Safety net for runners killed without cleanup (their slot only frees
    // once the dead pid is noticed). Only waiters run this — never the UI.
    timer = setInterval(tryTake, 2000);
    tryTake();
  });
}
