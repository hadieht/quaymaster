#!/usr/bin/env bash
# One-command end-to-end run against the fixture environment.
#   npm run e2e           # Playwright suite (login, all eight sections, one full update flow)
#   npm run screenshots   # regenerates docs/screenshots/*.png (QM_VISIBLE_SCOPE hides everything but qmtest-*)
#
# SAFETY: the server is started natively on 127.0.0.1:${E2E_PORT:-8791} with QM_MANAGED_SCOPE=qmtest-* and
# QM_VISIBLE_SCOPE=qmtest-*; only test-fixtures/ stacks (qmtest-*, label quaymaster.test=true) are touched.
# Requires a built tree (npm run build), Docker, and the local alpine image. Chromium: `npx playwright install chromium`.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"
MODE="${1:-e2e}"
PORT="${E2E_PORT:-8791}"
FXDIR="${E2E_FIXTURE_DIR:-$ROOT/test-fixtures}"
# Screenshots must not show host-specific paths: run the fixtures from a neutral copy.
if [ "$MODE" = screenshots ] && [ -z "${E2E_FIXTURE_DIR:-}" ]; then
  FXDIR=/srv/qmtest/test-fixtures
  mkdir -p "$FXDIR" && cp -a "$ROOT/test-fixtures/." "$FXDIR/"
fi
FX="$FXDIR/scripts"

[ -f server/dist/index.js ] && [ -f web/dist/index.html ] || { echo "run 'npm run build' first" >&2; exit 1; }
if ss -ltn 2>/dev/null | grep -q ":$PORT "; then echo "port $PORT busy" >&2; exit 1; fi

DATA="$(mktemp -d "${TMPDIR:-/tmp}/qm-e2e.XXXXXX")"
SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  bash "$FX/upd-down.sh" >/dev/null 2>&1 || true
  bash "$FX/registry-down.sh" >/dev/null 2>&1 || true
  bash "$FX/down.sh" >/dev/null 2>&1 || true
  rm -rf "$DATA"
}
trap cleanup EXIT

echo "== fixtures"
bash "$FX/up.sh" all >/dev/null
bash "$FX/upd-up.sh" >/dev/null
bash "$FX/publish.sh" app 2 good >/dev/null # a new release the UI flow can roll out

echo "== server on 127.0.0.1:$PORT"
QM_HOST=127.0.0.1 QM_PORT="$PORT" QM_DATA_DIR="$DATA" QM_SECRET_KEY="$(openssl rand -base64 32)" \
  QM_MANAGED_SCOPE='qmtest-*' QM_VISIBLE_SCOPE='qmtest-*' QM_STACK_PATHS="$FXDIR/stacks" \
  QM_DOCKER_ROOT_MOUNT="$FXDIR" QM_REGISTRY_INSECURE=127.0.0.1:5055 QM_SCRYPT_LOG2_N=14 \
  QM_WEB_DIR="$ROOT/web/dist" NODE_ENV=production node server/dist/index.js >"$DATA/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  kill -0 "$SERVER_PID" 2>/dev/null || { cat "$DATA/server.log" >&2; exit 1; }
  sleep 0.5
done

echo "== playwright ($MODE)"
export E2E_BASE_URL="http://127.0.0.1:$PORT" E2E_DATA_DIR="$DATA"
if [ "$MODE" = screenshots ]; then
  npx playwright test --config e2e/playwright.config.ts --project=screenshots
else
  npx playwright test --config e2e/playwright.config.ts --project=e2e
fi
