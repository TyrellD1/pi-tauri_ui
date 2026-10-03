import { Conversation, type Message, textOf } from "./conversation";
import { invoke, listen } from "./tauri-shim";
import { createPicker, type PickerItem } from "./picker";
import { open as openFolderPicker } from "@tauri-apps/plugin-dialog";
import {
  activityLabel,
  canSend,
  envelopeError,
  fmtRelative,
  queueSummary,
  renderMarkdown,
  toolSummary,
  truncateOutput,
} from "./logic";

// ---------- types ----------
type AgentMessage = Message;
interface PendingImage { data: string; mimeType: string; bytes: number }
interface SessionInfo { path: string; id: string; name: string | null; preview: string; mtime: number; messageCount: number }
interface PiEvent { type: string; [k: string]: unknown }
interface Draft { text: string; images: PendingImage[] }
interface FailedSend extends Draft { id: string; error: string; owner: string; kind: "prompt" | "steer" | "follow_up" }
interface PendingSend extends Draft { id: string; owner: string; index: number }
interface UiDialog { id: string; card: HTMLElement; inFlight: boolean; scope: { cwd: string; session: string | null } | null }
// CLI agents (`pi-agent`, see docs/pi-agent-cli-plan.md): records from the
// registry, merged live from `agent_update` events over the socket bridge.
interface AgentRecord {
  id: string; name: string; task?: string; cwd: string; model?: string; caller?: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled" | "lost";
  sessionFile?: string | null; queuePosition?: number | null; error?: string | null;
  createdAt?: number; startedAt?: number | null; endedAt?: number | null;
}
interface AgentModels { default: string; models: { id: string; use: string; avoid: string }[]; maxConcurrent: number }
// ---------- dom ----------
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const chatListEl = $("chat-list");
const chatContextEl = $("chat-context");
const messagesEl = $("messages");
const messagesInner = $("messages-inner");
const inputEl = $("input") as HTMLTextAreaElement;
const sendBtn = $("btn-send") as HTMLButtonElement;
const stopBtn = $("btn-stop") as HTMLButtonElement;
const queueBtn = $("btn-queue") as HTMLButtonElement;
const statusLine = $("status-line");
const runSpin = $("run-spin");
const branchLine = $("branch-line");
const ctxWarn = $("ctx-warn");
const chatTitle = $("chat-title");
const cwdBtn = $("btn-cwd") as HTMLButtonElement;
const cwdLabel = $("cwd-label");
const searchEl = $("search") as HTMLInputElement;
const dialogSlot = $("dialog-slot");
const attachStrip = $("attach-strip");
const attachError = $("attach-error");
const composerWrap = $("composer-wrap");
const noticesEl = $("notices");
// Model + thinking: controlled command pickers (searchable popovers). The
// pickers render whatever state is pushed in; every change flows through
// setModel / setThinking below, which own optimism and rollback.
const modelPicker = createPicker({
  id: "model-picker",
  label: "Model",
  searchPlaceholder: "Search models…",
  emptyText: "Default model",
  onChange: (v) => void setModel(v),
});
const THINKING_LEVELS: PickerItem[] = [
  { value: "off", label: "Off", hint: "No reasoning" },
  { value: "minimal", label: "Minimal", hint: "Quickest" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium", hint: "Balanced" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max", hint: "Deepest, slowest" },
];
const thinkingPicker = createPicker({
  id: "thinking-picker",
  label: "Thinking",
  searchPlaceholder: "Search levels…",
  emptyText: "Default",
  onChange: (v) => void setThinking(v),
});
thinkingPicker.setState({ items: THINKING_LEVELS, value: "medium" });
$("model-slot").replaceWith(modelPicker.trigger);
$("thinking-slot").replaceWith(thinkingPicker.trigger);
const queueBar = $("queue-bar");
const modalRoot = $("modal-root");
const menuRoot = $("menu-root");
const menuBtn = $("btn-menu") as HTMLButtonElement;
const jumpBtn = $("jump-latest") as HTMLButtonElement;
const connError = $("conn-error");
const crumbProject = $("crumb-project") as HTMLButtonElement;
const searchClear = $("search-clear") as HTMLButtonElement;
const searchHint = $("search-hint");
const composerHint = $("composer-hint");
const attachBtn = $("btn-attach") as HTMLButtonElement;
const fileInput = $("file-input") as HTMLInputElement;
const sidebarBtn = $("btn-sidebar") as HTMLButtonElement;

// Platform-aware modifier label for hints (⌘ on Apple, Ctrl elsewhere).
const IS_MAC = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
const MOD = IS_MAC ? "⌘" : "Ctrl+";
const kbd = (k: string) => `${MOD}${k}`;
searchHint.textContent = kbd("K");
$("btn-settings").title = `Settings (${kbd(",")})`;

// ---------- state ----------
let activeName = "";
let cwd = "", sessions: SessionInfo[] = [], activePath: string | null = null;
const projectChats = new Map<string, SessionInfo[]>();
let discovered: string[] = [];
let unlinked: { slug: string; sessions: SessionInfo[] }[] = [];
let expandedProjects = new Set<string>();
try {
  const raw = prefGet("pi-expanded");
  // Drop empty/junk entries: a stale "" here leaves the active project
  // collapsed, which reads as "my chats disappeared".
  if (raw) expandedProjects = new Set((JSON.parse(raw) as unknown[]).filter((p): p is string => typeof p === "string" && !!p.trim()));
} catch {
  /* ignore */
}
const conversation = new Conversation();
let messages: AgentMessage[] = conversation.messages;
let streaming = false, stopping = false, booting = true, bootError: string | null = null;
let bootGen = 0, revision = 0, navigating = false, eventsReady = false;
let unlisten: (() => void) | null = null;
let streamActivity = "thinking", streamActivityTool = "";
let pendingSend: PendingSend | null = null, sendInFlight: string | null = null;
const failedBySession = new Map<string, FailedSend[]>();
const drafts = new Map<string, Draft>();
let filter = "", visibleLimit = 100, debounceT: number | null = null, stickToBottom = true;
let pendingImages: PendingImage[] = [];
const expandedTools = new Set<string>(), showThinkingFor = new Set<string>(), fullTextByKey = new Map<string, string>();
let queue: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] };
// Per-chat queue truth. Server queues live in each chat's process and survive
// switching; the display var above is reset on every open, so the cache below
// restores the bar (and reports away-deliveries). Memory-only: processes die
// on quit, so there is nothing to restore across restarts.
type QueueLists = { steering: string[]; followUp: string[] };
const queueCache = new Map<string, QueueLists>();
const queueSeen = new Map<string, QueueLists>();
function capQueueMap(m: Map<string, QueueLists>, keep: string) {
  while (m.size > 200) {
    let victim: string | undefined;
    for (const k of m.keys()) { if (k !== keep) { victim = k; break; } }
    if (victim === undefined) break;
    m.delete(victim);
  }
}
let extStatus = "", lastFocus: HTMLElement | null = null;
let sessionsErrShown = false, modelsErrShown = false;
const MAX_IMAGES = 6, MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const dialogs = new Map<string, UiDialog>();
const sessKey = () => `${cwd}:${activePath ?? "new"}`;
const failedSends = () => failedBySession.get(sessKey()) ?? [];
const imgsOf = (m: AgentMessage) => [...imgList(m.content), ...imgList(m.attachments)];
const newClientId = () => crypto.randomUUID();
// ---------- prefs ----------
function prefGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function prefSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* session-only */
  }
}
if (prefGet("pi-quiet") === "1") document.body.classList.add("quiet");
if (prefGet("pi-hide-tools") === "1") document.body.classList.add("hide-tools");
else if (prefGet("pi-hide-tools") === null) prefSet("pi-hide-tools", "0");

// ---------- scroll ----------
messagesEl.addEventListener("scroll", () => {
  const gap = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
  stickToBottom = gap < 80;
  updateJump();
});
function updateJump() {
  const show = !stickToBottom && (streaming || messages.length > 0) && !booting;
  jumpBtn.classList.toggle("hidden", !show || messages.length === 0);
}
jumpBtn.onclick = () => {
  stickToBottom = true;
  messagesEl.scrollTop = messagesEl.scrollHeight;
  updateJump();
  inputEl.focus();
};
let scrollQueued = false, forceScroll = false;
function scrollBottom(force = false) {
  forceScroll ||= force;
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    if (forceScroll || stickToBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
    forceScroll = false; updateJump();
  });
}

// ---------- notices (floating toasts: never shift the transcript) ----------
const X_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>`;
function notify(opts: { text: string; kind?: "info" | "error"; sticky?: boolean; retryLabel?: string; onRetry?: () => void; details?: string }) {
  const el = document.createElement("div");
  el.className = "notice" + (opts.kind === "error" ? " error" : "");
  el.setAttribute("role", opts.kind === "error" ? "alert" : "status");
  const body = document.createElement("div");
  body.className = "n-body";
  const span = document.createElement("span");
  span.textContent = opts.text;
  body.appendChild(span);
  if (opts.details && opts.details !== opts.text && !opts.text.includes(opts.details)) {
    const det = document.createElement("details");
    const sum = document.createElement("summary");
    sum.textContent = "Details";
    const pre = document.createElement("pre");
    pre.textContent = opts.details;
    det.appendChild(sum);
    det.appendChild(pre);
    body.appendChild(det);
  }
  el.appendChild(body);
  const actions = document.createElement("div");
  actions.className = "n-actions";
  const dismiss = () => {
    if (timer !== null) clearTimeout(timer);
    el.classList.add("leaving");
    // Removal follows the fade; with reduced motion there is no transition.
    const gone = () => el.remove();
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) gone();
    else { el.addEventListener("transitionend", gone, { once: true }); setTimeout(gone, 250); }
  };
  if (opts.onRetry) {
    const r = document.createElement("button");
    r.type = "button";
    r.className = "n-act";
    r.textContent = opts.retryLabel ?? "Retry";
    r.onclick = () => {
      dismiss();
      opts.onRetry?.();
    };
    actions.appendChild(r);
  }
  const x = document.createElement("button");
  x.type = "button";
  x.className = "n-x";
  x.innerHTML = X_ICON;
  x.title = "Dismiss";
  x.setAttribute("aria-label", "Dismiss notice");
  x.onclick = dismiss;
  actions.appendChild(x);
  el.appendChild(actions);
  // Keep the stack short: the oldest non-error toast makes room.
  const live = noticesEl.querySelectorAll(".notice:not(.leaving)");
  if (live.length >= 4) (Array.from(live).find((n) => !n.classList.contains("error")) ?? live[0]).remove();
  noticesEl.appendChild(el);
  let timer: number | null = null;
  // Errors stay until dismissed — unless the caller passes sticky:false
  // because the error already has an inline home (a failed bubble's Retry).
  if (opts.sticky === false || (!opts.sticky && opts.kind !== "error")) {
    // One-shot per toast, paused while hovered so it can be read or acted on.
    const arm = () => { timer = window.setTimeout(dismiss, 6000); };
    arm();
    el.addEventListener("mouseenter", () => { if (timer !== null) { clearTimeout(timer); timer = null; } });
    el.addEventListener("mouseleave", () => { if (timer === null && el.isConnected) arm(); });
  }
}

function showConnError(text: string, onRetry: () => void) {
  connError.classList.remove("hidden");
  connError.innerHTML = "";
  const s = document.createElement("span");
  s.textContent = text;
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = "Retry";
  b.onclick = onRetry;
  connError.appendChild(s);
  connError.appendChild(b);
}
function hideConnError() {
  connError.classList.add("hidden");
  connError.innerHTML = "";
}

// ---------- menus ----------
interface MenuItem {
  label: string;
  hint?: string;
  checked?: boolean;
  title?: string;
  onPick: () => void;
}
let menuOutside: ((e: MouseEvent) => void) | null = null;
let ctxSubTimer: number | null = null;
function closeMenu() {
  if (ctxSubTimer !== null) { clearTimeout(ctxSubTimer); ctxSubTimer = null; }
  if (menuOutside) document.removeEventListener("mousedown", menuOutside);
  menuOutside = null;
  menuRoot.innerHTML = "";
  menuBtn.setAttribute("aria-expanded", "false");
  if (lastFocus && document.contains(lastFocus)) {
    lastFocus.focus();
    lastFocus = null;
  }
}
function openMenu(items: (MenuItem | "sep")[], at?: { left: number; top: number }, label?: string) {
  lastFocus = document.activeElement as HTMLElement;
  menuRoot.innerHTML = "";
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", label ?? "Conversation actions");
  const buttons: HTMLButtonElement[] = [];
  items.forEach((it) => {
    if (it === "sep") {
      const s = document.createElement("div");
      s.className = "menu-sep";
      menu.appendChild(s);
      return;
    }
    const b = document.createElement("button");
    b.type = "button";
    b.className = "menu-item";
    b.setAttribute("role", it.checked !== undefined ? "menuitemcheckbox" : "menuitem");
    if (it.checked !== undefined) b.setAttribute("aria-checked", String(it.checked));
    const check = document.createElement("span");
    check.className = "check";
    check.textContent = it.checked ? "✓" : "";
    const lab = document.createElement("span");
    lab.textContent = it.label;
    if (it.title) b.title = it.title;
    b.appendChild(check);
    b.appendChild(lab);
    if (it.hint) {
      const k = document.createElement("kbd");
      k.className = "menu-kbd";
      k.textContent = it.hint;
      b.appendChild(k);
    }
    b.onclick = () => {
      closeMenu();
      it.onPick();
    };
    menu.appendChild(b);
    buttons.push(b);
  });
  menuRoot.appendChild(menu);
  if (at) {
    menu.style.minWidth = "220px";
    const h = Math.min(menu.offsetHeight || 200, window.innerHeight - 16);
    menu.style.top = `${Math.max(8, Math.min(at.top, window.innerHeight - h - 8))}px`;
    menu.style.left = `${Math.max(8, Math.min(at.left, window.innerWidth - 228))}px`;
  } else {
    const r = menuBtn.getBoundingClientRect();
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  }
  if (!at) menuBtn.setAttribute("aria-expanded", "true");
  let idx = 0;
  buttons[0]?.focus();
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      closeMenu();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      idx = (idx + 1) % buttons.length;
      buttons[idx].focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      idx = (idx - 1 + buttons.length) % buttons.length;
      buttons[idx].focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      idx = 0;
      buttons[idx].focus();
    } else if (e.key === "End") {
      e.preventDefault();
      idx = buttons.length - 1;
      buttons[idx].focus();
    } else if (e.key === "Tab") {
      closeMenu();
    }
  });
  menuOutside = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node) && !menuBtn.contains(e.target as Node)) {
      closeMenu();

    }
  };
  document.addEventListener("mousedown", menuOutside);
}
function openHeaderMenu() {
  const showTools = !document.body.classList.contains("hide-tools");
  const quiet = document.body.classList.contains("quiet");
  openMenu([
    { label: "Session details", onPick: openSessionDetails },
    { label: "Compact context", onPick: doCompact },
    { label: "Export conversation", onPick: doExport },
    { label: "Rename chat", hint: kbd("R"), onPick: startInlineRename },
    "sep",
    {
      label: "Show tool activity",
      checked: showTools,
      onPick: () => {
        const hide = document.body.classList.toggle("hide-tools");
        prefSet("pi-hide-tools", hide ? "1" : "0");
        renderSettled();
      },
    },
    {
      label: "Quiet mode (pi's words only)",
      checked: quiet,
      onPick: () => {
        const on = document.body.classList.toggle("quiet");
        prefSet("pi-quiet", on ? "1" : "0");
        renderSettled();
      },
    },
    "sep",
    { label: "Keyboard shortcuts", hint: kbd("/"), onPick: openShortcuts },
    { label: "Settings", hint: kbd(","), onPick: openSettings },
  ]);
}
menuBtn.onclick = (e) => {
  e.stopPropagation();
  if (menuRoot.innerHTML) closeMenu();
  else openHeaderMenu();
};
chatTitle.ondblclick = () => { if (!booting && !bootError) startInlineRename(); };

// ---------- title: header breadcrumb, window title, inline rename ----------
let titleEditing = false, extTitle = false;
function currentTitle(): string { return activeName || deriveTitle() || "New chat"; }
function renderTitle() {
  const t = currentTitle();
  if (!titleEditing && chatTitle.textContent !== t) chatTitle.textContent = t;
  chatTitle.title = `${t} — double-click to rename (${kbd("R")})`;
  const proj = cwd ? baseName(cwd) : "";
  if (crumbProject.textContent !== proj) crumbProject.textContent = proj;
  crumbProject.title = cwd ? `Project: ${cwd} — click to start a chat elsewhere` : "";
  updateDocTitle();
}
// The OS window title names the chat (⌘-Tab, Mission Control), with a dot
// while a turn runs. An extension's setTitle wins until the app restarts.
function updateDocTitle() {
  if (extTitle) return;
  const t = `${streaming ? "● " : ""}${currentTitle()} — pi`;
  if (document.title !== t) document.title = t;
}
crumbProject.onclick = () => openProjectPickerModal(cwd, "Start chat here", (dir) => { void pickProjectDir(dir); });
function startInlineRename() {
  if (agentGuard()) return;
  if (titleEditing) { chatTitle.querySelector("input")?.focus(); return; }
  titleEditing = true;
  chatTitle.classList.add("editing");
  const inp = document.createElement("input");
  inp.className = "title-edit";
  inp.value = activeName || deriveTitle();
  inp.placeholder = "Name this chat";
  inp.setAttribute("aria-label", "Chat name");
  inp.spellcheck = false;
  chatTitle.replaceChildren(inp);
  inp.focus();
  inp.select();
  let done = false;
  const finish = async (save: boolean) => {
    if (done) return;
    done = true;
    titleEditing = false;
    chatTitle.classList.remove("editing");
    const name = inp.value.trim();
    const changed = save && !!name && name !== activeName;
    const before = activeName;
    if (changed) activeName = name; // optimistic: the header never flickers back
    chatTitle.textContent = "";
    renderTitle();
    if (document.activeElement === document.body || !document.activeElement) inputEl.focus();
    if (!changed) return;
    try {
      await invokeScoped("pi_set_name", { name });
      await refreshState();
      await refreshSessions();
    } catch (e) {
      activeName = before;
      renderTitle();
      notify({ text: `Rename failed: ${String(e)}`, kind: "error", sticky: true, retryLabel: "Retry", onRetry: startInlineRename });
    }
  };
  inp.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Enter") { e.preventDefault(); void finish(true); inputEl.focus(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); void finish(false); inputEl.focus(); }
  });
  inp.addEventListener("blur", () => void finish(true));
}

// ---------- modals (accessible dialog, focus trap + restore) ----------
let modalPrevFocus: HTMLElement | null = null;
function closeModal() {
  modalRoot.innerHTML = "";
  if (modalPrevFocus && document.contains(modalPrevFocus)) {
    modalPrevFocus.focus();
    modalPrevFocus = null;
  }
}
function openModal(title: string, build: (body: HTMLElement, close: () => void) => void, opts?: { wide?: boolean; focusBox?: boolean; className?: string }) {
  modalPrevFocus = document.activeElement as HTMLElement;
  modalRoot.innerHTML = "";
  const back = document.createElement("div");
  back.className = "modal-back";
  const box = document.createElement("div");
  box.className = "modal" + (opts?.wide ? " wide" : "") + (opts?.className ? ` ${opts.className}` : "");
  box.tabIndex = -1;
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", title);
  const h = document.createElement("h3");
  h.textContent = title;
  box.appendChild(h);
  build(box, closeModal);
  back.appendChild(box);
  modalRoot.appendChild(back);
  back.addEventListener("mousedown", (e) => {
    if (e.target === back) closeModal();
  });
  back.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeModal();
      return;
    }
    if (e.key !== "Tab") return;
    const f = Array.from(box.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]")).filter(
      (el) => !el.hasAttribute("disabled")
    );
    if (f.length === 0) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
  // Text fields take focus; reading surfaces (settings, shortcuts) focus the
  // box itself so no button opens wearing a focus ring.
  const firstInput = opts?.focusBox ? box : box.querySelector<HTMLElement>("input, select, textarea, button");
  setTimeout(() => firstInput?.focus(), 20);
}

// Settings: appearance, transcript display, project folder, shortcuts.
// Every toggle applies immediately (no Save for preferences); only the
// folder change, which navigates, waits for an explicit action.
function openSettings() {
  openModal("Settings", (box, close) => {
    const section = (title: string) => {
      const h = document.createElement("div");
      h.className = "set-head";
      h.textContent = title;
      box.appendChild(h);
    };
    // Appearance: segmented System / Light / Dark.
    section("Appearance");
    const seg = document.createElement("div");
    seg.className = "segmented";
    seg.setAttribute("role", "radiogroup");
    seg.setAttribute("aria-label", "Theme");
    const pref = () => document.documentElement.dataset.themePreference ?? "system";
    const segBtns: HTMLButtonElement[] = [];
    for (const [val, label] of [["system", "System"], ["light", "Light"], ["dark", "Dark"]] as const) {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.textContent = label;
      b.dataset.val = val;
      b.onclick = () => {
        setThemePreference(val);
        for (const o of segBtns) o.setAttribute("aria-checked", String(o.dataset.val === val));
      };
      b.setAttribute("aria-checked", String(pref() === val));
      segBtns.push(b);
      seg.appendChild(b);
    }
    box.appendChild(seg);

    section("Transcript");
    const toggle = (label: string, desc: string, get: () => boolean, set: (on: boolean) => void) => {
      const row = document.createElement("label");
      row.className = "set-toggle";
      const text = document.createElement("span");
      text.className = "set-toggle-text";
      const l = document.createElement("span");
      l.textContent = label;
      const d = document.createElement("span");
      d.className = "set-desc";
      d.textContent = desc;
      text.append(l, d);
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "switch";
      cb.checked = get();
      cb.onchange = () => set(cb.checked);
      row.append(text, cb);
      box.appendChild(row);
    };
    toggle("Show tool activity", "Tool calls appear as compact rows. Failures always show.",
      () => !document.body.classList.contains("hide-tools"),
      (on) => { document.body.classList.toggle("hide-tools", !on); prefSet("pi-hide-tools", on ? "0" : "1"); renderSettled(); });
    toggle("Quiet mode", "Only pi's words: hides routine tools and thinking.",
      () => document.body.classList.contains("quiet"),
      (on) => { document.body.classList.toggle("quiet", on); prefSet("pi-quiet", on ? "1" : "0"); renderSettled(); });

    section("Project folder");
    const pathRow = document.createElement("div");
    pathRow.className = "path-row";
    const inp = document.createElement("input");
    inp.id = "m-cwd";
    inp.value = cwd;
    inp.spellcheck = false;
    inp.setAttribute("aria-label", "Project folder");
    const browse = document.createElement("button");
    browse.type = "button";
    browse.className = "btn";
    browse.textContent = "Browse…";
    browse.onclick = () => { close(); openProjectPickerModal(cwd, "Open project", (dir) => { void setCwd(dir); }); };
    pathRow.append(inp, browse);
    box.appendChild(pathRow);
    const hint = document.createElement("p");
    hint.className = "muted";
    hint.textContent = "Switches to that folder's chats. Running chats keep running. Drafts stay with their original chat.";
    box.appendChild(hint);

    // Agents (pi-agent CLI): recommended models + concurrency. Edited from the
    // CLI so every caller shares one source of truth; shown here read-only.
    section("Agents");
    const agentBox = document.createElement("div");
    agentBox.className = "agent-models";
    const fillAgents = (m: AgentModels | null) => {
      agentBox.replaceChildren();
      if (!m) {
        const p = document.createElement("p"); p.className = "muted";
        p.textContent = "Agent settings unavailable.";
        agentBox.appendChild(p);
        return;
      }
      for (const x of m.models) {
        const row = document.createElement("div"); row.className = "am-row";
        const head = document.createElement("div"); head.className = "am-head";
        const id = document.createElement("code"); id.textContent = x.id;
        head.appendChild(id);
        if (x.id === m.default) { const d = document.createElement("span"); d.className = "agent-chip"; d.textContent = "default"; head.appendChild(d); }
        const use = document.createElement("div"); use.className = "am-line"; use.innerHTML = "<span>Use</span>"; use.append(x.use);
        const avoid = document.createElement("div"); avoid.className = "am-line"; avoid.innerHTML = "<span>Avoid</span>"; avoid.append(x.avoid);
        row.append(head, use, avoid);
        agentBox.appendChild(row);
      }
      const note = document.createElement("p"); note.className = "muted am-note";
      note.innerHTML = `Up to <strong></strong> agents run at once; more wait in a queue. Change these with <code>pi-agent models set &lt;provider/id&gt; --use "…" --avoid "…" [--default]</code> and <code>pi-agent config set max-concurrent N</code>.`;
      (note.querySelector("strong") as HTMLElement).textContent = String(m.maxConcurrent);
      agentBox.appendChild(note);
    };
    fillAgents(agentModels);
    box.appendChild(agentBox);
    void refreshAgentModels().then(() => { if (agentBox.isConnected) fillAgents(agentModels); });


    const row = document.createElement("div");
    row.className = "dialog-actions";
    const keys = document.createElement("button");
    keys.type = "button";
    keys.className = "left";
    keys.textContent = "Keyboard shortcuts";
    keys.onclick = () => { close(); openShortcuts(); };
    const c = document.createElement("button");
    c.type = "button";
    c.textContent = "Done";
    c.onclick = close;
    const s = document.createElement("button");
    s.type = "button";
    s.textContent = "Open folder";
    s.className = "primary";
    const sync = () => { s.disabled = !inp.value.trim() || inp.value.trim() === cwd; };
    sync();
    inp.addEventListener("input", sync);
    s.onclick = async () => {
      const ncwd = inp.value.trim();
      close();
      if (ncwd && ncwd !== cwd) await setCwd(ncwd);
    };
    row.append(keys, c, s);
    box.appendChild(row);
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing && !s.disabled) s.click();
    });
  }, { focusBox: true, wide: true });
}

function openShortcuts() {
  openModal("Keyboard shortcuts", (box, close) => {
    const groups: [string, [string, string][]][] = [
      ["Chats", [
        [kbd("N"), "New chat"],
        [kbd("K"), "Search chats"],
        ["↑ ↓ · Enter", "Move through results · open"],
        [kbd("R"), "Rename this chat"],
        [kbd("B"), "Show / hide sidebar"],
      ]],
      ["Composer", [
        ["Enter", "Send (steers while pi works)"],
        ["⇧ Enter", "New line"],
        ["↑", "Recall your last message (empty composer)"],
        ["/ or $", "Insert a skill"],
        [kbd("⇧M"), "Pick model"],
        [kbd("⇧T"), "Pick thinking level"],
        ["Esc", "Stop the running turn"],
      ]],
      ["Requests from pi", [
        ["Y · N", "Answer a yes/no request"],
        ["Esc", "Cancel the request"],
      ]],
      ["App", [
        [kbd(","), "Settings"],
        [kbd("/"), "This list"],
      ]],
    ];
    const grid = document.createElement("div");
    grid.className = "keys-grid";
    box.appendChild(grid);
    for (const [title, rows] of groups) {
      const col = document.createElement("section");
      grid.appendChild(col);
      const h = document.createElement("div");
      h.className = "set-head";
      h.textContent = title;
      col.appendChild(h);
      const dl = document.createElement("dl");
      dl.className = "keys";
      for (const [k, v] of rows) {
        const dt = document.createElement("dt");
        for (const part of k.split(" · ")) {
          const el = document.createElement("kbd");
          el.textContent = part;
          dt.appendChild(el);
        }
        const dd = document.createElement("dd");
        dd.textContent = v;
        dl.append(dt, dd);
      }
      col.appendChild(dl);
    }
    const row = document.createElement("div");
    row.className = "dialog-actions";
    const done = document.createElement("button");
    done.type = "button";
    done.className = "primary";
    done.textContent = "Done";
    done.onclick = close;
    row.appendChild(done);
    box.appendChild(row);
  }, { wide: true, focusBox: true, className: "keys-modal" });
}

function rowName(project: string, path: string): string {
  const s = (projectChats.get(project) ?? []).find((x) => x.path === path);
  return s?.name ?? s?.preview.slice(0, 48) ?? "";
}
function openRename(target?: { cwd: string; session: string | null; current: string }) {
  openModal("Rename chat", (box, close) => {
    const lab = document.createElement("label");
    lab.textContent = "Name";
    lab.setAttribute("for", "m-name");
    const inp = document.createElement("input");
    inp.id = "m-name";
    inp.value = target?.current ?? (chatTitle.textContent === "New chat" ? "" : chatTitle.textContent ?? "");
    inp.placeholder = "e.g. refactor-auth";
    const row = document.createElement("div");
    row.className = "dialog-actions";
    const c = document.createElement("button");
    c.type = "button";
    c.textContent = "Cancel";
    c.onclick = close;
    const s = document.createElement("button");
    s.type = "button";
    s.textContent = "Save";
    s.className = "primary";
    s.onclick = async () => {
      const name = inp.value.trim();
      close();
      if (!name) return;
      try {
        if (target && (target.session !== activePath || target.cwd !== cwd)) {
          // Row rename: direct scoped call, never via targetScope (R2-F1's
          // sibling — the global override would retarget every command).
          if (target.session && runningSet.has(`${target.cwd}:${target.session}`)) {
            notify({ text: "Wait for the turn to finish before renaming." });
            return;
          }
          await invokeChecked("pi_set_name", { cwd: target.cwd, session: target.session, name });
          await refreshSessions();
          await refreshAllProjects();
        } else {
          await invokeScoped("pi_set_name", { name });
          await refreshState();
          await refreshSessions();
        }
      } catch (e) {
        notify({ text: `Rename failed: ${String(e)}`, kind: "error", sticky: true, retryLabel: "Retry", onRetry: () => openRename(target) });
      }
    };
    row.appendChild(c);
    row.appendChild(s);
    box.appendChild(lab);
    box.appendChild(inp);
    box.appendChild(row);
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) s.click();
    });
  });
}

async function openSessionDetails() {
  if (agentGuard()) return;
  openModal("Session details", (box) => {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "Loading…";
    box.appendChild(p);
    (async () => {
      try {
        const st = (await invokeScoped("pi_get_state")) as Record<string, unknown>;
        const stats = (await invokeScoped("pi_get_stats")) as Record<string, unknown>;
        p.remove();
        const grid = document.createElement("div");
        grid.className = "stat-grid";
        const model = st.model as { id?: string; provider?: string } | null;
        const tokens = stats.tokens as Record<string, number> | undefined;
        const ctx = stats.contextUsage as { percent?: number | null; tokens?: number | null; contextWindow?: number } | undefined;
        const cells: [string, string][] = [
          ["session", String((st.sessionName as string) ?? (st.sessionId as string) ?? "—")],
          ["model", model ? `${model.provider}/${model.id}` : "—"],
          ["messages", String(Number(st.messageCount ?? messages.length ?? 0))],
          ["thinking", String((st.thinkingLevel as string) ?? thinkingPicker.state.value ?? "—")],
          ["input tok", tokens ? String(tokens.input ?? "—") : "—"],
          ["output tok", tokens ? String(tokens.output ?? "—") : "—"],
          ["cost", `$${Number((stats.cost as number) ?? 0).toFixed(4)}`],
          ["context", ctx?.percent != null ? `${ctx.percent}%` : "—"],
        ];
        for (const [k, v] of cells) {
          const cell = document.createElement("div");
          cell.className = "stat-cell";
          const kk = document.createElement("div");
          kk.className = "k";
          kk.textContent = k;
          const vv = document.createElement("div");
          vv.className = "v";
          vv.textContent = v;
          cell.appendChild(kk);
          cell.appendChild(vv);
          grid.appendChild(cell);
        }
        box.appendChild(grid);
        if (st.sessionFile) {
          const f = document.createElement("p");
          f.className = "muted";
          f.textContent = String(st.sessionFile);
          f.style.marginTop = "10px";
          box.appendChild(f);
        }
        const row = document.createElement("div");
        row.className = "dialog-actions";
        const done = document.createElement("button");
        done.type = "button";
        done.textContent = "Done";
        done.className = "primary";
        done.onclick = closeModal;
        row.appendChild(done);
        box.appendChild(row);
      } catch (e) {
        p.textContent = `Couldn't load session details: ${String(e)}`;
      }
    })();
  });
}

