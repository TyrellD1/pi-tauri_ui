import { Conversation, type Message, textOf } from "./conversation";
import { invoke, listen } from "./tauri-shim";
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
interface UiDialog { id: string; card: HTMLElement; inFlight: boolean }
// ---------- dom ----------
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const chatListEl = $("chat-list");
const messagesEl = $("messages");
const messagesInner = $("messages-inner");
const inputEl = $("input") as HTMLTextAreaElement;
const sendBtn = $("btn-send") as HTMLButtonElement;
const stopBtn = $("btn-stop") as HTMLButtonElement;
const queueBtn = $("btn-queue") as HTMLButtonElement;
const statusLine = $("status-line");
const tokenLine = $("token-line");
const ctxWarn = $("ctx-warn");
const chatTitle = $("chat-title");
const chatSub = $("chat-sub");
const cwdBtn = $("btn-cwd") as HTMLButtonElement;
const cwdLabel = $("cwd-label");
const searchEl = $("search") as HTMLInputElement;
const dialogSlot = $("dialog-slot");
const attachStrip = $("attach-strip");
const attachError = $("attach-error");
const composerWrap = $("composer-wrap");
const noticesEl = $("notices");
const modelSelect = $("model-select") as HTMLSelectElement;
const thinkingSelect = $("thinking-select") as HTMLSelectElement;
const queueBar = $("queue-bar");
const modalRoot = $("modal-root");
const menuRoot = $("menu-root");
const menuBtn = $("btn-menu") as HTMLButtonElement;
const jumpBtn = $("jump-latest") as HTMLButtonElement;
const connError = $("conn-error");

// ---------- state ----------
let activeName = "";
let cwd = "", sessions: SessionInfo[] = [], activePath: string | null = null;
const projectChats = new Map<string, SessionInfo[]>();
let discovered: string[] = [];
let unlinked: { slug: string; sessions: SessionInfo[] }[] = [];
let expandedProjects = new Set<string>();
try {
  const raw = prefGet("pi-expanded");
  if (raw) expandedProjects = new Set(JSON.parse(raw) as string[]);
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

// ---------- notices ----------
function notify(opts: { text: string; kind?: "info" | "error"; sticky?: boolean; retryLabel?: string; onRetry?: () => void; details?: string }) {
  const el = document.createElement("div");
  el.className = "notice" + (opts.kind === "error" ? " error" : "");
  const body = document.createElement("div");
  body.className = "n-body";
  const span = document.createElement("span");
  span.textContent = opts.text;
  body.appendChild(span);
  if (opts.details) {
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
  if (opts.onRetry) {
    const r = document.createElement("button");
    r.type = "button";
    r.textContent = opts.retryLabel ?? "Retry";
    r.onclick = () => {
      el.remove();
      opts.onRetry?.();
    };
    actions.appendChild(r);
  }
  const x = document.createElement("button");
  x.type = "button";
  x.textContent = "Dismiss";
  x.setAttribute("aria-label", "Dismiss notice");
  x.onclick = () => el.remove();
  actions.appendChild(x);
  el.appendChild(actions);
  noticesEl.appendChild(el);
  if (!opts.sticky && opts.kind !== "error") {
    setTimeout(() => el.remove(), 6000);
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
  checked?: boolean;
  onPick: () => void;
}
let menuOutside: ((e: MouseEvent) => void) | null = null;
function closeMenu() {
  if (menuOutside) document.removeEventListener("mousedown", menuOutside);
  menuOutside = null;
  menuRoot.innerHTML = "";
  menuBtn.setAttribute("aria-expanded", "false");
  if (lastFocus && document.contains(lastFocus)) {
    lastFocus.focus();
    lastFocus = null;
  }
}
function openMenu(items: (MenuItem | "sep")[]) {
  lastFocus = document.activeElement as HTMLElement;
  menuRoot.innerHTML = "";
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Conversation actions");
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
    b.appendChild(check);
    b.appendChild(lab);
    b.onclick = () => {
      closeMenu();
      it.onPick();
    };
    menu.appendChild(b);
    buttons.push(b);
  });
  menuRoot.appendChild(menu);
  const r = menuBtn.getBoundingClientRect();
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  menuBtn.setAttribute("aria-expanded", "true");
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
    { label: "Rename chat", onPick: openRename },
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
  ]);
}
menuBtn.onclick = (e) => {
  e.stopPropagation();
  if (menuRoot.innerHTML) closeMenu();
  else openHeaderMenu();
};

