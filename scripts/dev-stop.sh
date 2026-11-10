#!/usr/bin/env bash
# Stops the dev server started by scripts/dev-server.sh
PIDF="$(dirname "${BASH_SOURCE[0]}")/../.local/dev-server.pid"
if [ -f "$PIDF" ]; then kill "$(cat "$PIDF")" 2>/dev/null || true; rm -f "$PIDF"; fi
echo stopped
