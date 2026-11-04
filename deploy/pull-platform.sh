#!/usr/bin/env bash
# Pulls one platform's image out of a multi-platform image and prints its reference (by digest).
#
#   deploy/pull-platform.sh <image>@<digest>|<image>:<tag> <amd64|arm64>
set -euo pipefail
ref=${1:?Usage: $0 <image reference> <arch>}
arch=${2:?Usage: $0 <image reference> <arch>}
name=${ref%@*}
[ "$name" != "$ref" ] || name=${ref%:*}

child=$(docker buildx imagetools inspect "$ref" --raw | jq -r --arg arch "$arch" \
  '.manifests[] | select(.platform.os == "linux" and .platform.architecture == $arch) | .digest')
if [ -z "$child" ] || [ "$(printf '%s\n' "$child" | wc -l)" -ne 1 ]; then
  echo "$ref has no single linux/$arch image." >&2
  exit 1
fi
docker pull --quiet --platform "linux/$arch" "$name@$child" > /dev/null
echo "$name@$child"
