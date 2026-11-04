#!/usr/bin/env bash
# Scans one image, which Docker already holds, for high and critical vulnerabilities that have a
# fix: what Trivy finds in the image, and the web app's packages. Those are bundled into the web
# app's files, so Trivy can't see them there; the build lists them in web-packages.cdx.json.
#
#   deploy/scan-image.sh <image> <out folder> [--fail]
#
# Needs TRIVY_IMAGE. Writes scan.json, web-scan.json, scan.txt, web-packages.cdx.json and count
# (the findings above) to the out folder, and all-severities.txt (every known vulnerability, for
# the record). With --fail, exits 1 on any finding. Always exits 1 if Trivy lists no packages for
# the image or for the web app: no packages would otherwise read as no vulnerabilities.
set -euo pipefail
image=${1:?Usage: $0 <image> <out folder> [--fail]}
out=${2:?Usage: $0 <image> <out folder> [--fail]}
fail=${3:-}
: "${TRIVY_IMAGE:?Set TRIVY_IMAGE}"
mkdir -p "$out"
out=$(cd "$out" && pwd)
work=$(mktemp -d)
cid=""
cleanup() {
  [ -z "$cid" ] || docker rm "$cid" > /dev/null 2>&1 || true
  rm -rf -- "$work"
}
trap cleanup EXIT

platform=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")
cid=$(docker create --platform "$platform" "$image")
docker cp "$cid:/app/frontend/dist/web-packages.cdx.json" "$out/web-packages.cdx.json"
docker save "$image" -o "$work/image.tar"

run_trivy() {
  # A shared cache, so the vulnerability database is downloaded once per run, not once per scan.
  docker run --rm -v sa-trivy-cache:/root/.cache/trivy -v "$work/image.tar:/image.tar:ro" \
    -v "$out:/out" "$TRIVY_IMAGE" "$@" \
    --no-progress --scanners vuln
}
trivy() { run_trivy "$@" --severity HIGH,CRITICAL --ignore-unfixed; }
trivy image --input /image.tar --format json --list-all-pkgs --output /out/scan.json
trivy sbom /out/web-packages.cdx.json --format json --list-all-pkgs --output /out/web-scan.json
for scanned in "scan.json:the image" "web-scan.json:the web app's packages"; do
  packages=$(jq '[.Results[]?.Packages[]?] | length' "$out/${scanned%%:*}")
  if [ "$packages" -eq 0 ]; then
    echo "$platform: Trivy found no packages in ${scanned#*:}, so this scan proves nothing." >&2
    exit 1
  fi
done
{
  echo "== $platform: the image"
  trivy image --input /image.tar --format table
  echo "== $platform: the web app's packages"
  trivy sbom /out/web-packages.cdx.json --format table
} > "$out/scan.txt"
{
  echo "== $platform: the image"
  run_trivy image --input /image.tar --format table
  echo "== $platform: the web app's packages"
  run_trivy sbom /out/web-packages.cdx.json --format table
} > "$out/all-severities.txt"

in_image=$(jq '[.Results[]?.Vulnerabilities[]?] | length' "$out/scan.json")
in_web=$(jq '[.Results[]?.Vulnerabilities[]?] | length' "$out/web-scan.json")
count=$((in_image + in_web))
echo "$count" > "$out/count"
echo "$platform: $count fixable high or critical vulnerabilities ($in_image in the image, $in_web in the web app's packages)."
if [ "$fail" = "--fail" ] && [ "$count" -gt 0 ]; then
  cat "$out/scan.txt"
  exit 1
fi
