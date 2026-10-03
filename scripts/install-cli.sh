#!/bin/bash
# Put `pi-agent` on PATH as a symlink to this checkout's cli/pi-agent.mjs.
# A symlink (not a copy) means every `git pull` updates the CLI in place.
#
# Where it goes, first match wins:
#   1. $PI_AGENT_BIN_DIR, if set
#   2. the folder holding `pi` — on PATH by definition (Homebrew, nvm, npm-global)
#   3. ~/.local/bin (created if needed; warns when it isn't on PATH)
#
# Safe to re-run. Never overwrites a `pi-agent` that isn't ours.
# Usage: ./scripts/install-cli.sh        (also run by install-latest.sh)
set -euo pipefail
cd "$(dirname "$0")/.."
target="$PWD/cli/pi-agent.mjs"
chmod +x "$target"

if ! command -v node >/dev/null 2>&1; then
  echo "pi-agent: node isn't on PATH — install Node 18+ first" >&2
  exit 1
fi

dir="${PI_AGENT_BIN_DIR:-}"
if [ -z "$dir" ]; then
  pi_bin="$(command -v pi 2>/dev/null || true)"
  if [ -n "$pi_bin" ] && [ -w "$(dirname "$pi_bin")" ]; then
    dir="$(dirname "$pi_bin")"
  else
    dir="$HOME/.local/bin"
  fi
fi
mkdir -p "$dir"
link="$dir/pi-agent"

if [ -e "$link" ] || [ -L "$link" ]; then
  current="$(readlink "$link" 2>/dev/null || true)"
  if [ "$current" = "$target" ]; then
    echo "pi-agent: already linked ($link)"
    exit 0
  fi
  case "$current" in
    */cli/pi-agent.mjs) ;; # an older checkout of this repo: safe to repoint
    *)
      echo "pi-agent: $link exists and isn't ours — leaving it alone (set PI_AGENT_BIN_DIR to install elsewhere)" >&2
      exit 1
      ;;
  esac
fi
ln -sf "$target" "$link"
echo "pi-agent: linked $link -> $target"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "pi-agent: note — $dir isn't on your PATH; add it to your shell profile:  export PATH=\"$dir:\$PATH\"" >&2 ;;
esac
