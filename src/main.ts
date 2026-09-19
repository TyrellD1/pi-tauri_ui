import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ---------- types ----------
type MsgContent =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown };

interface AgentMessage {
  role: string;
  content?: string | MsgContent[];
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  command?: string;
  output?: string;
  exitCode?: number;
  [k: string]: unknown;
}

interface SessionInfo {
  path: string;
  id: string;
  name: string | null;
  preview: string;
  mtime: number;
  messageCount: number;
}

interface PiEvent {
  type: string;
  [k: string]: unknown;
}

// ---------- dom ----------
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const chatListEl = $("chat-list");
const messagesEl = $("messages");
const inputEl = $("input") as HTMLTextAreaElement;
const sendBtn = $("btn-send") as HTMLButtonElement;
const statusLine = $("status-line");
const tokenLine = $("token-line");
const chatTitle = $("chat-title");
const chatMeta = $("chat-meta");
const cwdLabel = $("cwd-label");
const connDot = $("conn-dot");
const connText = $("conn-text");
const searchEl = $("search") as HTMLInputElement;
const dialogSlot = $("dialog-slot");
const noticesEl = $("notices");
const modelSelect = $("model-select") as HTMLSelectElement;
const thinkingSelect = $("thinking-select") as HTMLSelectElement;
const queueBar = $("queue-bar");
const modalRoot = $("modal-root");

// ---------- state ----------
let cwd = "";
let sessions: SessionInfo[] = [];
let activePath: string | null = null;
let messages: AgentMessage[] = [];
let streaming = false;
let streamBuf = { text: "", thinking: "", toolArgs: new Map<string, string>(), toolMeta: new Map<string, string>() };
let pendingUi: PiEvent | null = null;
let filter = "";
let debounceT: number | null = null;
let stickToBottom = true;

messagesEl.addEventListener("scroll", () => {
  const gap = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
  stickToBottom = gap < 80;
});

function scrollBottom(force = false) {
  if (stickToBottom || force) {
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }
}

// ---------- tiny markdown ----------
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderMarkdown(src: string): string {
  // code fences first
  const fences: string[] = [];
  let out = esc(src);
  out = out.replace(/```(\w*)\n([\s\S]*?)(```|$)/g, (_m, lang, code) => {
    const i = fences.length;
    fences.push(
      `<pre><code data-lang="${esc(lang || "text")}">${code.replace(/\n$/, "")}</code></pre>`
    );
    return `\u0000FENCE${i}\u0000`;
  });
  // headings
  out = out.replace(/^### (.*)$/gm, "<h3>$1</h3>").replace(/^## (.*)$/gm, "<h2>$1</h2>").replace(/^# (.*)$/gm, "<h1>$1</h1>");
  // bold / italic / inline code / links
  out = out
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\W)\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  // lists (simple)
  out = out.replace(/^(?:- |\* )(.*)$/gm, "<li>$1</li>");
  out = out.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
  // paragraphs: double newline
  out = out
    .split(/\n{2,}/)
    .map((b) => {
      const t = b.trim();
      if (!t) return "";
      if (/^<(h\d|pre|ul|blockquote)/.test(t)) return t;
      return `<p>${t.replace(/\n/g, "<br/>")}</p>`;
    })
    .join("");
  out = out.replace(/\u0000FENCE(\d+)\u0000/g, (_m, i) => fences[Number(i)] ?? "");
  return out;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function msgText(m: AgentMessage): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("\n");
  }
  if (m.role === "bashExecution") return `${m.command ?? ""}\n${m.output ?? ""}`;
  if (m.role === "toolResult") {
    const c = m.content as MsgContent[] | undefined;
    if (Array.isArray(c)) return c.map((x) => ("text" in x ? (x as { text: string }).text : "")).join("\n");
    return "";
  }
  return "";
}

