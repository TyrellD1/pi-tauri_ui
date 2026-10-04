---
name: pi-agent
description: Delegate work to headless pi agents with the `pi-agent` CLI. Use whenever the user says to use pi, hand a task to pi, spawn/run a pi agent or subagent, or delegate work to pi. Use `pi-agent`, never the bare `pi` CLI (that is the interactive coding agent and will hang or open a TUI).
---

# pi-agent

When the user says "use pi", "ask pi", "have a pi agent do X", or similar, they mean `pi-agent`, **not** `pi`.
Never run bare `pi` (interactive TUI) or `pi --mode rpc` yourself.

```bash
pi-agent run --cwd <project> --caller claude-code "<self-contained brief>"   # answer on stdout, progress on stderr
a=$(pi-agent run --detach --cwd <project> "task A"); pi-agent wait "$a"      # parallel: detach each, then wait
pi-agent models        # recommended models + when to use each (default used if --model omitted)
pi-agent list | status ID | result ID | cancel ID
```

- Briefs must be self-contained: the agent sees none of your context.
- Exit codes: `0` done, `1` failed, `130` cancelled, `2` bad input. `--json` for structured output.
- Run `pi-agent guide` for the full brief.
