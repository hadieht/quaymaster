#!/usr/bin/env bash
# Removes the fixture registry and the fixture images built for it. Explicit names only, never a prune.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

remove_if_fixture qmtest-registry
# fixture images: repository names qmtest-* under the fixture registry or the local build namespace,
# AND the test label. Docker's own `reference=` filter selects them; each is removed by tag, unforced.
for ref in $(docker image ls --filter label=quaymaster.test=true --format '{{.Repository}}:{{.Tag}}' | grep -E '^(127\.0\.0\.1:5055/qmtest-|qmtest-build/|quaymaster-(staged|rollback)/)' || true); do
  docker image rm "$ref" >/dev/null 2>&1 || true
done
echo "fixture registry removed"