// ---------- message text helpers ----------
const msgText = textOf;

function imgList(list: unknown): { data: string; mime: string }[] {
  if (!Array.isArray(list)) return [];
  const out: { data: string; mime: string }[] = [];
  for (const raw of list) {
    const b = raw as Record<string, unknown>;
    const data = (b.data ?? b.content) as unknown;
    const mime = ((b.mimeType ?? b.mime) as string) ?? "";
    if (typeof data === "string" && typeof mime === "string" && data.length > 0 && mime.startsWith("image/")) {
      out.push({ data, mime });
    }
  }
  return out;
}

// ---------- projects + sidebar ----------
function addedProjects(): string[] {
  try {
    const raw = prefGet("pi-added-projects");
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((p): p is string => typeof p === "string" && !!p) : [];
  } catch {
    return [];
  }
}
function hiddenProjects(): Set<string> {
  try {
    const raw = prefGet("pi-hidden-projects");
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((p): p is string => typeof p === "string") : []);
  } catch {
    return new Set();
  }
}
type ChatGroups = Record<string, string[]>;
function loadGroups(): ChatGroups {
  try {
    const raw = prefGet("pi-chat-groups");
    const o = raw ? (JSON.parse(raw) as unknown) : {};
    if (o && typeof o === "object" && !Array.isArray(o)) {
      const out: ChatGroups = {};
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        if (k && Array.isArray(v)) out[k] = v.filter((p): p is string => typeof p === "string" && !!p);
      }
      return out;
    }
  } catch { /* ignore */ }
  return {};
}
function saveGroups(g: ChatGroups) { prefSet("pi-chat-groups", JSON.stringify(g)); }
// Chats made by code (idea 7). Names may not persist in session files (D1),
// so the flag lives here next to groups and follows the same retention rule.
// The set is cached in memory: isCoded runs per sidebar row, so parsing
// localStorage on every row would cost 100 JSON.parse calls per render.
const CODE_PREFIX = "[code]";
let codedCache: Set<string> | null = null;
function codedSet(): Set<string> {
  if (codedCache) return codedCache;
  try {
    const raw = prefGet("pi-coded-chats");
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    codedCache = new Set(
      Array.isArray(arr) ? arr.filter((p): p is string => typeof p === "string" && !!p) : []
    );
  } catch {
    codedCache = new Set();
  }
  return codedCache;
}
function saveCoded(paths: string[]) {
  codedCache = new Set(paths);
  prefSet("pi-coded-chats", JSON.stringify(paths));
}
function isCoded(name: string | null, path: string): boolean {
  return !!name?.startsWith(CODE_PREFIX) || codedSet().has(path);
}
// ---------- CLI agents (pi-agent) ----------
// The CLI owns each agent's pi process; the app observes. While an agent
// runs, its chat is read-only here (transcript read straight from the
// session file, live events over the socket bridge) so there is never a
// second writer on that session. See docs/pi-agent-cli-plan.md.
const AGENT_PREFIX = "[agent]";
function isAgentName(name: string | null | undefined): boolean { return !!name?.startsWith(AGENT_PREFIX); }
function displayName(name: string | null | undefined): string {
  return name && isAgentName(name) ? name.slice(AGENT_PREFIX.length).trim() : name ?? "";
}
let agents: AgentRecord[] = [];
// Session files that belong to headless subagents (from the registry). Those
// chats live only under "Headless subagents" — never in Recent, Groups, or a
// project's top-level list. The `[agent]` name prefix covers records the
// registry has already pruned.
let agentSessionPaths = new Set<string>();
function setAgents(list: AgentRecord[]) {
  agents = list;
  agentSessionPaths = new Set(list.map((a) => a.sessionFile).filter((p): p is string => !!p));
}
function isHeadless(s: { name: string | null; path: string }): boolean {
  return isAgentName(s.name) || agentSessionPaths.has(s.path);
}
function headlessPath(path: string | null): boolean {
  if (!path) return false;
  if (agentSessionPaths.has(path)) return true;
  for (const list of projectChats.values()) { const s = list.find((x) => x.path === path); if (s) return isAgentName(s.name); }
  return false;
}
function subagentsOpen(): Set<string> {
  try {
    const a = JSON.parse(prefGet("pi-subagents-open") ?? "[]") as unknown;
    return new Set(Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : []);
  } catch { return new Set(); }
}
function toggleSubagentsOpen(project: string) {
  const o = subagentsOpen();
  if (o.has(project)) o.delete(project); else o.add(project);
  prefSet("pi-subagents-open", JSON.stringify([...o]));
  renderProjects();
}
let agentModels: AgentModels | null = null;
let agentMax = 12;
let agentsExpanded = false;
const AGENT_DONE = new Set(["done", "failed", "cancelled", "lost"]);
const agentActive = (a: AgentRecord) => !AGENT_DONE.has(a.status);
function activeAgentFor(path: string): AgentRecord | null {
  return agents.find((a) => a.status === "running" && !!a.sessionFile && a.sessionFile === path) ?? null;
}
function visibleAgent(): AgentRecord | null { return activePath ? activeAgentFor(activePath) : null; }
function agentGuard(): boolean {
  if (!visibleAgent()) return false;
  notify({ text: "This chat is read-only while its agent runs. Stop the agent or wait for it to finish." });
  return true;
}
async function refreshAgents() {
  try {
    const r = await invokeChecked<{ agents?: AgentRecord[]; maxConcurrent?: number }>("pi_agents_list");
    const was = visibleAgent();
    setAgents(Array.isArray(r.agents) ? r.agents : []);
    agentMax = Number(r.maxConcurrent) || agentMax;
    renderProjects();
    if (was && !visibleAgent()) void reloadVisibleChat();
    updateSendState();
  } catch { /* older backend: no agents */ }
}
async function refreshAgentModels() {
  try {
    const m = await invokeChecked<AgentModels>("pi_agent_models");
    if (!m || !Array.isArray(m.models)) return;
    agentModels = m;
    agentMax = Number(m.maxConcurrent) || agentMax;
    modelPicker.setState({ items: modelPicker.state.items.map((i) => ({ ...i, hint: recommendedHint(i.value) })) });
  } catch { /* none */ }
}
function recommendedHint(id: string): string | undefined {
  if (!agentModels) return undefined;
  if (agentModels.default === id) return "agent default";
  return agentModels.models.some((m) => m.id === id) ? "recommended" : undefined;
}
function onAgentUpdate(rec: AgentRecord | undefined) {
  if (!rec || typeof rec.id !== "string") return;
  const was = visibleAgent();
  const i = agents.findIndex((a) => a.id === rec.id);
  const prev = i >= 0 ? agents[i] : null;
  const next = [...agents];
  if (i >= 0) next[i] = rec; else next.unshift(rec);
  setAgents(next);
  // New session rows appear (and finished ones update) in their project.
  if ((!prev || prev.status !== rec.status) && (rec.status === "running" || AGENT_DONE.has(rec.status))) void refreshAllProjects();
  renderProjects();
  if (was && !visibleAgent()) void reloadVisibleChat();
  updateSendState();
}
// The agent finished while its chat was open: it is now an ordinary chat
// (the backend already retired any stale process), so load it normally.
async function reloadVisibleChat() {
  try { await refreshState(); } catch { /* the transcript read below reports */ }
  await refreshMessages();
  void refreshStats(); void refreshModels(); void refreshCommands();
}
async function openAgentChat(a: AgentRecord) {
  if (navigating || booting) return;
  if (dialogs.size) { notify({ text: "Answer the pending request before changing chats or folders." }); return; }
  if (a.sessionFile === activePath && a.cwd === cwd) return;
  navigating = true; saveDraft(); const gen = ++bootGen; updateSendState();
  try {
    const res = await invokeChecked<{ messages: AgentMessage[] }>("pi_read_session", { path: a.sessionFile });
    if (gen !== bootGen) return;
    cwd = a.cwd; activePath = a.sessionFile ?? null; activeName = a.name;
    cwdLabel.textContent = baseName(cwd); cwdBtn.title = cwd;
    clearRunScope(true);
    conversation.reset(res.messages ?? []); messages = conversation.messages;
    if (unseenFinished.delete(visibleKey())) saveUnseen();
    restoreDraft();
    expandedProjects.add(cwd); saveExpanded();
    setBusy(true);
    renderTitle(); renderProjects(); renderSettled(); void refreshBranch();
    stickToBottom = true; scrollBottom(true);
  } catch (e) {
    notify({ text: `Couldn't open the agent's chat: ${String(e)}`, kind: "error", retryLabel: "Retry", onRetry: () => openAgentChat(a) });
  } finally { navigating = false; updateSendState(); }
}
async function cancelAgent(a: AgentRecord) {
  try { await invokeChecked("pi_agent_cancel", { id: a.id }); }
  catch (e) { notify({ text: `Couldn't stop the agent: ${String(e)}`, kind: "error" }); void refreshAgents(); }
}
async function clearFinishedAgents() {
  try {
    const r = await invokeChecked<{ removed?: number }>("pi_agents_clear");
    notify({ text: `Cleared ${r.removed ?? 0} finished agent${r.removed === 1 ? "" : "s"}.` });
  } catch (e) { notify({ text: `Couldn't clear agents: ${String(e)}`, kind: "error" }); }
  await refreshAgents();
}
const agentBanner = $("agent-banner");
function renderAgentBanner(a: AgentRecord | null) {
  if (!a) {
    if (!agentBanner.classList.contains("hidden")) { agentBanner.classList.add("hidden"); agentBanner.replaceChildren(); agentBanner.dataset.sig = ""; }
    return;
  }
  const sig = `${a.id}:${a.status}:${stopping}`;
  if (agentBanner.dataset.sig === sig) return;
  agentBanner.dataset.sig = sig;
  agentBanner.classList.remove("hidden");
  const dot = document.createElement("span"); dot.className = "run-spin"; dot.setAttribute("aria-hidden", "true");
  const text = document.createElement("span"); text.className = "ab-text";
  const strong = document.createElement("strong"); strong.textContent = "Running as a CLI agent";
  const meta = document.createElement("span"); meta.className = "ab-meta";
  const bits = [a.caller && a.caller !== "cli" ? `started by ${a.caller}` : "started from the CLI", a.startedAt ? fmtRelative(a.startedAt) : "", a.model?.split("/").pop() ?? ""].filter(Boolean);
  meta.textContent = ` · ${bits.join(" · ")} — read-only until it finishes`;
  text.append(strong, meta);
  const stop = document.createElement("button"); stop.type = "button";
  stop.textContent = stopping ? "Stopping…" : "Stop agent"; stop.disabled = stopping;
  stop.onclick = () => void doAbort();
  agentBanner.replaceChildren(dot, text, stop);
}
function agentStatusChip(a: AgentRecord): HTMLElement | null {
  if (a.status === "running") {
    const sp = document.createElement("span"); sp.className = "run-spin"; sp.setAttribute("role", "img"); sp.setAttribute("aria-label", "running"); return sp;
  }
  const label = a.status === "queued" ? (a.queuePosition ? `#${a.queuePosition}` : "queued")
    : a.status === "failed" ? "failed" : a.status === "lost" ? "lost" : a.status === "cancelled" ? "stopped" : "";
  if (!label) return null;
  const c = document.createElement("span");
  c.className = "agent-chip" + (a.status === "failed" || a.status === "lost" ? " bad" : "");
  c.textContent = label;
  if (a.status === "queued") c.title = "Waiting for a free agent slot";
  if (a.error) c.title = a.error;
  return c;
}
function agentRow(a: AgentRecord): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "agent-item";
  el.dataset.agentId = a.id;
  if (a.sessionFile && a.sessionFile === activePath) el.setAttribute("aria-current", "true");
  const row = document.createElement("div"); row.className = "ci-row";
  const t = document.createElement("div"); t.className = "ci-title"; t.textContent = a.name || "agent";
  row.appendChild(t);
  const chip = agentStatusChip(a); if (chip) row.appendChild(chip);
  const time = document.createElement("div"); time.className = "ci-time";
  const at = a.endedAt || a.startedAt || a.createdAt; time.textContent = at ? fmtRelative(at) : "";
  row.appendChild(time);
  const sub = document.createElement("div"); sub.className = "ci-sub";
  sub.textContent = (a.status === "failed" || a.status === "lost") && a.error ? a.error : [baseName(a.cwd), a.model?.split("/").pop()].filter(Boolean).join(" · ");
  el.append(row, sub);
  el.title = a.task ? `${a.task.slice(0, 300)}${a.task.length > 300 ? "…" : ""}` : a.name;
  el.setAttribute("aria-label", `${a.name}, agent ${a.status}${a.queuePosition ? ` number ${a.queuePosition}` : ""}`);
  el.disabled = navigating || booting;
  el.onclick = () => {
    if (a.sessionFile) void openSession(a.cwd, a.sessionFile);
    else notify({ text: a.status === "queued" ? `${a.name} is waiting for a free slot (${agentMax} run at once).` : `${a.name} has no chat to open.` });
  };
  return el;
}
function renderAgentsParent(q: string, isOpen: boolean) {
  if (!agents.length) return;
  const list = q ? agents.filter((a) => `${a.name} ${a.task ?? ""}`.toLowerCase().includes(q)) : agents;
  if (q && !list.length) return;
  const running = agents.filter((a) => a.status === "running").length;
  const queued = agents.filter((a) => a.status === "queued").length;
  const count = document.createElement("span");
  count.className = "agents-count";
  count.textContent = running || queued ? `${running}/${agentMax}${queued ? ` +${queued}` : ""}` : "";
  count.title = `${running} running, ${queued} queued, up to ${agentMax} at once`;
  const section = document.createElement("div");
  section.className = "parent-section agents-section";
  section.setAttribute("role", "group");
  section.setAttribute("aria-label", "Headless subagents");
  section.appendChild(parentHead("Headless subagents", "agents", isOpen, count));
  chatListEl.appendChild(section);
  if (!isOpen) return;
  const body = document.createElement("div");
  body.className = "parent-body";
  section.appendChild(body);
  // Active agents always show; finished ones fill the rest.
  const limit = agentsExpanded ? 30 : 6;
  const active = list.filter(agentActive);
  const shown = [...active, ...list.filter((a) => !agentActive(a)).slice(0, Math.max(0, limit - active.length))];
  for (const a of shown) body.appendChild(agentRow(a));
  const hasFinished = agents.some((a) => !agentActive(a));
  const foot = document.createElement("div");
  foot.className = "agents-foot";
  if (list.length > shown.length || agentsExpanded) {
    const more = document.createElement("button");
    more.type = "button"; more.className = "show-more";
    more.textContent = agentsExpanded ? "Show less" : `Show ${Math.min(list.length, 30) - shown.length} more`;
    more.onclick = () => { agentsExpanded = !agentsExpanded; renderProjects(); };
    foot.appendChild(more);
  }
  if (hasFinished && !q) {
    const clr = document.createElement("button");
    clr.type = "button"; clr.className = "show-more";
    clr.textContent = "Clear finished";
    clr.onclick = () => void clearFinishedAgents();
    foot.appendChild(clr);
  }
  if (foot.childElementCount) body.appendChild(foot);
}
function openAgentMenu(x: number, y: number, a: AgentRecord) {
  const items: (MenuItem | "sep")[] = [];
  if (a.sessionFile) items.push({ label: "Open chat", onPick: () => void openSession(a.cwd, a.sessionFile!) });
  if (agentActive(a)) items.push({ label: "Stop agent", onPick: () => void cancelAgent(a) });
  items.push({ label: "Copy agent ID", onPick: () => { void navigator.clipboard.writeText(a.id).then(() => notify({ text: `Copied ${a.id}` }), () => notify({ text: a.id })); } });
  if (agents.some((x) => !agentActive(x))) items.push("sep", { label: "Clear finished agents", onPick: () => void clearFinishedAgents() });
  openMenu(items, { left: x, top: y }, "Agent actions");
}