// ---------- sidebar ----------
function renderSessions() {
  const q = filter.toLowerCase();
  const list = sessions.filter(
    (s) => !q || (s.name ?? "").toLowerCase().includes(q) || s.preview.toLowerCase().includes(q)
  );
  chatListEl.innerHTML = "";
  if (list.length === 0) {
    const d = document.createElement("div");
    d.style.cssText = "padding:16px 10px;font-size:12px;color:#a3a3a3;";
    d.textContent = filter ? "No matches." : "No chats yet. Start one below.";
    chatListEl.appendChild(d);
    return;
  }
  for (const s of list) {
    const el = document.createElement("div");
    el.className = "chat-item" + (s.path === activePath ? " active" : "");
    el.innerHTML = `<div class="ci-row"><div class="ci-title">${esc(
      s.name || s.preview.slice(0, 42) || "Untitled"
    )}</div><div class="ci-time">${fmtTime(s.mtime)}</div></div>
    <div class="ci-sub">${esc(s.preview.slice(0, 80))}</div>`;
    el.onclick = () => switchSession(s.path);
    chatListEl.appendChild(el);
  }
}

// ---------- messages ----------
function toolCardHtml(id: string, name: string, args: unknown, running: boolean): string {
  const argStr = typeof args === "string" ? args : JSON.stringify(args ?? {}, null, 1);
  const short = argStr.length > 140 ? argStr.slice(0, 140) + "…" : argStr;
  return `<div class="tool-card" data-tool="${esc(id)}">
    <div class="tool-head"><span class="t-dot ${running ? "run" : "done"}"></span><span>${esc(name)}</span><span style="color:#a3a3a3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(short)}</span></div>
    <div class="tool-body">${esc(argStr)}</div>
  </div>`;
}

function renderMessages() {
  messagesEl.innerHTML = "";
  if (messages.length === 0) {
    messagesEl.innerHTML = `<div style="max-width:560px;margin:60px auto;text-align:center;color:#a3a3a3;">
      <div style="font-size:28px;color:#171717;font-weight:700;">π</div>
      <div style="font-weight:650;color:#525252;margin-top:8px;">Same pi, quieter room.</div>
      <div style="font-size:12.5px;margin-top:6px;">Full RPC harness — tools, sessions, models. Grayscale by design.<br/>Try “list files in this directory” or “explain this repo”.</div>
      <div style="display:flex;gap:8px;justify-content:center;margin-top:16px;">
        <button class="pill-btn" data-hint="List the files in this directory and summarize the project">summarize project</button>
        <button class="pill-btn" data-hint="What tools and models are available?">capabilities</button>
        <button class="pill-btn" data-hint="/help">slash commands</button>
      </div></div>`;
    messagesEl.querySelectorAll("[data-hint]").forEach((b) => {
      (b as HTMLButtonElement).onclick = () => {
        inputEl.value = (b as HTMLElement).dataset.hint ?? "";
        autosize();
        inputEl.focus();
      };
    });
    return;
  }
  for (const m of messages) {
    messagesEl.appendChild(messageNode(m));
  }
  // live streaming node
  if (streaming && (streamBuf.text || streamBuf.thinking || streamBuf.toolMeta.size > 0)) {
    messagesEl.appendChild(streamingNode());
  }
  scrollBottom();
}

function messageNode(m: AgentMessage): HTMLElement {
  const wrap = document.createElement("div");
  const isUser = m.role === "user" || m.role === "bashExecution";
  wrap.className = `msg ${isUser ? "user" : "assistant"}`;
  const avatar = m.role === "user" ? "Y" : m.role === "bashExecution" ? "$" : "π";
  const label = m.role === "user" ? "You" : m.role === "bashExecution" ? "Shell" : m.role === "toolResult" ? `Tool · ${String(m.toolName ?? "")}` : "pi";
  let inner = "";
  const text = msgText(m);
  if (text) inner += `<div class="md">${renderMarkdown(text.slice(0, 12000))}</div>`;
  if (Array.isArray(m.content)) {
    const thoughts = (m.content as MsgContent[]).filter((c) => c.type === "thinking" && (c as { thinking: string }).thinking);
    if (thoughts.length > 0) {
      const t = (thoughts[0] as { thinking: string }).thinking;
      inner += `<button class="think-toggle">thoughts (${t.length} chars) ▸</button><div class="think-body">${esc(t.slice(0, 4000))}</div>`;
    }
    const calls = (m.content as MsgContent[]).filter((c) => c.type === "toolCall");
    for (const c of calls) {
      const tc = c as { id: string; name: string; arguments: unknown };
      inner += toolCardHtml(tc.id, tc.name, tc.arguments, false);
    }
  }
  if (m.role === "toolResult") {
    inner += `<div class="tool-card open"><div class="tool-head"><span class="t-dot done"></span><span>${esc(String(m.toolName ?? "tool"))}</span></div><div class="tool-body">${esc(text.slice(0, 4000))}</div></div>`;
  }
  wrap.innerHTML = `<div class="msg-row"><div class="avatar">${avatar}</div><div class="bubble"><div class="role-label">${esc(label)}</div>${inner}<div class="msg-actions"><button class="mini-btn" data-copy>copy</button></div></div></div>`;
  (wrap.querySelector("[data-copy]") as HTMLButtonElement).onclick = (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).catch(() => {});
    (e.target as HTMLButtonElement).textContent = "copied";
    setTimeout(() => ((e.target as HTMLButtonElement).textContent = "copy"), 1200);
  };
  wrap.querySelectorAll(".tool-head").forEach((h) => {
    (h as HTMLElement).onclick = () => (h.parentElement as HTMLElement).classList.toggle("open");
  });
  const tt = wrap.querySelector(".think-toggle");
  if (tt) tt.addEventListener("click", () => wrap.querySelector(".think-body")?.classList.toggle("open"));
  return wrap;
}

