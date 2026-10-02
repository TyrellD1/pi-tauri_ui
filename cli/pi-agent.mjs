#!/usr/bin/env node
// pi-agent — hand work to a pi agent from any CLI (a terminal, a script,
// Claude Code, another agent) and get the answer on stdout. Every agent is a
// real pi session, so it shows up in the pi Tauri app; when the app is open
// it streams there live over a local socket. A machine-wide queue caps how
// many run at once. Zero dependencies; Node 18+.
//
// Protocol: `pi --mode rpc` JSONL (split on \n only, never readline).
// Ground truth: pi docs rpc.md / rpc-commands.md / rpc-extension-ui.md.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as store from "./store.mjs";

const DIALOGS = new Set(["select", "confirm", "input", "editor"]);
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// ---------- args ----------
const BOOL_FLAGS = new Set(["detach", "json", "quiet", "all", "default", "help"]);
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = (eq > 0 ? a.slice(2, eq) : a.slice(2)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (eq > 0) out[key] = a.slice(eq + 1);
      else if (BOOL_FLAGS.has(key) || BOOL_FLAGS.has(a.slice(2))) out[key] = true;
      else if (i + 1 < argv.length) out[key] = argv[++i];
      else throw new UsageError(`${a} needs a value`);
    } else if (a === "-h") out.help = true;
    else out._.push(a);
  }
  return out;
}
class UsageError extends Error {}

const log = { quiet: false, info: (...a) => { if (!log.quiet) console.error(...a); } };

