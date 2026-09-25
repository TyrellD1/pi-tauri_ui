# Batch 2 plan — ideas 1–7 (idea 8 excluded: standalone project)

Target: pi-tauri_ui @ 7e66058 (PR #1 merged). Branch: `feat/batch2-ideas-1-7`.
Exclusion: idea 8 (Tauri HTML viewer + adversarial-review skill) ships as a separate standalone project. No protocol changes to `pi --mode rpc`; no new npm/Rust deps; no polling (event-driven only, per AGENTS.md).

## 0. Discoveries to confirm before coding (30 min, all read-only)

- D1 — session-name persistence: backend `parse_session_preview` reads `session_info.name`, but real session files (v3) carry only a `{"type":"session",…}` header with no name. Check: rename a chat via RPC, then grep the session file for a name record; record the EXACT name-record shape (or its absence) — §7's badge depends on teaching the parser that shape or falling back to a localStorage coded-path set. Decides whether rename/auto-rename survive restart or are session-scoped.
- D2 — `switch_session` tolerance: backend `ensure()` already switches to arbitrary paths; confirm opening a fresh `new_session` file with zero messages renders empty state (needed by items 5 and 7).
- D3 — stats payload: confirm `get_session_stats` returns `contextUsage {percent, tokens, contextWindow}` on the current pi build (code already reads it; verify non-null on a live chat).

## 1. Context circle + popup (idea 1) — rev R1 (F6, F7)
Simplest call: circle = `contextUsage.percent`; popup lists tokens in/out, context tokens, window size; 80% tick = compaction point. No “last compaction” row (no source field; add only if D3 finds one).
- Header: a `ctx-circle` button showing `NN%` (header owns the circle; footer stays spinner + status + branch — no two owners of the footer's right side). Reuses `refreshStats()` data; no new timers — updates on existing call sites (open, submit, `agent_settled`).
- Click → `openModal("Context usage")` reusing `.stat-grid`: session, model, input/output tok, context tok, window, percent + thin bar with an 80% tick + `Compact now` button (existing `doCompact`).
- Acceptance: percent matches Session details; popup opens/closes via Esc + backdrop; ≥80% shows existing `ctx-warn` path unchanged.

## 2. Clickable .md / .html paths (idea 2)
Simplest call: linkify `*.md` / `*.html` tokens relative to cwd; click opens via the OS opener (`tauri-plugin-opener`, i.e. `open <path>` behavior on macOS).
- Frontend: post-process each rendered `.md` div (same pass as `resolveMdImages`): wrap path-like tokens ending `.md`/`.html` in `<button class="path-link">`. Resolve relative → `cwd/`; absolute kept as-is.
- Backend: new `pi_open_path { cwd, path }` — called with the chat cwd (the app process cwd is NOT the project folder). Allowlist extensions (`md`, `html`), must exist + be a file; canonicalize BOTH `cwd` and the file before the inside-cwd check, reject escapes. Opens via the already-initialized `tauri-plugin-opener` (no hardcoded `/usr/bin/open`, no `xdg-open` cfg; exact Rust method confirmed at build). Errors surface via `notify`, never throw raw.
- [v3, UNREVIEWED — accepted from R2-F3 after depth exhausted]
- Rust test: rejects `.sh`, missing files, `../` escapes; opener call abstracted so tests assert the allowlist decision without launching anything.
- Acceptance: paths in chat highlight; click opens the file; `javascript:`/`http` never linkified.

## 3. Rename: modal discoverability + auto-rename (idea 3)
Simplest call: keep existing modal; add entry points; auto-rename = local heuristic, no model call.
- Add `Rename chat` to right-click chat menu (`openChatMenu`) operating on that row's session via a direct `invokeChecked("pi_set_name", { cwd: rowProject, session: rowPath, name })` — NEVER via `targetScope` (that global retargets every scoped command while set; it stays navigation-only).
- Double-click on `#chat-title` opens the same modal.
- Auto-rename: on the first `agent_settled` for a session whose `sessionName` is empty, set name = first user message whitespace-collapsed then sliced to 48 chars (extend `deriveTitle` cleanup), once per session (in-memory guarded set). No model round-trip: zero cost/latency. If D1 shows names don't persist in files, note it in-session and file a pi-side follow-up; do not build a sidecar.
- Acceptance: rename from menu/modal/double-click updates sidebar after `refreshSessions`; first-run auto-name appears once, never overwrites a manual name.

## 4. ```json blocks render right (idea 4)
Simplest call: pretty-print + copy (reuse codeblock head); collapse only when long.
- `logic.ts` `renderMarkdown` fence branch: when lang == `json`, try `JSON.parse` → re-stringify 2-space; on failure render as-is. Over 50 lines: hide the extra lines in the visible block only — the copy handler keeps copying `pre.textContent` (full text), mirroring neither tool-output one-way control nor truncating the copied text. Regression cases cover full text + the 50-line cutoff.
- Unit cases in `scripts/regression-check.mjs`: valid object/array, invalid JSON passthrough, long JSON collapse boundary.
- Acceptance: no new deps, grayscale unchanged, `npm test` green.

## 5. First chat shows up right away (idea 5)
Simplest call: refresh once the first message sends (as specced).
- `submit()` prompt-accepted path: the existing accept-time `pi_get_state` read adopts `sessionFile` when the view has none, then `await refreshSessions()`. Adopting changes `sessKey()`/`visibleKey()`, so on adopt ALSO retarget `pendingSend.owner` (and the in-flight `owner`) to the new key — otherwise `reconcileSend` keeps the optimistic block all turn and failed-send cards hide under the old key. And until the adopt lands, treat same-cwd events as this view even when `activePath` is still empty (before the `isVis` check) — otherwise pre-adopt `message_*` deltas are dropped. The once-guard is set only after the new path is actually in the list; one backup `refreshSessions` on `agent_settled` if it was missing. (`agent_start` needs no change; `newChatInProject` needs no extra refresh — it flows through `openSession`, which already refreshes.)
- [v3, UNREVIEWED — accepted from R2-F1 after depth exhausted]
- Acceptance: manual — new chat → send → sidebar row appears without switching away; no duplicate rows; no extra refresh while streaming (guard by key).

## 6. Progress step: move, spin, branch (idea 6)
Simplest call: status cluster moves right in composer-foot; spinner animates while streaming; branch shown beside it.
- Layout: composer-foot becomes `[spinner + status-line] … [branch]`. `#status-line` has exactly one place; add `.spin` reusing the existing `.run-spin` keyframes + reduced-motion rule, visible only when `streaming`. The branch takes `#token-line`'s right-edge slot (that rule owns `margin-left:auto` — move the margin to the branch element or the branch won't own the right edge).
- Backend: `pi_git_branch { cwd }` — `git -C <cwd> rev-parse --abbrev-ref HEAD`, trimmed, `null` on any failure (not a repo / no git); resolve git via PATH then `/usr/bin/git` then `/opt/homebrew/bin/git` (Finder-launch PATH is short — same lesson as `resolve_pi`); cached per cwd in-memory, refreshed on `openSession`/`setCwd`. Frontend shows `⎇ <branch>` or nothing.
- Acceptance: idle shows `Ready` in its single place, streaming spins; non-repo cwd shows no branch, no error; reduced-motion disables spin.

## 7. Code-made chats (idea 7)
Simplest call: app-side support only — `[code]`-prefixed names get a badge; Tauri command creates them; groups assigned via existing storage; pi extension deferred.
- Backend `pi_coded_chat { cwd, name, firstMessage? }` (NO `group` — groups live in webview localStorage `pi-chat-groups`, which Rust cannot touch): `ensure(pristine)` → `set_session_name("[code] " + name)` → optional `prompt` fire-and-forget for `firstMessage` → return `{ path }`. (Uses only existing RPC verbs; D2 confirms the file lists/opens.) Rust test: prefix applied + no-`firstMessage`-means-no-prompt, no live `pi` process.
- Frontend: the in-app caller passes `group?` — after `{ path }` returns, FIRST `await refreshSessions(); await refreshAllProjects();` (a coded chat never enters `submit()`/settle, so item-5's refresh never fires for it), and only then append the path to that `pi-chat-groups` entry (create if missing) + coded-path set — and only if the path is actually listed. Sidebar rows + title show a small `code` badge when the name starts with `[code]`; if D1 shows the parser can't read names from files (it only reads `session_info`, real files carry a `session` header), ALSO keep coded paths in a localStorage set and badge from that set, run through the SAME retention rule as groups (the `refreshAllProjects` prune drops unseen paths when `unseenFinished` is non-empty — apply it to both sets or neither loses silently).
- [v3, UNREVIEWED — accepted from R2-F2 after depth exhausted]
- External scripts cannot call Tauri commands and the pi extension is deferred, so this batch's caller is in-app (documented in `scripts/new-coded-chat.mjs` as the seam the future extension will use). Extension-on-pi stays an explicit non-goal.
- Acceptance: created chat lists immediately (ties into item 5 refresh), carries badge, sits in the requested group, opens like any chat.

## Order + verification
Order: D1–D3 → 4 → 5 → 2 → 3 → 6 → 1 → 7 (pure-frontend first, backend commands together for 2/6/7, badge last).
Verify each: `npm run build`, `npm test`, `cargo test --manifest-path src-tauri/Cargo.toml`; final `npm run tauri build`. Update README sessions/shortcuts section. Open PR with `gh`, run `/html-review-checklist` after merge-ready.

## Open risks
- D1 may show renames don't persist → auto-rename becomes cosmetic; fallback: prefix `deriveTitle` display only, no RPC.
- `pi_open_path` goes through `tauri-plugin-opener` (already a dependency), so no OS-specific open binary or cfg is needed.
- Item 6's "move over" is my interpretation (right cluster); original note is terse — flagged for Tyrell, not blocking.
