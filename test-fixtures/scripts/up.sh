#!/usr/bin/env bash
# Brings the fixtures up. Usage: up.sh [all|multi|single|secrets|standalone]...
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
targets=("${@:-all}")
for t in "${targets[@]}"; do
  case "$t" in
    all)
      for s in "${STACKS[@]}"; do compose_stack "$s" up --detach --no-build --pull never --wait --wait-timeout 60; done
      standalone_up;;
    multi|single|secrets) compose_stack "qmtest-$t" up --detach --no-build --pull never --wait --wait-timeout 60;;
    standalone) standalone_up;;
    *) echo "unknown target: $t" >&2; exit 1;;
  esac
done