function groupClosed(): Set<string> {
  try {
    const a = JSON.parse(prefGet("pi-groups-closed") ?? "[]") as unknown;
    return new Set(Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : []);
  } catch { return new Set(); }
}
function saveGroupClosed(s: Set<string>) { prefSet("pi-groups-closed", JSON.stringify([...s])); }
type ParentState = { groups: boolean; projects: boolean; recent: boolean; agents: boolean };
function parentsOpen(): ParentState {
  try {
    const o = JSON.parse(prefGet("pi-parents") ?? "{}") as Partial<ParentState>;
    return { groups: o.groups !== false, projects: o.projects !== false, recent: o.recent === true, agents: o.agents !== false };
  } catch { return { groups: true, projects: true, recent: false, agents: true }; }
}
function saveParents(p: ParentState) { prefSet("pi-parents", JSON.stringify(p)); }
function findProjectForPath(path: string): string | null {
  for (const [c, list] of projectChats) if (list.some((s) => s.path === path)) return c;
  if (sessions.some((s) => s.path === path)) return cwd;
  return null;
}
function groupHomeProject(name: string, groups: ChatGroups): string {
  const paths = groups[name] ?? [];
  for (let i = paths.length - 1; i >= 0; i--) {
    const c = findProjectForPath(paths[i]);
    if (c) return c;
  }
  return cwd;
}
function groupChats(name: string, groups: ChatGroups, q: string): { info: SessionInfo; project: string }[] {
  const out: { info: SessionInfo; project: string }[] = [];
  for (const path of groups[name] ?? []) {
    const c = findProjectForPath(path);
    if (!c) continue;
    const info = (projectChats.get(c) ?? []).find((s) => s.path === path);
    if (!info || isHeadless(info) || !chatMatches(info, q)) continue;
    out.push({ info, project: c });
  }
  return out;
}
let projectOrder: string[] = [];
function getProjects(): string[] {
  const hidden = hiddenProjects();
  const known = new Set([...discovered, ...addedProjects()]);
  if (cwd) known.add(cwd);
  // Stable order: first-seen positions are kept forever, newcomers append at
  // the end. The active project never jumps to the top.
  projectOrder = projectOrder.filter((p) => known.has(p));
  for (const p of discovered) if (!projectOrder.includes(p)) projectOrder.push(p);
  for (const a of addedProjects()) if (!projectOrder.includes(a)) projectOrder.push(a);
  if (cwd && !projectOrder.includes(cwd)) projectOrder.push(cwd);
  return projectOrder.filter((p) => !hidden.has(p));
}
function saveExpanded() {
  prefSet("pi-expanded", JSON.stringify([...expandedProjects]));
}
function baseName(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
}

async function refreshAllProjects() {
  void refreshAgents();
  const gen = bootGen;
  try {
    const res = await invokeChecked<{
      projects: { slug: string; cwd: string | null; sessions: SessionInfo[] }[];
    }>("pi_all_projects");
    if (gen !== bootGen) return;
    discovered = [];
    unlinked = [];
    for (const p of res.projects ?? []) {
      if (p.cwd) {
        discovered.push(p.cwd);
        projectChats.set(p.cwd, p.sessions ?? []);
      } else {
        unlinked.push({ slug: p.slug, sessions: p.sessions ?? [] });
      }
    }
  } catch (e) {
    if (gen === bootGen) {
      notify({
        text: `Couldn't list projects: ${String(e)}`,
        kind: "error",
        sticky: true,
        retryLabel: "Retry",
        onRetry: () => refreshAllProjects(),
      });
    }
    return;
  }
  if (gen !== bootGen) return;
  if (cwd && !expandedProjects.has(cwd)) {
    expandedProjects.add(cwd);
    saveExpanded();
  }
  if (unseenFinished.size) {
    const known = new Set<string>();
    for (const [c, list] of projectChats) for (const s of list) known.add(`${c}:${s.path}`);
    let pruned = false;
    for (const k of unseenFinished) if (!known.has(k)) { unseenFinished.delete(k); pruned = true; }
    const g = loadGroups();
    let gdirty = false;
    const paths = new Set<string>();
    for (const list of projectChats.values()) for (const s of list) paths.add(s.path);
    for (const [n, arr] of Object.entries(g)) {
      const kept = arr.filter((p) => paths.has(p));
      if (kept.length !== arr.length) { g[n] = kept; gdirty = true; }
    }
    if (gdirty) saveGroups(g);
    const coded = [...codedSet()].filter((p) => paths.has(p));
    if (coded.length !== codedSet().size) saveCoded(coded);
    if (pruned) saveUnseen();
  }
  renderProjects();
}

async function registerAddedProject(dir: string) {
  const added = addedProjects();
  if (!added.includes(dir)) prefSet("pi-added-projects", JSON.stringify([...added, dir]));
  const hidden = hiddenProjects();
  if (hidden.delete(dir)) prefSet("pi-hidden-projects", JSON.stringify([...hidden]));
  expandedProjects.add(dir);
  saveExpanded();
  projectChats.set(dir, projectChats.get(dir) ?? []);
  await refreshAllProjects();
}
interface DirListOut { path: string; parent: string | null; home: string; dirs: string[]; truncated: boolean }
// Universal project picker: searchable one-level filesystem browser with
// breadcrumbs, / ~ path jump, and a Finder escape hatch.
function openProjectPickerModal(startDir: string, selectLabel: string, onPick: (dir: string) => void) {
  openModal("Choose project folder", (box, close) => {
    const crumbs = document.createElement("div");
    crumbs.className = "crumbs";
    crumbs.setAttribute("aria-label", "Current folder");
    const search = document.createElement("input");
    search.placeholder = "Search folders here, or type a path starting with / or ~";
    search.setAttribute("aria-label", "Search folders or type a path");
    search.setAttribute("autocomplete", "off");
    search.setAttribute("spellcheck", "false");
    const list = document.createElement("div");
    list.className = "pick-list";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Folders");
    const err = document.createElement("div");
    err.className = "pick-error";
    err.setAttribute("role", "status");
    const row = document.createElement("div");
    row.className = "dialog-actions";
    const finder = document.createElement("button");
    finder.type = "button";
    finder.className = "left";
    finder.textContent = "Browse in Finder…";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.onclick = close;
    const select = document.createElement("button");
    select.type = "button";
    select.className = "primary";
    select.textContent = selectLabel;
    row.appendChild(finder);
    row.appendChild(cancel);
    row.appendChild(select);
    box.appendChild(crumbs);
    box.appendChild(search);
    box.appendChild(list);
    box.appendChild(err);
    box.appendChild(row);
    let cur = startDir;
    let home = "";
    const cache = new Map<string, DirListOut>();
    let deb: number | null = null;
    const isJump = (s: string) => s.startsWith("/") || s === "~" || s.startsWith("~/");
    const resolveJump = (s: string): string | null => {
      if (s === "~") return home || null;
      if (s.startsWith("~/")) return home ? home + s.slice(1) : null;
      return s;
    };
    const renderCrumbs = (d: DirListOut) => {
      crumbs.replaceChildren();
      const root = document.createElement("button");
      root.type = "button";
      root.textContent = "/";
      root.title = "Go to /";
      root.onclick = () => nav("/");
      crumbs.appendChild(root);
      const parts = d.path.split("/").filter(Boolean);
      parts.forEach((seg, i) => {
        const sep = document.createElement("span");
        sep.className = "sep";
        sep.textContent = "›";
        crumbs.appendChild(sep);
        if (i === parts.length - 1) {
          const s = document.createElement("span");
          s.className = "cur";
          s.textContent = seg;
          crumbs.appendChild(s);
        } else {
          const b = document.createElement("button");
          b.type = "button";
          b.textContent = seg;
          b.title = "/" + parts.slice(0, i + 1).join("/");
          b.onclick = () => nav("/" + parts.slice(0, i + 1).join("/"));
          crumbs.appendChild(b);
        }
      });
    };
    const renderList = (d: DirListOut, q: string) => {
      list.replaceChildren();
      const trimmed = q.trim();
      const query = trimmed.toLowerCase();
      const items = query && !isJump(trimmed) ? d.dirs.filter((p) => baseName(p).toLowerCase().includes(query)) : d.dirs;
      if (items.length === 0) {
        const e = document.createElement("div");
        e.className = "pick-empty";
        e.textContent = query ? "No folders match." : "No subfolders here — pick this folder or go up.";
        list.appendChild(e);
        return;
      }
      for (const full of items) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "pick-row";
        b.setAttribute("role", "option");
        b.title = full;
        const name = document.createElement("span");
        name.textContent = baseName(full);
        b.appendChild(name);
        b.onclick = () => nav(full);
        list.appendChild(b);
      }
      if (d.truncated) {
        const t = document.createElement("div");
        t.className = "pick-empty";
        t.textContent = "Showing the first 1000 folders.";
        list.appendChild(t);
      }
    };
    let navGen = 0;
    async function nav(path: string) {
      const gen = ++navGen;
      err.textContent = "";
      let d = cache.get(path);
      if (!d) {
        list.replaceChildren();
        const l = document.createElement("div");
        l.className = "pick-empty";
        l.textContent = "Loading…";
        list.appendChild(l);
        try {
          d = await invoke<DirListOut>("pi_list_dirs", { path });
          if (gen !== navGen) return;
          cache.set(path, d);
        } catch (e) {
          if (gen !== navGen) return;
          err.textContent = typeof e === "string" && e ? e : e instanceof Error ? e.message : "Couldn't list that folder.";
          const back = cache.get(cur);
          if (back) renderList(back, search.value);
          else {
            list.replaceChildren();
            const f = document.createElement("div");
            f.className = "pick-empty";
            f.textContent = "Couldn't load this folder.";
            list.appendChild(f);
          }
          return;
        }
      }
      cur = d.path;
      home = d.home || home;
      renderCrumbs(d);
      renderList(d, search.value);
    }
    list.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const rows = Array.from(list.querySelectorAll<HTMLButtonElement>(".pick-row"));
      if (rows.length === 0) return;
      e.preventDefault();
      const i = rows.indexOf(document.activeElement as HTMLButtonElement);
      const n = e.key === "ArrowDown" ? (i + 1) % rows.length : (i - 1 + rows.length) % rows.length;
      rows[n].focus();
    });
    search.addEventListener("input", () => {
      if (deb !== null) window.clearTimeout(deb);
      deb = window.setTimeout(() => {
        if (!box.isConnected) return;
        const d = cache.get(cur);
        if (d) renderList(d, search.value);
      }, 150);
    });
    search.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      const v = search.value.trim();
      if (isJump(v)) {
        const dest = resolveJump(v);
        if (dest) { e.preventDefault(); search.value = ""; nav(dest); }
        return;
      }
      const d = cache.get(cur);
      if (!d) return;
      const query = v.toLowerCase();
      const items = query ? d.dirs.filter((p) => baseName(p).toLowerCase().includes(query)) : d.dirs;
      if (items.length === 1) { e.preventDefault(); search.value = ""; nav(items[0]); }
    });
    finder.onclick = async () => {
      try {
        const picked = await openFolderPicker({ directory: true, multiple: false, title: "Choose project folder" });
        if (typeof picked === "string" && picked) nav(picked);
      } catch {
        notify({ text: "Couldn't open the folder picker." });
      }
    };
    select.onclick = () => { close(); onPick(cur); };
    nav(startDir);
  }, { wide: true });
}
function openAddProject() {
  openProjectPickerModal(cwd, "Add project", (dir) => { void registerAddedProject(dir); });
}

function removeProject(project: string) {
  const added = addedProjects();
  if (added.includes(project)) {
    prefSet("pi-added-projects", JSON.stringify(added.filter((p) => p !== project)));
  } else {
    const hidden = hiddenProjects();
    hidden.add(project);
    prefSet("pi-hidden-projects", JSON.stringify([...hidden]));
  }
  projectChats.delete(project);
  expandedProjects.delete(project);
  saveExpanded();
  renderProjects();
}

async function openChat(project: string, path: string) {
  await openSession(project, path);
}

function chatMatches(s: SessionInfo, q: string): boolean {
  return !q || (s.name ?? "").toLowerCase().includes(q) || s.preview.toLowerCase().includes(q);
}

function chatButton(s: SessionInfo, project: string): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "chat-item";
  const selected = s.path === activePath;
  if (selected) el.setAttribute("aria-current", "true");
  el.setAttribute("aria-label", `${s.name || s.preview.slice(0, 60) || "Untitled"}, ${fmtRelative(s.mtime)}`);
  const row = document.createElement("div");
  row.className = "ci-row";
  const t = document.createElement("div");
  t.className = "ci-title";
  t.textContent = displayName(s.name) || s.preview.slice(0, 42) || "Untitled";
  const time = document.createElement("div");
  time.className = "ci-time";
  time.textContent = fmtRelative(s.mtime);
  row.appendChild(t);
  el.dataset.path = s.path;
  el.dataset.project = project;
  if (isHeadless(s)) el.dataset.headless = "1";
  const rkey = `${project}:${s.path}`;
  const rlabel = s.name || s.preview.slice(0, 60) || "Untitled";
  if (!isHeadless(s) && isCoded(s.name, s.path)) {
    const badge = document.createElement("span");
    badge.className = "code-badge";
    badge.textContent = "code";
    badge.title = "Made by code";
    row.appendChild(badge);
  }
  if (runningSet.has(rkey) || !!activeAgentFor(s.path)) {
    const spin = document.createElement("span");
    spin.className = "run-spin";
    spin.title = "Running";
    spin.setAttribute("role", "img");
    spin.setAttribute("aria-label", `${rlabel} is running`);
    row.appendChild(spin);
  } else if (unseenFinished.has(rkey)) {
    const dot = document.createElement("span");
    dot.className = "run-dot";
    dot.title = "Finished — not yet viewed";
    dot.setAttribute("role", "img");
    dot.setAttribute("aria-label", `${rlabel} finished`);
    row.appendChild(dot);
  }
  row.appendChild(time);
  const sub = document.createElement("div");
  sub.className = "ci-sub";
  sub.textContent = s.preview.slice(0, 80);
  el.appendChild(row);
  if (s.name && s.preview && s.preview !== s.name) el.appendChild(sub);
  el.disabled = navigating || booting;
  el.onclick = () => openChat(project, s.path);
  return el;
}