// ---------- modals (accessible dialog, focus trap + restore) ----------
let modalPrevFocus: HTMLElement | null = null;
function closeModal() {
  modalRoot.innerHTML = "";
  if (modalPrevFocus && document.contains(modalPrevFocus)) {
    modalPrevFocus.focus();
    modalPrevFocus = null;
  }
}
function openModal(title: string, build: (body: HTMLElement, close: () => void) => void) {
  modalPrevFocus = document.activeElement as HTMLElement;
  modalRoot.innerHTML = "";
  const back = document.createElement("div");
  back.className = "modal-back";
  const box = document.createElement("div");
  box.className = "modal";
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
  const firstInput = box.querySelector<HTMLElement>("input, select, textarea, button");
  setTimeout(() => firstInput?.focus(), 20);
}

function openSettings() {
  openModal("Settings", (box, close) => {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "Choose the project you want to work on.";
    const lab = document.createElement("label");
    lab.textContent = "Project folder";
    lab.setAttribute("for", "m-cwd");
    const inp = document.createElement("input");
    inp.id = "m-cwd";
    inp.value = cwd;
    const hint = document.createElement("p");
    hint.className = "muted";
    hint.textContent = "Switches to that folder's chats. Running chats keep running. Drafts stay with their original chat.";
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
      const ncwd = inp.value.trim();
      close();
      if (ncwd && ncwd !== cwd) await setCwd(ncwd);
    };
    row.appendChild(c);
    row.appendChild(s);
    box.appendChild(p);
    box.appendChild(lab);
    box.appendChild(inp);
    box.appendChild(hint);
    box.appendChild(row);
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) s.click();
    });
  });
}

