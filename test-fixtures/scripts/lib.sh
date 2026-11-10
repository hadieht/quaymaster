#!/usr/bin/env bash
# Shared helpers for the Quaymaster test fixtures.
# SAFETY: only ever touches Docker resources named qmtest-* AND labelled quaymaster.test=true.
set -euo pipefail

FIXTURES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACKS_DIR="$FIXTURES_DIR/stacks"
STACKS=(qmtest-multi qmtest-single qmtest-secrets)
STANDALONE=qmtest-standalone

compose_stack() { # compose_stack <stack> <compose args...>
  local stack="$1"; shift
  case "$stack" in qmtest-*) ;; *) echo "refusing non-fixture stack: $stack" >&2; exit 1;; esac
  [ -f "$STACKS_DIR/$stack/compose.yaml" ] || { echo "unknown fixture stack: $stack" >&2; exit 1; }
  docker compose --project-name "$stack" --project-directory "$STACKS_DIR/$stack" \
    --file "$STACKS_DIR/$stack/compose.yaml" "$@"
}

standalone_up() {
  if docker inspect "$STANDALONE" >/dev/null 2>&1; then
    docker start "$STANDALONE" >/dev/null
    return
  fi
  docker run -d --name "$STANDALONE" --label quaymaster.test=true --init --stop-timeout 2 \
    --pull never alpine:latest sh -c 'echo standalone started; exec sleep 3600' >/dev/null
}

# Removes a container only if it is a fixture: name qmtest-* AND the test label.
remove_if_fixture() {
  local ref="$1" name label
  name="$(docker inspect --format '{{.Name}}' "$ref" 2>/dev/null | sed 's#^/##')" || return 0
  label="$(docker inspect --format '{{index .Config.Labels "quaymaster.test"}}' "$ref" 2>/dev/null)" || return 0
  case "$name" in qmtest-*) ;; *) return 0;; esac
  [ "$label" = "true" ] || return 0
  docker rm -f -v "$ref" >/dev/null
}