function renderProjects() {
  const q = filter.trim().toLowerCase();
  chatListEl.innerHTML = "";
  const parents = parentsOpen();
  renderRecentParent(q, parents.recent);
  renderGroupsParent(q, parents.groups);
  renderProjectsParent(q, parents.projects);
  renderAgentsParent(q, parents.agents);
}
function parentHead(title: string, key: keyof ParentState, isOpen: boolean, extra: HTMLElement | null): HTMLElement {
  const row = document.createElement("div");
  row.className = "p-row parent-row";
  const head = document.createElement("button");
  head.type = "button";
  head.className = "project-head parent-head" + (isOpen ? " open" : "");
  head.setAttribute("aria-expanded", String(isOpen));
  head.title = title;
  const chev = document.createElement("span");
  chev.innerHTML = chevSvg();
  const name = document.createElement("span");
  name.className = "p-name";
  name.textContent = title;
  head.appendChild(chev);
  head.appendChild(name);
  head.onclick = () => {
    const p = parentsOpen();
    p[key] = !p[key];
    saveParents(p);
    renderProjects();
  };
  row.appendChild(head);
  if (extra) row.appendChild(extra);
  return row;
}
function miniButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "mini-add";
  b.textContent = label;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.onclick = onClick;
  return b;
}
let recentExpanded = false;
// Most recent chats across every project and group, newest first.
function recentChats(q: string): { info: SessionInfo; project: string }[] {
  const seen = new Set<string>();
  const all: { info: SessionInfo; project: string }[] = [];
  const push = (project: string, info: SessionInfo) => {
    if (seen.has(info.path)) return;
    seen.add(info.path);
    if (isHeadless(info)) return;
    if (!chatMatches(info, q)) return;
    all.push({ info, project });
  };
  for (const s of sessions) push(cwd, s);
  for (const [c, list] of projectChats) for (const s of list) push(c, s);
  all.sort((a, b) => b.info.mtime - a.info.mtime);
  return all;
}
function renderRecentParent(q: string, isOpen: boolean) {
  const section = document.createElement("div");
  section.className = "parent-section";
  section.setAttribute("role", "group");
  section.setAttribute("aria-label", "Recent");
  section.appendChild(parentHead("Recent", "recent", isOpen, null));
  chatListEl.appendChild(section);
  if (!isOpen) return;
  const body = document.createElement("div");
  body.className = "parent-body";
  section.appendChild(body);
  const all = recentChats(q);
  const shown = all.slice(0, recentExpanded ? 15 : 5);
  if (shown.length === 0) {
    const e = document.createElement("div");
    e.className = "project-empty";
    e.textContent = q ? "No recent matches." : "No chats yet.";
    body.appendChild(e);
    return;
  }
  for (const { info, project } of shown) body.appendChild(chatButton(info, project));
  if (all.length > 5) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "show-more";
    more.textContent = recentExpanded ? "Show less" : `Show ${Math.min(all.length, 15) - 5} more`;
    more.setAttribute("aria-expanded", String(recentExpanded));
    more.onclick = () => { recentExpanded = !recentExpanded; renderProjects(); };
    body.appendChild(more);
  }
}
function renderGroupsParent(q: string, isOpen: boolean) {
  const groups = loadGroups();
  const names = Object.keys(groups);
  const rows = names.map((n) => ({ name: n, list: groupChats(n, groups, q) }));
  const visible = q ? rows.filter((r) => r.list.length > 0) : rows;
  if (q && visible.length === 0) return;
  const section = document.createElement("div");
  section.className = "parent-section";
  section.setAttribute("role", "group");
  section.setAttribute("aria-label", "Groups");
  section.appendChild(parentHead("Groups", "groups", isOpen, miniButton("+", "New group", () => openNewGroup(null))));
  if (!isOpen) { chatListEl.appendChild(section); return; }
  for (const { name, list } of visible) section.appendChild(groupSection(name, list, q));
  if (!q && names.length === 0) {
    const e = document.createElement("div");
    e.className = "project-empty";
    e.textContent = "No groups yet. Right-click any chat to group it.";
    section.appendChild(e);
  }
  chatListEl.appendChild(section);
}
function groupSection(name: string, list: { info: SessionInfo; project: string }[], q: string): HTMLElement {
  const section = document.createElement("div");
  section.className = "project-section group-section";
  section.dataset.group = name;
  section.setAttribute("role", "group");
  section.setAttribute("aria-label", `Group ${name}`);
  const row = document.createElement("div");
  row.className = "p-row";
  const head = document.createElement("button");
  head.type = "button";
  const closed = groupClosed();
  const open = !!q || !closed.has(name);
  head.className = "project-head" + (open ? " open" : "");
  head.setAttribute("aria-expanded", String(open));
  head.title = name;
  const chev = document.createElement("span");
  chev.innerHTML = chevSvg();
  const label = document.createElement("span");
  label.className = "p-name";
  label.textContent = name;
  const count = document.createElement("span");
  count.className = "p-count";
  count.textContent = String(list.length);
  head.appendChild(chev);
  head.appendChild(label);
  head.appendChild(count);
  head.onclick = () => {
    const c = groupClosed();
    if (c.has(name)) c.delete(name); else c.add(name);
    saveGroupClosed(c);
    renderProjects();
  };
  row.appendChild(head);
  const add = document.createElement("button");
  add.type = "button";
  add.className = "p-add";
  add.textContent = "+";
  add.title = `New chat in this group (${name})`;
  add.setAttribute("aria-label", `New chat in group ${name}`);
  add.onclick = () => newChatInGroup(name);
  row.appendChild(add);
  const x = document.createElement("button");
  x.type = "button";
  x.className = "p-x";
  x.textContent = "✕";
  x.title = `Delete group ${name} (chats stay in their projects)`;
  x.setAttribute("aria-label", `Delete group ${name}`);
  x.onclick = () => {
    const g = loadGroups();
    delete g[name];
    saveGroups(g);
    renderProjects();
    notify({ text: `Deleted group ${name}. Its chats stay in their projects.` });
  };
  row.appendChild(x);
  section.appendChild(row);
  if (!open) return section;
  const box = document.createElement("div");
  box.className = "project-chats";
  if (list.length === 0) {
    const e = document.createElement("div");
    e.className = "project-empty";
    e.textContent = q ? "No matches in this group." : "No chats yet. Right-click a chat to add it here.";
    box.appendChild(e);
  } else {
    for (const { info, project } of list) box.appendChild(chatButton(info, project));
  }
  section.appendChild(box);
  return section;
}
function openNewGroup(firstPath: string | null) {
  openModal("New group", (box, close) => {
    const lab = document.createElement("label");
    lab.textContent = "Group name";
    lab.setAttribute("for", "m-group");
    const inp = document.createElement("input");
    inp.id = "m-group";
    inp.placeholder = "e.g. launch-blockers";
    const row = document.createElement("div");
    row.className = "dialog-actions";
    const c = document.createElement("button");
    c.type = "button";
    c.textContent = "Cancel";
    c.onclick = close;
    const s = document.createElement("button");
    s.type = "button";
    s.textContent = "Create";
    s.className = "primary";
    s.onclick = () => {
      const name = inp.value.trim();
      close();
      if (!name) return;
      const g = loadGroups();
      if (!g[name]) g[name] = [];
      if (firstPath && !g[name].includes(firstPath)) g[name].push(firstPath);
      saveGroups(g);
      const closed = groupClosed();
      if (closed.delete(name)) saveGroupClosed(closed);
      renderProjects();
      notify({ text: firstPath ? `Created ${name} and added this chat.` : `Created group ${name}.` });
    };
    row.appendChild(c);
    row.appendChild(s);
    box.appendChild(lab);
    box.appendChild(inp);
    box.appendChild(row);
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) s.click();
    });
  });
}
async function newChatInGroup(group: string) {
  const groups = loadGroups();
  if (!groups[group]) return;
  const project = groupHomeProject(group, groups);
  const path = await newChatInProject(project);
  if (!path) return;
  const g = loadGroups();
  if (!g[group]) return;
  if (!g[group].includes(path)) { g[group].push(path); saveGroups(g); }
  notify({ text: `New chat in ${baseName(project)} · added to ${group}.` });
  renderProjects();
  renderSettled();
}
// A project's "Headless subagents" sub-folder: collapsed by default (open
// state remembered per project), opened automatically while searching.
function subagentFolder(project: string, list: SessionInfo[], q: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "subfolder";
  const open = !!q || subagentsOpen().has(project);
  const head = document.createElement("button");
  head.type = "button";
  head.className = "project-head subfolder-head" + (open ? " open" : "");
  head.setAttribute("aria-expanded", String(open));
  head.title = `Chats run by pi-agent in ${baseName(project)}`;
  const chev = document.createElement("span");
  chev.innerHTML = chevSvg();
  const name = document.createElement("span");
  name.className = "p-name";
  name.textContent = "Headless subagents";
  const running = list.filter((s) => runningSet.has(`${project}:${s.path}`) || !!activeAgentFor(s.path)).length;
  const count = document.createElement("span");
  count.className = "p-count";
  count.textContent = String(list.length);
  if (running) {
    const sp = document.createElement("span"); sp.className = "run-spin"; sp.setAttribute("role", "img"); sp.setAttribute("aria-label", `${running} running`);
    head.append(chev, name, sp, count);
  }
  if (!running) head.append(chev, name, count);
  head.onclick = () => toggleSubagentsOpen(project);
  wrap.appendChild(head);
  if (open) {
    const box = document.createElement("div");
    box.className = "project-chats";
    for (const s of list.slice(0, 50)) box.appendChild(chatButton(s, project));
    if (list.length > 50) {
      const more = document.createElement("div");
      more.className = "project-empty";
      more.textContent = `${list.length - 50} more — search to find older ones.`;
      box.appendChild(more);
    }
    wrap.appendChild(box);
  }
  return wrap;
}
function renderProjectsParent(q: string, isOpen: boolean) {
  const projects = getProjects();
  const section = document.createElement("div");
  section.className = "parent-section";
  section.setAttribute("role", "group");
  section.setAttribute("aria-label", "Projects");
  section.appendChild(parentHead("Projects", "projects", isOpen, miniButton("+", "Add project folder", openAddProject)));
  chatListEl.appendChild(section);
  if (!isOpen) return;
  const projSection = document.createElement("div");
  projSection.className = "parent-body";
  section.appendChild(projSection);
  if (projects.length === 0) {
    const d = document.createElement("div");
    d.className = "list-empty";
    const p = document.createElement("p");
    p.textContent = "No projects yet. Add one to see its chats.";
    d.appendChild(p);
    projSection.appendChild(d);
    return;
  }
  for (const p of projects) {
    const all = projectChats.get(p) ?? (p === cwd ? sessions : []);
    const list = all.filter((s) => !isHeadless(s) && chatMatches(s, q));
    const subList = all.filter((s) => isHeadless(s) && chatMatches(s, q));
    const section = document.createElement("div");
    section.className = "project-section";
    section.setAttribute("role", "group");
    section.setAttribute("aria-label", p);
    const row = document.createElement("div");
    row.className = "p-row";
    const head = document.createElement("button");
    head.type = "button";
    head.className = "project-head";
    const open = !!q || expandedProjects.has(p);
    if (open) head.classList.add("open");
    head.setAttribute("aria-expanded", String(open));
    head.title = p;
    const chev = document.createElement("span");
    chev.innerHTML = chevSvg();
    const name = document.createElement("span");
    name.className = "p-name";
    name.textContent = baseName(p);
    const count = document.createElement("span");
    count.className = "p-count";
    count.textContent = String(list.length);
    head.appendChild(chev);
    head.appendChild(name);
    head.appendChild(count);
    head.onclick = () => {
      if (expandedProjects.has(p)) expandedProjects.delete(p);
      else expandedProjects.add(p);
      saveExpanded();
      renderProjects();
    };
    row.appendChild(head);
    const add = document.createElement("button");
    add.type = "button";
    add.className = "p-add";
    add.textContent = "+";
    add.title = `New chat in ${baseName(p)}`;
    add.setAttribute("aria-label", `New chat in ${baseName(p)}`);
    add.onclick = () => newChatInProject(p);
    row.appendChild(add);
    if (p !== cwd) {
      const x = document.createElement("button");
      x.type = "button";
      x.className = "p-x";
      x.textContent = "✕";
      x.title = `Remove ${baseName(p)} from the list`;
      x.setAttribute("aria-label", `Remove ${baseName(p)} from the list`);
      x.onclick = () => removeProject(p);
      row.appendChild(x);
    }
    section.appendChild(row);
    if (open) {
      const box = document.createElement("div");
      box.className = "project-chats";
      if (list.length === 0) {
        if (!subList.length) {
          const e = document.createElement("div");
          e.className = "project-empty";
          e.textContent = q ? "No matches in this project." : "No chats yet.";
          box.appendChild(e);
        }
      } else if (p === cwd) {
        // Bounded visible window over the full session list: search filters across
        // every session the backend returned (paths are real), paging keeps the DOM
        // small no matter how many chats exist.
        visibleLimit = Math.min(visibleLimit, Math.max(100, Math.ceil(list.length / 100) * 100));
        const capped = list.slice(visibleLimit - 100, visibleLimit);
        for (const s of capped) box.appendChild(chatButton(s, p));
        if (list.length > 100) {
          const nav = document.createElement("div"); nav.className = "list-empty";
          const label = document.createElement("p"); label.textContent = `${visibleLimit - 99}–${Math.min(visibleLimit, list.length)} of ${list.length}`;
          nav.appendChild(label);
          for (const [text, step] of [["Previous chats", -100], ["Older chats", 100]] as const) {
            const b = document.createElement("button"); b.type = "button"; b.className = "text-btn"; b.textContent = text;
            b.disabled = step < 0 ? visibleLimit === 100 : visibleLimit >= list.length;
            b.onclick = () => { visibleLimit += step; renderProjects(); chatListEl.scrollTop = 0; chatListEl.querySelector<HTMLButtonElement>(".chat-item")?.focus(); };
            nav.appendChild(b);
          }
          box.appendChild(nav);
        }
      } else {
        for (const s of list.slice(0, 100)) box.appendChild(chatButton(s, p));
        if (list.length > 100) {
          const more = document.createElement("div");
          more.className = "project-empty";
          more.textContent = `${list.length - 100} more — refine search or open the project.`;
          box.appendChild(more);
        }
      }
      // Folder before files: the sub-folder leads, so it never hides below
      // a long (paged) chat list.
      if (subList.length) box.prepend(subagentFolder(p, subList, q));
      section.appendChild(box);
    }
    projSection.appendChild(section);
  }
  const hidden = hiddenProjects();
  for (const u of unlinked) {
    if (hidden.has(u.slug)) continue;
    const list = u.sessions.filter((s) => chatMatches(s, q));
    if (q && list.length === 0) continue;
    const section = document.createElement("div");
    section.className = "project-section";
    section.setAttribute("role", "group");
    section.setAttribute("aria-label", u.slug);
    const row = document.createElement("div");
    row.className = "p-row";
    const head = document.createElement("button");
    head.type = "button";
    head.className = "project-head open";
    head.setAttribute("aria-expanded", "true");
    head.title = `Original folder not found (${u.slug})`;
    const chev = document.createElement("span");
    chev.innerHTML = chevSvg();
    const name = document.createElement("span");
    name.className = "p-name";
    name.textContent = u.slug;
    const count = document.createElement("span");
    count.className = "p-count";
    count.textContent = String(list.length);
    head.appendChild(chev);
    head.appendChild(name);
    head.appendChild(count);
    head.onclick = () => {
      notify({ text: `These chats live in ${u.slug}, but that folder no longer exists, so they can't be resumed.` });
    };
    row.appendChild(head);
    const x = document.createElement("button");
    x.type = "button";
    x.className = "p-x";
    x.textContent = "✕";
    x.title = "Hide these chats";
    x.setAttribute("aria-label", `Hide chats from ${u.slug}`);
    x.onclick = () => {
      const h = hiddenProjects();
      h.add(u.slug);
      prefSet("pi-hidden-projects", JSON.stringify([...h]));
      renderProjects();
    };
    row.appendChild(x);
    section.appendChild(row);
    const box = document.createElement("div");
    box.className = "project-chats";
    if (list.length === 0) {
      const e = document.createElement("div");
      e.className = "project-empty";
      e.textContent = "No chats.";
      box.appendChild(e);
    } else {
      for (const s of list.slice(0, 100)) {
        const b = chatButton(s, "");
        b.disabled = true;
        b.title = "Original folder not found";
        box.appendChild(b);
      }
    }
    section.appendChild(box);
    projSection.appendChild(section);
  }
}

chatListEl.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const items = Array.from(chatListEl.querySelectorAll<HTMLButtonElement>(".chat-item, .agent-item"));
  if (items.length === 0) return;
  e.preventDefault();
  const i = items.indexOf(document.activeElement as HTMLButtonElement);
  // ↑ from the first result returns to search when it holds a query.
  if (e.key === "ArrowUp" && i === 0 && searchEl.value) { searchEl.focus(); return; }
  const next = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
  items[next].focus();
});

// ---------- chat context menu (right-click): groups ----------
interface CtxTarget { path: string; project: string | null; inGroup: string | null }
function openChatMenu(x: number, y: number, target: CtxTarget) {
  closeMenu();
  lastFocus = document.activeElement as HTMLElement;
  const menu = document.createElement("div");
  menu.className = "menu ctx-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Chat actions");
  const buttons: HTMLButtonElement[] = [];
  let sub: HTMLElement | null = null;
  const clearSubTimer = () => { if (ctxSubTimer !== null) { clearTimeout(ctxSubTimer); ctxSubTimer = null; } };
  const hideSub = () => { clearSubTimer(); sub?.remove(); sub = null; trigger.setAttribute("aria-expanded", "false"); };
  const addItem = (label: string, onPick: () => void, checked?: boolean, keepOpen?: boolean) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "menu-item";
    b.setAttribute("role", "menuitem");
    const check = document.createElement("span");
    check.className = "check";
    check.textContent = checked ? "✓" : "";
    const lab = document.createElement("span");
    lab.textContent = label;
    b.appendChild(check);
    b.appendChild(lab);
    b.onclick = () => { if (keepOpen) onPick(); else { closeMenu(); onPick(); } };
    menu.appendChild(b);
    buttons.push(b);
    return b;
  };
  const showSub = (anchor: HTMLButtonElement) => {
    clearSubTimer();
    hideSub();
    const groups = loadGroups();
    const names = Object.keys(groups);
    sub = document.createElement("div");
    sub.className = "menu ctx-sub";
    sub.setAttribute("role", "menu");
    sub.setAttribute("aria-label", "Groups");
    const subBtns: HTMLButtonElement[] = [];
    const mk = (label: string, onPick: () => void, checked?: boolean) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "menu-item";
      b.setAttribute("role", "menuitem");
      const check = document.createElement("span");
      check.className = "check";
      check.textContent = checked ? "✓" : "";
      const lab = document.createElement("span");
      lab.textContent = label;
      b.appendChild(check);
      b.appendChild(lab);
      b.onclick = () => { closeMenu(); onPick(); };
      sub!.appendChild(b);
      subBtns.push(b);
      return b;
    };
    if (names.length === 0) {
      const e = document.createElement("div");
      e.className = "menu-note";
      e.textContent = "No groups yet.";
      sub.appendChild(e);
    }
    for (const n of names) mk(n, () => toggleGroupMember(n, target.path), groups[n].includes(target.path));
    mk("＋ New group", () => openNewGroup(target.path));
    menuRoot.appendChild(sub);
    const r = anchor.getBoundingClientRect();
    const w = 220;
    sub.style.minWidth = `${w}px`;
    const sh = Math.min(sub.offsetHeight || 200, window.innerHeight - 16);
    sub.style.top = `${Math.max(8, Math.min(r.top - 6, window.innerHeight - sh - 8))}px`;
    const left = r.right + 6;
    sub.style.left = `${left + w > window.innerWidth - 8 ? Math.max(8, r.left - w - 6) : left}px`;
    let sidx = 0;
    sub.addEventListener("mouseenter", clearSubTimer);
    sub.addEventListener("mouseleave", (e) => {
      if (e.relatedTarget instanceof Node && anchor.contains(e.relatedTarget)) return;
      hideSub();
    });
    sub.addEventListener("keydown", (e) => {
      if (e.key === "Escape" || e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); hideSub(); anchor.focus(); }
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const cur = subBtns.indexOf(document.activeElement as HTMLButtonElement);
        if (cur !== -1) sidx = cur;
        sidx = e.key === "ArrowDown" ? (sidx + 1) % subBtns.length : (sidx - 1 + subBtns.length) % subBtns.length;
        subBtns[sidx].focus();
      }
      else if (e.key === "Tab") { closeMenu(); }
    });
    anchor.setAttribute("aria-expanded", "true");
    return subBtns;
  };
  if (target.project) addItem("Open chat", () => openChat(target.project!, target.path));
  addItem("Rename chat", () => {
    const pcwd = target.project ?? findProjectForPath(target.path) ?? cwd;
    openRename({ cwd: pcwd, session: target.path, current: rowName(pcwd, target.path) });
  });
  if (target.inGroup) addItem(`Remove from ${target.inGroup}`, () => removeFromGroup(target.inGroup!, target.path));
  // Headless subagent chats stay in their own section: no groups.
  const groupable = !headlessPath(target.path);
  const trigger = addItem("Add to group ›", () => {
    if (sub) hideSub();
    else { const btns = showSub(trigger); btns[0]?.focus(); }
  }, false, true);
  if (!groupable) { trigger.remove(); buttons.splice(buttons.indexOf(trigger), 1); }
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  trigger.addEventListener("mouseenter", () => { clearSubTimer(); if (groupable && !sub) showSub(trigger); });
  trigger.addEventListener("mouseleave", () => {
    clearSubTimer();
    ctxSubTimer = window.setTimeout(hideSub, 150);
  });
  menuRoot.appendChild(menu);
  const w = 240, h = Math.min(menu.offsetHeight || 200, window.innerHeight - 16);
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - h - 8))}px`;
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - w - 8))}px`;
  menu.style.minWidth = `${w}px`;
  let idx = 0;
  buttons[0]?.focus();
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); idx = (idx + 1) % buttons.length; buttons[idx].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); idx = (idx - 1 + buttons.length) % buttons.length; buttons[idx].focus(); }
    else if (e.key === "ArrowRight" && document.activeElement === trigger) {
      e.preventDefault();
      const btns = sub ? Array.from(sub.querySelectorAll<HTMLButtonElement>("button")) : showSub(trigger);
      btns[0]?.focus();
    }
    else if (e.key === "Tab") { closeMenu(); }
  });
  menuOutside = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node) && !(sub && sub.contains(e.target as Node))) closeMenu();
  };
  document.addEventListener("mousedown", menuOutside);
}
function toggleGroupMember(name: string, path: string) {
  const g = loadGroups();
  if (!g[name]) return;
  if (g[name].includes(path)) {
    g[name] = g[name].filter((p) => p !== path);
    notify({ text: `Removed from ${name}.` });
  } else {
    g[name].push(path);
    notify({ text: `Added to ${name}.` });
  }
  saveGroups(g);
  renderProjects();
}
function removeFromGroup(name: string, path: string) {
  const g = loadGroups();
  if (!g[name]) return;
  g[name] = g[name].filter((p) => p !== path);
  saveGroups(g);
  notify({ text: `Removed from ${name}.` });
  renderProjects();
}
async function newCodedChat(opts: { name: string; group?: string; firstMessage?: string }): Promise<string | null> {
  const name = opts.name.trim();
  if (!name) return null;
  if (navigating || booting || sendInFlight) { notify({ text: "One moment — try again when idle." }); return null; }
  if (dialogs.size) { notify({ text: "Answer the pending request before creating a chat." }); return null; }
  const first = opts.firstMessage?.trim();
  let path: string;
  try {
    const r = await invokeChecked<{ path: string }>("pi_coded_chat", {
      cwd, name, first_message: first ? first : null,
    });
    path = r.path;
  } catch (e) {
    notify({ text: `Couldn't make coded chat: ${String(e)}`, kind: "error", sticky: true });
    return null;
  }
  // Item-5 refresh never fires for coded chats (no submit/settle), so list
  // first and only claim group/badge for a path that's actually there (R2-F2).
  await refreshSessions();
  await refreshAllProjects();
  const listed = [...projectChats.values()].some((list) => list.some((s) => s.path === path));
  if (!listed) { notify({ text: "Chat was made but isn't listed yet — reopen the project.", kind: "error" }); return null; }
  if (!isCoded(`${CODE_PREFIX} ${name}`, path)) saveCoded([...codedSet(), path]);
  const group = opts.group?.trim();
  if (group) {
    const g = loadGroups();
    if (!g[group]) g[group] = [];
    if (!g[group].includes(path)) g[group].push(path);
    saveGroups(g);
  }
  renderProjects();
  await openSession(cwd, path);
  return path;
}
function openNewCodedChat() {
  openModal("New coded chat", (box, close) => {
    const mkField = (label: string, id: string, ph: string) => {
      const lab = document.createElement("label");
      lab.textContent = label;
      lab.setAttribute("for", id);
      const inp = document.createElement("input");
      inp.id = id;
      inp.placeholder = ph;
      box.append(lab, inp);
      return inp;
    };
    const nameInp = mkField("Name", "cc-name", "e.g. nightly-review");
    const groupInp = mkField("Group (optional)", "cc-group", "e.g. agents");
    const mLab = document.createElement("label");
    mLab.textContent = "First message (optional)";
    mLab.setAttribute("for", "cc-msg");
    const msgInp = document.createElement("textarea");
    msgInp.id = "cc-msg";
    msgInp.rows = 3;
    msgInp.placeholder = "Sent as the first prompt";
    box.append(mLab, msgInp);
    const row = document.createElement("div");
    row.className = "dialog-actions";
    const c = document.createElement("button");
    c.type = "button";
    c.textContent = "Cancel";
    c.onclick = close;
    const s = document.createElement("button");
    s.type = "button";
    s.textContent = "Create";
    s.className = "primary";
    s.onclick = async () => {
      const name = nameInp.value.trim();
      if (!name) { nameInp.focus(); return; }
      close();
      await newCodedChat({ name, group: groupInp.value, firstMessage: msgInp.value });
    };
    row.append(c, s);
    box.appendChild(row);
    nameInp.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) s.click(); });
  });
}
chatListEl.addEventListener("contextmenu", (e) => {
  const agentEl = (e.target as HTMLElement).closest(".agent-item") as HTMLElement | null;
  if (agentEl) {
    const a = agents.find((x) => x.id === agentEl.dataset.agentId);
    if (a) { e.preventDefault(); openAgentMenu(e.clientX, e.clientY, a); }
    return;
  }
  const item = (e.target as HTMLElement).closest(".chat-item") as HTMLElement | null;
  if (!item || !item.dataset.path) {
    // Empty sidebar background: offer creation instead of nothing.
    if ((e.target as HTMLElement).closest("button,input,.parent-body")) return;
    e.preventDefault();
    openMenu([{ label: "New coded chat…", onPick: openNewCodedChat }], { left: e.clientX, top: e.clientY }, "Sidebar");
    return;
  }
  e.preventDefault();
  const groupSection = item.closest(".group-section") as HTMLElement | null;
  openChatMenu(e.clientX, e.clientY, {
    path: item.dataset.path,
    project: item.dataset.project ?? null,
    inGroup: groupSection?.dataset.group ?? null,
  });
});

type Block =
  | { t: "text"; text: string; key: string; images?: { data: string; mime: string }[] }
  | { t: "thinking"; text: string; key: string }
  | { t: "tool"; id: string; name: string; args: unknown; output: string; isError: boolean; key: string; state?: string }
  | { t: "bash"; command: string; output: string; exitCode: number; key: string }
  | { t: "user"; text: string; images: { data: string; mime: string }[]; key: string; failed?: FailedSend; ts?: number };
function blocks(): Block[] {
  const out: Block[] = [];
  const results = new Map(messages.filter(m => m.role === "toolResult").map(m => [m.toolCallId, m]));
  const calls = new Set<string>();
  messages.forEach((m, i) => {
    const key = `m-${i}`;
    if (m.role === "user") out.push({ t: "user", key, text: msgText(m), images: imgsOf(m), ts: typeof m.timestamp === "number" && m.timestamp > 1e11 ? m.timestamp : undefined });
    if (m.role === "assistant" || (m.role === "custom" && m.display !== false)) {
      const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content ?? [];
      content.forEach((c, ci) => {
        const k = `${key}-${ci}`;
        if (c.type === "text") out.push({ t: "text", key: k, text: c.text ?? "" });
        if (c.type === "thinking") out.push({ t: "thinking", key: k, text: c.thinking ?? "" });
        if (c.type === "image") out.push({ t: "text", key: k, text: "", images: imgList([c]) });
        if (c.type === "toolCall") {
          const id = c.id ?? k; calls.add(id);
          const r = results.get(id), live = conversation.tools.get(id);
          out.push({ t: "tool", key: `tool-${id}`, id, name: c.name ?? "tool", args: c.arguments,
            output: r ? msgText(r) : live?.output ?? "", isError: r?.isError ?? live?.isError ?? false,
            state: r ? r.isError ? "failed" : "done" : live?.state ?? (streaming ? "running" : "done") });
        }
      });
      const attached = imgList(m.attachments);
      if (attached.length) out.push({ t: "text", key: `${key}-images`, text: "", images: attached });
      // An aborted turn (Esc, or switching chats mid-run) is an intentional stop,
      // never a failure: render it as a quiet note instead of the error card.
      if (m.stopReason === "aborted") out.push({ t: "text", key: `${key}-stopped`, text: "*Turn stopped.*" });
      else if (m.stopReason === "error" || m.errorMessage) out.push({ t: "text", key: `${key}-error`, text: `**Response failed**\n\n${String(m.errorMessage ?? "The model could not finish. Please try again.")}` });
    }
    if (m.role === "toolResult" && !calls.has(String(m.toolCallId))) out.push({ t: "tool", id: String(m.toolCallId), key, name: m.toolName ?? "tool", args: {}, output: msgText(m), isError: !!m.isError, state: m.isError ? "failed" : "done" });
    if (m.role === "bashExecution") out.push({ t: "bash", key, command: m.command ?? "", output: m.output ?? "", exitCode: m.exitCode ?? 0 });
  });
  if (pendingSend) out.push({ t: "user", key: `m-${pendingSend.index}`, text: pendingSend.text, images: pendingSend.images.map(im => ({ data: im.data, mime: im.mimeType })) });
  for (const f of failedSends()) out.push({ t: "user", key: f.id, text: f.text, images: f.images.map(im => ({ data: im.data, mime: im.mimeType })), failed: f });
  return out;
}