function openRename() {
  openModal("Rename chat", (box, close) => {
    const lab = document.createElement("label");
    lab.textContent = "Name";
    lab.setAttribute("for", "m-name");
    const inp = document.createElement("input");
    inp.id = "m-name";
    inp.value = chatTitle.textContent === "New chat" ? "" : chatTitle.textContent ?? "";
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
        await invokeScoped("pi_set_name", { name });
        await refreshState();
        await refreshSessions();
      } catch (e) {
        notify({ text: `Rename failed: ${String(e)}`, kind: "error", sticky: true, retryLabel: "Retry", onRetry: openRename });
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
          ["thinking", String((st.thinkingLevel as string) ?? thinkingSelect.value)],
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
function groupClosed(): Set<string> {
  try {
    const a = JSON.parse(prefGet("pi-groups-closed") ?? "[]") as unknown;
    return new Set(Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : []);
  } catch { return new Set(); }
}
function saveGroupClosed(s: Set<string>) { prefSet("pi-groups-closed", JSON.stringify([...s])); }
function parentsOpen(): { groups: boolean; projects: boolean } {
  try {
    const o = JSON.parse(prefGet("pi-parents") ?? "{}") as { groups?: boolean; projects?: boolean };
    return { groups: o.groups !== false, projects: o.projects !== false };
  } catch { return { groups: true, projects: true }; }
}
function saveParents(p: { groups: boolean; projects: boolean }) { prefSet("pi-parents", JSON.stringify(p)); }
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
    if (!info || !chatMatches(info, q)) continue;
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
    if (pruned) saveUnseen();
  }
  renderProjects();
}

function openAddProject() {
  openModal("Add project", (box, close) => {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "Existing projects appear automatically. Add a brand-new folder here to point pi at it before it has any chats.";
    const lab = document.createElement("label");
    lab.textContent = "Project folder";
    lab.setAttribute("for", "m-project");
    const pathRow = document.createElement("div");
    pathRow.className = "path-row";
    const inp = document.createElement("input");
    inp.id = "m-project";
    inp.placeholder = "/Users/you/workspace_a/projects/…";
    const browse = document.createElement("button");
    browse.type = "button";
    browse.textContent = "Browse…";
    browse.title = "Choose a folder in Finder";
    browse.onclick = async () => {
      try {
        const picked = await openFolderPicker({ directory: true, multiple: false, title: "Choose project folder" });
        if (typeof picked === "string" && picked) {
          inp.value = picked;
          inp.focus();
        }
      } catch {
        notify({ text: "Couldn't open the folder picker." });
      }
    };
    pathRow.appendChild(inp);
    pathRow.appendChild(browse);
    const row = document.createElement("div");
    row.className = "dialog-actions";
    const c = document.createElement("button");
    c.type = "button";
    c.textContent = "Cancel";
    c.onclick = close;
    const s = document.createElement("button");
    s.type = "button";
    s.textContent = "Add";
    s.className = "primary";
    s.onclick = async () => {
      const path = inp.value.trim();
      close();
      if (!path) return;
      const added = addedProjects();
      if (!added.includes(path)) prefSet("pi-added-projects", JSON.stringify([...added, path]));
      const hidden = hiddenProjects();
      if (hidden.delete(path)) prefSet("pi-hidden-projects", JSON.stringify([...hidden]));
      expandedProjects.add(path);
      saveExpanded();
      projectChats.set(path, projectChats.get(path) ?? []);
      await refreshAllProjects();
    };
    row.appendChild(c);
    row.appendChild(s);
    box.appendChild(p);
    box.appendChild(lab);
    box.appendChild(pathRow);
    box.appendChild(row);
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) s.click();
    });
  });
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
  t.textContent = s.name || s.preview.slice(0, 42) || "Untitled";
  const time = document.createElement("div");
  time.className = "ci-time";
  time.textContent = fmtRelative(s.mtime);
  row.appendChild(t);
  el.dataset.path = s.path;
  el.dataset.project = project;
  const rkey = `${project}:${s.path}`;
  const rlabel = s.name || s.preview.slice(0, 60) || "Untitled";
  if (runningSet.has(rkey)) {
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
  renderGroupsParent(q, parents.groups);
  renderProjectsParent(q, parents.projects);
}
function parentHead(title: string, key: "groups" | "projects", isOpen: boolean, extra: HTMLElement | null): HTMLElement {
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
    const list = all.filter((s) => chatMatches(s, q));
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
        const e = document.createElement("div");
        e.className = "project-empty";
        e.textContent = q ? "No matches in this project." : "No chats yet.";
        box.appendChild(e);
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
  const items = Array.from(chatListEl.querySelectorAll<HTMLButtonElement>(".chat-item"));
  if (items.length === 0) return;
  e.preventDefault();
  const i = items.indexOf(document.activeElement as HTMLButtonElement);
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
  const addItem = (label: string, onPick: () => void, checked?: boolean) => {
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
    menu.appendChild(b);
    buttons.push(b);
    return b;
  };
  const renderMain = () => {
    menu.replaceChildren(); buttons.length = 0;
    if (target.project) addItem("Open chat", () => openChat(target.project!, target.path));
    if (target.inGroup) addItem(`Remove from ${target.inGroup}`, () => removeFromGroup(target.inGroup!, target.path));
    addItem("Add to group ›", renderGroups);
  };
  const renderGroups = () => {
    menu.replaceChildren(); buttons.length = 0;
    const groups = loadGroups();
    const names = Object.keys(groups);
    addItem("‹ Back", renderMain);
    if (names.length === 0) {
      const e = document.createElement("div");
      e.className = "menu-note";
      e.textContent = "No groups yet.";
      menu.appendChild(e);
    }
    for (const n of names) {
      const member = groups[n].includes(target.path);
      addItem(n, () => toggleGroupMember(n, target.path), member);
    }
    addItem("＋ New group", () => openNewGroup(target.path));
  };
  renderMain();
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
    else if (e.key === "Tab") { closeMenu(); }
  });
  menuOutside = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) closeMenu();
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
chatListEl.addEventListener("contextmenu", (e) => {
  const item = (e.target as HTMLElement).closest(".chat-item") as HTMLElement | null;
  if (!item || !item.dataset.path) return;
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
  | { t: "user"; text: string; images: { data: string; mime: string }[]; key: string; failed?: FailedSend };
function blocks(): Block[] {
  const out: Block[] = [];
  const results = new Map(messages.filter(m => m.role === "toolResult").map(m => [m.toolCallId, m]));
  const calls = new Set<string>();
  messages.forEach((m, i) => {
    const key = `m-${i}`;
    if (m.role === "user") out.push({ t: "user", key, text: msgText(m), images: imgsOf(m) });
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
  btn.innerHTML = chevSvg() + '<span class="t-state"></span><span class="t-summary"></span>';
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
    const label = `${summary.lead}${summary.rest ? " · " + summary.rest.slice(0, 90) : ""}${b.isError ? " · failed" : ""}`;
    const lab = btn.querySelector(".t-summary")!; if (lab.textContent !== label) lab.textContent = label;
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
  lab.textContent = "Thinking";
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

function assistantTextBlock(text: string, key: string, images?: { data: string; mime: string }[]): HTMLElement {
  const div = document.createElement("div");
  div.className = "assistant-block";
  if (text) {
    const md = document.createElement("div");
    md.className = "md";
    md.innerHTML = renderMarkdown(text);
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
  const row = document.createElement("div");
  row.className = "msg-copy-row";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy-btn";
  copy.textContent = "Copy";
  copy.setAttribute("aria-label", "Copy message");
  fullTextByKey.set(key, text);
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(fullTextByKey.get(key) ?? "");
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 1200);
    } catch {
      copy.textContent = "Copy failed";
      setTimeout(() => (copy.textContent = "Copy"), 1200);
    }
  };
  row.appendChild(copy);
  div.appendChild(row);
  return div;
}

function userBlock(text: string, images: { data: string; mime: string }[], failed: string | null, onRetry?: () => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "user-block";
  const col = document.createElement("div");
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
function renderSettled() {
  if (booting || bootError) {
    resetView();
    const d = document.createElement("div"); d.className = "empty-state";
    const title = document.createElement("h2"); title.textContent = booting ? "Starting pi…" : "Couldn't connect to pi";
    const desc = document.createElement("p"); desc.className = "empty-folder"; desc.textContent = bootError ?? "Your workspace will be ready in a moment.";
    d.append(title, desc);
    if (bootError) { const b = document.createElement("button"); b.textContent = "Retry connection"; b.onclick = () => boot(true); d.append(b); }
    messagesInner.append(d); return;
  }
  const list = blocks();
  messagesInner.querySelector(".empty-state")?.remove();
  if (!list.length) {
    const d = document.createElement("div"); d.className = "empty-state";
    const h = document.createElement("h2"); h.textContent = "What would you like to work on?";
    const f = document.createElement("div"); f.className = "empty-folder"; f.textContent = cwd; f.title = cwd;
    const row = document.createElement("div"); row.className = "empty-actions";
    for (const text of ["Explain this project", "Review recent changes"]) {
      const b = document.createElement("button"); b.type = "button"; b.textContent = text;
      b.onclick = () => { inputEl.value = text; saveDraft(); autosize(); updateSendState(); inputEl.focus(); }; row.append(b);
    }
    d.append(h, f, row); messagesInner.append(d);
  }
  const keep = new Set(list.map(b => b.key));
  for (const [key, view] of rendered) if (!keep.has(key)) { view.node.remove(); rendered.delete(key); fullTextByKey.delete(key); }
  let cursor: ChildNode | null = messagesInner.firstChild;
  for (const b of list) {
    let view = rendered.get(b.key);
    if (!view || view.block.t !== b.t) {
      const node = b.t === "user" ? userBlock(b.text, b.images, b.failed?.error ?? null, () => retrySend(b.failed!)) :
        b.t === "text" ? assistantTextBlock(b.text, b.key, b.images) : b.t === "thinking" ? thinkDisclosure(b.text, b.key) : b.t === "tool" ? toolDisclosure(b) : bashDisclosure(b);
      view?.node.replaceWith(node); view = { node, block: b }; rendered.set(b.key, view);
      node.dataset.blockKey = b.key;
      node.setAttribute("role", "group"); node.setAttribute("aria-label", b.t === "user" ? "Your message" : b.t === "text" ? "pi response" : b.t === "thinking" ? "pi thinking" : "Tool activity");
    } else if (!sameBlock(view.block, b)) {
      if (b.t === "user") { const n = userBlock(b.text, b.images, b.failed?.error ?? null, () => retrySend(b.failed!)); n.dataset.blockKey = b.key; view.node.replaceWith(n); view.node = n; }
      if (b.t === "tool") updateTool.get(view.node)?.(b);
      if (b.t === "thinking") { const body = view.node.querySelector(".think-body"); if (body && body.textContent !== b.text) body.textContent = b.text; }
      if (b.t === "text") {
        fullTextByKey.set(b.key, b.text);
        let md = view.node.querySelector<HTMLElement>(".md");
        if (!md) { md = document.createElement("div"); md.className = "md"; view.node.prepend(md); }
        // Only the changed prose block is re-parsed; tools and prior prose stay untouched.
        if ((view.block as Extract<Block, {t:"text"}>).text !== b.text) md.innerHTML = renderMarkdown(b.text);
      }
      view.block = b;
    }
    if (cursor && cursor.parentNode !== messagesInner) cursor = view.node;
    if (view.node !== cursor) messagesInner.insertBefore(view.node, cursor);
    cursor = view.node.nextSibling;
  }
  scrollBottom(); updateJump();
  messagesInner.querySelectorAll<HTMLButtonElement>(".retry-btn").forEach(b => b.disabled = streaming || stopping || booting || !!bootError || !!sendInFlight);
}

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
  return invokeChecked<T>(cmd, { ...params, ...visibleScope() });
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
      streamActivity === "running" ? activityLabel("running", streamActivityTool) : activityLabel("thinking");
  } else if (extStatus) label = extStatus;
  else label = activityLabel("idle");
  statusLine.textContent = label;
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
  modelSelect.disabled = !conn || streaming; thinkingSelect.disabled = !conn || streaming;
  inputEl.disabled = navigating;
  $("btn-new").toggleAttribute("disabled", !conn);
  chatListEl.querySelectorAll<HTMLButtonElement>(".chat-item").forEach(b => b.disabled = !conn);
  sendBtn.disabled = !ok || !conn || sendInFlight !== null;
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
    queueBtn.classList.remove("hidden");
  }
  messagesInner.querySelectorAll<HTMLButtonElement>(".retry-btn").forEach(b => b.disabled = streaming || stopping || !conn || sendInFlight !== null);
  renderStatus();
}

// Session key that owns the live run. Kept until its settle arrives, even if
// the user has switched away (pi aborts the turn on switch; its leftover
// events must never render into the visible chat). runningSet drives the
// pulsing blue dots in the sidebar.
const runningSet = new Set<string>();
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
function setBusy(b: boolean) { streaming = b; if (!b) stopping = false; updateSendState(); }
function clearRunScope(preserveDialogs = false) {
  pendingSend = null; sendInFlight = null; conversation.reset(); messages = conversation.messages;
  if (!preserveDialogs) { dialogs.clear(); dialogSlot.replaceChildren(); visibleDialogId = null; }
  queue = { steering: [], followUp: [] }; renderQueue();
  noticesEl.replaceChildren(); attachError.classList.add("hidden");
  extStatus = ""; streamActivity = "thinking"; streamActivityTool = ""; resetView();
}
function applyState(st: Record<string, unknown>) {
  cwd = String(st.cwd ?? cwd); activePath = typeof st.sessionFile === "string" ? st.sessionFile : null;
  cwdLabel.textContent = cwd.split("/").filter(Boolean).pop() ?? cwd; cwdBtn.title = cwd;
  activeName = String(st.sessionName ?? "");
  chatTitle.textContent = activeName || deriveTitle() || "New chat";
  const level = String(st.thinkingLevel ?? thinkingSelect.value);
  if ([...thinkingSelect.options].some(o => o.value === level)) thinkingSelect.value = level;
  setBusy(st.isStreaming === true); renderProjects();
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
  return msgText(firstUser).slice(0, 48);
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
    const res = await invokeScoped<{messages: AgentMessage[]}>("pi_get_messages");
    if (gen !== bootGen || rev !== revision) return;
    conversation.reset(res.messages ?? []); messages = conversation.messages;
    reconcileSend(); chatTitle.textContent = activeName || deriveTitle() || "New chat"; renderSettled();
  } catch (e) {
    if (gen === bootGen) notify({ text: `Couldn't load messages: ${String(e)}`, kind: "error", sticky: true, retryLabel: "Retry", onRetry: refreshMessages });
  }
}
async function refreshSessions() {
  const gen = bootGen;
  try {
    const res = await invokeScoped<{sessions: SessionInfo[]}>("pi_list_sessions");
    if (gen !== bootGen) return;
    sessionsErrShown = false; sessions = res.sessions ?? [];
    projectChats.set(cwd, sessions);
    renderProjects();
  } catch (e) {
    if (gen === bootGen && !sessionsErrShown) { sessionsErrShown = true; notify({ text: `Couldn't list chats: ${String(e)}`, kind: "error", sticky: true, retryLabel: "Retry", onRetry: () => { sessionsErrShown = false; refreshSessions(); } }); }
  }
}

