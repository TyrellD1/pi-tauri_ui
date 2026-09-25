# Batch 2 plan — ideas 1–7 (idea 8 excluded: standalone project)

Target: pi-tauri_ui @ 7e66058 (PR #1 merged). Branch: `feat/batch2-ideas-1-7`.
Exclusion: idea 8 (Tauri HTML viewer + adversarial-review skill) ships as a separate standalone project. No protocol changes to `pi --mode rpc`; no new npm/Rust deps; no polling (event-driven only, per AGENTS.md).

## 0. Discoveries to confirm before coding (30 min, all read-only)

- D1 — session-name persistence: backend `parse_session_preview` reads `session_info.name`, but real session files (v3) carry only a `{"type":"session",…}` header with no name. Check: rename a chat via RPC, then grep the session file for a name record. Decides whether rename/auto-rename survive restart or are session-scoped.
- D2 — `switch_session` tolerance: backend `ensure()` already switches to arbitrary paths; confirm opening a fresh `new_session` file with zero messages renders empty state (needed by items 5 and 7).
- D3 — stats payload: confirm `get_session_stats` returns `contextUsage {percent, tokens, contextWindow}` on the current pi build (code already reads it; verify non-null on a live chat).

## 1. Context circle + popup (idea 1)
Simplest call: circle = `contextUsage.percent`; popup lists tokens in/out, context tokens, window size, last compaction; 80% tick = compaction point.
- Header (or composer-foot right): a `ctx-circle` button showing `NN%`. Reuses `refreshStats()` data; no new timers — updates on existing call sites (open, submit, `agent_settled`).
- Click → `openModal("Context usage")` reusing `.stat-grid`: session, model, input/output tok, context tok, window, percent + thin bar with an 80% tick + `Compact now` button (existing `doCompact`).
- Acceptance: percent matches Session details; popup opens/closes via Esc + backdrop; ≥80% shows existing `ctx-warn` path unchanged.

## 2. Clickable .md / .html paths (idea 2)
Simplest call: linkify `*.md` / `*.html` tokens relative to cwd; click opens via `open <path>` (macOS, as specced).
- Frontend: post-process each rendered `.md` div (same pass as `resolveMdImages`): wrap path-like tokens ending `.md`/`.html` in `<button class="path-link">`. Resolve relative → `cwd/`; absolute kept as-is.
- Backend: new `pi_open_path { path }` — allowlist extensions (`md`, `html`), must exist + be a file, must be absolute or inside `cwd` (canonicalize, reject escapes); then `/usr/bin/open <path>`. Errors surface via `notify`, never throw raw.
- Rust test: rejects `.sh`, missing files, `../` escapes; accepts a temp `.md` (mock `open` via `PI_UI_OPEN_BIN` env override for tests).
- Acceptance: paths in chat highlight; click opens the file; `javascript:`/`http` never linkified.

## 3. Rename: modal discoverability + auto-rename (idea 3)
Simplest call: keep existing modal; add entry points; auto-rename = local heuristic, no model call.
- Add `Rename chat` to right-click chat menu (`openChatMenu`) operating on that row's session (needs a scoped `pi_set_name` for an arbitrary path — route via `targetScope`-style override already used by `openSession`).
- Double-click on `#chat-title` opens the same modal.
- Auto-rename: on the first `agent_settled` for a session whose `sessionName` is empty, set name = first user message cleaned + sliced to 48 chars (existing `deriveTitle`), once per session (in-memory guarded set). No model round-trip: zero cost/latency. If D1 shows names don't persist in files, note it in-session and file a pi-side follow-up; do not build a sidecar.
- Acceptance: rename from menu/modal/double-click updates sidebar after `refreshSessions`; first-run auto-name appears once, never overwrites a manual name.

## 4. ```json blocks render right (idea 4)
Simplest call: pretty-print + copy (reuse codeblock head); collapse only when long.
- `logic.ts` `renderMarkdown` fence branch: when lang == `json`, try `JSON.parse` → re-stringify 2-space; on failure render as-is. Over 50 lines: collapsed with `Show more / Show less` reusing the tool-output truncation pattern.
- Unit cases in `scripts/regression-check.mjs`: valid object/array, invalid JSON passthrough, long JSON collapse boundary.
- Acceptance: no new deps, grayscale unchanged, `npm test` green.

## 5. First chat shows up right away (idea 5)
Simplest call: refresh once the first message sends (as specced).
- `submit()` prompt-accepted path + `agent_start` for an unknown key: `await refreshSessions(); await refreshAllProjects();` (settled handler already does projects; sessions list is what's stale).
- Also refresh both after `newChatInProject` resolves.
- Acceptance: manual — new chat → send → sidebar row appears without switching away; no duplicate rows; no extra refresh while streaming (guard by key).

## 6. Progress step: move, spin, branch (idea 6)
Simplest call: status cluster moves right in composer-foot; spinner animates while streaming; branch shown beside it.
- Layout: composer-foot becomes `[spinner + status-line] … [branch]`. Move `#status-line` into a right-aligned cluster; add `.spin` (reuse `run-rotate` keyframes) visible only when `streaming`.
- Backend: `pi_git_branch { cwd }` — `git -C <cwd> rev-parse --abbrev-ref HEAD`, trimmed, `null` on any failure (not a repo / no git); cached per cwd in-memory, refreshed on `openSession`/`setCwd`. Frontend shows `⎇ <branch>` or nothing.
- Acceptance: idle shows `Ready` left... (right cluster), streaming spins; non-repo cwd shows no branch, no error; reduced-motion disables spin (existing media query pattern).

## 7. Code-made chats (idea 7)
Simplest call: app-side support only — `[code]`-prefixed names get a badge; Tauri command creates them; groups assigned via existing storage; pi extension deferred.
- Backend `pi_coded_chat { cwd, name, group?, firstMessage? }`: `ensure(pristine)` → `set_session_name("[code] " + name)` → optional `prompt` fire-and-forget for `firstMessage` → return `{ path }`. (Uses only existing RPC verbs; D2 confirms the file lists/opens.)
- Frontend: sidebar rows + title show a small `code` badge when name starts with `[code]`; if `group` given, append path to that `pi-chat-groups` entry (create if missing) then `renderProjects`.
- `scripts/new-coded-chat.mjs`: thin wrapper doc — how a script/extension triggers creation (open the app's Tauri command via a deep link? No — document: run inside app console or call the command from a future pi extension). Extension-on-pi is an explicit non-goal, noted as follow-up.
- Rust test: name prefix applied; unknown group created; no prompt → no stream started.
- Acceptance: created chat lists immediately (ties into item 5 refresh), carries badge, sits in the requested group, opens like any chat.

## Order + verification
Order: D1–D3 → 4 → 5 → 2 → 3 → 6 → 1 → 7 (pure-frontend first, backend commands together for 2/6/7, badge last).
Verify each: `npm run build`, `npm test`, `cargo test --manifest-path src-tauri/Cargo.toml`; final `npm run tauri build`. Update README sessions/shortcuts section. Open PR with `gh`, run `/html-review-checklist` after merge-ready.

## Open risks
- D1 may show renames don't persist → auto-rename becomes cosmetic; fallback: prefix `deriveTitle` display only, no RPC.
- `open(1)` exists on macOS only; Linux fallback `xdg-open` via cfg — Tauri target is macOS-first, note only.
- Item 6's "move over" is my interpretation (right cluster); original note is terse — flagged for Tyrell, not blocking.
