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
  - Implements `prompt` / `steer` / `abort` / `clear_queue`, `get_messages`, `get_state`, `new_session`, `switch_session`, models, thinking, compact, export, session listing from `~/.pi/agent/sessions/<cwd-slug>/`, and `extension_ui_response` for `select` / `confirm` / `input` / `editor`.
- Frontend (`src/`) is vanilla TS, no framework runtime. Grayscale system-font UI, markdown-lite renderer, streaming deltas, tool cards, thinking toggles, queue bar, `⌘N` / `⌘K` / `Esc`.

## Sessions

Sessions are cwd-bound (pi behavior). Switching working directory in Settings respawns the RPC process. Session files live under `~/.pi/agent/sessions/--path-slug--/`.

## Shortcuts

- `Enter` send · `Shift+Enter` newline · `Esc` stop
- `⌘N` new chat · `⌘K` search · `⌘,` settings