function streamingNode(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "msg assistant streaming";
  let inner = "";
  if (streamBuf.thinking) {
    inner += `<button class="think-toggle">thinking… ▸</button><div class="think-body">${esc(streamBuf.thinking.slice(-2000))}</div>`;
  }
  if (streamBuf.text) inner += `<div class="md">${renderMarkdown(streamBuf.text.slice(0, 12000))}<span class="caret"></span></div>`;
  for (const [id, name] of streamBuf.toolMeta) {
    const args = streamBuf.toolArgs.get(id) ?? "";
    inner += toolCardHtml(id, name, args, true);
  }
  wrap.innerHTML = `<div class="msg-row"><div class="avatar">π</div><div class="bubble"><div class="role-label">pi · streaming</div>${inner}</div></div>`;
  wrap.querySelectorAll(".tool-head").forEach((h) => {
    (h as HTMLElement).onclick = () => (h.parentElement as HTMLElement).classList.toggle("open");
  });
  const tt = wrap.querySelector(".think-toggle");
  if (tt) tt.addEventListener("click", () => wrap.querySelector(".think-body")?.classList.toggle("open"));
  return wrap;
}

function refreshStreaming() {
  // cheap path: re-render only if streaming; rAF-throttled by caller
  if (!streaming) return;
  renderMessages();
}

let rafQueued = false;
function queueRefresh() {
  if (rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    refreshStreaming();
  });
}

// ---------- backend calls ----------
async function refreshState() {
  try {
    const st = (await invoke("pi_get_state")) as Record<string, unknown>;
    cwd = String(st.cwd ?? cwd);
    cwdLabel.textContent = cwd.split("/").slice(-2).join("/");
    cwdLabel.title = cwd;
    const sf = (st.sessionFile as string) ?? null;
    if (sf && sf !== activePath) {
      activePath = sf;
      renderSessions();
    }
    const name = (st.sessionName as string) ?? "";
    chatTitle.textContent = name || deriveTitle() || "New chat";
    chatMeta.textContent = `${String((st.model as { id?: string } | null)?.id ?? "model")} · ${Number(st.messageCount ?? 0)} msgs`;
    if (st.isStreaming) setBusy(true);
  } catch {
    /* offline */
  }
}

function deriveTitle(): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "";
  return msgText(firstUser).slice(0, 48);
}

async function refreshMessages() {
  try {
    const res = (await invoke("pi_get_messages")) as { messages: AgentMessage[] };
    messages = res.messages ?? [];
    renderMessages();
    await refreshState();
  } catch (e) {
    notice(`get_messages failed: ${String(e)}`);
  }
}

async function refreshSessions() {
  try {
    const res = (await invoke("pi_list_sessions")) as { sessions: SessionInfo[]; active: string | null };
    sessions = res.sessions ?? [];
    if (res.active) activePath = res.active;
    renderSessions();
  } catch {
    /* ignore */
  }
}

