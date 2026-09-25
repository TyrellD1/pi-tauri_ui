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

## Shortcuts & send contract

- `Enter` send (idle) / steer (running with a draft) · running + empty draft + `Enter` = no action
- `Shift+Enter` newline · IME composition `Enter` only confirms composition
- `Esc` stops the running turn (outside menus/dialogs); `Esc` on a menu/dialog dismisses only that surface
- Secondary composer action queues the draft as `follow_up` (sent after this turn)
- `⌘N` new chat · `⌘K` search · `⌘,` settings

Header holds the title (double-click to rename), a context-usage circle (click for the usage popup with the 80% compaction marker), a conversation menu (Session details, Compact, Export, Rename, Show tool activity, Quiet mode), and the sun/moon toggle. Model + thinking controls live beside the composer. The composer foot shows a spinner while streaming plus the git branch (`⎇ main`, hidden outside repos). Right-click any chat for Open / Rename / group actions. `.md` / `.html` paths in chat render as buttons that open via the OS opener (allowlisted, project-scoped). ```json fences pretty-print and collapse past 50 lines without touching Copy.

## Verify UI changes

```bash
npm run build
npm test
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build
```

For the actual app UI with a deterministic local transport, run:

```bash
npm run dev -- --port 1422 --host 127.0.0.1
```

Open `http://127.0.0.1:1422/?dev=1`. Expand **Preview scenarios** for populated, empty, streaming, permission, and rejected-send states. **Run UI regression** exercises the real composer, event handler, history renderer, drafts, permission responses, and navigation. Add `&listenerFailure=1` to verify startup retry. These controls and mock messages are excluded from production builds; no model calls occur in preview mode.

The small Markdown renderer supports headings, fenced code, lists, quotes, links, and tables. It deliberately escapes raw HTML. Tool output starts at 200 lines with full output and copying on demand. No new runtime dependencies or polling were added.
