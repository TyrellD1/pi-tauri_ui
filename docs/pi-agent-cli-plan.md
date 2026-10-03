# `pi-agent`: spawn pi agents from any CLI and watch them in the app

Branch: `claude/trusting-tesla-v7660q` (restarted from `main` @ 8d81b66, after #4 merged)

## Goal

Any caller (a terminal, a script, Claude Code, another agent) can hand work to a **pi agent** with one command and
get the answer back on stdout. Every agent is a real pi session, so it shows up in the pi Tauri app. While the app
is open you can watch it stream live, answer its permission prompts, and stop it. A machine-wide queue caps how many
agents run at once (default **12**). A small file of **recommended models**, editable from the CLI, tells callers
which model to use and when, defaulting to `opencode-go/muse-spark-1.3-contributor`.

## Ground truth (checked against the pi 1.0.0 docs: `docs/rpc*.md`, `cli.md`, `json.md`)

- `pi --mode rpc` accepts the normal CLI options: `--model <provider/id>`, `--thinking <level>`, `-n/--name <name>`.
- `prompt` → `response.data.disposition` is `started`, `queued` or `handled`. On `handled` no run starts, so don't wait.
- Wait for **`agent_settled`**, not `agent_end`: retries, compaction and queued messages can run after `agent_end`.
- `get_last_assistant_text` → `{ text | null }` gives the final answer, so callers never have to parse transcripts.
- Dialog requests (`select` / `confirm` / `input` / `editor`) **block** until an `extension_ui_response` arrives.
  A headless agent with nobody answering would hang forever, so it needs a policy (see §3).
- Closing stdin asks pi to shut down cleanly.

## Architecture

```
caller ──► pi-agent run "task"             (Node CLI, zero deps, ships in this repo)
             │  1. writes a registry record   ~/.pi/agent/pi-tauri-ui/agents/<id>.json
             │  2. waits for a queue slot      ~/.pi/agent/pi-tauri-ui/{queue,slots}/   (cap: config.json)
             │  3. spawns `pi --mode rpc --model … --name "[agent] …"` in --cwd
             │  4. prompt → stream → agent_settled → get_last_assistant_text → stdout
             │
             └─(optional) Unix socket ~/.pi/agent/pi-tauri-ui/ui.sock ──► Tauri app (if running)
                     CLI → app : agent_update, every pi event (tagged with cwd + session)
                     app → CLI : abort, ui_response (dialog answers)
```

- **Runs without the app.** Agents must never depend on a GUI being open. The CLI owns the pi process. The app is
  an optional observer.
- **Visible in the app for free.** Each agent is a normal pi session in pi's own sessions folder, so it appears under
  its project like any chat, named `[agent] …` and badged **agent**.
- **Live, with no polling.** When the app is running it listens on a Unix socket (tokio `UnixListener`, no new
  crate). The CLI forwards each pi event with the same `cwd` + `session` tags the app's own processes use, so the
  existing routing just works:
  - the sidebar spinner and the blue "finished" dot
  - "Finished in …" toasts
  - live streaming when you have that chat open

  With the app closed, the socket isn't there and the CLI skips it. The app reads the registry on launch.
- **No double writers.** While an agent runs, its chat is **read-only** in the app: the composer is locked and a
  banner offers **Stop**. When the agent settles, the backend retires any app process holding a stale copy of that
  session *before* passing the settle event on, so the next read loads the finished file.

## 1. CLI: `cli/pi-agent.mjs` (+ `cli/store.mjs`)

Node 18+ (pi already needs Node). No dependencies. Installed with `npm link` from the repo, or by putting
`cli/pi-agent.mjs` on `PATH`; `package.json` gets a `bin` entry.

| Command | What it does |
|---|---|
| `pi-agent run [opts] "task"` (or task on stdin) | Queue, run, and print the final answer to stdout. Exit `0` done, `1` failed, `130` cancelled. |
| `  --cwd DIR` | Project folder (default: current dir). |
| `  --model provider/id` | Model (default: the recommended default). |
| `  --thinking LEVEL` | Thinking level (`off` … `max`). |
| `  --name NAME` | Session name; the chat appears as `[agent] NAME` (default: first words of the task). |
| `  --detach` | Return the agent id right away; the run continues in the background. |
| `  --json` | Print a JSON result instead of plain text. |
| `  --timeout MIN` | Abort after N minutes (default: none). |
| `  --yes` | Auto-approve confirm dialogs when no app is attached to answer them. |
| `  --caller NAME` | Who started it (shown in the app); also `PI_AGENT_CALLER`. |
| `  --quiet` | No progress lines on stderr. |
| `pi-agent list [--json] [--all]` | Recent agents with status and queue position. |
| `pi-agent status ID [--json]` | One agent's record. |
| `pi-agent wait ID [--json]` | Block until it ends, then print its answer (pairs with `--detach`). |
| `pi-agent result ID` | Print a finished agent's full answer. |
| `pi-agent cancel ID` | Stop a queued or running agent. |
| `pi-agent models [--json]` | Recommended models, each with when to use it and when not to. |
| `pi-agent models set ID --use "…" --avoid "…" [--default]` | Add or update a recommendation. |
| `pi-agent models default ID` / `models remove ID` / `models reset` | Manage the list. |
| `pi-agent config [get\|set max-concurrent N]` | Machine-wide settings. |
| `pi-agent guide` | A short, paste-able brief for AI callers: how to delegate, plus the current recommendations. |

**Progress to stderr, answer to stdout.** A calling agent captures stdout as the answer and can ignore stderr.

**Storage** (`PI_AGENT_HOME` overrides the root; tests use it):

```
~/.pi/agent/pi-tauri-ui/
  models.json            { "default": "opencode-go/muse-spark-1.3-contributor", "models": [{ id, use, avoid }] }
  config.json            { "maxConcurrent": 12 }
  agents/<id>.json       registry record (status, cwd, sessionFile, model, pid, caller, times, error)
  agents/<id>.out.md     full final answer
  queue/<ts>-<id>        waiting tickets (FIFO)
  slots/<id>             running slots (pid inside)
  ui.sock                the app's socket (only while the app runs)
```

## 2. Queue (machine-wide, across independent processes)

- A waiter writes a ticket. It takes a slot when `slots + (its position among tickets) < maxConcurrent`. It writes
  the slot **before** deleting its ticket, so two waiters can never both take the last slot.
- Waiting is event-driven (`fs.watch` on `slots/`), plus one 2s re-check that clears stale entries. The re-check
  catches runners that crashed without releasing their slot (dead pid). This timer lives in the CLI waiter only,
  never in the UI.
- Slots and tickets are released on exit, on a signal (SIGINT / SIGTERM) and on a crash. The 2s re-check cleans up
  anything a hard kill leaves behind.
- The registry record carries the queue position, so `list` and the app can show `queued #3`.

## 3. Dialogs from headless agents

- **App attached:** the request goes to the app. The permission card appears and says which agent it's from, and
  your answer goes back over the socket.
- **No app:** cancel, so the run doesn't hang. With `--yes`, confirms are approved and selects take the first
  option. Either way the CLI writes a stderr note, so the caller knows a prompt was auto-answered.
- If the app disconnects while a dialog is open, it falls back to the same no-app policy.
- **Fix found along the way:** the app shows dialogs from *any* chat, but it always answered them through the
  *visible* chat's process. Dialogs now remember which chat they came from and answer there. This matters for agents
  and for background chats generally.

## 4. Recommended models

- Seeded with `opencode-go/muse-spark-1.3-contributor` as the default. Each entry has a one-to-two-sentence `use`
  and `avoid`.
- Edited from the CLI (`models set/default/remove/reset`). `run` uses the default when `--model` is omitted.
- Shown in the app: Settings → **Agents** lists them, with the default marked and the concurrency cap. Recommended
  models carry a "recommended" hint in the model picker.
- `pi-agent guide` and `models --json` give AI callers the same text, so a caller picks a model with a reason.

## 5. App changes

**Rust (`src-tauri/src/agents.rs`, no new crates):**
- Socket bridge (Unix only):
  - binds `ui.sock`, after first checking that no other running app owns it
  - one task per connection
  - a session → connection map so `pi_abort` and `pi_ui_response` reach the agent
- When a settle or terminal update arrives, it retires stale pool processes on that session file *before* passing
  the event on.
- New commands:
  - `pi_agents_list`: registry, newest first; reports dead runners as `lost`
  - `pi_agent_models`: the models file and config
  - `pi_agent_cancel`: sends SIGTERM to the runner, which aborts pi cleanly
  - `pi_agents_clear`: removes finished records
- Unit tests for record parsing and sorting, lost-pid detection, terminal-status rules and the socket-path ownership
  check.

**Frontend:**
- **Agents section** at the top of the sidebar, shown when any agents exist:
  - status for each agent (queued #n, a spinner while running, done, failed, stopped), its project, model and age
  - a `2 running · 1 queued` summary in the header
  - click to open its chat; right-click to Open / Stop / Copy ID
  - **Clear finished**
- **Read-only gate.** A running agent's chat locks the composer and shows a banner (`Running as a CLI agent ·
  claude-code · 3m — read-only until it finishes · Stop`). Stop cancels the agent.
- **Live.** Forwarded events stream into the open chat, and the sidebar spinner, finished dot and toasts all work.
  `agent_update` merges into the list.
- **`agent` badge** on `[agent] …` session rows.
- **Settings → Agents** (models, cap, the CLI commands to change them) and a "recommended" hint in the model picker.
- **Dialogs** remember their source chat and say which agent is asking.

## 6. Tests

- `scripts/agent-cli-check.mjs` runs the end-to-end CLI tests against a **fake `pi`**: a tiny Node RPC server set
  through `PI_BIN`. It checks:
  - run → answer on stdout, and the record goes from `running` to `done` with `sessionFile`
  - `--model` / `--name` / `--thinking` are passed to pi
  - the default model comes from `models.json`
  - the queue: 4 agents at `maxConcurrent 2` never run more than 2 at once, and all finish
  - `--detach` + `wait`, `cancel` while running (exit 130, status `cancelled`)
  - dialogs: auto-cancel with no app, `--yes` approves
  - `models set/default/remove`, `config set max-concurrent`
  - socket: a fake app socket receives `agent_update` and tagged events, and its `abort` stops the run
- Rust unit tests for `agents.rs` (`cargo test`).
- Dev-preview UI regression: `agent_update` events fill the Agents section. Opening a running agent's chat locks the
  composer and shows the banner, Stop calls `pi_agent_cancel`, and the settle unlocks it.

## As built

Everything above shipped. Changes made while building:

- **Queue race fixed (found by the tests).** Reading slots before tickets let two waiters take the last slot: the
  checks saw 3 running at a cap of 2. Tickets are now read first, which the slot-before-ticket-removal write order
  makes safe. Pid files are written with an atomic rename, so a concurrent sweep never reads an empty pid and
  deletes a live entry. A 10-agent burst at a cap of 3 now guards this.
- **A running agent's chat never starts an app-side pi process.** Loading a session could append entries to it, so
  the read-only view reads messages straight from the session file. It uses `pi_read_session`, allowlisted to
  session files that an agent record names. No command reaches a pool process for that chat until the agent ends.
  Then the chat reloads as an ordinary chat.
- **Automatic install.** `install-latest.sh` (`npm run install`) now runs `scripts/install-cli.sh`, which symlinks
  `pi-agent` next to `pi`, falling back to `~/.local/bin`. It's idempotent, never overwrites a foreign file, and a
  `git pull` updates the CLI through the symlink. `npm run install:cli` runs just this step. Plain `npm link` is no
  longer needed; it would also run the app installer, because of the package's `install` script.
- **Rust status.** Crate downloads (`static.crates.io`) were blocked by this environment's network policy, so the
  Rust changes are parse-checked (`rustfmt`) but **not compiled or `cargo test`ed here**. Logic sits in pure,
  unit-tested functions; run `cargo test` / `npm run tauri build` locally before merging.

### Follow-up (requested after review)

- **No permission handling.** Agents run with pi's normal full permissions, so `--yes`, forwarding dialogs to the app
  and answering them from the app are all removed. As a safety net, the runner dismisses any stray extension dialog
  itself and never forwards it to the app. The fix for background-chat dialogs answering through the visible chat
  stays.
- **Sidebar placement.** Agent chats are flagged in two ways: the registry's session files, plus the `[agent]` name
  for records that have been pruned. They live only in:
  - a top-level **Headless subagents** section, a sibling of Recent, Groups and Projects, which replaces "Agents"
  - a collapsible **Headless subagents** sub-folder at the top of each project, with its open state remembered per
    project

  They are excluded from Recent, from groups, and from a project's top-level list and count. The "Add to group"
  action and the group badge are hidden for them. Once an agent finishes, its chat is writable like any other.

## Out of scope (follow-ups)

- **Steering a running agent from the app.** It's read-only for now. The socket could carry `steer` later.
- **Resuming an agent's session from the CLI** (`--session`). Every run is a new session today.
- **Windows named pipe** for the socket. The CLI works without it; only live view needs it.