async function refreshModels() {
  try {
    const res = (await invoke("pi_get_models")) as { models: { id: string; provider: string }[]; current: string | null };
    modelSelect.innerHTML = "";
    for (const m of res.models ?? []) {
      const o = document.createElement("option");
      o.value = `${m.provider}/${m.id}`;
      o.textContent = `${m.provider}/${m.id}`;
      if (res.current && o.value === res.current) o.selected = true;
      modelSelect.appendChild(o);
    }
    if (modelSelect.options.length === 0) {
      const o = document.createElement("option");
      o.textContent = "default model";
      modelSelect.appendChild(o);
    }
  } catch {
    /* ignore */
  }
}

async function doSend() {
  const text = inputEl.value.trim();
  if (!text) return;
  if (streaming) {
    // steer while running
    try {
      await invoke("pi_steer", { message: text });
      inputEl.value = "";
      autosize();
      notice("Steered the running turn.");
    } catch (e) {
      notice(`steer failed: ${String(e)}`);
    }
    return;
  }
  // optimistic user bubble
  messages = [...messages, { role: "user", content: text, timestamp: Date.now() }];
  renderMessages();
  inputEl.value = "";
  autosize();
  setBusy(true);
  try {
    const r = (await invoke("pi_prompt", { message: text })) as { accepted: boolean; error?: string };
    if (!r.accepted) {
      setBusy(false);
      notice(`prompt rejected: ${r.error ?? "unknown"}`);
    }
  } catch (e) {
    setBusy(false);
    notice(`prompt failed: ${String(e)}`);
  }
}

async function doAbort() {
  try {
    await invoke("pi_abort");
  } catch (e) {
    notice(`abort failed: ${String(e)}`);
  }
}

async function newChat() {
  try {
    await invoke("pi_new_session");
    messages = [];
    streamBuf = { text: "", thinking: "", toolArgs: new Map(), toolMeta: new Map() };
    setBusy(false);
    renderMessages();
    await Promise.all([refreshMessages(), refreshSessions(), refreshState()]);
    inputEl.focus();
  } catch (e) {
    notice(`new session failed: ${String(e)}`);
  }
}

async function switchSession(path: string) {
  if (path === activePath) return;
  try {
    await invoke("pi_switch_session", { path });
    activePath = path;
    streamBuf = { text: "", thinking: "", toolArgs: new Map(), toolMeta: new Map() };
    setBusy(false);
    renderSessions();
    await refreshMessages();
  } catch (e) {
    notice(`switch failed: ${String(e)}`);
  }
}

function setBusy(b: boolean) {
  streaming = b;
  sendBtn.textContent = b ? "■" : "↑";
  sendBtn.classList.toggle("stop", b);
  sendBtn.title = b ? "Stop (Esc)" : "Send (Enter)";
  connDot.className = "conn " + (b ? "busy" : "ok");
  connText.textContent = b ? "working…" : "connected";
  statusLine.textContent = b ? "working — Esc to stop" : "idle";
  if (!b) renderMessages();
}