// ---------- settled render (stable: preserves expansion, scroll, focus) ----------
function chevSvg(): string {
  return `<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`;
}

const updateTool = new WeakMap<HTMLElement, (b: Extract<Block, {t: "tool"}>) => void>();
function toolDisclosure(initial: Extract<Block, {t: "tool"}>): HTMLElement {
  let b = initial, showFull = false;
  const wrap = document.createElement("div"); wrap.className = "tool-disclosure";
  const btn = document.createElement("button"); btn.type = "button"; btn.className = "tool-toggle";
  btn.innerHTML = chevSvg() + '<span class="t-state"></span><span class="t-summary"><span class="t-lead"></span><span class="t-rest"></span></span>';
  btn.dataset.tool = b.key;
  const detail = document.createElement("div"); detail.className = "tool-detail";
  const args = document.createElement("pre"); args.className = "tool-args";
  const output = document.createElement("div"); output.className = "tool-output";
  const actions = document.createElement("div"); actions.className = "tool-detail-actions";
  const more = document.createElement("button"); more.type = "button";
  const copy = document.createElement("button"); copy.type = "button"; copy.textContent = "Copy output";
  actions.append(more, copy); detail.append(args, output, actions); wrap.append(btn, detail);
  const render = (next: typeof b) => {
    b = next;
    wrap.dataset.routine = String(!b.isError); wrap.dataset.failed = String(b.isError);
    btn.dataset.state = b.state ?? (b.isError ? "failed" : "done");
    const summary = toolSummary(b.name, b.args);
    const rest = `${summary.rest ? summary.rest.slice(0, 90) : ""}${b.isError ? (summary.rest ? " · failed" : "failed") : ""}`;
    const lead = btn.querySelector(".t-lead")!, restEl = btn.querySelector(".t-rest")!;
    if (lead.textContent !== summary.lead) lead.textContent = summary.lead;
    if (restEl.textContent !== rest) restEl.textContent = rest;
    btn.title = summary.rest ? `${summary.lead} · ${summary.rest}` : summary.lead;
    const a = typeof b.args === "string" ? b.args : JSON.stringify(b.args ?? {}, null, 2);
    if (args.textContent !== a) args.textContent = a;
    args.classList.toggle("hidden", !a || a === "{}");
    const t = truncateOutput(b.output), text = showFull ? b.output : t.visible;
    if (output.textContent !== text) output.textContent = text;
    output.classList.toggle("hidden", !b.output); actions.classList.toggle("hidden", !b.output);
    more.classList.toggle("hidden", showFull || !t.truncated); more.textContent = `Show full output (${t.totalLines} lines)`;
    const open = expandedTools.has(b.key); btn.setAttribute("aria-expanded", String(open)); detail.classList.toggle("hidden", !open);
  };
  btn.onclick = () => { if (expandedTools.has(b.key)) expandedTools.delete(b.key); else expandedTools.add(b.key); render(b); };
  more.onclick = () => { showFull = true; render(b); };
  copy.onclick = async () => { try { await navigator.clipboard.writeText(b.output); copy.textContent = "Copied"; } catch { copy.textContent = "Copy failed"; } setTimeout(() => copy.textContent = "Copy output", 1200); };
  updateTool.set(wrap, render); render(b); return wrap;
}
function bashDisclosure(b: Extract<Block, {t: "bash"}>): HTMLElement {
  return toolDisclosure({ t: "tool", id: b.key, key: b.key, name: "bash", args: { command: b.command }, output: b.output, isError: b.exitCode !== 0, state: b.exitCode ? "failed" : "done" });
}

function thinkLabel(text: string): string {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return words ? `Thinking · ${words.toLocaleString()} word${words === 1 ? "" : "s"}` : "Thinking";
}
function thinkDisclosure(text: string, key: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "think-disclosure";
  wrap.dataset.routine = "true";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "think-toggle";
  const open = showThinkingFor.has(key);
  btn.setAttribute("aria-expanded", String(open));
  btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`;
  const lab = document.createElement("span");
  lab.className = "think-label";
  lab.textContent = thinkLabel(text);
  btn.appendChild(lab);
  const body = document.createElement("div");
  body.className = "think-body" + (open ? " open" : "");
  if (!open) body.classList.add("hidden");
  body.textContent = text;
  btn.onclick = () => {
    const willOpen = body.classList.contains("hidden") && !body.classList.contains("open");
    body.classList.toggle("hidden", !willOpen ? true : false);
    body.classList.toggle("open", willOpen);
    if (willOpen) showThinkingFor.add(key);
    else showThinkingFor.delete(key);
    btn.setAttribute("aria-expanded", String(willOpen));
  };
  wrap.appendChild(btn);
  wrap.appendChild(body);
  return wrap;
}

// Markdown ![alt](path) placeholders resolve to real images. Local files go
// through pi_read_image (allowlisted types, 10MB cap); https loads directly;
// anything else degrades to a link so a weird path never eats content.
const MD_IMG_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);
const mdImgCache = new Map<string, string>();
const mdImgFlight = new Map<string, Promise<string>>();
function capMdImgCache() {
  while (mdImgCache.size > 50) {
    const first = mdImgCache.keys().next().value as string | undefined;
    if (first === undefined) break;
    mdImgCache.delete(first);
  }
}
// Resolved-path keying: two chats often reference the same relative name
// (shot.png), so the cache must key on cwd + path, never the raw token.
function mdFullPath(raw: string): string | null {
  if (/^https:\/\//i.test(raw)) return raw;
  if (/^(http:\/\/|data:|javascript:|file:|~)/i.test(raw)) return null;
  return raw.startsWith("/") ? raw : `${cwd}/${raw}`;
}
function mdFallback(img: HTMLImageElement, raw: string) {
  const alt = img.alt || "image";
  const label = alt && alt !== "image" ? `${alt} (${raw})` : raw;
  if (/^https?:\/\//i.test(raw)) {
    const a = document.createElement("a");
    a.href = raw;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.className = "md-img-fallback";
    a.textContent = label;
    img.replaceWith(a);
  } else {
    const s = document.createElement("span");
    s.className = "md-img-fallback";
    s.textContent = label;
    s.title = raw;
    img.replaceWith(s);
  }
}
function resolveMdImages(root: ParentNode) {
  const imgs = root.querySelectorAll<HTMLImageElement>("img.md-img[data-path]:not([data-done])");
  for (const img of imgs) {
    img.dataset.done = "1";
    const raw = img.dataset.path ?? "";
    const full = mdFullPath(raw);
    if (!full) { mdFallback(img, raw); continue; }
    const hit = mdImgCache.get(full);
    if (hit) {
      img.src = hit;
      img.addEventListener("click", () => img.classList.toggle("full"));
      continue;
    }
    void loadMdImage(img, raw, full);
  }
}
async function loadMdImage(img: HTMLImageElement, raw: string, full: string) {
  const fallback = () => mdFallback(img, raw);
  if (/^https:\/\//i.test(full)) {
    img.src = raw;
    img.addEventListener("click", () => img.classList.toggle("full"));
    img.addEventListener("error", fallback, { once: true });
    return;
  }
  const ext = full.split(".").pop()?.toLowerCase() ?? "";
  if (!MD_IMG_EXTS.has(ext)) { fallback(); return; }
  try {
    let flight = mdImgFlight.get(full);
    if (!flight) {
      flight = invoke<{ mime: string; data: string }>("pi_read_image", { path: full }).then((r) => `data:${r.mime};base64,${r.data}`);
      mdImgFlight.set(full, flight);
    }
    const url = await flight;
    mdImgFlight.delete(full);
    mdImgCache.set(full, url);
    capMdImgCache();
    if (img.isConnected) {
      img.src = url;
      img.addEventListener("click", () => img.classList.toggle("full"));
      img.addEventListener("error", fallback, { once: true });
    }
  } catch {
    mdImgFlight.delete(full);
    if (img.isConnected) fallback();
  }
}
// Clickable chat paths (idea 2): .md/.html tokens become buttons that open
// via the allowlisted backend command. Fenced code and real links are left
// alone; inline `code` is included because that is how pi usually prints a
// path. NOTE: this runs on a detached tree (the block is appended after), so
// never test isConnected here — only whether the node still has a parent.
// A fresh regex per pass: a shared /g/ instance carries lastIndex between
// test() and matchAll(), which is easy to get wrong later.
const pathTokenRe = () => /(^|[\s("'\[>])([\w.~\-/]+\.(md|html))\b/gi;
function linkifyPaths(root: ParentNode) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  while (walker.nextNode()) {
    const n = walker.currentNode as Text;
    const p = n.parentElement;
    if (!p || p.closest("pre,a,button")) continue;
    if (pathTokenRe().test(n.data)) targets.push(n);
  }
  for (const n of targets) {
    if (!n.parentNode) continue;
    const inCode = n.parentElement?.tagName === "CODE";
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of n.data.matchAll(pathTokenRe())) {
      const idx = m.index ?? 0;
      const raw = m[2] ?? "";
      if (!raw || raw.includes("://")) continue;
      frag.append(n.data.slice(last, idx) + (m[1] ?? ""));
      const b = document.createElement("button");
      b.type = "button";
      b.className = "path-link" + (inCode ? " in-code" : "");
      b.textContent = raw;
      b.dataset.openPath = raw;
      b.title = `Open ${raw}`;
      frag.append(b);
      last = idx + m[0].length;
    }
    frag.append(n.data.slice(last));
    n.replaceWith(frag);
  }
}
// Markdown links: a webview ignores target=_blank, so hand http(s) links to
// the OS opener (granted by opener:default). The browser preview falls back.
messagesInner.addEventListener("click", async (e) => {
  const a = (e.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
  if (!a) return;
  const href = a.getAttribute("href") ?? "";
  if (!/^https?:\/\//i.test(href)) return;
  e.preventDefault();
  try {
    await invoke("plugin:opener|open_url", { url: href });
  } catch {
    window.open(href, "_blank", "noopener,noreferrer");
  }
});
messagesInner.addEventListener("click", async (e) => {
  const b = (e.target as HTMLElement).closest("[data-open-path]") as HTMLElement | null;
  if (!b) return;
  const raw = b.dataset.openPath ?? "";
  // Direct call with explicit cwd: opening a file must never spawn a pi process.
  try {
    await invokeChecked("pi_open_path", { cwd, path: raw });
  } catch (err) {
    notify({ text: `Couldn't open ${raw}: ${String(err)}`, kind: "error" });
  }
});
function assistantTextBlock(text: string, key: string, images?: { data: string; mime: string }[]): HTMLElement {
  const div = document.createElement("div");
  div.className = "assistant-block";
  if (text) {
    const md = document.createElement("div");
    md.className = "md";
    md.innerHTML = renderMarkdown(text);
    resolveMdImages(md);
    linkifyPaths(md);
    div.appendChild(md);
  }
  for (const im of images ?? []) {
    const img = document.createElement("img");
    img.className = "msg-img";
    img.alt = "attached image";
    img.src = `data:${im.mime};base64,${im.data}`;
    img.addEventListener("click", () => img.classList.toggle("full"));
    div.appendChild(img);
  }
  fullTextByKey.set(key, text);
  if (text) {
    const row = document.createElement("div");
    row.className = "msg-actions";
    row.appendChild(gutterButton(COPY_ICON, "Copy message", (b) => copyWithFeedback(b, fullTextByKey.get(key) ?? "")));
    div.appendChild(row);
  }
  return div;
}

// Gutter actions: icon buttons beside a message that take no layout space.
const COPY_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/></svg>`;
const CHECK_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>`;
const EDIT_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 19.5h4l10-10a2.1 2.1 0 0 0-3-3l-10 10Z"/><path d="m13.5 8 2.5 2.5"/></svg>`;
function gutterButton(icon: string, label: string, onClick: (b: HTMLButtonElement) => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "gutter-btn";
  b.innerHTML = icon;
  b.title = label;
  b.setAttribute("aria-label", label);
  b.onclick = (e) => { e.stopPropagation(); onClick(b); };
  return b;
}
async function copyWithFeedback(b: HTMLButtonElement, text: string) {
  const icon = b.innerHTML, label = b.title;
  try {
    await navigator.clipboard.writeText(text);
    b.innerHTML = CHECK_ICON;
    b.title = "Copied";
    b.classList.add("ok");
  } catch {
    b.title = "Copy failed";
  }
  setTimeout(() => { b.innerHTML = icon; b.title = label; b.classList.remove("ok"); }, 1200);
}

function userBlock(text: string, images: { data: string; mime: string }[], failed: string | null, onRetry?: () => void, ts?: number): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "user-block";
  const col = document.createElement("div");
  col.className = "user-col";
  if (ts) col.title = `Sent ${new Date(ts).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
  if (text && !failed) {
    const acts = document.createElement("div");
    acts.className = "msg-actions user-actions";
    acts.append(
      gutterButton(EDIT_ICON, "Edit in composer", () => putInComposer(text)),
      gutterButton(COPY_ICON, "Copy message", (b) => copyWithFeedback(b, text)),
    );
    col.appendChild(acts);
  }
  col.style.maxWidth = text.length < 140 && !text.includes("\n") ? "80%" : "100%";
  if (text) {
    const b = document.createElement("div");
    b.className = "user-bubble" + (text.length < 140 && !text.includes("\n") ? " short" : "") + (failed ? " failed" : "");
    b.textContent = text;
    col.appendChild(b);
  }
  for (const im of images) {
    const img = document.createElement("img");
    img.className = "msg-img";
    img.alt = "attached image";
    img.src = `data:${im.mime};base64,${im.data}`;
    img.addEventListener("click", () => img.classList.toggle("full"));
    col.appendChild(img);
  }
  if (failed) {
    const meta = document.createElement("div");
    meta.className = "user-meta";
    const lab = document.createElement("span");
    lab.className = "fail-label";
    lab.textContent = `Not sent — ${failed}`;
    const r = document.createElement("button");
    r.type = "button";
    r.className = "retry-btn";
    r.textContent = "Retry";
    r.onclick = () => onRetry?.();
    meta.appendChild(lab);
    meta.appendChild(r);
    col.appendChild(meta);
  }
  wrap.appendChild(col);
  return wrap;
}

const rendered = new Map<string, { node: HTMLElement; block: Block }>();
function sameBlock(a: Block, b: Block): boolean {
  const aa = a as unknown as Record<string, unknown>, bb = b as unknown as Record<string, unknown>;
  return Object.keys(bb).every(k => {
    if (k !== "images") return aa[k] === bb[k];
    const x = aa[k] as {data:string;mime:string}[] | undefined, y = bb[k] as {data:string;mime:string}[] | undefined;
    return (x?.length ?? 0) === (y?.length ?? 0) && (x ?? []).every((im,i) => im.data === y![i].data && im.mime === y![i].mime);
  });
}
function resetView() {
  rendered.clear(); fullTextByKey.clear(); expandedTools.clear(); showThinkingFor.clear();
  messagesInner.replaceChildren();
}
// ---------- new-chat context badges: project + groups, both changeable ----------
function chatContextBar(): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "ctx-bar";
  const pb = document.createElement("button");
  pb.type = "button";
  pb.className = "ctx-badge";
  const pk = document.createElement("span");
  pk.className = "ctx-kind";
  pk.textContent = "project";
  const pn = document.createElement("span");
  pn.textContent = baseName(cwd);
  pb.appendChild(pk);
  pb.appendChild(pn);
  pb.title = `Project folder: ${cwd} — click to change`;
  pb.setAttribute("aria-label", `Project ${baseName(cwd)}. Activate to change project.`);
  pb.onclick = () => openProjectPickerModal(cwd, "Start chat here", (dir) => { void pickProjectDir(dir); });
  if (cwd) bar.appendChild(pb);
  const groups = loadGroups();
  const ap = activePath;
  const memberOf = ap ? Object.keys(groups).filter((n) => groups[n].includes(ap)) : [];
  const shown: (string | null)[] = headlessPath(ap) ? [] : memberOf.length > 0 ? memberOf : [null];
  for (const n of shown) {
    const gb = document.createElement("button");
    gb.type = "button";
    gb.className = "ctx-badge";
    const gk = document.createElement("span");
    gk.className = "ctx-kind";
    gk.textContent = "group";
    const gn = document.createElement("span");
    gn.textContent = n ?? "+ Add";
    gb.appendChild(gk);
    gb.appendChild(gn);
    gb.title = n ? `Group ${n} — click to change` : "Add this chat to a group";
    gb.setAttribute("aria-label", n ? `Group ${n}. Activate to change groups.` : "No group. Activate to add this chat to a group.");
    gb.onclick = () => openGroupPicker(gb);
    bar.appendChild(gb);
  }
  bar.appendChild(ctxCircle);
  return bar;
}
async function pickProjectDir(dir: string) {
  await registerAddedProject(dir);
  await newChatInProject(dir);
}
function openGroupPicker(anchor: HTMLElement) {
  if (headlessPath(activePath)) { notify({ text: "Headless subagent chats stay in their own section and can't join groups." }); return; }
  if (!activePath) { notify({ text: "Start or open a chat first — groups need a session to hold." }); return; }
  const path = activePath;
  const groups = loadGroups();
  const items: (MenuItem | "sep")[] = Object.keys(groups).map((n) => ({
    label: n,
    checked: groups[n].includes(path),
    onPick: () => { toggleGroupMember(n, path); renderSettled(); },
  }));
  items.push("sep", { label: "＋ New group", onPick: () => openNewGroup(path) });
  const r = anchor.getBoundingClientRect();
  openMenu(items, { left: r.left, top: r.bottom + 6 }, "Choose groups");
}
function renderChatContext() { chatContextEl.replaceChildren(chatContextBar()); }
// Boot: a skeleton of the transcript instead of a spinner (AGENTS: no
// spinners where a skeleton will do). Static — no shimmer animation.
function bootSkeleton(): HTMLElement {
  const d = document.createElement("div");
  d.className = "loading-state";
  d.setAttribute("aria-label", "Starting pi");
  d.setAttribute("role", "status");
  const user = document.createElement("div");
  user.className = "skel skel-user";
  d.appendChild(user);
  for (const w of [92, 78, 85, 40]) {
    const l = document.createElement("div");
    l.className = "skel";
    l.style.width = `${w}%`;
    d.appendChild(l);
  }
  const label = document.createElement("p");
  label.className = "skel-label";
  label.textContent = "Starting pi…";
  d.appendChild(label);
  return d;
}
function bootFailure(err: string): HTMLElement {
  const d = document.createElement("div"); d.className = "empty-state";
  const title = document.createElement("h2"); title.textContent = "Couldn't connect to pi";
  const desc = document.createElement("p"); desc.className = "empty-folder";
  desc.textContent = "Your draft is kept. Check that `pi` is on your PATH, then retry.";
  d.append(title, desc);
  if (err) {
    const det = document.createElement("pre"); det.className = "empty-error"; det.textContent = err;
    d.append(det);
  }
  const row = document.createElement("div"); row.className = "empty-actions";
  const b = document.createElement("button"); b.type = "button"; b.className = "primary"; b.textContent = "Retry connection"; b.onclick = () => boot(true);
  row.append(b); d.append(row);
  return d;
}
// Empty chat: teach. Starter prompts fill the composer (never auto-send) and
// a quiet row of shortcut tips shows what the keyboard can do.
const STARTERS = ["Explain this project", "Review recent changes", "Find and fix a bug", "Write tests for…"];
function emptyState(): HTMLElement {
  const d = document.createElement("div"); d.className = "empty-state";
  const h = document.createElement("h2"); h.textContent = "What would you like to work on?";
  const f = document.createElement("div"); f.className = "empty-folder";
  f.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h5l2 2.5h8A1.5 1.5 0 0 1 21 9v8.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5Z"/></svg>`;
  const fp = document.createElement("span"); fp.textContent = cwd; f.appendChild(fp); f.title = cwd;
  const branch = branchCache.get(cwd);
  if (branch) { const bs = document.createElement("span"); bs.className = "empty-branch"; bs.textContent = `\u2387 ${branch}`; f.appendChild(bs); }
  const row = document.createElement("div"); row.className = "empty-actions";
  for (const text of STARTERS) {
    const b = document.createElement("button"); b.type = "button"; b.textContent = text;
    b.onclick = () => {
      inputEl.value = text.endsWith("…") ? text.slice(0, -1) + " " : text;
      saveDraft(); autosize(); updateSendState(); inputEl.focus();
      inputEl.selectionStart = inputEl.selectionEnd = inputEl.value.length;
    };
    row.append(b);
  }
  const tips = document.createElement("div"); tips.className = "empty-tips";
  for (const [k, v] of [[kbd("K"), "search chats"], ["/", "skills"], ["↑", "last message"], [kbd("/"), "all shortcuts"]] as const) {
    const t = document.createElement("span");
    const kk = document.createElement("kbd"); kk.textContent = k;
    t.append(kk, ` ${v}`);
    tips.append(t);
  }
  d.append(h, f, row, tips);
  return d;
}
// Live tail: while a turn runs and no prose is streaming, a quiet line at the
// end of the transcript says what pi is doing. CSS-only pulse, removed on settle.
const liveTail = document.createElement("div");
liveTail.className = "live-tail";
liveTail.setAttribute("aria-hidden", "true");
liveTail.innerHTML = `<span class="dots"><i></i><i></i><i></i></span><span class="live-label"></span>`;
const liveLabel = liveTail.querySelector(".live-label") as HTMLElement;
function syncLiveIndicators(list: Block[]) {
  const last = list[list.length - 1];
  const writing = streaming && !stopping && last?.t === "text" && !!last.text && !last.key.endsWith("-stopped") && !last.key.endsWith("-error");
  for (const n of messagesInner.querySelectorAll(".assistant-block.streaming")) {
    if (!writing || n !== rendered.get(last.key)?.node) n.classList.remove("streaming");
  }
  if (writing) rendered.get(last.key)?.node.classList.add("streaming");
  const showTail = streaming && !writing && !dialogs.size;
  if (showTail) {
    const l = statusLine.textContent || "Working…";
    if (liveLabel.textContent !== l) liveLabel.textContent = l;
    if (messagesInner.lastChild !== liveTail) messagesInner.appendChild(liveTail);
  } else if (liveTail.isConnected) liveTail.remove();
}
function renderSettled() {
  renderChatContext();
  if (booting || bootError) {
    resetView();
    messagesInner.append(booting ? bootSkeleton() : bootFailure(bootError ?? ""));
    return;
  }
  const list = blocks();
  messagesInner.querySelector(":scope > .loading-state")?.remove();
  if (!list.length) {
    // Reuse the empty state while its inputs are unchanged, so unrelated
    // re-renders (sidebar toggles, groups) never replay its entrance.
    const sig = `${cwd}\n${branchCache.get(cwd) ?? ""}`;
    const cur = messagesInner.querySelector<HTMLElement>(":scope > .empty-state");
    if (!cur || cur.dataset.sig !== sig) { cur?.remove(); const e = emptyState(); e.dataset.sig = sig; messagesInner.append(e); }
  } else messagesInner.querySelector(":scope > .empty-state")?.remove();
  const keep = new Set(list.map(b => b.key));
  for (const [key, view] of rendered) if (!keep.has(key)) { view.node.remove(); rendered.delete(key); fullTextByKey.delete(key); }
  let cursor: ChildNode | null = messagesInner.firstChild;
  for (const b of list) {
    let view = rendered.get(b.key);
    if (!view || view.block.t !== b.t) {
      const node = b.t === "user" ? userBlock(b.text, b.images, b.failed?.error ?? null, () => retrySend(b.failed!), b.ts) :
        b.t === "text" ? assistantTextBlock(b.text, b.key, b.images) : b.t === "thinking" ? thinkDisclosure(b.text, b.key) : b.t === "tool" ? toolDisclosure(b) : bashDisclosure(b);
      view?.node.replaceWith(node); view = { node, block: b }; rendered.set(b.key, view);
      node.dataset.blockKey = b.key;
      node.setAttribute("role", "group"); node.setAttribute("aria-label", b.t === "user" ? "Your message" : b.t === "text" ? "pi response" : b.t === "thinking" ? "pi thinking" : "Tool activity");
    } else if (!sameBlock(view.block, b)) {
      if (b.t === "user") { const n = userBlock(b.text, b.images, b.failed?.error ?? null, () => retrySend(b.failed!), b.ts); n.dataset.blockKey = b.key; view.node.replaceWith(n); view.node = n; }
      if (b.t === "tool") updateTool.get(view.node)?.(b);
      if (b.t === "thinking") {
        const body = view.node.querySelector(".think-body"); if (body && body.textContent !== b.text) body.textContent = b.text;
        const lab = view.node.querySelector(".think-label"); const l = thinkLabel(b.text); if (lab && lab.textContent !== l) lab.textContent = l;
      }
      if (b.t === "text") {
        fullTextByKey.set(b.key, b.text);
        let md = view.node.querySelector<HTMLElement>(".md");
        if (!md) { md = document.createElement("div"); md.className = "md"; view.node.prepend(md); }
        // Only the changed prose block is re-parsed; tools and prior prose stay untouched.
        if ((view.block as Extract<Block, {t:"text"}>).text !== b.text) { md.innerHTML = renderMarkdown(b.text); resolveMdImages(md); linkifyPaths(md); }
      }
      view.block = b;
    }
    if (cursor && cursor.parentNode !== messagesInner) cursor = view.node;
    if (view.node !== cursor) messagesInner.insertBefore(view.node, cursor);
    cursor = view.node.nextSibling;
  }
  syncLiveIndicators(list);
  scrollBottom(); updateJump();
  messagesInner.querySelectorAll<HTMLButtonElement>(".retry-btn").forEach(b => b.disabled = streaming || stopping || booting || !!bootError || !!sendInFlight);
}

