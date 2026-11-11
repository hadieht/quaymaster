#!/usr/bin/env bash
# Update fixture: fixture registry + v1 images of db/app/worker pulled into the daemon + the qmtest-upd stack up.
# Usage: upd-up.sh
set -euo pipefail
here="$(dirname "${BASH_SOURCE[0]}")"
source "$here/lib.sh"
bash "$here/registry-up.sh" >/dev/null
for n in db app worker; do
  bash "$here/publish.sh" "$n" 1 good >/dev/null
  # a real "pull": the daemon gets the registry tag and digest, like a normal deployment
  docker pull --quiet "127.0.0.1:5055/qmtest-$n:latest" >/dev/null
done
compose_stack qmtest-upd up --detach --no-build --pull never --wait --wait-timeout 90
echo "qmtest-upd up"
