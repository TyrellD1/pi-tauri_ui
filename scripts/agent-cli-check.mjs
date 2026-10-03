// End-to-end checks for cli/pi-agent.mjs against a fake `pi` (no model calls).
// Run: node scripts/agent-cli-check.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-check-"));
const home = path.join(root, "home");
const project = path.join(root, "project");
const sessions = path.join(root, "sessions");
const fakeLog = path.join(root, "fake.log");
fs.mkdirSync(project, { recursive: true });
const CLI = path.resolve("cli/pi-agent.mjs");
const env = { ...process.env, PI_AGENT_HOME: home, PI_BIN: path.resolve("scripts/fixtures/fake-pi.mjs"), FAKE_PI_LOG: fakeLog, FAKE_PI_SESSIONS: sessions, PI_AGENT_CALLER: "check" };
delete env.PI_AGENT_MAX_CONCURRENT;

function cli(args, { input, extraEnv } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd: project, env: { ...env, ...extraEnv } });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    if (input !== undefined) p.stdin.end(input); else p.stdin.end();
    p.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
function startCli(args) {
  const p = spawn(process.execPath, [CLI, ...args], { cwd: project, env });
  let stdout = "", stderr = "";
  p.stdout.on("data", (d) => (stdout += d));
  p.stderr.on("data", (d) => (stderr += d));
  p.stdin.end();
  const done = new Promise((r) => p.on("exit", (code) => r({ code, stdout, stderr })));
  return { p, done };
}
const fakeEvents = () => (fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(40); }
  throw new Error("timed out waiting");
}
const records = () => {
  try { return fs.readdirSync(path.join(home, "agents")).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(home, "agents", f), "utf8"))); } catch { return []; }
};

let count = 0;
async function check(name, fn) {
  await fn();
  console.log(`ok - ${name}`);
  count++;
}