// long-JSON collapse toggle (visual only — full text stays for Copy)
messagesInner.addEventListener("click", (e) => {
  const tgl = (e.target as HTMLElement).closest("[data-toggle-json]") as HTMLButtonElement | null;
  if (tgl) {
    const box = tgl.closest(".codeblock");
    if (!box) return;
    const collapsed = box.classList.toggle("json-collapsed");
    tgl.textContent = collapsed ? "Show more" : "Show less";
    return;
  }
});
// code-copy delegation (copies decoded full code, only confirms on success)
messagesInner.addEventListener("click", async (e) => {
  const btn = (e.target as HTMLElement).closest("[data-copy-code]") as HTMLButtonElement | null;
  if (!btn) return;
  const pre = btn.closest(".codeblock")?.querySelector("code");
  if (!pre) return;
  try {
    await navigator.clipboard.writeText(pre.textContent ?? "");
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = "Copy"), 1200);
  } catch {
    btn.textContent = "Copy failed";
    setTimeout(() => (btn.textContent = "Copy"), 1200);
  }
});

let rafQueued = false;
function queueStreamUpdate() {
  if (rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => { rafQueued = false; renderSettled(); });
}

// ---------- status / composer state ----------
/**
 * Invoke a Tauri command and normalize negative RPC envelopes.
 * Transport failures throw; envelopes with success:false also throw, so the
 * UI can never mistake a rejected command for success and drop a draft.
 */
async function invokeChecked<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const r = await invoke<T>(cmd, args);
  const err = envelopeError(r);
  if (err !== null) throw new Error(err);
  return r;
}

// Every command is routed to the process holding a chat: an explicit session
// override while navigating, otherwise the visible chat (activePath, or the
// cwd default when the chat has no session file yet).
let targetScope: { cwd: string; session: string | null } | null = null;
function visibleScope(): { cwd: string; session: string | null } {
  if (targetScope) return targetScope;
  return { cwd, session: activePath };
}
async function invokeScoped<T>(cmd: string, params: Record<string, unknown> = {}): Promise<T> {
  // A running CLI agent owns its session file: never route a command (which
  // would spawn a second pi process on that file) while it runs.
  if (!targetScope && visibleAgent()) throw new Error("read-only while the agent runs");
  return invokeChecked<T>(cmd, { ...params, ...visibleScope() });
}

// Git branch for the status cluster (idea 6). Cached per cwd, refreshed on
// every chat open; null = not a repo, shown as nothing. Needs no pi process.
// Git branch for the status cluster (idea 6). Cached per cwd so the sync
// renderer can show it; refetched on every chat open, null = not a repo.
const branchCache = new Map<string, string | null>();
function setBranch(dir: string, branch: string | null) {
  branchCache.set(dir, branch);
  while (branchCache.size > 50) {
    const first = branchCache.keys().next().value as string | undefined;
    if (first === undefined || first === dir) break;
    branchCache.delete(first);
  }
}
function renderBranch() {
  const b = branchCache.get(cwd) ?? null;
  if (b) {
    branchLine.textContent = `\u2387 ${b}`;
    branchLine.title = `Git branch: ${b}`;
    branchLine.classList.remove("hidden");
  } else {
    branchLine.textContent = "";
    branchLine.title = "";
    branchLine.classList.add("hidden");
  }
}
async function refreshBranch() {
  if (!cwd) return;
  const dir = cwd;
  try {
    const r = await invokeChecked<{ branch: string | null }>("pi_git_branch", { cwd: dir });
    setBranch(dir, r.branch);
  } catch {
    setBranch(dir, null);
  }
  if (dir === cwd) {
    renderBranch();
    if (!messages.length && !booting && !bootError) renderSettled(); // empty state shows the branch
  }
}
function renderStatus() {
  let label: string;
  if (booting) label = "Connecting…";
  else if (bootError) label = "Disconnected";
  else if (navigating) label = "Switching workspace…";
  else if (stopping) label = activityLabel("stopping");
  else if (dialogs.size > 0) label = activityLabel("waiting");
  else if (streaming) {
    label =
      streamActivity === "running" ? activityLabel("running", streamActivityTool)
      : streamActivity === "writing" ? activityLabel("writing") : activityLabel("thinking");
  } else if (extStatus) label = extStatus;
  else label = activityLabel("idle");
  statusLine.textContent = label;
  if (liveTail.isConnected && liveLabel.textContent !== label) liveLabel.textContent = label;
  runSpin.classList.toggle("hidden", !streaming);
  runSpin.setAttribute("aria-label", streaming ? label : "Idle");
}

function hasDraft(): boolean {
  return inputEl.value.trim().length > 0 || pendingImages.length > 0;
}

function updateSendState() {
  const ok = canSend({ streaming, stopping, hasText: inputEl.value.trim().length > 0, hasImages: pendingImages.length > 0 });
  // No sending while booting/disconnected, and never a second submit while a
  // send round-trip is still in flight (acceptance != completion).
  const conn = !booting && !bootError && !navigating;
  queueBtn.disabled = !ok || !conn || sendInFlight !== null;
  stopBtn.disabled = stopping || !conn;
  modelPicker.setState({ disabled: !conn || streaming }); thinkingPicker.setState({ disabled: !conn || streaming });
  const agent = visibleAgent();
  inputEl.disabled = navigating || !!agent;
  $("btn-new").toggleAttribute("disabled", !conn);
  chatListEl.querySelectorAll<HTMLButtonElement>(".chat-item, .agent-item").forEach(b => b.disabled = !conn);
  sendBtn.disabled = !ok || !conn || sendInFlight !== null || !!agent;
  attachBtn.disabled = !conn || !!agent;
  renderAgentBanner(agent);
  const hint = agent ? "Esc stop agent" : streaming ? "↵ steer · ◷ queue · Esc stop" : "↵ send · ⇧↵ newline · / skills";
  if (composerHint.textContent !== hint) composerHint.textContent = hint;
  const ph = navigating ? "Opening chat…" : agent ? "Read-only while the agent runs" : streaming ? "Steer pi while it works… (◷ queues for after)" : "Message pi…";
  if (inputEl.placeholder !== ph) inputEl.placeholder = ph;
  if (!streaming) {
    sendBtn.setAttribute("aria-label", "Send message");
    sendBtn.title = "Send (Enter)";
    stopBtn.classList.add("hidden");
    queueBtn.classList.add("hidden");
  } else {
    const steerable = inputEl.value.trim().length > 0 || pendingImages.length > 0;
    sendBtn.setAttribute("aria-label", steerable ? "Send steering message" : "Type a message to steer");
    sendBtn.title = steerable ? "Send steering message (Enter)" : "Type to steer";
    stopBtn.classList.remove("hidden");
    queueBtn.classList.toggle("hidden", !!agent);
  }
  messagesInner.querySelectorAll<HTMLButtonElement>(".retry-btn").forEach(b => b.disabled = streaming || stopping || !conn || sendInFlight !== null);
  renderStatus();
}

// Session key that owns the live run. Kept until its settle arrives, even if
// the user has switched away (pi aborts the turn on switch; its leftover
// events must never render into the visible chat). runningSet drives the
// unseen-finished blue dots in the sidebar (running rows use the spinner).
const runningSet = new Set<string>();
// Adopted session file not yet visible in the sidebar list (idea 5). One-shot
// backup refresh on settle, then cleared either way — never a standing flag.
let adoptedUnlisted: string | null = null;
// Chats whose background run finished while you weren't looking. Blue dot
// until opened. Persisted so it survives app restarts.
let unseenFinished = new Set<string>();
function loadUnseen() {
  try {
    const raw = localStorage.getItem("pi-unseen-finished");
    const arr = raw ? JSON.parse(raw) : [];
    unseenFinished = new Set(Array.isArray(arr) ? arr.filter((p): p is string => typeof p === "string") : []);
  } catch { unseenFinished = new Set(); }
}
function saveUnseen() {
  try {
    const arr = [...unseenFinished].slice(-100);
    unseenFinished = new Set(arr);
    localStorage.setItem("pi-unseen-finished", JSON.stringify(arr));
  } catch { /* ignore */ }
}
function setBusy(b: boolean) { streaming = b; if (!b) stopping = false; updateSendState(); updateDocTitle(); }
function clearRunScope(preserveDialogs = false) {
  pendingSend = null; sendInFlight = null; conversation.reset(); messages = conversation.messages;
  // A popover anchored to the chat scope must not outlive a chat switch.
  closePopover();
  if (!preserveDialogs) { dialogs.clear(); dialogSlot.replaceChildren(); visibleDialogId = null; }
  queue = { steering: [], followUp: [] }; renderQueue();
  lastUsage = null; renderCtxCircle();
  noticesEl.replaceChildren(); attachError.classList.add("hidden");
  extStatus = ""; streamActivity = "thinking"; streamActivityTool = ""; resetView();
}
function applyState(st: Record<string, unknown>) {
  // Never adopt an empty cwd/session: the first state read at boot carries the
  // still-unknown "" cwd, and accepting it empties the project list (chats
  // vanish from the sidebar). The real backend resolves this itself, so a
  // preview/older backend must not be able to.
  const stCwd = typeof st.cwd === "string" ? st.cwd.trim() : "";
  if (stCwd) cwd = stCwd;
  const stFile = typeof st.sessionFile === "string" ? st.sessionFile.trim() : "";
  activePath = stFile || null;
  cwdLabel.textContent = cwd.split("/").filter(Boolean).pop() ?? cwd; cwdBtn.title = cwd;
  activeName = String(st.sessionName ?? "");
  renderTitle();
  renderBranch();
  const level = typeof st.thinkingLevel === "string" ? st.thinkingLevel : null;
  if (level && THINKING_LEVELS.some(o => o.value === level)) thinkingPicker.setState({ value: level });
  setBusy(st.isStreaming === true || !!visibleAgent()); renderProjects();
}
async function refreshState() {
  const gen = bootGen;
  const st = await invokeScoped<Record<string, unknown>>("pi_get_state");
  if (gen !== bootGen) return;
  applyState(st);
}

function deriveTitle(): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "";
  return msgText(firstUser).replace(/\s+/g, " ").trim().slice(0, 48);
}
// Auto-rename once per session from the first user message (idea 3).
// Local heuristic only — no model round-trip, zero cost/latency.
const autoNamed = new Set<string>();
async function maybeAutoRename() {
  if (!activePath || activeName || autoNamed.has(activePath) || booting || bootError) return;
  const name = deriveTitle();
  if (!name) return;
  autoNamed.add(activePath);
  while (autoNamed.size > 200) {
    const first = autoNamed.values().next().value as string | undefined;
    if (first === undefined || first === activePath) break;
    autoNamed.delete(first);
  }
  try {
    await invokeScoped("pi_set_name", { name });
    await refreshState();
    await refreshSessions();
  } catch {
    autoNamed.delete(activePath ?? "");
  }
}

function reconcileSend() {
  const p = pendingSend;
  if (!p || p.owner !== sessKey()) return;
  // The next authoritative user event belongs to this accepted prompt. pi may
  // expand skills/templates, so text comparison would leave duplicate bubbles.
  if (messages.slice(p.index).some(m => m.role === "user")) pendingSend = null;
}
async function refreshMessages() {
  const gen = bootGen, rev = revision;
  try {
    const agent = visibleAgent();
    const res = agent
      ? await invokeChecked<{messages: AgentMessage[]}>("pi_read_session", { path: agent.sessionFile })
      : await invokeScoped<{messages: AgentMessage[]}>("pi_get_messages");
    if (gen !== bootGen || rev !== revision) return;
    conversation.reset(res.messages ?? []); messages = conversation.messages;
    reconcileSend(); renderTitle(); renderSettled();
  } catch (e) {
    if (gen === bootGen) notify({ text: `Couldn't load messages: ${String(e)}`, kind: "error", sticky: true, retryLabel: "Retry", onRetry: refreshMessages });
  }
}
async function refreshSessions() {
  if (visibleAgent()) return; // read-only agent view: nothing to ask pi
  const gen = bootGen;
  try {
    const res = await invokeScoped<{sessions: SessionInfo[]}>("pi_list_sessions");
    if (gen !== bootGen) return;
    sessionsErrShown = false; sessions = res.sessions ?? [];
    if (adoptedUnlisted && sessions.some((s) => `${cwd}:${s.path}` === adoptedUnlisted)) adoptedUnlisted = null;
    projectChats.set(cwd, sessions);
    renderProjects();
  } catch (e) {
    if (gen === bootGen && !sessionsErrShown) { sessionsErrShown = true; notify({ text: `Couldn't list chats: ${String(e)}`, kind: "error", sticky: true, retryLabel: "Retry", onRetry: () => { sessionsErrShown = false; refreshSessions(); } }); }
  }
}

async function refreshModels() {
  if (visibleAgent()) return; // read-only agent view: nothing to ask pi
  const gen = bootGen;
  try {
    const res = (await invokeScoped("pi_get_models")) as { models: { id: string; provider: string }[]; current: string | null };
    if (gen !== bootGen) return;
    // Grouped by provider; the trigger shows just the model id.
    const items: PickerItem[] = (res.models ?? []).map((m) => ({
      value: `${m.provider}/${m.id}`, label: m.id, group: m.provider, title: `${m.provider}/${m.id}`,
      hint: recommendedHint(`${m.provider}/${m.id}`),
    }));
    items.sort((x, y) => (x.group ?? "").localeCompare(y.group ?? "") || 0);
    const cur = modelPicker.state.value;
    const has = (v: string | null) => !!v && items.some((i) => i.value === v);
    modelPicker.setState({ items, value: has(res.current) ? res.current : has(cur) ? cur : null });
    modelsErrShown = false;
  } catch (e) {
    if (!modelsErrShown) {
      modelsErrShown = true;
      notify({
        text: `Couldn't load models: ${String(e)}`,
        kind: "error",
        sticky: true,
        retryLabel: "Retry",
        onRetry: () => {
          modelsErrShown = false;
          refreshModels();
        },
        details: String(e),
      });
    }
  }
}

