#!/bin/sh
# Adds the web app's packages to the SBOM Trivy made of the image, each package once, and fails
# unless all of them are in the result with a version.
#
#   deploy/merge-sbom.sh <image.cdx.json> <web-packages.cdx.json> <out.cdx.json>
set -eu
[ $# -eq 3 ] || { echo "Usage: $0 <image.cdx.json> <web-packages.cdx.json> <out.cdx.json>" >&2; exit 2; }

jq --slurpfile web "$2" '
  .components = ((.components // []) + ($web[0].components // [])
    | group_by(.purl // .["bom-ref"] // .name) | map(.[0]))
' "$1" > "$3"

missing=$(jq -n --slurpfile sbom "$3" --slurpfile web "$2" '
  ($sbom[0].components | map(select(.version != null and .version != "") | .purl)) as $have
  | [$web[0].components[].purl | select(. as $purl | $have | index($purl) | not)]
  | length')
total=$(jq '.components | length' "$2")
if [ "$total" -eq 0 ] || [ "$missing" -ne 0 ]; then
  echo "The SBOM lacks web app packages ($missing missing of $total)." >&2
  exit 1
fi
echo "SBOM: $(jq '.components | length' "$3") components, including all $total web app packages."