// ---------- pi RPC client ----------
/** `pi` on PATH, or $PI_BIN (a .js/.mjs file runs under this Node). */
function resolvePi() {
  const bin = process.env.PI_BIN || "pi";
  return /\.m?js$/.test(bin) ? { cmd: process.execPath, lead: [bin] } : { cmd: bin, lead: [] };
}
class PiRpc {
  constructor(cwd, args) {
    const { cmd, lead } = resolvePi();
    this.child = spawn(cmd, [...lead, "--mode", "rpc", ...args], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.pending = new Map();
    this.listeners = new Set();
    this.exited = new Promise((resolve) => this.child.on("exit", (code, sig) => resolve({ code, sig })));
    this.spawnError = new Promise((resolve) => this.child.on("error", resolve));
    this.stderr = "";
    this.child.stderr.on("data", (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    let buf = Buffer.alloc(0);
    this.child.stdout.on("data", (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      let nl;
      while ((nl = buf.indexOf(0x0a)) >= 0) {
        let line = buf.subarray(0, nl);
        buf = buf.subarray(nl + 1);
        if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
        if (!line.length) continue;
        let rec;
        try { rec = JSON.parse(line.toString("utf8")); } catch { continue; }
        if (rec.type === "response" && rec.id && this.pending.has(rec.id)) {
          const p = this.pending.get(rec.id);
          this.pending.delete(rec.id);
          rec.success === false ? p.reject(new Error(rec.error || `${rec.command} failed`)) : p.resolve(rec.data ?? {});
          continue;
        }
        for (const l of this.listeners) l(rec);
      }
    });
    this.child.on("exit", () => {
      for (const p of this.pending.values()) p.reject(new Error("pi exited"));
      this.pending.clear();
    });
  }
  write(obj) {
    if (!this.child.stdin.writable) return false;
    this.child.stdin.write(JSON.stringify(obj) + "\n");
    return true;
  }
  request(obj, timeoutMs = 30000) {
    const id = `pa-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`pi timed out on ${obj.type}`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      if (!this.write({ ...obj, id })) { clearTimeout(t); this.pending.delete(id); reject(new Error("pi is not accepting input")); }
    });
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  async close() {
    try { this.child.stdin.end(); } catch { /* closed */ }
    const t = setTimeout(() => this.child.kill("SIGTERM"), 5000);
    await this.exited;
    clearTimeout(t);
  }
}

// ---------- app link (optional Unix socket to the Tauri app) ----------
class AppLink {
  constructor(onMessage, onDrop) {
    this.sock = null;
    this.onMessage = onMessage;
    this.onDrop = onDrop;
    this.lastTry = 0;
  }
  get connected() { return !!this.sock && !this.sock.destroyed; }
  /** Try to (re)connect, at most once per 3s. Resolves true when connected. */
  connect(force = false) {
    if (this.connected) return Promise.resolve(true);
    if (process.platform === "win32") return Promise.resolve(false);
    const now = Date.now();
    if (!force && now - this.lastTry < 3000) return Promise.resolve(false);
    this.lastTry = now;
    const file = store.paths.socket();
    if (!fs.existsSync(file)) return Promise.resolve(false);
    return new Promise((resolve) => {
      const s = net.createConnection(file);
      let buf = "";
      s.setEncoding("utf8");
      s.once("connect", () => { this.sock = s; resolve(true); });
      s.once("error", () => { if (this.sock === s) this.sock = null; resolve(false); });
      s.on("data", (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try { this.onMessage(JSON.parse(line)); } catch { /* ignore junk */ }
        }
      });
      s.on("close", () => { if (this.sock === s) { this.sock = null; this.onDrop(); } });
    });
  }
  send(obj) {
    if (!this.connected) return false;
    try { this.sock.write(JSON.stringify(obj) + "\n"); return true; } catch { return false; }
  }
  close() { try { this.sock?.end(); } catch { /* closed */ } this.sock = null; }
}

// ---------- run ----------
function defaultName(task) {
  const words = task.replace(/\s+/g, " ").trim().split(" ").slice(0, 8).join(" ");
  return words.length > 60 ? words.slice(0, 59) + "…" : words || "agent";
}
function shortTool(e) {
  const a = e.args ?? {};
  const target = a.path ?? a.command ?? a.pattern ?? a.query ?? a.url ?? "";
  return `${e.toolName ?? "tool"}${target ? ` ${String(target).replace(/\s+/g, " ").slice(0, 80)}` : ""}`;
}

async function runAgent(opts) {
  const task = opts.task;
  const cwd = fs.realpathSync(path.resolve(opts.cwd || process.cwd()));
  if (!fs.statSync(cwd).isDirectory()) throw new UsageError(`not a folder: ${cwd}`);
  const models = store.loadModels();
  const model = opts.model || models.default;
  if (opts.thinking && !THINKING.includes(opts.thinking)) throw new UsageError(`--thinking must be one of ${THINKING.join(", ")}`);
  const name = (opts.name || defaultName(task)).trim();
  const id = opts.id || store.newAgentId();
  let rec = store.readAgent(id) ?? {};
  rec = store.writeAgent({
    ...rec,
    id, name, task: task.slice(0, 2000), cwd, model, thinking: opts.thinking ?? null,
    caller: opts.caller || process.env.PI_AGENT_CALLER || rec.caller || "cli",
    status: "queued", pid: process.pid, createdAt: rec.createdAt ?? Date.now(),
    startedAt: null, endedAt: null, sessionFile: null, error: null, queuePosition: null,
  });
  store.pruneAgents();

  let rpc = null, sessionFile = null, finished = false, cancelReason = null;
  const queueAbort = new AbortController();
  let settleResolve;
  const settled = new Promise((r) => { settleResolve = r; });

  const update = (patch) => {
    rec = store.writeAgent({ ...rec, ...patch });
    app.send({ type: "agent_update", agent: rec });
    return rec;
  };
  // Agents run with pi's normal full permissions; nobody is asked anything.
  // A stray extension dialog is cancelled at once so a run can never hang.
  const dismissDialog = (req) => {
    log.info(`pi-agent: extension asked "${req.title ?? req.method}" — dismissed (headless agents don't prompt)`);
    rpc?.write({ type: "extension_ui_response", id: req.id, cancelled: true });
  };
  const app = new AppLink(
    (msg) => { if (msg.type === "abort") void cancel("stopped from the app"); },
    () => {},
  );
  if (await app.connect(true)) app.send({ type: "agent_update", agent: rec });

  async function cancel(reason) {
    if (finished || cancelReason) return;
    cancelReason = reason;
    log.info(`pi-agent: ${reason}`);
    if (!rpc) { queueAbort.abort(); return; }
    try { await rpc.request({ type: "abort" }, 5000); } catch { /* exiting anyway */ }
    // Give pi a moment to settle and persist; then stop waiting.
    setTimeout(() => settleResolve("cancel-timeout"), 8000).unref();
  }
  const onSignal = (sig) => void cancel(sig === "SIGINT" ? "interrupted" : "cancelled");
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let release = () => {};
  try {
    log.info(`pi-agent ${id}: queued (max ${store.loadConfig().maxConcurrent} at once)`);
    release = await store.acquireSlot(id, {
      signal: queueAbort.signal,
      onPosition: (n) => { update({ queuePosition: n }); log.info(`pi-agent ${id}: waiting — #${n} in queue`); },
    });
  } catch (e) {
    finished = true;
    update({ status: "cancelled", endedAt: Date.now(), error: cancelReason ?? String(e.message ?? e), queuePosition: null });
    app.close();
    return { rec, code: 130 };
  }
  const releaseOnExit = () => release();
  process.on("exit", releaseOnExit);

  let timeoutTimer = null;
  try {
    const args = [];
    if (model) args.push("--model", model);
    if (opts.thinking) args.push("--thinking", opts.thinking);
    args.push("--name", `[agent] ${name}`);
    rpc = new PiRpc(cwd, args);
    const spawnErr = await Promise.race([rpc.spawnError, new Promise((r) => setTimeout(() => r(null), 50))]);
    if (spawnErr) throw new Error(`couldn't start pi (${spawnErr.code === "ENOENT" ? "is pi on PATH? set PI_BIN to override" : spawnErr.message})`);

    rpc.on((ev) => {
      // Tag like the app's own processes so its routing works unchanged.
      // Nothing is forwarded before the session file is known: an untagged
      // event would match any fresh "new chat" view in the same folder.
      const dialog = ev.type === "extension_ui_request" && DIALOGS.has(ev.method);
      if (sessionFile && !dialog) app.send({ type: "event", event: { ...ev, cwd, session: sessionFile, agentId: id } });
      if (!app.connected) void app.connect().then((ok) => ok && app.send({ type: "agent_update", agent: rec }));
      if (ev.type === "tool_execution_start") log.info(`  › ${shortTool(ev)}`);
      if (dialog) dismissDialog(ev);
      if (ev.type === "agent_settled") settleResolve("settled");
    });
    void rpc.exited.then(() => settleResolve("exited"));

    const st = await rpc.request({ type: "get_state" });
    sessionFile = typeof st.sessionFile === "string" ? st.sessionFile : null;
    const actualModel = st.model ? `${st.model.provider}/${st.model.id}` : model;
    if (model && actualModel !== model) log.info(`pi-agent: requested ${model}, pi is using ${actualModel}`);
    update({ status: "running", startedAt: Date.now(), queuePosition: null, sessionFile, model: actualModel });
    log.info(`pi-agent ${id}: running ${actualModel} in ${cwd}${sessionFile ? `\n  session ${sessionFile}` : ""}`);

    if (opts.timeout) {
      const min = Number(opts.timeout);
      if (!(min > 0)) throw new UsageError("--timeout takes minutes, e.g. --timeout 30");
      timeoutTimer = setTimeout(() => void cancel(`timed out after ${min} min`), min * 60000);
      timeoutTimer.unref();
    }
    const pr = await rpc.request({ type: "prompt", message: task });
    if (pr.disposition !== "handled") await settled;
    else settleResolve("handled");

    let text = null, failure = null;
    if (rpc.child.exitCode === null) {
      try { text = (await rpc.request({ type: "get_last_assistant_text" })).text ?? null; } catch { /* keep null */ }
      try {
        const msgs = (await rpc.request({ type: "get_messages" })).messages ?? [];
        const last = [...msgs].reverse().find((m) => m.role === "assistant");
        if (last?.stopReason === "error") failure = String(last.errorMessage ?? "the model reported an error");
      } catch { /* best effort */ }
      try {
        const st2 = await rpc.request({ type: "get_state" });
        if (typeof st2.sessionFile === "string") sessionFile = st2.sessionFile;
      } catch { /* keep */ }
    } else failure = `pi exited unexpectedly${rpc.stderr ? `: ${rpc.stderr.trim().split("\n").pop()}` : ""}`;

    finished = true;
    if (text) fs.writeFileSync(store.resultFile(id), text.endsWith("\n") ? text : text + "\n");
    const status = cancelReason ? (cancelReason.startsWith("timed out") ? "failed" : "cancelled") : failure ? "failed" : "done";
    update({ status, endedAt: Date.now(), sessionFile, error: cancelReason ?? failure, hasResult: !!text });
    return { rec, text, code: status === "done" ? 0 : status === "cancelled" ? 130 : 1 };
  } catch (e) {
    finished = true;
    update({ status: "failed", endedAt: Date.now(), sessionFile, error: String(e.message ?? e) });
    if (e instanceof UsageError) throw e;
    return { rec, text: null, code: 1 };
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (rpc) await rpc.close();
    release();
    process.off("exit", releaseOnExit);
    app.close();
  }
}

// ---------- output helpers ----------
function ago(ms) {
  if (!ms) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function statusText(r) {
  if (r.status === "queued") return r.queuePosition ? `queued #${r.queuePosition}` : "queued";
  return r.status;
}
function printResult(r, text, json) {
  if (json) {
    console.log(JSON.stringify({ id: r.id, status: r.status, sessionFile: r.sessionFile, model: r.model, cwd: r.cwd, error: r.error, result: text ?? null }, null, 2));
    return;
  }
  if (text) process.stdout.write(text.endsWith("\n") ? text : text + "\n");
  if (r.status !== "done") console.error(`pi-agent ${r.id}: ${r.status}${r.error ? ` — ${r.error}` : ""}`);
}
function readResult(id) {
  try { return fs.readFileSync(store.resultFile(id), "utf8"); } catch { return null; }
}
function exitCodeFor(status) {
  return status === "done" ? 0 : status === "cancelled" ? 130 : 1;
}

/** Wait for a record to reach a terminal status (event-driven, 2s safety net). */
function waitForAgent(id) {
  return new Promise((resolve) => {
    const check = () => {
      const r = store.listAgents().find((x) => x.id === id);
      if (!r) return null;
      if (store.TERMINAL.has(r.status)) { cleanup(); resolve(r); }
      return r;
    };
    let watcher = null;
    const timer = setInterval(check, 2000);
    const cleanup = () => { clearInterval(timer); watcher?.close(); };
    try { watcher = fs.watch(store.paths.agents(), (_e, f) => { if (!f || f.startsWith(id)) check(); }); } catch { /* interval only */ }
    if (!check()) { cleanup(); resolve(null); }
  });
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

const HELP = `pi-agent — hand work to a pi agent; it shows up live in the pi app.

Usage
  pi-agent run [options] "task"     run an agent, print its final answer to stdout
  pi-agent run [options] < task.md  task from stdin
  pi-agent list [--all] [--json]    recent agents (queued / running / done / failed)
  pi-agent status ID [--json]       one agent
  pi-agent wait ID [--json]         wait for a (--detach'ed) agent, print its answer
  pi-agent result ID                print a finished agent's answer
  pi-agent cancel ID                stop a queued or running agent
  pi-agent models [--json]          recommended models and when to use them
  pi-agent models set ID --use "…" --avoid "…" [--default]
  pi-agent models default ID | remove ID | reset
  pi-agent config [set max-concurrent N]
  pi-agent guide                    a brief for AI callers (how to delegate + models)

Run options
  --cwd DIR          project folder (default: current folder)
  --model P/ID       model (default: the recommended default — see \`pi-agent models\`)
  --thinking LEVEL   off | minimal | low | medium | high | xhigh | max
  --name NAME        chat name in the app (shown as "[agent] NAME")
  --detach           print the agent id and return; use \`pi-agent wait ID\` later
  --timeout MIN      stop after MIN minutes
  --caller NAME      who is asking (shown in the app); or PI_AGENT_CALLER
  --json             JSON output   --quiet  no progress on stderr

Progress goes to stderr; the answer goes to stdout. Exit: 0 done, 1 failed, 130 cancelled.
Data: ${store.home()}`;

// ---------- commands ----------
async function main(argv) {
  const [cmd = "help", ...rest] = argv;
  const a = parseArgs(rest);
  log.quiet = !!a.quiet;
  switch (cmd) {
    case "help": case "--help": case "-h":
      console.log(HELP);
      return 0;
    case "run": {
      if (a.help) { console.log(HELP); return 0; }
      let task = a._.join(" ").trim();
      if (!task) task = (await readStdin()).trim();
      if (!task) throw new UsageError('give the agent a task: pi-agent run "…" (or pipe it on stdin)');
      if (a.detach) {
        const id = store.newAgentId();
        const cwd = fs.realpathSync(path.resolve(a.cwd || process.cwd()));
        const self = fileURLToPath(import.meta.url);
        const childArgs = [self, "run", "--id", id, "--cwd", cwd, "--quiet"];
        for (const k of ["model", "thinking", "name", "timeout", "caller"]) if (a[k]) childArgs.push(`--${k}`, String(a[k]));
        childArgs.push("--", task);
        store.writeAgent({ id, name: (a.name || defaultName(task)).trim(), task: task.slice(0, 2000), cwd, model: a.model || store.loadModels().default, status: "queued", pid: null, caller: a.caller || process.env.PI_AGENT_CALLER || "cli", createdAt: Date.now() });
        const child = spawn(process.execPath, childArgs, { detached: true, stdio: "ignore", env: process.env });
        store.updateAgent(id, { pid: child.pid });
        child.unref();
        if (a.json) console.log(JSON.stringify({ id, status: "queued" }));
        else console.log(id);
        return 0;
      }
      const { rec, text, code } = await runAgent({ ...a, task });
      printResult(rec, text, a.json);
      return code;
    }
    case "list": {
      const all = store.listAgents();
      const rows = a.all ? all : all.slice(0, 20);
      if (a.json) { console.log(JSON.stringify(rows, null, 2)); return 0; }
      if (!rows.length) { console.log("No agents yet. Start one: pi-agent run \"…\""); return 0; }
      const { slots, tickets } = store.queueSnapshot();
      console.log(`${slots.length} running · ${tickets.length} queued · max ${store.loadConfig().maxConcurrent}\n`);
      for (const r of rows) {
        console.log(`${r.id}  ${statusText(r).padEnd(10)}  ${ago(r.endedAt || r.startedAt || r.createdAt).padEnd(8)}  ${path.basename(r.cwd ?? "")}  ${r.name}`);
      }
      return 0;
    }
    case "status": {
      const id = a._[0];
      const r = id && store.listAgents().find((x) => x.id === id);
      if (!r) throw new UsageError(`no agent ${id ?? "(missing id)"}`);
      if (a.json) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(`${r.id}  ${statusText(r)}\n  name     ${r.name}\n  project  ${r.cwd}\n  model    ${r.model}\n  caller   ${r.caller}`);
        if (r.sessionFile) console.log(`  session  ${r.sessionFile}`);
        if (r.error) console.log(`  error    ${r.error}`);
      }
      return 0;
    }
    case "wait": {
      const id = a._[0];
      if (!id) throw new UsageError("usage: pi-agent wait ID");
      const r = await waitForAgent(id);
      if (!r) throw new UsageError(`no agent ${id}`);
      printResult(r, readResult(id), a.json);
      return exitCodeFor(r.status);
    }
    case "result": {
      const id = a._[0];
      const r = id && store.listAgents().find((x) => x.id === id);
      if (!r) throw new UsageError(`no agent ${id ?? "(missing id)"}`);
      const text = readResult(id);
      if (text) process.stdout.write(text);
      else console.error(`pi-agent ${id}: ${statusText(r)} — no answer${store.TERMINAL.has(r.status) ? "" : " yet"}`);
      return text ? 0 : 1;
    }
    case "cancel": {
      const id = a._[0];
      const r = id && store.listAgents().find((x) => x.id === id);
      if (!r) throw new UsageError(`no agent ${id ?? "(missing id)"}`);
      if (store.TERMINAL.has(r.status)) { console.log(`${id} already ${r.status}`); return 0; }
      if (!store.pidAlive(r.pid)) { store.updateAgent(id, { status: "cancelled", endedAt: Date.now(), error: "runner was not running" }); return 0; }
      process.kill(r.pid, "SIGTERM");
      console.log(`stopping ${id}…`);
      return 0;
    }
    case "models": {
      const [sub, id] = a._;
      if (!sub) {
        const m = store.loadModels();
        if (a.json) { console.log(JSON.stringify(m, null, 2)); return 0; }
        for (const x of m.models) {
          console.log(`${x.id}${x.id === m.default ? "  (default)" : ""}\n  use:   ${x.use}\n  avoid: ${x.avoid}\n`);
        }
        console.log(`Change with: pi-agent models set <provider/id> --use "…" --avoid "…" [--default]`);
        return 0;
      }
      if (sub === "set") {
        if (!id) throw new UsageError('usage: pi-agent models set provider/id --use "…" --avoid "…" [--default]');
        store.setModel(id, { use: a.use, avoid: a.avoid, makeDefault: !!a.default });
      } else if (sub === "default") {
        if (!id) throw new UsageError("usage: pi-agent models default provider/id");
        store.setDefaultModel(id);
      } else if (sub === "remove") {
        if (!id) throw new UsageError("usage: pi-agent models remove provider/id");
        store.removeModel(id);
      } else if (sub === "reset") {
        store.saveModels(store.seedModels());
      } else throw new UsageError(`unknown: pi-agent models ${sub}`);
      const m = store.loadModels();
      console.log(`default: ${m.default} · ${m.models.length} recommended`);
      return 0;
    }
    case "config": {
      const [sub, key, value] = a._;
      if (!sub || sub === "get") { console.log(JSON.stringify(store.loadConfig(), null, 2)); return 0; }
      if (sub === "set") { console.log(JSON.stringify(store.setConfig(key, value), null, 2)); return 0; }
      throw new UsageError("usage: pi-agent config [get | set max-concurrent N]");
    }
    case "guide": {
      const m = store.loadModels();
      const lines = [
        "# Delegating to pi agents",
        "",
        "Run `pi-agent run --cwd <project> \"<task>\"`. It blocks until the agent finishes and prints the agent's final answer on stdout (progress on stderr). Exit code 0 = done, 1 = failed, 130 = cancelled.",
        "For parallel work use `--detach` (prints an id), then `pi-agent wait <id>` for each.",
        `At most ${store.loadConfig().maxConcurrent} agents run at once; extra runs wait in a queue automatically.`,
        "Write tasks as self-contained briefs: the goal, the files involved, constraints, and what to report back. The agent starts with no context from you.",
        "Every agent is visible (and stoppable) in the pi app as an `[agent]` chat.",
        "",
        "## Recommended models (pass with --model; the default is used when omitted)",
        "",
        ...m.models.map((x) => `- \`${x.id}\`${x.id === m.default ? " (default)" : ""}\n  - Use: ${x.use}\n  - Avoid: ${x.avoid}`),
      ];
      console.log(lines.join("\n"));
      return 0;
    }
    default:
      throw new UsageError(`unknown command "${cmd}" — try: pi-agent help`);
  }
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code ?? 0; },
  (e) => {
    console.error(`pi-agent: ${e.message ?? e}`);
    process.exitCode = e instanceof UsageError || e instanceof store.InputError ? 2 : 1;
  },
);