// Last usage snapshot for the header context circle + popup (idea 1).
interface UsageSnap {
  tokens?: { input: number; output: number; total: number };
  cost?: number;
  contextUsage?: { percent: number | null; tokens: number | null; contextWindow?: number };
}
let lastUsage: UsageSnap | null = null;
// The context circle lives in the chat context bar (same line as project +
// group, flush right). One persistent node re-appended on every bar render.
const ctxCircle = document.createElement("button");
ctxCircle.id = "ctx-circle";
ctxCircle.type = "button";
ctxCircle.className = "ctx-circle";
ctxCircle.title = "Context usage";
ctxCircle.setAttribute("aria-label", "Context usage");
ctxCircle.setAttribute("aria-haspopup", "dialog");
ctxCircle.setAttribute("aria-expanded", "false");
ctxCircle.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="ring-bg" cx="12" cy="12" r="9"/><circle id="ctx-ring" class="ring-fg" cx="12" cy="12" r="9"/></svg>`;
const ctxRing = ctxCircle.querySelector("#ctx-ring") as SVGCircleElement;
const RING_C = 2 * Math.PI * 9;
function renderCtxCircle() {
  const pct = lastUsage?.contextUsage?.percent ?? null;
  ctxRing.setAttribute(
    "stroke-dasharray",
    pct == null ? `0 ${RING_C.toFixed(1)}` : `${((pct / 100) * RING_C).toFixed(1)} ${RING_C.toFixed(1)}`
  );
  ctxCircle.classList.toggle("hot", pct != null && pct >= 80);
  ctxCircle.classList.toggle("empty", pct == null);
  ctxCircle.title = pct == null ? "Context usage — nothing reported yet" : `Context ${pct}% full`;
  ctxCircle.setAttribute(
    "aria-label",
    pct == null ? "Context usage unavailable" : `Context ${pct}% full. Activate for details.`
  );
}
// Popover primitive: floating surface above its trigger, bottom-right flush
// with the trigger's right edge and a few pixels above it. Toggle on the
// trigger, Esc or outside click to dismiss, focus restored on close.
let popoverEl: HTMLElement | null = null;
let popoverOutside: ((e: MouseEvent) => void) | null = null;
function closePopover() {
  popoverEl?.remove();
  popoverEl = null;
  ctxCircle.setAttribute("aria-expanded", "false");
  if (popoverOutside) {
    document.removeEventListener("mousedown", popoverOutside);
    popoverOutside = null;
  }
}
function openPopover(anchor: HTMLElement, build: (box: HTMLElement, close: () => void) => void) {
  closePopover();
  const box = document.createElement("div");
  box.className = "popover";
  box.setAttribute("role", "dialog");
  // Focusable so Esc works and Tab reaches the actions, but focusing the
  // surface itself keeps buttons from opening with a focus ring.
  box.tabIndex = -1;
  box.style.outline = "none";
  build(box, closePopover);
  document.body.appendChild(box);
  const r = anchor.getBoundingClientRect();
  const gap = 6, pad = 8;
  box.style.width = `${Math.min(300, window.innerWidth - pad * 2)}px`;
  box.style.right = `${Math.max(pad, window.innerWidth - r.right)}px`;
  box.style.bottom = `${window.innerHeight - r.top + gap}px`;
  // Keep it on screen: nudge left, and flip below when there is no room above.
  if (box.getBoundingClientRect().left < pad) {
    box.style.right = "auto";
    box.style.left = `${pad}px`;
  }
  if (box.getBoundingClientRect().top < pad) {
    box.style.bottom = "auto";
    box.style.top = `${r.bottom + gap}px`;
  }
  anchor.setAttribute("aria-expanded", "true");
  popoverEl = box;
  popoverOutside = (e: MouseEvent) => {
    if (!box.contains(e.target as Node) && !anchor.contains(e.target as Node)) closePopover();
  };
  document.addEventListener("mousedown", popoverOutside);
  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closePopover();
      anchor.focus();
    }
  });
  box.focus();
}
function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
function openContextUsage() {
  const u = lastUsage;
  openPopover(ctxCircle, (box, close) => {
    const pct = u?.contextUsage?.percent ?? null;
    const win = u?.contextUsage?.contextWindow ?? null;
    const h = document.createElement("h3");
    h.textContent = "Context usage";
    box.appendChild(h);

    // One headline figure, one bar. The 80% marker is the compaction point.
    const head = document.createElement("div");
    head.className = "ctx-head";
    const big = document.createElement("span");
    big.className = "ctx-big" + (pct != null && pct >= 80 ? " hot" : "");
    big.textContent = pct != null ? `${pct}%` : "—";
    const sub = document.createElement("span");
    sub.className = "ctx-sub";
    sub.textContent = win != null ? `of ${fmtCount(win)} window` : "no window reported";
    head.append(big, sub);
    box.appendChild(head);

    if (pct != null) {
      const bar = document.createElement("div");
      bar.className = "ctx-bar-usage" + (pct >= 80 ? " hot" : "");
      bar.title = "Progress vs the 80% compaction point";
      const fill = document.createElement("div");
      fill.className = "fill";
      fill.style.width = `${Math.min(100, pct)}%`;
      const tick = document.createElement("div");
      tick.className = "tick";
      tick.title = "Compact around 80%";
      bar.append(fill, tick);
      box.appendChild(bar);
    }

    // Quiet label/value rows — no nested boxes inside a box.
    const rows: [string, string][] = [
      ["Context", u?.contextUsage?.tokens != null ? `${fmtCount(u.contextUsage.tokens)} tok` : "—"],
      ["Input", u?.tokens ? `${fmtCount(u.tokens.input ?? 0)} tok` : "—"],
      ["Output", u?.tokens ? `${fmtCount(u.tokens.output ?? 0)} tok` : "—"],
      ["Cost", typeof u?.cost === "number" ? `$${u.cost.toFixed(4)}` : "—"],
    ];
    const list = document.createElement("dl");
    list.className = "ctx-rows";
    for (const [k, v] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      list.append(dt, dd);
    }
    box.appendChild(list);

    const note = document.createElement("p");
    note.className = "ctx-note";
    note.textContent = pct == null
      ? "No usage reported for this chat yet."
      : pct >= 80 ? "Past the compaction point." : "Compacts around 80%.";
    box.appendChild(note);

    const row = document.createElement("div");
    row.className = "dialog-actions";
    const compact = document.createElement("button");
    compact.type = "button";
    compact.textContent = "Compact now";
    compact.onclick = () => { close(); void doCompact(); };
    row.appendChild(compact);
    box.appendChild(row);
  });
}
renderCtxCircle();
ctxCircle.onclick = () => {
  if (popoverEl) closePopover();
  else openContextUsage();
};
async function refreshStats() {
  if (visibleAgent()) return; // read-only agent view: nothing to ask pi
  const gen = bootGen;
  try {
    const s = (await invokeScoped("pi_get_stats")) as UsageSnap;
    if (gen !== bootGen) return;
    lastUsage = s;
    renderCtxCircle();
    const pct = s.contextUsage?.percent ?? null;
    if (pct != null && pct >= 80) {
      ctxWarn.classList.remove("hidden");
      ctxWarn.innerHTML = "";
      const t = document.createElement("span");
      t.textContent = `Context ${pct}% full.`;
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = "Compact now";
      b.onclick = () => doCompact();
      ctxWarn.appendChild(t);
      ctxWarn.appendChild(b);
    } else {
      ctxWarn.classList.add("hidden");
      ctxWarn.innerHTML = "";
    }
  } catch {
    /* ignore */
  }
}

// ---------- send / steer / follow-up / stop ----------
function takeDraft(): Draft {
  const d = { text: inputEl.value.trim(), images: [...pendingImages] };
  inputEl.value = ""; pendingImages = []; saveDraft(); renderAttachments(); autosize(); updateSendState(); hideSkillPop(); return d;
}
async function retrySend(f: FailedSend) {
  if (!f || f.owner !== sessKey() || streaming || stopping || booting || bootError || sendInFlight) return;
  failedBySession.set(f.owner, failedSends().filter(x => x.id !== f.id));
  await submit(f, "prompt");
}
// Stuck-flag watchdog: if a send or navigation is still outstanding after 120s
// with zero stream progress, fail loud into the standard retry card instead
// of bricking the app. One-shot timer, armed only while work is in flight —
// justification for the timer: it is the only recovery from a hung harness.
let watchTimer: number | null = null;
let lastProgressAt = 0;
function pokeProgress() { lastProgressAt = Date.now(); }
function armWatchdog() {
  pokeProgress();
  if (watchTimer !== null) return;
  watchTimer = window.setTimeout(checkWatchdog, 120000);
}
function disarmWatchdog() {
  if (sendInFlight === null && !navigating && watchTimer !== null) {
    clearTimeout(watchTimer); watchTimer = null;
  }
}
function checkWatchdog() {
  watchTimer = null;
  if (sendInFlight === null && !navigating) return;
  if (Date.now() - lastProgressAt < 120000) { armWatchdog(); return; }
  if (sendInFlight !== null) {
    sendInFlight = null;
    const p = pendingSend; pendingSend = null;
    const owner = p?.owner ?? sessKey();
    const list = failedBySession.get(owner) ?? [];
    list.push({ text: p?.text ?? "", images: p?.images ?? [], id: newClientId(), owner, kind: "prompt", error: "Send timed out with no response — the chat may be stuck. Retry, or reopen the chat." });
    failedBySession.set(owner, list);
    setBusy(false);
    renderSettled();
    notify({ text: "Send timed out. Use Retry beside it; your newer draft is unchanged.", kind: "error", sticky: false });
  }
  if (navigating) {
    navigating = false;
    notify({ text: "Opening the chat timed out. Try again.", kind: "error" });
  }
  updateSendState();
  disarmWatchdog();
}
async function submit(d: Draft, kind: "prompt" | "steer" | "follow_up") {
  let owner = sessKey(); const gen = bootGen, id = newClientId(), startIndex = messages.length;
  sendInFlight = id; armWatchdog();
  if (kind === "prompt") { pendingSend = { ...d, id, owner, index: messages.length }; setBusy(true); renderSettled(); }
  updateSendState();
  try {
    const r = await invokeScoped<{accepted?: boolean; error?: string}>(`pi_${kind}`, { message: d.text, images: d.images.map(im => ({ data: im.data, mimeType: im.mimeType })) });
    if (r?.accepted === false) throw new Error(r.error ?? "Message rejected");
    if (gen !== bootGen || owner !== sessKey()) return;
    // Commands handled by extensions may produce no user message or agent run.
    if (kind === "prompt") {
      let st: Record<string, unknown>;
      try { st = await invokeScoped<Record<string, unknown>>("pi_get_state"); }
      catch { return; } // Acceptance already succeeded; never offer a duplicate send.
      if (gen !== bootGen) return;
      // First message on a chat with no session file yet: adopt the file pi
      // just created so the row selects, events tag, and the sidebar lists
      // it right away (idea 5). Ownership moves with the key (R2-F1).
      const sf = typeof st.sessionFile === "string" ? st.sessionFile : null;
      if (sf && !activePath) {
        activePath = sf; owner = sessKey();
        if (typeof st.sessionName === "string") activeName = st.sessionName;
        if (pendingSend) pendingSend.owner = owner;
        await refreshSessions();
        adoptedUnlisted = sessions.some((s) => s.path === sf) ? null : `${cwd}:${sf}`;
        renderTitle();
        renderProjects();
      }
      if (!st.isStreaming && pendingSend?.id === id) { pendingSend = null; setBusy(false); await refreshMessages(); }
    }
  } catch (e) {
    if (kind === "prompt" && owner === sessKey() && messages.slice(startIndex).some(m => m.role === "user")) {
      notify({text: "pi received this message, but the connection failed. Reconnect and check its result before sending again.", kind: "error", sticky: true}); return;
    }
    const list = failedBySession.get(owner) ?? [];
    list.push({ ...d, id, owner, kind, error: String(e) }); failedBySession.set(owner, list);
    if (gen === bootGen && owner === sessKey()) {
      if (pendingSend?.id === id) pendingSend = null;
      if (kind === "prompt") setBusy(false);
      renderSettled();
      notify({ text: "Message wasn't sent. Use Retry beside it; your newer draft is unchanged.", kind: "error", sticky: false });
    }
  } finally {
    if (sendInFlight === id) sendInFlight = null;
    updateSendState();
    disarmWatchdog();
  }
}
function canSubmit() { return !booting && !bootError && !navigating && !stopping && !sendInFlight && hasDraft(); }
async function doSend() { if (!canSubmit()) return; await submit(takeDraft(), streaming ? "steer" : "prompt"); }
async function doSteer() { if (!canSubmit()) return; await submit(takeDraft(), streaming ? "steer" : "prompt"); }
async function doFollowUp() { if (!canSubmit()) return; await submit(takeDraft(), streaming ? "follow_up" : "prompt"); }

// Switching chats while a turn runs: pi aborts the turn on session switch
// anyway (verified: stop=aborted), so stop it explicitly first and navigate
// immediately. The run's settle arrives as a foreign event and only touches
// the sidebar. No confirm modal — switching must feel instant.
async function doAbort() {
  if (!streaming || stopping) return;
  stopping = true;
  updateSendState();
  try {
    const agent = visibleAgent();
    // An agent's runner aborts pi itself and records `cancelled`.
    if (agent) await invokeChecked("pi_agent_cancel", { id: agent.id });
    else await invokeScoped("pi_abort");
    // actual settle arrives via agent_settled; Stopping… stays until then
  } catch (e) {
    stopping = false;
    updateSendState();
    notify({
      text: `Stop failed: ${String(e)}`,
      kind: "error",
      sticky: true,
      retryLabel: "Retry",
      onRetry: () => doAbort(),
      details: String(e),
    });
  }
}

async function doClearQueue() {
  try {
    await invokeScoped("pi_clear_queue");
  } catch (e) {
    notify({ text: `Couldn't clear queue: ${String(e)}`, kind: "error", sticky: true, details: String(e) });
  }
}

// Restore this chat's queue bar from cache after an open. If items drained
// while we were looking elsewhere, say so — otherwise a delivered follow-up
// looks like a message that sent itself.
function restoreQueueBar() {
  const vk = visibleKey();
  const cached = queueCache.get(vk);
  queue = cached ? { steering: [...cached.steering], followUp: [...cached.followUp] } : { steering: [], followUp: [] };
  renderQueue();
  const prev = queueSeen.get(vk);
  if (prev) {
    const same = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
    if (same(prev.steering, queue.steering) && same(prev.followUp, queue.followUp)) return;
    const before = prev.steering.length + prev.followUp.length;
    const now = queue.steering.length + queue.followUp.length;
    if (before > now) {
      const n = before - now;
      notify({ text: `${n} queued message${n === 1 ? " was" : "s were"} delivered while you were away.` });
    } else {
      notify({ text: "Queued messages changed while you were away." });
    }
  }
}
function renderQueue() {
  const { steering, followUp } = queue;
  if (steering.length + followUp.length === 0) {
    queueBar.classList.add("hidden");
    queueBar.innerHTML = "";
    return;
  }
  queueBar.classList.remove("hidden");
  queueBar.innerHTML = "";
  const label = document.createElement("span");
  label.className = "q-list";
  label.textContent = `Queued — ${queueSummary(steering, followUp)}`;
  label.title = queueSummary(steering, followUp);
  const clear = document.createElement("button");
  clear.type = "button";
  clear.textContent = "Clear queue";
  clear.setAttribute("aria-label", "Clear queued steering and follow-up messages");
  clear.onclick = () => doClearQueue();
  queueBar.appendChild(label);
  queueBar.appendChild(clear);
}

// Opening a chat never touches other chats' processes: the backend routes
// the scope to the right process (spawning/switching inside it) and returns
// that session as truth. Running turns elsewhere keep streaming.
async function openSession(project: string, path: string | null) {
  const runningAgent = path ? activeAgentFor(path) : null;
  if (runningAgent) { await openAgentChat(runningAgent); return; }
  if (navigating || booting || sendInFlight) {
    if (sendInFlight) notify({ text: "Sending your message — one moment, then click again." });
    return;
  }
  if (dialogs.size) { notify({text: "Answer the pending request before changing chats or folders."}); return; }
  if (path !== null && project === cwd && path === activePath) {
    if (unseenFinished.delete(`${project}:${path}`)) { saveUnseen(); renderProjects(); }
    return;
  }
  queueSeen.set(visibleKey(), { steering: [...queue.steering], followUp: [...queue.followUp] });
  capQueueMap(queueSeen, visibleKey());
  const prevCwd = cwd, prevPath = activePath, prevName = activeName;
  navigating = true; saveDraft(); ++bootGen; updateSendState();
  armWatchdog();
  if (!eventsReady) await initEvents();
  targetScope = { cwd: project, session: path };
  try {
    await refreshState();
    if (activePath === null) throw new Error("pi returned no session");
    if (unseenFinished.delete(visibleKey())) saveUnseen();
    clearRunScope(true); restoreDraft(); updateSkillPop();
    restoreQueueBar();
    await refreshMessages(); await refreshSessions(); await refreshModels(); await refreshCommands(); await refreshStats();
    void refreshBranch();
    expandedProjects.add(project); saveExpanded();
    await refreshAllProjects();
    stickToBottom = true; scrollBottom(true); inputEl.focus();
  } catch (e) {
    // applyState may have retargeted before the throw: roll the scope back so
    // the (untouched) transcript and queue bar match the visible chat again.
    cwd = prevCwd; activePath = prevPath; activeName = prevName;
    renderTitle();
    renderProjects(); renderChatContext(); renderQueue();
    notify({ text: `Couldn't open chat: ${String(e)}`, kind: "error", sticky: true, retryLabel: "Retry", onRetry: () => openSession(project, path) });
  } finally { targetScope = null; navigating = false; updateSendState(); disarmWatchdog(); if (!bootError && !dialogs.size) inputEl.focus(); }
}
async function newChat() { await newChatInProject(cwd); }
async function newChatInProject(project: string): Promise<string | null> {
  if (navigating || booting || sendInFlight) return null;
  if (dialogs.size) { notify({text: "Answer the pending request before changing chats or folders."}); return null; }
  let path: string;
  try {
    const r = await invokeChecked<{ path: string }>("pi_new_chat", { cwd: project });
    path = r.path;
  } catch (e) {
    notify({ text: `Couldn't start a new chat: ${String(e)}`, kind: "error", sticky: true });
    return null;
  }
  await openSession(project, path);
  return path;
}
async function setCwd(ncwd: string) { await openSession(ncwd, null); }

async function doCompact() {
  if (agentGuard()) return;
  if (streaming || booting || navigating) { notify({text: "Wait for the current turn to finish before compacting."}); return; }
  try {
    statusLine.textContent = activityLabel("compacting");
    await invokeScoped("pi_compact");
    await refreshMessages();
    notify({ text: "Context compacted." });
  } catch (e) {
    notify({ text: `Compact failed: ${String(e)}`, kind: "error", sticky: true, retryLabel: "Retry", onRetry: doCompact, details: String(e) });
  } finally {
    renderStatus();
  }
}

async function doExport() {
  if (agentGuard()) return;
  try {
    const r = (await invokeScoped("pi_export")) as { path: string };
    notify({ text: `Exported to ${r.path}` });
  } catch (e) {
    notify({ text: `Export failed: ${String(e)}`, kind: "error", sticky: true, retryLabel: "Retry", onRetry: doExport, details: String(e) });
  }
}

// ---------- drafts ----------
function draftKey() { return `pi-draft:${sessKey()}`; }
function saveDraft() {
  drafts.set(sessKey(), {text: inputEl.value, images: [...pendingImages]});
  prefSet(draftKey(), inputEl.value);
}
function restoreDraft() {
  const d = drafts.get(sessKey()); inputEl.value = d?.text ?? prefGet(draftKey()) ?? "";
  pendingImages = [...(d?.images ?? [])]; renderAttachments(); autosize(); updateSendState();
}

// ---------- extension UI dialogs ----------
function dialogContext(req: PiEvent): string {
  const bits: string[] = [];
  for (const k of ["command", "path", "file", "toolName", "message"]) {
    const v = req[k];
    if (typeof v === "string" && v) bits.push(v);
  }
  return bits.join(" · ");
}

function showExtensionDialog(req: PiEvent) {
  const method = String(req.method ?? "");
  if (!["select", "confirm", "input", "editor"].includes(method)) {
    if (method === "notify") notify({ text: String(req.message ?? ""), kind: req.notifyType === "error" ? "error" : "info" });
    if (method === "setStatus") { extStatus = String(req.statusText ?? "").slice(0,120); renderStatus(); }
    if (method === "setTitle" && typeof req.title === "string") { extTitle = true; document.title = req.title; }
    if (method === "set_editor_text" && typeof req.text === "string") { inputEl.value = req.text; saveDraft(); autosize(); updateSendState(); }
    return;
  }
  const id = String(req.id ?? ""); if (!id || dialogs.has(id)) return;
  const card = document.createElement("div");
  card.className = "dialog-card";
  card.tabIndex = -1;
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", String(req.title ?? method));
  const title = document.createElement("div");
  title.className = "dialog-title";
  title.textContent = String(req.title ?? method);
  card.appendChild(title);
  const ctx = dialogContext(req);
  if (ctx && method !== "confirm") {
    const c = document.createElement("div");
    c.className = "dialog-context";
    c.textContent = ctx;
    card.appendChild(c);
  }
  const state = document.createElement("div");
  state.className = "dialog-state pending hidden";


  const cancelBtn = (label: string) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.onclick = () => respondUi(id, { cancelled: true });
    return b;
  };

  if (method === "select") {
    const opts = (req.options as string[]) ?? [];
    const wrap = document.createElement("div");
    wrap.className = "dialog-opts";
    for (const o of opts) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = o;
      b.onclick = () => respondUi(id, { value: o });
      wrap.appendChild(b);
    }
    card.appendChild(wrap);
    const row = document.createElement("div");
    row.className = "dialog-actions";
    row.appendChild(cancelBtn("Cancel"));
    card.appendChild(row);

  } else if (method === "confirm") {
    const msg = String(req.message ?? ctx ?? "");
    if (msg) {
      const d = document.createElement("div");
      d.className = "dialog-desc";
      d.textContent = msg;
      card.appendChild(d);
    }
    // Yes / No only; Cancel stays one key away (Esc). Y and N answer from
    // the keyboard, ignored for a beat after the card appears so a keystroke
    // already in flight from the composer can never answer it.
    const row = document.createElement("div");
    row.className = "dialog-actions";
    const esc = document.createElement("span");
    esc.className = "dialog-hint";
    esc.innerHTML = "<kbd>Esc</kbd> cancel";
    const no = document.createElement("button");
    no.type = "button";
    no.innerHTML = `No <kbd>N</kbd>`;
    no.setAttribute("aria-label", "No");
    no.onclick = () => respondUi(id, { confirmed: false });
    const yes = document.createElement("button");
    yes.type = "button";
    yes.innerHTML = `Yes <kbd>Y</kbd>`;
    yes.setAttribute("aria-label", "Yes");
    yes.className = "primary";
    yes.onclick = () => respondUi(id, { confirmed: true });
    row.append(esc, no, yes);
    card.appendChild(row);
    const shownAt = performance.now();
    card.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      if ((e.target as HTMLElement).closest("input, textarea")) return;
      if (performance.now() - shownAt < 400) return;
      const k = e.key.toLowerCase();
      if (k === "y") { e.preventDefault(); void respondUi(id, { confirmed: true }); }
      else if (k === "n") { e.preventDefault(); void respondUi(id, { confirmed: false }); }
    });

  } else if (method === "input" || method === "editor") {
    const pre = String(req.prefill ?? "");
    const inp = document.createElement(method === "editor" ? "textarea" : "input") as HTMLInputElement | HTMLTextAreaElement;
    inp.className = "dialog-input";
    if (method === "editor") (inp as HTMLTextAreaElement).rows = 4;
    inp.placeholder = String(req.placeholder ?? "");
    inp.value = pre;
    inp.setAttribute("aria-label", String(req.title ?? "Input"));
    card.appendChild(inp);
    const row = document.createElement("div");
    row.className = "dialog-actions";
    const ok = document.createElement("button");
    ok.type = "button";
    ok.textContent = "Submit";
    ok.className = "primary";
    ok.onclick = () => respondUi(id, { value: inp.value });
    row.appendChild(cancelBtn("Cancel"));
    row.appendChild(ok);
    card.appendChild(row);

    inp.addEventListener("keydown", (ev) => {
      const e = ev as KeyboardEvent;
      if (!e.isComposing && e.keyCode !== 229 && e.key === "Enter" && method === "input" && !e.shiftKey) {
        e.preventDefault();
        respondUi(id, { value: inp.value });
      }
      if (e.key === "Escape") {
        e.stopPropagation();
        respondUi(id, { cancelled: true });
      }
    });
  }

  card.appendChild(state);
  card.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      respondUi(id, { cancelled: true });
    }
  });
  // Answer where the request came from — a background chat or a CLI agent —
  // never through whichever chat happens to be visible.
  const scope = typeof req.cwd === "string" ? { cwd: req.cwd, session: typeof req.session === "string" ? req.session : null } : null;
  dialogs.set(id, {id, card, inFlight: false, scope});
  dialogSlot.appendChild(card);
  syncDialogs();
  renderStatus();
  scrollBottom();
}

