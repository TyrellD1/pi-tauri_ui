# pi-agent

`pi-agent` hands a task to a pi agent and prints the agent's final answer. Every agent is a real pi session, so it
shows up in the pi app under its project, badged **agent**. While the app is open you can watch it stream, answer its
permission prompts, and stop it. Agents also run with the app closed; the app picks them up on its next launch.

## Install

Node 18+ and `pi` on your `PATH`.

```bash
# from this repo; --ignore-scripts matters: the package's own `install` script rebuilds the app
npm link --ignore-scripts
# or put the script on PATH yourself
ln -s "$PWD/cli/pi-agent.mjs" /usr/local/bin/pi-agent
```

## Use

```bash
pi-agent run --cwd ~/code/app "Find unused exports in src/ and list them with file:line"
pi-agent run --cwd ~/code/app --model anthropic/claude-sonnet-4 --thinking high "…"
echo "long brief…" | pi-agent run --cwd ~/code/app --name "deps audit"
```

- Progress goes to **stderr**. The answer goes to **stdout**.
- Exit codes: `0` done, `1` failed, `130` cancelled, `2` bad input.
- `--json` returns `{ id, status, sessionFile, model, cwd, error, result }`.

**Run in parallel:** detach each run, then wait for each one.

```bash
a=$(pi-agent run --detach --cwd ~/code/app "task A")
b=$(pi-agent run --detach --cwd ~/code/app "task B")
pi-agent wait "$a"; pi-agent wait "$b"
```

**Manage agents:**

```bash
pi-agent list            # recent agents: queued #n / running / done / failed / cancelled / lost
pi-agent status ID       # one agent's record
pi-agent result ID       # a finished agent's full answer
pi-agent cancel ID       # stop it (pi is aborted cleanly)
```

## Queue

At most `max-concurrent` agents run at once across the whole machine. The default is **12**. Extra runs wait in a
first-in, first-out queue, and the app shows their position.

```bash
pi-agent config                      # { "maxConcurrent": 12 }
pi-agent config set max-concurrent 8
```

## Recommended models

One file tells every caller which model to use and why. `run` uses the default when `--model` is omitted.

```bash
pi-agent models                       # each model with "use" and "avoid" guidance
pi-agent models set anthropic/claude-sonnet-4 \
  --use "Hard reasoning, design reviews, tricky debugging." \
  --avoid "Bulk mechanical edits where a cheaper model is fine."
pi-agent models default anthropic/claude-sonnet-4
pi-agent models remove anthropic/claude-sonnet-4
pi-agent models reset                 # back to opencode-go/muse-spark-1.3-contributor
```

The app shows the same list under **Settings → Agents**. Recommended models also carry a hint in the model picker.

## Permission prompts

- **App open:** an agent's dialogs appear in the app, labelled with the agent's name, and your answer goes back to
  the agent.
- **App closed:** dialogs are cancelled so the run never hangs. Pass `--yes` to approve confirms (and take the first
  option of selects) instead.

Either way, stderr says what was auto-answered.

## For AI callers (Claude Code and others)

`pi-agent guide` prints a short brief: how to delegate, plus the current model recommendations. Paste it into a
`CLAUDE.md` / `AGENTS.md`, or have the caller run it first. A minimal snippet:

```md
## Delegating to pi agents
- Run `pi-agent run --cwd <project> --caller claude-code "<self-contained brief>"`; the answer is on stdout.
- Parallel: `--detach` each, then `pi-agent wait <id>`. Up to 12 run at once; the rest queue.
- Pick a model with `pi-agent models` (default used when `--model` is omitted).
- The user can watch and stop every agent in the pi app.
```

## Where things live

`$PI_AGENT_HOME`, default `~/.pi/agent/pi-tauri-ui/`:

| Path | What |
|---|---|
| `models.json` | Recommended models and the default |
| `config.json` | `maxConcurrent` |
| `agents/<id>.json` | One record per agent (status, cwd, session file, model, caller, times, error) |
| `agents/<id>.out.md` | The agent's full final answer |
| `queue/`, `slots/` | The machine-wide queue |
| `ui.sock` | The app's socket; exists only while the app runs (macOS/Linux) |

The agent's chat itself is an ordinary pi session in pi's sessions folder.