function notice(text: string) {
  const el = document.createElement("div");
  el.className = "notice";
  el.innerHTML = `<span>${esc(text)}</span>`;
  const x = document.createElement("button");
  x.textContent = "✕";
  x.onclick = () => el.remove();
  el.appendChild(x);
  noticesEl.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

// ---------- extension UI dialogs ----------
function showExtensionDialog(req: PiEvent) {
  pendingUi = req;
  const method = String(req.method ?? "");
  dialogSlot.innerHTML = "";
  const card = document.createElement("div");
  card.className = "dialog-card";
  const title = String(req.title ?? method);

  if (method === "select") {
    const opts = (req.options as string[]) ?? [];
    card.innerHTML = `<div class="dialog-title">${esc(title)}</div><div class="dialog-opts"></div>`;
    const wrap = card.querySelector(".dialog-opts") as HTMLElement;
    for (const o of opts) {
      const b = document.createElement("button");
      b.textContent = o;
      b.onclick = () => respondUi({ value: o });
      wrap.appendChild(b);
    }
    const cancel = document.createElement("button");
    cancel.textContent = "cancel";
    cancel.style.marginTop = "8px";
    cancel.onclick = () => respondUi({ cancelled: true });
    card.appendChild(cancel);
  } else if (method === "confirm") {
    const msg = String(req.message ?? "");
    card.innerHTML = `<div class="dialog-title">${esc(title)}</div><div style="font-size:12.5px;color:#525252;margin-bottom:10px;">${esc(msg)}</div><div class="dialog-actions"><button data-x>cancel</button><button data-no>No</button><button data-yes class="primary">Yes</button></div>`;
    (card.querySelector("[data-yes]") as HTMLButtonElement).onclick = () => respondUi({ confirmed: true });
    (card.querySelector("[data-no]") as HTMLButtonElement).onclick = () => respondUi({ confirmed: false });
    (card.querySelector("[data-x]") as HTMLButtonElement).onclick = () => respondUi({ cancelled: true });
  } else if (method === "input" || method === "editor") {
    const pre = String(req.prefill ?? req.placeholder ?? "");
    card.innerHTML = `<div class="dialog-title">${esc(title)}</div><${method === "editor" ? 'textarea rows="4"' : "input"} class="dialog-input" placeholder="${esc(String(req.placeholder ?? ""))}">${esc(pre)}</${method === "editor" ? "textarea" : "input"}><div class="dialog-actions"><button data-x>cancel</button><button data-ok class="primary">submit</button></div>`;
    const inp = card.querySelector(".dialog-input") as HTMLInputElement;
    (card.querySelector("[data-ok]") as HTMLButtonElement).onclick = () => respondUi({ value: inp.value });
    (card.querySelector("[data-x]") as HTMLButtonElement).onclick = () => respondUi({ cancelled: true });
    setTimeout(() => inp.focus(), 30);
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && method === "input") respondUi({ value: inp.value });
      if (e.key === "Escape") respondUi({ cancelled: true });
    });
  } else if (method === "notify") {
    notice(String(req.message ?? "notification"));
    pendingUi = null;
    return;
  } else {
    // setStatus / setWidget / setTitle / set_editor_text → status line
    const txt =
      (req.statusText as string) ??
      ((req.widgetLines as string[]) ?? []).join(" ") ??
      (req.message as string) ??
      "";
    if (txt) statusLine.textContent = txt.slice(0, 120);
    if (req.text) {
      inputEl.value = String(req.text);
      autosize();
    }
    pendingUi = null;
    return;
  }
  dialogSlot.appendChild(card);
}

async function respondUi(payload: Record<string, unknown>) {
  if (!pendingUi) return;
  const id = String(pendingUi.id);
  pendingUi = null;
  dialogSlot.innerHTML = "";
  try {
    await invoke("pi_ui_response", { id, payload });
  } catch (e) {
    notice(`dialog response failed: ${String(e)}`);
  }
}

// ---------- events ----------
async function initEvents() {
  await listen<PiEvent>("pi-event", (ev) => {
    const p = ev.payload as PiEvent;
    const t = String(p.type ?? "");
    if (t === "agent_start" || t === "turn_start" || t === "message_start") {
      if (!streaming) {
        streamBuf = { text: "", thinking: "", toolArgs: new Map(), toolMeta: new Map() };
        setBusy(true);
      }
    } else if (t === "message_update") {
      const d = p.assistantMessageEvent as Record<string, unknown> | undefined;
      if (!d) return;
      const kind = String(d.type ?? "");
      if (kind === "text_delta") streamBuf.text += String(d.delta ?? "");
      else if (kind === "thinking_delta") streamBuf.thinking += String(d.delta ?? "");
      else if (kind === "toolcall_start") {
        const id = String(d.id ?? "");
        streamBuf.toolMeta.set(id, String(d.toolName ?? "tool"));
        streamBuf.toolArgs.set(id, "");
      } else if (kind === "toolcall_delta") {
        // delta shape varies; best-effort append
        const id = String((d as { id?: string }).id ?? "");
        const key = id || [...streamBuf.toolMeta.keys()].pop() || "";
        if (key) streamBuf.toolArgs.set(key, (streamBuf.toolArgs.get(key) ?? "") + String((d as { delta?: string }).delta ?? ""));
      }
      queueRefresh();
      scrollBottom();
    } else if (t === "tool_execution_start") {
      statusLine.textContent = `running ${String(p.toolName ?? "tool")}…`;
    } else if (t === "tool_execution_update") {
      queueRefresh();
    } else if (t === "tool_execution_end") {
      statusLine.textContent = streaming ? "working…" : "idle";
    } else if (t === "queue_update") {
      const s = ((p.steering as string[]) ?? []).length;
      const f = ((p.followUp as string[]) ?? []).length;
      if (s + f > 0) {
        queueBar.classList.remove("hidden");
        queueBar.textContent = `queued: ${s} steering · ${f} follow-up — Esc clears, agent continues after`;
      } else queueBar.classList.add("hidden");
    } else if (t === "agent_settled" || t === "agent_end") {
      if (t === "agent_settled") {
        setBusy(false);
        refreshMessages().then(() => refreshSessions());
        refreshStats();
      }
    } else if (t === "extension_ui_request") {
      showExtensionDialog(p);
    } else if (t === "response" && p.success === false) {
      notice(`pi error: ${String(p.error ?? p.command ?? "unknown")}`);
    }
  });
}

