# pi-tauri_ui

Grayscale, minimal-footprint Tauri UI for the [pi coding agent](https://github.com/badlogic/pi-mono) — the exact CLI harness (`pi --mode rpc`) in a quiet desktop shell.

![stack](https://img.shields.io/badge/tauri-v2-lightgrey) ![proto](https://img.shields.io/badge/pi---mode_rpc-lightgrey)

## Why

- Terminal `pi` is the source of truth. This app spawns `pi --mode rpc` from your chosen `cwd` — same settings, extensions, skills, models, sessions.
- Left: chat list. Middle: chat. Nothing else shouting.
- Guiding principles live in [AGENTS.md](./AGENTS.md): clean UI/UX, minimal hardware utilization (no polling, event-driven, <300KB frontend).

## Run

Prereqs: Node 18+, Rust stable, `pi` on PATH.

```bash
npm install
npm run tauri dev
```

Build:

```bash
npm run tauri build
```

## How it works

- Rust backend (`src-tauri/src/main.rs`) holds one long-lived `pi --mode rpc` child.
  - JSONL split on `\n` only (strips optional `\r`). Never `readline` semantics.
  - Commands with `id` await correlated `response` (30s timeout). All other lines emit as `pi-event` to the frontend.
  - Implements `prompt` / `steer` / `follow_up` / `abort` plus explicit `clear_queue`, `get_messages`, `get_state`, `new_session`, `switch_session`, models, thinking, compact, export, session listing from the actual directory reported by `get_state.sessionFile`, and `extension_ui_response` for `select` / `confirm` / `input` / `editor`.
  - `abort` stops only; queued steering/follow-up messages survive it (pi semantics) and are cleared only via the queue bar's explicit Clear action.
- Frontend (`src/`) is vanilla TS, no framework runtime. Grayscale system-font UI, markdown-lite renderer, ordered streaming with stable message and tool nodes, collapsed tool disclosures with output attached once by tool-call id, thinking collapsed, queue bar, `⌘N` / `⌘K` / `Esc`.
- Pure helpers live in `src/logic.ts` (markdown, tool summaries, 200-line output truncation, queue labels, send contract, activity labels) with focused checks in `scripts/regression-check.mjs`.

## Sessions

Sessions are cwd-bound (pi behavior). The backend keeps one `pi --mode rpc` process per live chat (cap 6, idle ones reaped), so switching chats or folders never disturbs a running turn — background runs keep streaming with a blue dot in the sidebar. The harness reports its session file; the UI uses that real directory. A brand-new chat adopts its session file on the first accepted send, so its row appears without switching away. All chats remain searchable, with 100 rows per page. Text drafts persist locally; image drafts stay in memory while switching between chats in the same app run.

Chats made by code carry a `[code]` name prefix (plus a local `code` badge that survives restarts) and can be filed into groups on creation: right-click empty sidebar → New coded chat, or call the `pi_coded_chat` Tauri command (`{ cwd, name, first_message? }`) from a future extension.

## Agents from the CLI (`pi-agent`)

Any caller (a terminal, a script, Claude Code) can hand work to a pi agent. `npm run install` (`install-latest.sh`) links the `pi-agent` command onto your PATH automatically, next to `pi`. To link it without rebuilding the app, run `npm run install:cli`.

```bash
pi-agent run --cwd ~/code/app "Find unused exports in src/ and list them"   # answer on stdout
```

- **Kept apart in the app.** Agents run headless with pi's normal full permissions, so nothing prompts. Their chats
  live only in the sidebar's **Headless subagents** section (with queued / running / done / failed status) and in a
  **Headless subagents** sub-folder inside each project. They never appear in Recent, in groups, or among a project's
  own chats.
- **Live while it runs.** With the app open you can watch an agent stream and stop it. The chat is read-only while
  the agent runs and writable once it finishes.
- **Queue.** At most 12 agents run at once (`pi-agent config set max-concurrent N`); the rest queue.
- **Recommended models.** A shared list with when-to-use and when-not-to-use notes. The default is
  `opencode-go/muse-spark-1.3-contributor`; edit it with `pi-agent models set|default|remove`.

Full reference: [docs/pi-agent.md](./docs/pi-agent.md). Design: [docs/pi-agent-cli-plan.md](./docs/pi-agent-cli-plan.md).

## Shortcuts & send contract

- `Enter` send (idle) / steer (running with a draft) · running + empty draft + `Enter` = no action
- `Shift+Enter` newline · IME composition `Enter` only confirms composition
- `↑` in an empty composer recalls your last message
- `Esc` stops the running turn (outside menus/dialogs); `Esc` on a menu/dialog dismisses only that surface
- Secondary composer action (◷) queues the draft as `follow_up` (sent after this turn)
- `⌘N` new chat · `⌘K` search (`↓` into results, `Enter` opens the first, `Esc` clears) · `⌘R` rename · `⌘B` hide/show sidebar · `⌘,` settings · `⌘/` shortcut sheet (Ctrl on Windows/Linux; hints follow the platform)
- Yes/no requests from pi answer with `Y` / `N` (ignored for 400ms after the card appears, and the card never steals focus from a half-typed message); `Esc` cancels

The header holds a sidebar toggle, a `project › chat` breadcrumb (click the project to start a chat elsewhere; double-click the title or press `⌘R` to rename it inline), a conversation menu (Session details, Compact, Export, Rename, Show tool activity, Quiet mode, Keyboard shortcuts, Settings), and the sun/moon toggle. The window title follows the chat (`● ` while a turn runs). Settings covers appearance (System / Light / Dark), transcript display, and the project folder (with Browse…). When the opencode CLI has an OpenCode Go key saved (`~/.local/share/opencode/auth.json`), an **OpenCode usage** button appears above Settings; it opens a popover with the 5-hour, weekly, and monthly plan limits, fetched from opencode.ai each time it opens. The context-usage circle sits at the right end of the project/group strip above the composer (click for a popover with tokens, window, and the 80% compaction marker; a dashed ring means nothing reported yet). Model and thinking are command pickers beside the composer (searchable popovers; models grouped by provider; `⌘⇧M` / `⌘⇧T` open them, `↑↓` + `Enter` pick, `Esc` clears the search then closes), next to an attach button (paste and drop work too). The composer foot shows a spinner while streaming plus the git branch (`⎇ main`, hidden outside repos). While pi works, a quiet live line at the end of the transcript says what it is doing, and a caret follows streaming prose. Hover a message for gutter actions (Copy; on your own messages also Edit, plus the send time). Notices are floating toasts that never shift the transcript; a background chat finishing offers **Open**. Markdown links open in the system browser. Right-click any chat for Open / Rename / group actions; right-click empty sidebar space for New coded chat. `.md` / `.html` paths in chat render as buttons that open via the OS opener (allowlisted, project-scoped). ```json fences pretty-print and collapse past 50 lines without touching Copy.

## Verify UI changes

```bash
npm run build
npm test            # logic + controller + pi-agent CLI end-to-end (fake pi, no model calls)
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build
```

For the actual app UI with a deterministic local transport, run:

```bash
npm run dev -- --port 1422 --host 127.0.0.1
```

Open `http://127.0.0.1:1422/?dev=1`. Expand **Preview scenarios** for populated, empty, streaming, permission, and rejected-send states. **Run UI regression** exercises the real composer, event handler, history renderer, drafts, permission responses, and navigation. Add `&listenerFailure=1` to verify startup retry. These controls and mock messages are excluded from production builds; no model calls occur in preview mode.

The small Markdown renderer supports headings, fenced code, lists, quotes, links, and tables. It deliberately escapes raw HTML. Tool output starts at 200 lines with full output and copying on demand. No new runtime dependencies or polling were added. `.md` / `.html` paths in chat render as clickable buttons (inline code included, fenced code and real links excluded).

**Run UI regression with a clean profile.** The suite reads real persisted state (drafts, groups, expanded projects, unseen dots), so repeated runs in one browser profile drift and report false failures. Click **Reset preview state** in the dev panel first (or clear site data) for a deterministic run; a clean profile passes all 46 checks.
