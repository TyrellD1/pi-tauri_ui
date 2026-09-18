# AGENTS.md — pi-tauri_ui

## Guiding Principles

### 1. Clean UI / UX above all
- Grayscale aesthetic only: `#fff`, `#fafafa`, `#f5f5f5`, `#e5e5e5`, `#a3a3a3`, `#737373`, `#525252`, `#171717`, `#0a0a0a`. No color except for semantic error/warning states (and even then, desaturated).
- System font stack. No webfont downloads. `-apple-system, BlinkMacSystemFont, "SF Pro", Inter, system-ui, sans-serif`.
- Monospace for code/tool output only: `ui-monospace, SFMono-Regular, Menlo, monospace`.
- Quiet chrome: 1px `#e5e5e5` borders, 8–12px radii, subtle shadows only on floating elements.
- Every interaction must feel instant (<100ms local feedback). Optimistic UI for sends. No spinners where a skeleton/shimmer will do. No layout shift.
- Keyboard-first: `Cmd+N` new chat, `Cmd+K` search chats, `Enter` send, `Shift+Enter` newline, `Esc` abort/stop, `Cmd+,` settings.
- Empty states teach. Error states explain + offer retry. Never a blank panel.

### 2. Minimal hardware utilization
- This is a chat shell around `pi --mode rpc`. The UI must never be the reason the fan spins.
- Rules:
  - No polling. Event-driven only (Tauri events from Rust side, no `setInterval` except a single 400ms streaming caret pulse, cleaned up on settle).
  - No frontend framework runtime if avoidable. Vanilla TS + minimal DOM diff. No React re-render storms. No animation libraries.
  - CSS animations: `transform` + `opacity` only. No `backdrop-filter` over scrolling lists. No blur over large areas.
  - Cap DOM nodes: virtualize or window chat lists >200 items, truncate tool output at 200 lines with "show full" on demand, collapse thinking by default.
  - Debounce search inputs (150ms), throttle autoscroll with `requestAnimationFrame`, use `IntersectionObserver` for code-block highlighting (lazy).
  - Rust backend: single long-lived `pi --mode rpc` child process. Line-buffered JSONL split on `\n` only (never Node `readline` semantics). Reuse buffers, avoid cloning large payloads. Emit Tauri events, don't log hot paths.
  - No telemetry, no auto-updater polling, no background timers. Idle = 0% CPU.
  - Bundle: no images, no fonts, inline SVG icons only. Target <300KB frontend JS.
- Measure before adding: if a dependency adds >10KB or a timer, justify it in the PR/commit message.

### 3. Pi integration = exact CLI harness via RPC
- Backend spawns `pi --mode rpc` from the user's chosen `cwd` with the same flags/settings as terminal `pi`.
- Protocol: JSONL over stdin/stdout, `\n` delimited, optional `\r` strip. See `~/.pi/agent/notes/2026-09-18-pi-permissions-ui-rpc.md`.
- Must implement: `prompt` / `steer` / `follow_up` / `abort`, render `message_update` (`text_delta`, `thinking_delta`, `toolcall_*`), `tool_execution_*`, `agent_settled`, sessions (`get_messages`, `get_state`, `new_session`, `switch_session`), extension dialogs (`extension_ui_request` → `extension_ui_response` for `select`/`confirm`/`input`/`editor`).
- Sessions are cwd-bound. Switching cwd = respawn RPC process. Never guess paths — use `get_state.sessionFile`.

### 4. Engineering habits
- Commit often. Small, working increments. `gh` cli for repo ops.
- Tauri v2 + vanilla TS frontend in `src/`, Rust in `src-tauri/`.
- `npm run tauri dev` for iteration. `npm run tauri build` must stay green.
- Keep `README.md` current with run instructions.
