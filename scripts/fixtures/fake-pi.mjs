// A tiny stand-in for `pi --mode rpc`, used by scripts/agent-cli-check.mjs.
// Speaks the JSONL protocol the real CLI does (get_state, prompt →
// agent_start … agent_settled, get_last_assistant_text, get_messages,
// abort, extension UI). Behavior is steered by the prompt text:
//   sleep:<ms>   hold the run open for <ms>
//   dialog       ask a confirm and report the answer
//   fail         end with a model error
// Every spawn and run start/end is appended to $FAKE_PI_LOG as JSON lines.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const log = (o) => { if (process.env.FAKE_PI_LOG) fs.appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify({ t: Date.now(), pid: process.pid, ...o }) + "\n"); };
log({ ev: "spawn", args, cwd: process.cwd() });

const [provider, ...rest] = (flag("--model") ?? "fake/default").split("/");
const model = { provider, id: rest.join("/") };
const sessionDir = process.env.FAKE_PI_SESSIONS ?? "/tmp";
const sessionFile = path.join(sessionDir, `fake-${process.pid}-${Date.now()}.jsonl`);
fs.mkdirSync(sessionDir, { recursive: true });
fs.writeFileSync(sessionFile, JSON.stringify({ type: "session", cwd: process.cwd() }) + "\n");
const messages = [];
let running = null, dialogWait = null;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const respond = (cmd, data, extra = {}) => out({ id: cmd.id, type: "response", command: cmd.type, success: true, ...(data === undefined ? {} : { data }), ...extra });

async function run(text) {
  out({ type: "agent_start" });
  log({ ev: "start", text });
  const user = { role: "user", content: text };
  messages.push(user);
  out({ type: "message_start", message: user });
  out({ type: "message_end", message: user });
  let reply = `ANSWER: ${text}`, stopReason = "stop", errorMessage;
  out({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "README.md" } });
  out({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: { content: [{ type: "text", text: "ok" }] }, isError: false });
  const ms = Number(/sleep:(\d+)/.exec(text)?.[1] ?? 0);
  if (ms) await new Promise((r) => { running = { stop: r }; setTimeout(r, ms); });
  if (running?.aborted) { reply = "partial"; stopReason = "aborted"; }
  if (/dialog/.test(text) && !running?.aborted) {
    out({ type: "extension_ui_request", id: "dlg-1", method: "confirm", title: "Allow the thing?", message: "fake permission" });
    const ans = await new Promise((r) => { dialogWait = r; });
    reply = `DIALOG: ${ans.cancelled ? "cancelled" : ans.confirmed ? "confirmed" : "denied"}`;
  }
  if (/fail/.test(text)) { reply = ""; stopReason = "error"; errorMessage = "fake provider error"; }
  const asst = { role: "assistant", content: reply ? [{ type: "text", text: reply }] : [], stopReason, ...(errorMessage ? { errorMessage } : {}) };
  messages.push(asst);
  fs.appendFileSync(sessionFile, JSON.stringify({ type: "message", message: asst }) + "\n");
  out({ type: "message_start", message: asst });
  out({ type: "message_end", message: asst });
  out({ type: "agent_end", messages: [asst], willRetry: false });
  log({ ev: "end", text, stopReason });
  running = null;
  out({ type: "agent_settled" });
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const cmd = JSON.parse(line);
    switch (cmd.type) {
      case "get_state":
        respond(cmd, { model, thinkingLevel: flag("--thinking") ?? "medium", isStreaming: !!running, sessionFile, sessionId: "fake", sessionName: flag("--name"), messageCount: messages.length });
        break;
      case "prompt":
        respond(cmd, { disposition: "started" });
        void run(cmd.message);
        break;
      case "abort":
        respond(cmd);
        if (running) { running.aborted = true; running.stop(); }
        if (dialogWait) { const w = dialogWait; dialogWait = null; w({ cancelled: true }); }
        break;
      case "extension_ui_response":
        log({ ev: "ui_response", payload: cmd });
        if (dialogWait) { const w = dialogWait; dialogWait = null; w(cmd); }
        break;
      case "get_last_assistant_text": {
        const last = [...messages].reverse().find((m) => m.role === "assistant");
        const t = last?.content?.find?.((c) => c.type === "text")?.text ?? null;
        respond(cmd, { text: t });
        break;
      }
      case "get_messages":
        respond(cmd, { messages });
        break;
      default:
        respond(cmd, {});
    }
  }
});
process.stdin.on("end", () => process.exit(0));
