#!/bin/sh
# Removes what builds and packages bring along that the app never needs at runtime: source maps,
# type declarations and build caches, third-party packages included. Used by the image build
# before deploy/check-image-files.sh.
set -eu
if [ $# -ne 1 ] || [ ! -d "$1" ]; then
  echo "Usage: $0 <folder>" >&2
  exit 2
fi
find "$1" \( -type f -o -type l \) \
  \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.tsbuildinfo' \) \
  -exec rm -f {} +
