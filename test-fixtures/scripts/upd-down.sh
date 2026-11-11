#!/usr/bin/env bash
# Removes the update fixture stack (containers, its volume and network). Leaves the registry running.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
compose_stack qmtest-upd down --volumes --timeout 3 >/dev/null 2>&1 || true
# containers left behind by a failed run (e.g. renamed orphans): fixture-labelled and qmtest-* only
for id in $(docker ps -aq --filter label=quaymaster.test=true); do remove_if_fixture "$id"; done
echo "qmtest-upd removed"
