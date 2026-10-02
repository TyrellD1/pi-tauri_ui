#!/bin/bash
# Build the newest release, install it to /Applications, and link the
# `pi-agent` CLI onto PATH (see scripts/install-cli.sh).
# Usage: npm run install
set -euo pipefail
cd "$(dirname "$0")"

echo "→ pulling latest…"
git pull --ff-only

echo "→ checks…"
npx tsc --noEmit
npm test

echo "→ release build (~3 min warm)…"
npm run tauri build

APP="src-tauri/target/release/bundle/macos/pi.app"
echo "→ installing to /Applications…"
pkill -f "pi-tauri-ui/Contents" 2>/dev/null || true
sleep 1
rm -rf /Applications/pi.app
ditto "$APP" /Applications/pi.app
touch /Applications/pi.app

echo "→ linking the pi-agent CLI…"
# Non-fatal: the app is already installed; a CLI link problem only warns.
./scripts/install-cli.sh || echo "  (pi-agent wasn't linked — run ./scripts/install-cli.sh to see why)"

echo "→ launching…"
open /Applications/pi.app
echo "done — pi.app is current."