async function refreshModels() {
  const gen = bootGen;
  try {
    const res = (await invokeScoped("pi_get_models")) as { models: { id: string; provider: string }[]; current: string | null };
    if (gen !== bootGen) return;
    const cur = modelSelect.value;
    modelSelect.innerHTML = "";
    for (const m of res.models ?? []) {
      const o = document.createElement("option");
      o.value = `${m.provider}/${m.id}`;
      o.textContent = `${m.provider}/${m.id}`;
      o.title = `${m.provider}/${m.id}`;
      modelSelect.appendChild(o);
    }
    if (modelSelect.options.length === 0) {
      const o = document.createElement("option");
      o.textContent = "default model";
      modelSelect.appendChild(o);
    } else if (res.current && [...modelSelect.options].some((o) => o.value === res.current)) {
      modelSelect.value = res.current;
    } else if (cur && [...modelSelect.options].some((o) => o.value === cur)) {
      modelSelect.value = cur;
    }
    modelSelect.title = modelSelect.value || "Model";
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

async function refreshStats() {
  const gen = bootGen;
  try {
    const s = (await invokeScoped("pi_get_stats")) as {
      tokens?: { input: number; output: number; total: number };
      cost?: number;
      contextUsage?: { percent: number | null; tokens: number | null; contextWindow?: number };
    };
    if (gen !== bootGen) return;
    const parts: string[] = [];
    if (s.tokens) parts.push(`${((s.tokens.total ?? 0) / 1000).toFixed(1)}k tok`);
    if (typeof s.cost === "number") parts.push(`$${s.cost.toFixed(4)}`);
    if (s.contextUsage?.percent != null) parts.push(`${s.contextUsage.percent}% ctx`);
    tokenLine.textContent = ""; // Full usage/cost lives in Session details.
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
    notify({ text: "Send timed out. Use Retry beside it; your newer draft is unchanged.", kind: "error" });
  }
  if (navigating) {
    navigating = false;
    notify({ text: "Opening the chat timed out. Try again.", kind: "error" });
  }
  updateSendState();
  disarmWatchdog();
}
async function submit(d: Draft, kind: "prompt" | "steer" | "follow_up") {
  const owner = sessKey(), gen = bootGen, id = newClientId(), startIndex = messages.length;
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
      notify({ text: "Message wasn't sent. Use Retry beside it; your newer draft is unchanged.", kind: "error" });
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
    await invokeScoped("pi_abort");
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
  if (navigating || booting || sendInFlight) {
    if (sendInFlight) notify({ text: "Sending your message — one moment, then click again." });
    return;
  }
  if (dialogs.size) { notify({text: "Answer the pending request before changing chats or folders."}); return; }
  if (path !== null && project === cwd && path === activePath) {
    if (unseenFinished.delete(`${project}:${path}`)) { saveUnseen(); renderProjects(); }
    return;
  }
  navigating = true; saveDraft(); ++bootGen; updateSendState();
  armWatchdog();
  if (!eventsReady) await initEvents();
  targetScope = { cwd: project, session: path };
  try {
    await refreshState();
    if (activePath === null) throw new Error("pi returned no session");
    if (unseenFinished.delete(visibleKey())) saveUnseen();
    clearRunScope(true); restoreDraft(); updateSkillPop();
    await refreshMessages(); await refreshSessions(); await refreshModels(); await refreshCommands(); await refreshStats();
    expandedProjects.add(project); saveExpanded();
    await refreshAllProjects();
    stickToBottom = true; scrollBottom(true); inputEl.focus();
  } catch (e) {
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
    if (method === "setTitle" && typeof req.title === "string") document.title = req.title;
    if (method === "set_editor_text" && typeof req.text === "string") { inputEl.value = req.text; saveDraft(); autosize(); updateSendState(); }
    return;
  }
  const id = String(req.id ?? ""); if (!id || dialogs.has(id)) return;
  const card = document.createElement("div");
  card.className = "dialog-card";
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
    const row = document.createElement("div");
    row.className = "dialog-actions";
    const no = document.createElement("button");
    no.type = "button";
    no.textContent = "No";
    no.onclick = () => respondUi(id, { confirmed: false });
    const yes = document.createElement("button");
    yes.type = "button";
    yes.textContent = "Yes";
    yes.className = "primary";
    yes.onclick = () => respondUi(id, { confirmed: true });
    row.appendChild(cancelBtn("Cancel"));
    row.appendChild(no);
    row.appendChild(yes);
    card.appendChild(row);

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
  dialogs.set(id, {id, card, inFlight: false});
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
  if (next && next.id !== visibleDialogId) next.card.querySelector<HTMLElement>("input, textarea, button")?.focus({preventScroll:true});
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
    await invokeScoped("pi_ui_response", {id, payload});
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
  const folder = c.split("/").filter(Boolean).pop() ?? c;
  return `${title} (${folder})`;
}
async function handleEvent(p: PiEvent) {
  const t = p.type;
  if (t === "process_disconnected") {
    ++bootGen; booting = false; setBusy(false); runningSet.clear(); bootError = "pi disconnected. Reconnect to continue; your draft is kept.";
    saveDraft(); dialogs.clear(); dialogSlot.replaceChildren(); renderSettled(); updateSendState();
    showConnError("pi disconnected", () => boot(true)); return;
  }
  if (t === "instance_disconnected") {
    // One chat's process died (crash or lazy reaping). Visible chat: reconnect
    // path. Background chat: note it; reopening respawns transparently.
    const key = eventRowKey(p);
    if (key !== null && key === visibleKey()) {
      ++bootGen; booting = false; setBusy(false); runningSet.clear(); bootError = "pi process for this chat exited. Reconnect to continue; your draft is kept.";
      saveDraft(); dialogs.clear(); dialogSlot.replaceChildren(); renderSettled(); updateSendState();
      showConnError("chat process exited", () => openSession(cwd, activePath)); return;
    }
    if (key !== null) runningSet.delete(key);
    notify({ text: "A background chat's process exited. Reopen it to continue." });
    await refreshAllProjects(); return;
  }
  if (t === "extension_ui_request") { showExtensionDialog(p); return; }
  // Route by owning chat: untagged events (preview fixtures) belong here.
  const key = eventRowKey(p);
  const isVis = key === null || key === visibleKey();
  if (isVis && (t === "agent_start" || t === "agent_settled" || t.startsWith("message_") || t.startsWith("tool_execution_"))) pokeProgress();
  if (t === "queue_update") {
    if (!isVis) return;
    queue = { steering: (p.steering as string[]) ?? [], followUp: (p.followUp as string[]) ?? [] }; renderQueue(); return;
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
      if (done) notify({ text: `Finished in ${done}.` });
    }
    return;
  }
  if (t.startsWith("message_") || t.startsWith("tool_execution_")) {
    ++revision; conversation.ingest(p); messages = conversation.messages; reconcileSend();
    chatTitle.textContent = activeName || deriveTitle() || "New chat";
    if (t === "tool_execution_start") { streamActivity = "running"; streamActivityTool = String(p.toolName ?? "tool"); }
    if (t === "message_update") streamActivity = "thinking";
    if (t === "tool_execution_end" && p.isError) expandedTools.add(`tool-${p.toolCallId}`);
    renderStatus(); queueStreamUpdate();
  }
  if (t === "agent_settled") {
    if (key !== null) runningSet.delete(key);
    setBusy(false); pendingSend = null; renderSettled();
    // Keep live content visible while authoritative history is fetched.
    await refreshMessages(); await refreshAllProjects(); await refreshStats();
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

function attachValidationError(text: string) {
  attachError.classList.remove("hidden");
  attachError.textContent = text;
  setTimeout(() => {
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
composerWrap.addEventListener("dragleave", () => composerWrap.classList.remove("drag"));
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
  if (!trig || skills.length === 0) { hideSkillPop(); return; }
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
cwdBtn.onclick = () => openSettings();
($("btn-settings") as HTMLButtonElement).onclick = () => openSettings();

modelSelect.onchange = async () => {
  const [provider, ...rest] = modelSelect.value.split("/");
  const modelId = rest.join("/");
  modelSelect.title = modelSelect.value;
  try {
    await invokeChecked("pi_set_model", { provider, modelId });
    await refreshState();
  } catch (e) {
    await refreshModels();
    notify({ text: `Couldn't switch model: ${String(e)}`, kind: "error", sticky: true, details: String(e) });
  }
};
thinkingSelect.onchange = async () => {
  try {
    await invokeChecked("pi_set_thinking", { level: thinkingSelect.value });
  } catch (e) {
    try { await refreshState(); } catch {}
    notify({ text: `Couldn't set thinking level: ${String(e)}`, kind: "error", sticky: true, details: String(e) });
  }
};

searchEl.addEventListener("input", () => {
  if (debounceT) window.clearTimeout(debounceT);
  debounceT = window.setTimeout(() => {
    filter = searchEl.value;
    visibleLimit = 100;
    renderProjects();
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
      booting = false; restoreDraft(); updateSkillPop();
      await refreshMessages(); await refreshSessions(); await refreshAllProjects(); await refreshModels(); await refreshCommands(); await refreshStats();
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
