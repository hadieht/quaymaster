#!/usr/bin/env bash
# Smoke test against a locally running dev server (127.0.0.1): first-run setup (or login) and the
# main read endpoints. Usage: scripts/smoke.sh   (env: QM_URL, QM_DATA_DIR, QM_SMOKE_PASSWORD)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
URL="${QM_URL:-http://127.0.0.1:8787}"
B="$URL/api/v1"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT
PASS="${QM_SMOKE_PASSWORD:-correct-horse-battery}"
H_ORIGIN="Origin: $URL"
H_JSON='Content-Type: application/json'

echo "== healthz";       curl -s "$URL/healthz"; echo
echo "== auth/status";   curl -s "$B/auth/status"; echo
echo "== unauthenticated request is refused"
curl -s -o /dev/null -w '%{http_code}\n' "$B/containers"
echo "== POST without Origin is refused"
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$B/auth/login" -H "$H_JSON" -d '{}'

if curl -s "$B/auth/status" | grep -q '"setupRequired":true'; then
  echo "== first-run setup"
  SETUP_TOKEN="$(cat "${QM_DATA_DIR:-.local/dev-data}/setup-token")"
  curl -s -c "$JAR" -X POST "$B/auth/setup" -H "$H_ORIGIN" -H "$H_JSON" \
    -d "{\"token\":\"$SETUP_TOKEN\",\"username\":\"admin\",\"password\":\"$PASS\"}" | head -c 300; echo
else
  echo "== login"
  curl -s -c "$JAR" -X POST "$B/auth/login" -H "$H_ORIGIN" -H "$H_JSON" \
    -d "{\"username\":\"admin\",\"password\":\"$PASS\"}" | head -c 300; echo
fi

get() { curl -s -b "$JAR" "$B/$1"; }
echo "== system/mode";   get system/mode; echo
echo "== system/health"; get system/health; echo
echo "== containers (name state health capability mutable)"
get containers | python3 -c "import sys,json; [print(' ',c['name'],c['state'],c['health'],c.get('capability'),c['mutable']) for c in json.load(sys.stdin)]"
echo "== compose projects (name level status services)"
get compose/projects | python3 -c "import sys,json; [print(' ',p['name'],p['level'],p['status'],len(p['services']),(p['reasons'] or [''])[0][:70]) for p in json.load(sys.stdin)]"
echo "== images / volumes / networks counts"
for r in images volumes networks; do echo "  $r: $(get $r | python3 -c 'import sys,json; print(len(json.load(sys.stdin)))')"; done
echo "== host metrics"; get system/host | head -c 400; echo
