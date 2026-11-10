#!/usr/bin/env bash
# Starts a LOCAL development server that is safe on a shared Docker daemon:
#   - binds 127.0.0.1 only
#   - QM_MANAGED_SCOPE=qmtest-* so mutating actions on real resources are refused server-side
#   - Compose projects are only recognised under test-fixtures/stacks
# Usage: scripts/dev-server.sh [data-dir]    (default data dir: .local/dev-data)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$(pwd)"
mkdir -p .local
[ -f .local/dev.env ] || echo "export QM_SECRET_KEY='$(openssl rand -base64 32)'" > .local/dev.env
# shellcheck disable=SC1091
source .local/dev.env
export QM_DATA_DIR="$(realpath -m "${1:-$ROOT/.local/dev-data}")"
export QM_HOST=127.0.0.1
export QM_PORT="${QM_PORT:-8787}"
export QM_STACK_PATHS="$ROOT/test-fixtures/stacks"
export QM_MANAGED_SCOPE='qmtest-*'
export NODE_ENV=test            # allows the fast scrypt setting below; never use in production
export QM_SCRYPT_LOG2_N=14
export QM_LOG_LEVEL="${QM_LOG_LEVEL:-info}"
echo $$ > "$ROOT/.local/dev-server.pid"
cd server
exec node --import tsx src/index.ts
