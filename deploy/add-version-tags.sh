#!/usr/bin/env bash
# Adds the version tags to an image pushed by digest. Tags can't be written as one step or held
# back, so it first asks what they would point at, writing nothing, and stops if that isn't the
# digest. It then reads each tag back. Any tag on another digest fails the run and is named, as a
# wrong tag can't safely be deleted from here: the host may already have pulled it.
#
#   deploy/add-version-tags.sh <image> <digest> <tags, one per line>
set -euo pipefail
image=${1:?Usage: $0 <image> <digest> <tags>}
digest=${2:?Usage: $0 <image> <digest> <tags>}
tags=${3:-}
help='See "After a failed release run" in the README.'

args=()
while IFS= read -r tag; do
  if [ -n "$tag" ]; then args+=(-t "$tag"); fi
done <<< "$tags"
if [ "${#args[@]}" -eq 0 ]; then
  echo "This tag isn't a version: nothing to tag." >&2
  exit 1
fi

# The dry run prints the manifest that would be pushed, then one newline. Perl drops just that
# newline and keeps every other byte, on Linux and macOS alike (macOS head has no -c -1).
planned="sha256:$(docker buildx imagetools create --dry-run "${args[@]}" "$image@$digest" \
  | perl -pe 'chomp if eof' | sha256sum | cut -d' ' -f1)"
if [ "$planned" != "$digest" ]; then
  echo "::error::The tags would point at $planned, not at $digest. No tag was written. $help" >&2
  exit 1
fi

status=0
if ! docker buildx imagetools create "${args[@]}" "$image@$digest"; then
  echo "::error::Writing the tags failed, and some may be written. $help" >&2
  status=1
fi
while IFS= read -r tag; do
  if [ -z "$tag" ]; then continue; fi
  tagged=$(docker buildx imagetools inspect "$tag" --format '{{json .Manifest.Digest}}' | tr -d '"') \
    || tagged="nothing that could be read"
  if [ "$tagged" != "$digest" ]; then
    echo "::error::$tag points at $tagged, not at $digest. $help" >&2
    status=1
  fi
done <<< "$tags"
exit "$status"