async function refreshStats() {
  try {
    const s = (await invoke("pi_get_stats")) as {
      tokens?: { input: number; output: number; total: number };
      cost?: number;
      contextUsage?: { percent: number | null; tokens: number | null };
    };
    const parts: string[] = [];
    if (s.tokens) parts.push(`${((s.tokens.total ?? 0) / 1000).toFixed(1)}k tok`);
    if (typeof s.cost === "number") parts.push(`$${s.cost.toFixed(4)}`);
    if (s.contextUsage?.percent != null) parts.push(`${s.contextUsage.percent}% ctx`);
    tokenLine.textContent = parts.join(" · ");
  } catch {
    /* ignore */
  }
}

// ---------- input ----------
function autosize() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
}
inputEl.addEventListener("input", autosize);

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (streaming) doAbort();
    else doSend();
  } else if (e.key === "Escape" && streaming) {
    e.preventDefault();
    doAbort();
  }
});
sendBtn.onclick = () => (streaming ? doAbort() : doSend());

// ---------- theme: one sun/moon button, system-following until manual override ----------
const themeBtn = $("btn-theme") as HTMLButtonElement;
function applyThemeLabel() {
  const dark = document.documentElement.dataset.theme === "dark";
  const label = dark ? "Switch to light theme" : "Switch to dark theme";
  themeBtn.setAttribute("aria-label", label);
  themeBtn.title = label;
}
function setTheme(theme: "light" | "dark", persist: boolean) {
  document.documentElement.dataset.theme = theme;
  if (persist) {
    document.documentElement.dataset.themePreference = theme;
    try {
      localStorage.setItem("pi-theme", theme);
    } catch {
      /* storage unavailable — session-only */
    }
  }
  applyThemeLabel();
}
themeBtn.onclick = () => {
  setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark", true);
};
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
  if (document.documentElement.dataset.themePreference === "system") {
    setTheme(e.matches ? "dark" : "light", false);
  }
});
applyThemeLabel();

($("btn-new") as HTMLButtonElement).onclick = newChat;
($("btn-cwd") as HTMLButtonElement).onclick = () => openSettings();
($("btn-settings") as HTMLButtonElement).onclick = () => openSettings();
($("btn-stats") as HTMLButtonElement).onclick = async () => {
  await refreshStats();
  openStats();
};
($("btn-compact") as HTMLButtonElement).onclick = async () => {
  try {
    statusLine.textContent = "compacting…";
    await invoke("pi_compact");
    await refreshMessages();
    notice("Context compacted.");
  } catch (e) {
    notice(`compact failed: ${String(e)}`);
  } finally {
    statusLine.textContent = streaming ? "working…" : "idle";
  }
};
($("btn-export") as HTMLButtonElement).onclick = async () => {
  try {
    const r = (await invoke("pi_export")) as { path: string };
    notice(`Exported to ${r.path}`);
  } catch (e) {
    notice(`export failed: ${String(e)}`);
  }
};

modelSelect.onchange = async () => {
  const [provider, ...rest] = modelSelect.value.split("/");
  const modelId = rest.join("/");
  try {
    await invoke("pi_set_model", { provider, modelId });
    notice(`Model → ${modelSelect.value}`);
    refreshState();
  } catch (e) {
    notice(`set model failed: ${String(e)}`);
  }
};
thinkingSelect.onchange = async () => {
  try {
    await invoke("pi_set_thinking", { level: thinkingSelect.value });
  } catch (e) {
    notice(`thinking level failed: ${String(e)}`);
  }
};

