#!/usr/bin/env bash
# Checks a finished image from outside: its file list (deploy/check-image-files.sh), no environment
# files or model exports anywhere in it, and its licence terms: the LICENSE file, the licence label,
# and third-party notices that name every package bundled into the web app, with its version.
#
#   deploy/check-finished-image.sh <image>
set -euo pipefail
image=${1:?Usage: $0 <image>}
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
cid=$(docker create "$image")
cleanup() {
  docker rm "$cid" > /dev/null 2>&1 || true
  rm -rf -- "$work"
}
trap cleanup EXIT

docker export "$cid" | tar -t > "$work/files.txt"
sed -n -E 's#^(\./)?app/##p' "$work/files.txt" | sh "$here/check-image-files.sh" --list -
# Outside /app too: whatever the base image holds.
if grep -E '(^|/)(\.env[^/]*|graph-export\.json)/?$' "$work/files.txt"; then
  echo "The image holds an environment file or a model export." >&2
  exit 1
fi

label=$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.licenses" }}' "$image")
if [ "$label" != "LicenseRef-SimpleArchitecture" ]; then
  echo "The image's licence label is '$label'." >&2
  exit 1
fi

docker cp "$cid:/app/LICENSE" "$work/LICENSE"
docker cp "$cid:/app/frontend/dist/third-party-licenses.txt" "$work/notices.txt"
docker cp "$cid:/app/frontend/dist/web-packages.cdx.json" "$work/web.cdx.json"
[ -s "$work/LICENSE" ] && [ -s "$work/notices.txt" ] || { echo "An empty licence file." >&2; exit 1; }

count=0
while IFS= read -r package; do
  count=$((count + 1))
  grep -qF "$package (" "$work/notices.txt" || {
    echo "The third-party notices don't list $package." >&2
    exit 1
  }
done < <(jq -r '.components[] | "\(.name) \(.version)"' "$work/web.cdx.json")
[ "$count" -gt 0 ] || { echo "The web app's package list is empty." >&2; exit 1; }
echo "Licence terms in the image: LICENSE, the label, and notices for all $count web app packages."
