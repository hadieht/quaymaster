#!/usr/bin/env bash
# Builds a tiny versioned fixture image on top of the LOCAL alpine and pushes it to the fixture registry.
#
#   publish.sh <name> <version> [good|unhealthy|crash]     e.g.  publish.sh app 2 unhealthy
#
# The registry tag 127.0.0.1:5055/qmtest-<name>:latest is re-pointed registry-side. Only qmtest-build/<name>:<version> stays
# behind, so publishing never moves the "latest" tag in the local Docker image store: the daemon sees the
# new version only when something pulls it (exactly like a real upstream release).
#   good       starts, creates /tmp/ready, passes its healthcheck
#   unhealthy  starts but never becomes healthy
#   crash      exits immediately with status 1
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

name="${1:?name}"; version="${2:?version}"; kind="${3:-good}"
case "$name" in [a-z]*) ;; *) echo "bad name" >&2; exit 1;; esac
case "$kind" in good|unhealthy|crash) ;; *) echo "kind must be good|unhealthy|crash" >&2; exit 1;; esac

ctx="$(mktemp -d "${TMPDIR:-/tmp}/qmtest-publish.XXXXXX")"
trap 'rm -rf "$ctx"' EXIT
echo "$name $version $kind" > "$ctx/VERSION"
case "$kind" in
  good)      cmd='["sh","-c","touch /tmp/ready; exec sleep 3600"]';;
  unhealthy) cmd='["sh","-c","exec sleep 3600"]';;
  crash)     cmd='["sh","-c","echo boom >&2; exit 1"]';;
esac
cat > "$ctx/Dockerfile" <<EOF
FROM alpine:latest
LABEL quaymaster.test="true" qmtest.version="$version" qmtest.kind="$kind"
COPY VERSION /VERSION
HEALTHCHECK --interval=2s --timeout=2s --start-period=1s --retries=3 CMD test -f /tmp/ready
CMD $cmd
EOF
repo="127.0.0.1:5055/qmtest-$name"
vtag="v$version-$kind"
docker build --quiet --pull=false --provenance=false --tag "qmtest-build/$name:$version-$kind" --tag "$repo:$vtag" "$ctx" >/dev/null
docker push --quiet "$repo:$vtag" >/dev/null
docker image rm "$repo:$vtag" >/dev/null # untag only: qmtest-build/... keeps the image
# registry-side retag: PUT the same manifest under "latest" (the local store never gets a "latest" from here)
accept='application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json'
mf="$ctx/manifest.json"
ctype="$(curl -fsS -D - -o "$mf" -H "Accept: $accept" "http://127.0.0.1:5055/v2/qmtest-$name/manifests/$vtag" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-type"{print $2}')"
curl -fsS -X PUT -H "Content-Type: $ctype" --data-binary "@$mf" "http://127.0.0.1:5055/v2/qmtest-$name/manifests/latest" >/dev/null
echo "published qmtest-$name:latest = $version ($kind)"