searchEl.addEventListener("input", () => {
  if (debounceT) window.clearTimeout(debounceT);
  debounceT = window.setTimeout(() => {
    filter = searchEl.value;
    renderSessions();
  }, 150);
});

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
    e.preventDefault();
    newChat();
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    searchEl.focus();
    searchEl.select();
  }
  if ((e.metaKey || e.ctrlKey) && e.key === ",") {
    e.preventDefault();
    openSettings();
  }
  if (e.key === "Escape" && streaming && document.activeElement !== inputEl) doAbort();
});

// ---------- modals ----------
function openSettings() {
  modalRoot.innerHTML = "";
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `<div class="modal"><h3>Settings</h3><p class="muted">RPC harness spawns from this directory. Switching restarts pi.</p>
    <label>Working directory</label><input id="m-cwd" value="${esc(cwd)}" />
    <label>Session name</label><input id="m-name" placeholder="e.g. refactor-auth" />
    <div class="dialog-actions"><button data-close>close</button><button data-save class="primary">save</button></div></div>`;
  modalRoot.appendChild(back);
  back.addEventListener("click", (e) => {
    if (e.target === back) modalRoot.innerHTML = "";
  });
  (back.querySelector("[data-close]") as HTMLButtonElement).onclick = () => (modalRoot.innerHTML = "");
  (back.querySelector("[data-save]") as HTMLButtonElement).onclick = async () => {
    const ncwd = (back.querySelector("#m-cwd") as HTMLInputElement).value.trim();
    const nname = (back.querySelector("#m-name") as HTMLInputElement).value.trim();
    try {
      if (ncwd && ncwd !== cwd) {
        await invoke("pi_set_cwd", { cwd: ncwd });
        cwd = ncwd;
      }
      if (nname) await invoke("pi_set_name", { name: nname });
      modalRoot.innerHTML = "";
      await Promise.all([refreshMessages(), refreshSessions(), refreshState()]);
    } catch (e) {
      notice(`save failed: ${String(e)}`);
    }
  };
}

async function openStats() {
  try {
    const s = (await invoke("pi_get_stats")) as Record<string, unknown>;
    modalRoot.innerHTML = "";
    const back = document.createElement("div");
    back.className = "modal-back";
    const t = s.tokens as Record<string, number> | undefined;
    back.innerHTML = `<div class="modal"><h3>Session stats</h3><p class="muted">${esc(String((s as { sessionId?: string }).sessionId ?? ""))}</p>
      <div class="stat-grid">
        <div class="stat-cell"><div class="k">input</div><div class="v">${t?.input ?? "—"}</div></div>
        <div class="stat-cell"><div class="k">output</div><div class="v">${t?.output ?? "—"}</div></div>
        <div class="stat-cell"><div class="k">total</div><div class="v">${t?.total ?? "—"}</div></div>
        <div class="stat-cell"><div class="k">cost</div><div class="v">$${Number((s as { cost?: number }).cost ?? 0).toFixed(4)}</div></div>
        <div class="stat-cell"><div class="k">user msgs</div><div class="v">${String((s as { userMessages?: number }).userMessages ?? "—")}</div></div>
        <div class="stat-cell"><div class="k">tool calls</div><div class="v">${String((s as { toolCalls?: number }).toolCalls ?? "—")}</div></div>
      </div>
      <div class="dialog-actions"><button data-close class="primary">done</button></div></div>`;
    modalRoot.appendChild(back);
    back.addEventListener("click", (e) => {
      if (e.target === back) modalRoot.innerHTML = "";
    });
    (back.querySelector("[data-close]") as HTMLButtonElement).onclick = () => (modalRoot.innerHTML = "");
  } catch (e) {
    notice(`stats failed: ${String(e)}`);
  }
}

// ---------- boot ----------
async function boot() {
  connText.textContent = "starting…";
  await initEvents();
  try {
    const r = (await invoke("pi_spawn", { cwd: null })) as { cwd: string; ok: boolean };
    cwd = r.cwd;
    cwdLabel.textContent = cwd.split("/").slice(-2).join("/");
    cwdLabel.title = cwd;
    connDot.className = "conn ok";
    connText.textContent = "connected";
  } catch (e) {
    connText.textContent = "failed to start pi";
    notice(`Could not spawn pi --mode rpc: ${String(e)}. Is pi on PATH?`);
    return;
  }
  await Promise.all([refreshSessions(), refreshMessages(), refreshModels(), refreshStats(), refreshState()]);
  autosize();
  inputEl.focus();
}

boot();
