#!/usr/bin/env bash
# Starts the fixture registry: registry:2 as qmtest-registry on 127.0.0.1:5055 (labelled).
# Loopback registries are "insecure" by default for the Docker daemon, so no daemon config is touched.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

if [ "$(docker inspect --format '{{.State.Running}}' qmtest-registry 2>/dev/null || true)" = "true" ]; then
  echo "qmtest-registry already running"
  exit 0
fi
remove_if_fixture qmtest-registry
docker run -d --name qmtest-registry --label quaymaster.test=true \
  --publish 127.0.0.1:5055:5000 --stop-timeout 2 --pull never registry:2 >/dev/null
for _ in $(seq 1 40); do
  if curl -fsS http://127.0.0.1:5055/v2/ >/dev/null 2>&1; then echo "qmtest-registry ready on 127.0.0.1:5055"; exit 0; fi
  sleep 0.5
done
echo "qmtest-registry did not become ready" >&2
exit 1