try {
  await check("run prints the answer on stdout and records done", async () => {
    const r = await cli(["run", "--name", "smoke", "say hi"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), "ANSWER: say hi");
    const rec = records().find((x) => x.name === "smoke");
    assert.equal(rec.status, "done");
    assert.ok(rec.sessionFile && fs.existsSync(rec.sessionFile));
    assert.equal(rec.caller, "check");
    assert.equal(rec.cwd, fs.realpathSync(project));
  });

  await check("default model comes from models.json; flags reach pi", async () => {
    fs.rmSync(fakeLog, { force: true });
    await cli(["run", "x"]);
    let spawnEv = fakeEvents().find((e) => e.ev === "spawn");
    assert.deepEqual(spawnEv.args.slice(0, 4), ["--mode", "rpc", "--model", "opencode-go/muse-spark-1.3-contributor"]);
    fs.rmSync(fakeLog, { force: true });
    await cli(["run", "--model", "anthropic/claude-x", "--thinking", "high", "--name", "flags", "y"]);
    spawnEv = fakeEvents().find((e) => e.ev === "spawn");
    assert.ok(spawnEv.args.includes("anthropic/claude-x") && spawnEv.args.includes("high"));
    assert.ok(spawnEv.args.includes("[agent] flags"));
  });

  await check("task can come from stdin; --json output", async () => {
    const r = await cli(["run", "--json"], { input: "from stdin" });
    const j = JSON.parse(r.stdout);
    assert.equal(j.status, "done");
    assert.equal(j.result, "ANSWER: from stdin");
  });

  await check("model errors exit 1 with status failed", async () => {
    const r = await cli(["run", "please fail"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /failed — fake provider error/);
  });

  await check("models set / default / remove / reset", async () => {
    let r = await cli(["models", "set", "anthropic/claude-x", "--use", "Hard reasoning.", "--avoid", "Bulk edits.", "--default"]);
    assert.equal(r.code, 0, r.stderr);
    const m = JSON.parse((await cli(["models", "--json"])).stdout);
    assert.equal(m.default, "anthropic/claude-x");
    assert.equal(m.models.length, 2);
    r = await cli(["models", "set", "openai/new"]);
    assert.equal(r.code, 2, "new recommendation needs use + avoid");
    r = await cli(["models", "default", "nope/x"]);
    assert.equal(r.code, 2);
    fs.rmSync(fakeLog, { force: true });
    await cli(["run", "uses new default"]);
    assert.ok(fakeEvents().find((e) => e.ev === "spawn").args.includes("anthropic/claude-x"));
    await cli(["models", "remove", "anthropic/claude-x"]);
    assert.equal(JSON.parse((await cli(["models", "--json"])).stdout).default, "opencode-go/muse-spark-1.3-contributor");
    await cli(["models", "reset"]);
    assert.match((await cli(["guide"])).stdout, /muse-spark-1\.3-contributor` \(default\)/);
  });

  await check("queue never exceeds max-concurrent and drains", async () => {
    assert.equal((await cli(["config", "set", "max-concurrent", "2"])).code, 0);
    fs.rmSync(fakeLog, { force: true });
    const runs = await Promise.all([1, 2, 3, 4, 5].map((i) => cli(["run", "--name", `q${i}`, `job ${i} sleep:400`])));
    assert.ok(runs.every((r) => r.code === 0), runs.map((r) => r.stderr).join("\n"));
    let live = 0, peak = 0;
    for (const e of fakeEvents()) {
      if (e.ev === "start") peak = Math.max(peak, ++live);
      if (e.ev === "end") live--;
    }
    assert.equal(peak, 2, `peak concurrency ${peak}`);
    assert.ok(runs.some((r) => /waiting — #\d in queue/.test(r.stderr)), "someone waited in the queue");
    assert.equal(fs.readdirSync(path.join(home, "slots")).length, 0, "slots released");
    assert.equal(fs.readdirSync(path.join(home, "queue")).length, 0, "tickets released");
    // Burst: 10 agents racing for 3 slots with short runs (catches snapshot races).
    await cli(["config", "set", "max-concurrent", "3"]);
    fs.rmSync(fakeLog, { force: true });
    const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => cli(["run", "--quiet", `burst ${i} sleep:60`])));
    assert.ok(burst.every((r) => r.code === 0));
    live = 0; peak = 0;
    for (const e of fakeEvents()) {
      if (e.ev === "start") peak = Math.max(peak, ++live);
      if (e.ev === "end") live--;
    }
    assert.ok(peak <= 3, `burst peak ${peak}`);
    await cli(["config", "set", "max-concurrent", "12"]);
  });

  await check("--detach returns an id; wait prints the answer", async () => {
    const d = await cli(["run", "--detach", "--name", "bg", "detached work sleep:200"]);
    const id = d.stdout.trim();
    assert.match(id, /^ag-\d{8}-\d{6}-\w{4}$/);
    const w = await cli(["wait", id]);
    assert.equal(w.code, 0, w.stderr);
    assert.equal(w.stdout.trim(), "ANSWER: detached work sleep:200");
    assert.equal((await cli(["result", id])).stdout.trim(), "ANSWER: detached work sleep:200");
  });

  await check("cancel stops a running agent (exit 130, status cancelled)", async () => {
    const run = startCli(["run", "--name", "long", "long job sleep:20000"]);
    const rec = await until(() => records().find((x) => x.name === "long" && x.status === "running"));
    const c = await cli(["cancel", rec.id]);
    assert.equal(c.code, 0);
    const r = await run.done;
    assert.equal(r.code, 130);
    assert.equal(records().find((x) => x.id === rec.id).status, "cancelled");
  });

  await check("cancel while queued releases the ticket", async () => {
    await cli(["config", "set", "max-concurrent", "1"]);
    const hold = startCli(["run", "--name", "holder", "hold sleep:3000"]);
    await until(() => records().find((x) => x.name === "holder" && x.status === "running"));
    const waiter = startCli(["run", "--name", "waiter", "waits"]);
    const rec = await until(() => records().find((x) => x.name === "waiter" && x.queuePosition === 1));
    await cli(["cancel", rec.id]);
    assert.equal((await waiter.done).code, 130);
    assert.equal(records().find((x) => x.id === rec.id).status, "cancelled");
    await hold.done;
    assert.equal(fs.readdirSync(path.join(home, "queue")).length, 0);
    await cli(["config", "set", "max-concurrent", "12"]);
  });

  await check("headless: extension dialogs are dismissed, never block", async () => {
    const r = await cli(["run", "needs dialog"]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), "DIALOG: cancelled");
    assert.match(r.stderr, /dismissed/);
  });

  await check("app socket: updates + tagged events stream in, dialogs never forwarded, abort from the app", async () => {
    const sockPath = path.join(home, "ui.sock");
    const got = [];
    let conn = null;
    const server = net.createServer((s) => {
      conn = s;
      let buf = "";
      s.setEncoding("utf8");
      s.on("data", (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const m = JSON.parse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          got.push(m);
          if (m.type === "event" && m.event.type === "extension_ui_request") s.write(JSON.stringify({ type: "ui_response", id: m.event.id, payload: { confirmed: true } }) + "\n");
        }
      });
    });
    await new Promise((r) => server.listen(sockPath, r));
    const r = await cli(["run", "--name", "live", "dialog via app"]);
    assert.equal(r.stdout.trim(), "DIALOG: cancelled", r.stderr);
    assert.ok(!got.some((m) => m.type === "event" && m.event.type === "extension_ui_request"), "dialogs stay inside the runner");
    const statuses = got.filter((m) => m.type === "agent_update").map((m) => m.agent.status);
    assert.ok(statuses.includes("running") && statuses.at(-1) === "done", statuses.join(","));
    const evs = got.filter((m) => m.type === "event").map((m) => m.event);
    assert.ok(evs.some((e) => e.type === "agent_settled"));
    assert.ok(evs.every((e) => e.cwd === fs.realpathSync(project) && typeof e.session === "string"), "events tagged with cwd + session");
    // abort from the app
    got.length = 0;
    const run = startCli(["run", "--name", "app-stop", "stop me sleep:20000"]);
    await until(() => got.some((m) => m.type === "agent_update" && m.agent.status === "running"));
    conn.write(JSON.stringify({ type: "abort" }) + "\n");
    assert.equal((await run.done).code, 130);
    await new Promise((r) => server.close(r));
    fs.rmSync(sockPath, { force: true });
  });

  await check("list / status behave; ids and missing tasks are usage errors", async () => {
    const l = await cli(["list"]);
    assert.match(l.stdout, /running · \d+ queued · max 12/);
    const j = JSON.parse((await cli(["list", "--json", "--all"])).stdout);
    assert.ok(j.length >= 10 && j.every((x) => x.id && x.status));
    assert.equal((await cli(["status", "../etc"])).code, 2);
    assert.equal((await cli(["run"])).code, 2, "missing task is a usage error");
  });

  console.log(`${count} pi-agent CLI checks passed.`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
