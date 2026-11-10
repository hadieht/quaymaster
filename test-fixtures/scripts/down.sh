#!/usr/bin/env bash
# Tears the fixtures down (containers, fixture networks and volumes). Never prunes anything.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
for s in "${STACKS[@]}"; do
  compose_stack "$s" down --volumes --timeout 3 >/dev/null 2>&1 || true
done
remove_if_fixture "$STANDALONE"
# Leftovers from interrupted runs: explicitly listed fixture resources, each re-checked by name.
for id in $(docker ps -aq --filter label=quaymaster.test=true); do remove_if_fixture "$id"; done
for v in $(docker volume ls -q --filter label=quaymaster.test=true); do
  case "$v" in qmtest-*) docker volume rm "$v" >/dev/null 2>&1 || true;; esac
done
for n in $(docker network ls -q --filter label=quaymaster.test=true); do
  name="$(docker network inspect --format '{{.Name}}' "$n" 2>/dev/null || true)"
  case "$name" in qmtest-*) docker network rm "$n" >/dev/null 2>&1 || true;; esac
done
echo "fixtures removed"