let visibleDialogId: string | null = null;
function syncDialogs() {
  let first = true;
  for (const d of dialogs.values()) { d.card.classList.toggle("hidden", !first); first = false; }
  const next = dialogs.values().next().value as UiDialog | undefined;
  // Never yank focus out of a half-typed composer: with Y/N live on the card,
  // the next keystrokes of that message could answer the request.
  const typing = document.activeElement === inputEl && inputEl.value.trim().length > 0;
  if (next && next.id !== visibleDialogId && !typing) (next.card.querySelector<HTMLElement>("input, textarea") ?? next.card).focus({preventScroll:true});
  visibleDialogId = next?.id ?? null;
}
async function respondUi(id: string, payload: Record<string, unknown>) {
  const d = dialogs.get(id); if (!d || d.inFlight) return;
  d.inFlight = true;
  const controls = Array.from(d.card.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input, textarea"));
  controls.forEach(c => c.disabled = true);
  const st = d.card.querySelector<HTMLElement>(".dialog-state")!;
  st.className = "dialog-state pending"; st.textContent = "Responding…";
  try {
    if (d.scope) await invokeChecked("pi_ui_response", { ...d.scope, id, payload });
    else await invokeScoped("pi_ui_response", {id, payload});
    if (dialogs.get(id) !== d) return;
    dialogs.delete(id); d.card.remove(); syncDialogs(); renderStatus();
    if (!dialogs.size) inputEl.focus();
  } catch (e) {
    if (dialogs.get(id) !== d) return;
    st.className = "dialog-state error"; st.textContent = `Couldn't send response: ${String(e)} `;
    const retry = document.createElement("button"); retry.type = "button"; retry.textContent = "Retry response";
    retry.onclick = () => respondUi(id, payload); st.append(retry);
    controls.forEach(c => c.disabled = false);
  } finally { d.inFlight = false; }
}

// ---------- events ----------
// Each backend event is tagged with the owning chat (instance/session/cwd).
// Row keys match the sidebar (`${project}:${path}`); chats with no session
// file yet use a cwd key that matches no row.
function eventRowKey(p: PiEvent): string | null {
  const ecwd = typeof p.cwd === "string" ? p.cwd : null;
  if (!ecwd) return null;
  const esess = typeof p.session === "string" ? p.session : null;
  return esess ? `${ecwd}:${esess}` : `cwdkey:${ecwd}`;
}
function visibleKey(): string {
  return activePath ? `${cwd}:${activePath}` : `cwdkey:${cwd}`;
}
function sessionLabel(key: string): string | null {
  const sep = key.indexOf(":");
  if (sep < 0) return null;
  const c = key.slice(0, sep), path = key.slice(sep + 1);
  const list = projectChats.get(c) ?? [];
  const s = list.find((x) => x.path === path);
  const title = s ? s.name || s.preview.slice(0, 42) : path.split("/").filter(Boolean).pop() ?? path;
  const folder = (c === "cwdkey" ? path : c).split("/").filter(Boolean).pop() ?? c;
  return `${title} (${folder})`;
}
async function handleEvent(p: PiEvent) {
  const t = p.type;
  if (t === "process_disconnected") {
    queueCache.clear(); queueSeen.clear();
    ++bootGen; booting = false; setBusy(false); runningSet.clear(); bootError = "pi disconnected. Reconnect to continue; your draft is kept.";
    saveDraft(); dialogs.clear(); dialogSlot.replaceChildren(); renderSettled(); updateSendState();
    showConnError("pi disconnected", () => boot(true)); return;
  }
  if (t === "instance_disconnected") {
    // One chat's process died (crash or lazy reaping). Visible chat: reconnect
    // path. Background chat: note it; reopening respawns transparently.
    const key = eventRowKey(p);
    if (key !== null) { queueCache.delete(key); queueSeen.delete(key); }
    if (key !== null && key === visibleKey()) {
      ++bootGen; booting = false; setBusy(false); runningSet.clear(); bootError = "pi process for this chat exited. Reconnect to continue; your draft is kept.";
      saveDraft(); dialogs.clear(); dialogSlot.replaceChildren(); renderSettled(); updateSendState();
      showConnError("chat process exited", () => openSession(cwd, activePath)); return;
    }
    if (key !== null) runningSet.delete(key);
    notify({ text: "A background chat's process exited. Reopen it to continue." });
    await refreshAllProjects(); return;
  }
  if (t === "agent_update") { onAgentUpdate(p.agent as AgentRecord | undefined); return; }
  // Headless agents never prompt (their runner dismisses dialogs itself).
  if (t === "extension_ui_request") { if (!p.external) showExtensionDialog(p); return; }
  // Route by owning chat: untagged events (preview fixtures) belong here.
  // While the visible chat has no session file yet, same-cwd tagged events
  // are also this view's (pre-adopt window, idea 5 / R2-F1).
  const key = eventRowKey(p);
  const preAdopt = activePath === null && cwd !== "" && key !== null && key.startsWith(`${cwd}:`);
  const isVis = key === null || key === visibleKey() || preAdopt;
  if (isVis && (t === "agent_start" || t === "agent_settled" || t.startsWith("message_") || t.startsWith("tool_execution_"))) pokeProgress();
  if (t === "queue_update") {
    const lists = { steering: (p.steering as string[]) ?? [], followUp: (p.followUp as string[]) ?? [] };
    if (key !== null) {
      queueCache.set(key, lists);
      capQueueMap(queueCache, key);
    }
    if (!isVis) return;
    queue = lists; renderQueue(); return;
  }
  if (t === "agent_start") {
    if (key !== null) { runningSet.add(key); unseenFinished.delete(key); saveUnseen(); }
    if (isVis) { setBusy(true); streamActivity = "thinking"; }
    else { await refreshAllProjects(); }
    renderProjects(); return;
  }
  if (!isVis) {
    // Another chat's live events: never render into this view. Its settle is
    // handled below; everything else only keeps the sidebar dot truthful.
    if (t === "agent_settled" && key !== null) {
      runningSet.delete(key);
      unseenFinished.add(key); saveUnseen();
      await refreshAllProjects();
      const done = sessionLabel(key);
      const sep = key.indexOf(":");
      if (done) notify({
        text: `Finished in ${done}.`,
        retryLabel: "Open",
        onRetry: sep > 0 && !key.startsWith("cwdkey:") ? () => { void openSession(key.slice(0, sep), key.slice(sep + 1)); } : undefined,
      });
    }
    return;
  }
  if (t.startsWith("message_") || t.startsWith("tool_execution_")) {
    ++revision; conversation.ingest(p); messages = conversation.messages; reconcileSend();
    renderTitle();
    if (t === "tool_execution_start") { streamActivity = "running"; streamActivityTool = String(p.toolName ?? "tool"); }
    if (t === "message_update") {
      const kind = String((p.assistantMessageEvent as Record<string, unknown> | undefined)?.type ?? "");
      streamActivity = kind.startsWith("text_") ? "writing" : "thinking";
    }
    if (t === "tool_execution_end" && p.isError) expandedTools.add(`tool-${p.toolCallId}`);
    renderStatus(); queueStreamUpdate();
  }
  if (t === "agent_settled" && visibleAgent()) {
    // A CLI agent finished in the open chat: show its final transcript from
    // the file; its `agent_update` then turns this into an ordinary chat.
    if (key !== null) runningSet.delete(key);
    await refreshMessages();
    return;
  }
  if (t === "agent_settled") {
    if (key !== null) runningSet.delete(key);
    setBusy(false); pendingSend = null; renderSettled();
    // Keep live content visible while authoritative history is fetched.
    await refreshMessages(); await refreshAllProjects(); await refreshStats();
    // One-shot backup: the first chat's row may still be unlisted (idea 5).
    if (adoptedUnlisted && activePath && adoptedUnlisted === `${cwd}:${activePath}`) {
      adoptedUnlisted = null;
      await refreshSessions();
    }
    void maybeAutoRename();
    try { await refreshState(); } catch (e) { notify({text: `Couldn't refresh session: ${String(e)}`, kind: "error"}); }
  }
  if (t === "response" && p.success === false) notify({ text: `pi error: ${String(p.error ?? "Request failed")}`, kind: "error", sticky: true });
}
async function initEvents() {
  if (eventsReady) return;
  unlisten = await listen<PiEvent>("pi-event", ev => { void handleEvent(ev.payload); });
  eventsReady = true;
}
window.addEventListener("pagehide", () => { unlisten?.(); unlisten = null; eventsReady = false; });
// A webview hidden long enough can go permanently deaf (listener dropped by
// the host with no event). Re-register on return; initEvents is idempotent.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !eventsReady) void initEvents();
});

// ---------- input ----------
function putInComposer(text: string) {
  inputEl.value = inputEl.value.trim() ? `${inputEl.value.replace(/\s+$/, "")}\n\n${text}` : text;
  saveDraft(); autosize(); updateSendState();
  inputEl.focus();
  inputEl.selectionStart = inputEl.selectionEnd = inputEl.value.length;
}
function autosize() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
}
inputEl.addEventListener("input", () => {
  autosize();
  saveDraft();
  updateSendState();
});

// ---------- image attachments ----------
function renderAttachments() {
  attachStrip.innerHTML = "";
  if (pendingImages.length === 0) {
    attachStrip.classList.add("hidden");
    return;
  }
  attachStrip.classList.remove("hidden");
  pendingImages.forEach((im, i) => {
    const el = document.createElement("div");
    el.className = "attach-thumb";
    const img = document.createElement("img");
    img.alt = `attached image ${i + 1}`;
    img.width = 64;
    img.height = 64;
    img.src = `data:${im.mimeType};base64,${im.data}`;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.title = "Remove image";
    rm.setAttribute("aria-label", `Remove image ${i + 1}`);
    rm.textContent = "✕";
    rm.onclick = () => {
      pendingImages.splice(i, 1);
      saveDraft();
      renderAttachments();
      updateSendState();
    };
    el.appendChild(img);
    el.appendChild(rm);
    attachStrip.appendChild(el);
  });
}

let attachErrTimer: number | null = null;
function attachValidationError(text: string) {
  attachError.classList.remove("hidden");
  attachError.textContent = text;
  if (attachErrTimer !== null) clearTimeout(attachErrTimer);
  attachErrTimer = window.setTimeout(() => {
    attachErrTimer = null;
    attachError.classList.add("hidden");
  }, 6000);
}

let imageReads = 0;
function addImageFiles(files: FileList | File[]) {
  const owner = sessKey();
  for (const f of Array.from(files)) {
    if (!f.type.startsWith("image/")) continue;
    if (pendingImages.length + imageReads >= MAX_IMAGES) {
      attachValidationError(`At most ${MAX_IMAGES} images per message.`);
      break;
    }
    if (f.size > MAX_IMAGE_BYTES) {
      attachValidationError(`Image too large (over ${MAX_IMAGE_BYTES / 1024 / 1024}MB), skipped.`);
      continue;
    }
    const reader = new FileReader(); imageReads++;
    reader.onerror = () => { imageReads--; attachValidationError("Couldn't read this image. Try attaching it again."); };
    reader.onload = () => {
      imageReads--;
      const url = String(reader.result ?? "");
      const comma = url.indexOf(",");
      const image = {
        data: comma >= 0 ? url.slice(comma + 1) : url,
        mimeType: f.type || "image/png",
        bytes: f.size,
      };
      if (owner !== sessKey()) { const d = drafts.get(owner) ?? {text:"",images:[]}; d.images.push(image); drafts.set(owner,d); return; }
      pendingImages.push(image); saveDraft();
      renderAttachments();
      updateSendState();
    };
    reader.readAsDataURL(f);
  }
}

attachBtn.onclick = () => fileInput.click();
fileInput.addEventListener("change", () => {
  if (fileInput.files?.length) addImageFiles(fileInput.files);
  fileInput.value = "";
  inputEl.focus();
});
inputEl.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  const files: File[] = [];
  for (const it of Array.from(items)) {
    if (it.type.startsWith("image/")) {
      const f = it.getAsFile();
      if (f) files.push(f);
    }
  }
  if (files.length > 0) addImageFiles(files);
});

composerWrap.addEventListener("dragover", (e) => {
  if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) {
    e.preventDefault();
    composerWrap.classList.add("drag");
  }
});
composerWrap.addEventListener("dragleave", (e) => {
  // Moving between children fires dragleave too; only leave when truly out.
  if (e.relatedTarget instanceof Node && composerWrap.contains(e.relatedTarget)) return;
  composerWrap.classList.remove("drag");
});
composerWrap.addEventListener("drop", (e) => {
  composerWrap.classList.remove("drag");
  if (e.dataTransfer?.files?.length) {
    e.preventDefault();
    addImageFiles(e.dataTransfer.files);
  }
});

// ---------- skills autocomplete ($ or / anywhere, inserts canonical /skill:name) ----------
interface SkillCmd { name: string; description?: string; location?: string; source?: string }
const commandCache = new Map<string, SkillCmd[]>();
async function refreshCommands() {
  if (visibleAgent()) return;
  if (commandCache.has(cwd)) return;
  try {
    const r = await invokeScoped<{ commands: SkillCmd[] }>("pi_get_commands");
    const all = Array.isArray(r.commands) ? r.commands : [];
    commandCache.set(cwd, all.filter((c) => c && typeof c.name === "string" && c.source === "skill"));
  } catch {
    // Popup stays hidden; retried on next chat open.
  }
}
const skillPopEl = $("skill-pop");
let skillMatches: SkillCmd[] = [];
let skillFocus = 0;
let skillAnchor = -1;
let skillSig = "";
function skillPopOpen(): boolean {
  return !skillPopEl.classList.contains("hidden");
}
function hideSkillPop() {
  skillPopEl.classList.add("hidden");
  skillPopEl.replaceChildren();
  skillMatches = []; skillFocus = 0; skillAnchor = -1; skillSig = "";
}
function skillTrigger(): { start: number; query: string } | null {
  const caret = inputEl.selectionStart ?? inputEl.value.length;
  const m = inputEl.value.slice(0, caret).match(/(^|[\s(])([/$])([\w:+-]*)$/);
  if (!m) return null;
  return { start: caret - m[3].length - 1, query: m[3] };
}
function updateSkillPop() {
  const trig = skillTrigger();
  const skills = commandCache.get(cwd) ?? [];
  if (!trig || !trig.query || skills.length === 0) { hideSkillPop(); return; }
  const sig = `${trig.start}:${trig.query}`;
  if (sig === skillSig && skillPopOpen()) return;
  skillSig = sig;
  const q = trig.query.toLowerCase();
  const bare = (n: string) => (n.startsWith("skill:") ? n.slice(6) : n).toLowerCase();
  const rank = (s: SkillCmd) => {
    const n = bare(s.name);
    if (!q) return 0;
    if (n.startsWith(q)) return 0;
    if (n.includes(q)) return 1;
    return 2;
  };
  const scored = skills
    .filter((s) => !q || bare(s.name).includes(q) || (s.description ?? "").toLowerCase().includes(q))
    .sort((a, b) => rank(a) - rank(b));
  if (scored.length === 0) { hideSkillPop(); return; }
  skillMatches = scored; skillFocus = 0; skillAnchor = trig.start;
  renderSkillPop();
}
function renderSkillPop() {
  skillPopEl.replaceChildren();
  skillMatches.forEach((s, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "menu-item" + (i === skillFocus ? " focused" : "");
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", String(i === skillFocus));
    const name = document.createElement("span");
    name.className = "s-name";
    name.textContent = s.name.startsWith("skill:") ? `/${s.name}` : `/skill:${s.name}`;
    b.appendChild(name);
    const sub = s.description || s.location;
    if (sub) {
      const d = document.createElement("span");
      d.className = "s-desc";
      d.textContent = s.description && s.location ? `${s.description} · ${s.location}` : sub;
      b.appendChild(d);
    }
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => { skillFocus = i; acceptSkill(); });
    skillPopEl.appendChild(b);
  });
  skillPopEl.classList.remove("hidden");
  skillPopEl.querySelector(".menu-item.focused")?.scrollIntoView({ block: "nearest" });
}
function acceptSkill() {
  const s = skillMatches[skillFocus];
  if (!s || skillAnchor < 0) return;
  const caret = inputEl.selectionStart ?? inputEl.value.length;
  const insert = `/${s.name.startsWith("skill:") ? s.name : `skill:${s.name}`} `;
  inputEl.value = inputEl.value.slice(0, skillAnchor) + insert + inputEl.value.slice(caret);
  const pos = skillAnchor + insert.length;
  inputEl.selectionStart = inputEl.selectionEnd = pos;
  hideSkillPop(); saveDraft(); autosize(); updateSendState(); inputEl.focus();
}
inputEl.addEventListener("input", updateSkillPop);
inputEl.addEventListener("click", updateSkillPop);
inputEl.addEventListener("keyup", updateSkillPop);
document.addEventListener("pointerdown", (e) => {
  if (skillPopOpen() && !(e.target as HTMLElement).closest("#skill-pop") && e.target !== inputEl) hideSkillPop();
});
inputEl.addEventListener("keydown", (e) => {
  // IME composition: Enter confirms the composition, never sends or stops.
  if ((e as unknown as { isComposing?: boolean }).isComposing || e.keyCode === 229) return;
  if (skillPopOpen()) {
    if (e.key === "ArrowDown") { e.preventDefault(); skillFocus = (skillFocus + 1) % skillMatches.length; renderSkillPop(); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); skillFocus = (skillFocus - 1 + skillMatches.length) % skillMatches.length; renderSkillPop(); return; }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); acceptSkill(); return; }
    if (e.key === "Escape") { e.preventDefault(); hideSkillPop(); return; }
  }
  // Shell-style recall: ↑ in an empty composer brings back your last message.
  if (e.key === "ArrowUp" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && inputEl.value === "" && pendingImages.length === 0) {
    const last = [...messages].reverse().find((m) => m.role === "user");
    const text = last ? msgText(last) : "";
    if (text) {
      e.preventDefault();
      putInComposer(text);
    }
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (streaming) {
      // running + valid draft → steer; running + empty → no action (never abort)
      if (hasDraft()) doSteer();
    } else {
      if (hasDraft()) doSend();
    }
  } else if (e.key === "Escape" && streaming) {
    // Esc inside the composer stops only when there is no transient surface
    if (dialogs.size || menuRoot.innerHTML || modalRoot.innerHTML) return;
    e.preventDefault();
    doAbort();
  }
});
sendBtn.onclick = () => {
  if (streaming) doSteer();
  else doSend();
};
stopBtn.onclick = () => doAbort();
queueBtn.onclick = () => doFollowUp();

// ---------- theme ----------
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
    prefSet("pi-theme", theme);
  }
  applyThemeLabel();
}
function setThemePreference(p: "system" | "light" | "dark") {
  if (p === "system") {
    document.documentElement.dataset.themePreference = "system";
    try { localStorage.removeItem("pi-theme"); } catch { /* ignore */ }
    setTheme(matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light", false);
  } else setTheme(p, true);
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

// ---------- header actions ----------
($("btn-new") as HTMLButtonElement).onclick = newChat;


// ---------- sidebar resize: drag the edge, double-click resets ----------
const sidebarEl = $("sidebar");
const sideGrip = $("side-grip");
const SIDE_W_MIN = 200, SIDE_W_MAX = 480;
try {
  const w = Number(prefGet("pi-sidebar-w"));
  if (Number.isFinite(w) && w > 0) {
    sidebarEl.style.width = `${Math.min(SIDE_W_MAX, Math.max(SIDE_W_MIN, w))}px`;
  }
} catch {
  /* ignore */
}
sideGrip.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  try {
    sideGrip.setPointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
  sideGrip.classList.add("drag");
  const startX = e.clientX;
  const startW = sidebarEl.getBoundingClientRect().width;
  const move = (ev: PointerEvent) => {
    const w = Math.min(SIDE_W_MAX, Math.max(SIDE_W_MIN, startW + ev.clientX - startX));
    sidebarEl.style.width = `${w}px`;
  };
  const up = () => {
    sideGrip.removeEventListener("pointermove", move);
    sideGrip.classList.remove("drag");
    try {
      prefSet("pi-sidebar-w", String(Math.round(sidebarEl.getBoundingClientRect().width)));
    } catch {
      /* ignore */
    }
  };
  sideGrip.addEventListener("pointermove", move);
  sideGrip.addEventListener("pointerup", up, { once: true });
  sideGrip.addEventListener("pointercancel", up, { once: true });
});
sideGrip.addEventListener("dblclick", () => {
  sidebarEl.style.width = "";
  try {
    localStorage.removeItem("pi-sidebar-w");
  } catch {
    /* ignore */
  }
});
// Focus mode: hide the sidebar entirely (no width animation — layout only).
function applySidebar(hidden: boolean) {
  document.body.classList.toggle("side-hidden", hidden);
  const label = hidden ? `Show sidebar (${kbd("B")})` : `Hide sidebar (${kbd("B")})`;
  sidebarBtn.title = label;
  sidebarBtn.setAttribute("aria-label", label);
  sidebarBtn.setAttribute("aria-pressed", String(hidden));
}
function toggleSidebar() {
  const hidden = !document.body.classList.contains("side-hidden");
  applySidebar(hidden);
  prefSet("pi-sidebar-hidden", hidden ? "1" : "0");
  if (hidden && sidebarEl.contains(document.activeElement)) inputEl.focus();
}
applySidebar(prefGet("pi-sidebar-hidden") === "1");
sidebarBtn.onclick = toggleSidebar;
cwdBtn.onclick = () => openProjectPickerModal(cwd, "Open project", (dir) => { void setCwd(dir); });
cwdBtn.setAttribute("aria-label", "Change project folder");
($("btn-settings") as HTMLButtonElement).onclick = () => openSettings();

async function setModel(value: string) {
  const prev = modelPicker.state.value;
  const [provider, ...rest] = value.split("/");
  modelPicker.setState({ value }); // optimistic; rolled back below on failure
  try {
    await invokeChecked("pi_set_model", { provider, modelId: rest.join("/") });
    await refreshState();
  } catch (e) {
    modelPicker.setState({ value: prev });
    await refreshModels();
    notify({ text: `Couldn't switch model: ${String(e)}`, kind: "error", sticky: true, details: String(e) });
  }
}
async function setThinking(level: string) {
  const prev = thinkingPicker.state.value;
  thinkingPicker.setState({ value: level });
  try {
    await invokeChecked("pi_set_thinking", { level });
  } catch (e) {
    thinkingPicker.setState({ value: prev });
    try { await refreshState(); } catch { /* keep rollback */ }
    notify({ text: `Couldn't set thinking level: ${String(e)}`, kind: "error", sticky: true, details: String(e) });
  }
}

function syncSearchChrome() {
  const has = searchEl.value.length > 0;
  searchClear.classList.toggle("hidden", !has);
  searchHint.classList.toggle("hidden", has);
}
searchEl.addEventListener("input", () => {
  syncSearchChrome();
  if (debounceT) window.clearTimeout(debounceT);
  debounceT = window.setTimeout(() => {
    filter = searchEl.value;
    visibleLimit = 100;
    renderProjects();
  }, 150);
});
function clearSearch() {
  if (debounceT) { window.clearTimeout(debounceT); debounceT = null; }
  searchEl.value = "";
  syncSearchChrome();
  if (filter) { filter = ""; visibleLimit = 100; renderProjects(); }
}
searchClear.onclick = () => { clearSearch(); searchEl.focus(); };
// Search drives the list: ↓ moves into results, Enter opens the first match,
// Esc clears (or, when already empty, hands focus back to the composer).
searchEl.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    if (searchEl.value) clearSearch();
    else inputEl.focus();
    return;
  }
  if (e.key !== "ArrowDown" && e.key !== "Enter") return;
  // Flush a pending debounce so the list reflects exactly what was typed.
  if (debounceT) { window.clearTimeout(debounceT); debounceT = null; filter = searchEl.value; visibleLimit = 100; renderProjects(); }
  const first = chatListEl.querySelector<HTMLButtonElement>(".agent-item:not(:disabled), .chat-item:not(:disabled)");
  if (!first) return;
  e.preventDefault();
  if (e.key === "ArrowDown") first.focus();
  else first.click();
});

document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  // An open modal owns the keyboard: no chats created or panels opened behind it.
  if (mod && modalRoot.innerHTML) return;
  if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
    e.preventDefault();
    toggleSidebar();
    return;
  }
  if (mod && (e.key === "/" || e.key === "?")) {
    e.preventDefault();
    openShortcuts();
    return;
  }
  if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === "m") {
    e.preventDefault();
    modelPicker.open();
    return;
  }
  if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === "t") {
    e.preventDefault();
    thinkingPicker.open();
    return;
  }
  if (mod && !e.shiftKey && e.key.toLowerCase() === "r") {
    e.preventDefault();
    if (!booting && !bootError) startInlineRename();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
    e.preventDefault();
    newChat();
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (document.body.classList.contains("side-hidden")) toggleSidebar();
    searchEl.focus();
    searchEl.select();
  }
  if ((e.metaKey || e.ctrlKey) && e.key === ",") {
    e.preventDefault();
    openSettings();
  }
  if (e.key === "Escape") {
    if (modalRoot.innerHTML) return; // modal handles its own Escape
    if (menuRoot.innerHTML) {
      e.preventDefault();
      closeMenu();
      return;
    }
    if (dialogs.size) { e.preventDefault(); const first = dialogs.values().next().value as UiDialog; void respondUi(first.id, {cancelled:true}); return; }
    if (streaming && !stopping && document.activeElement !== inputEl) {
      e.preventDefault();
      doAbort();
    }
  }
});

// ---------- boot ----------
let bootPromise: Promise<void> | null = null;
async function boot(_respawn = false): Promise<void> {
  void _respawn;
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    const gen = ++bootGen; booting = true; bootError = null; navigating = true;
    saveDraft(); dialogs.clear(); dialogSlot.replaceChildren(); visibleDialogId = null;
    updateSendState(); hideConnError(); renderSettled();
    loadUnseen();
    armWatchdog();
    try {
      await initEvents();
      // No explicit spawn: the first scoped command ensures the cwd's
      // default session (spawning only if no process holds it yet).
      if (gen !== bootGen) return;
      clearRunScope(true); await refreshState();
      if (gen !== bootGen) return;
      restoreQueueBar();
      booting = false; restoreDraft(); updateSkillPop();
      await refreshMessages(); await refreshSessions(); await refreshAllProjects(); await refreshModels(); await refreshCommands(); await refreshStats();
      void refreshAgentModels();
      void refreshBranch();
      if (gen !== bootGen) return;
      hideConnError(); renderSettled(); inputEl.focus();
    } catch (e) {
      if (gen !== bootGen) return;
      bootError = String(e); booting = false; renderSettled();
      showConnError("Couldn't connect to pi.", () => boot(true));
    } finally { navigating = false; updateSendState(); disarmWatchdog(); if (!bootError && !dialogs.size) inputEl.focus(); }
  })();
  try { await bootPromise; } finally { bootPromise = null; }
}
void boot();
