#!/usr/bin/env bash
# CI: runs the built image the way a host should (read-only root file system, no capabilities,
# a throwaway PostgreSQL) and checks it from outside:
# - it runs as a non-root user and can't change its own code;
# - it starts and serves the web app with a read-only root file system;
# - it listens on port 8080 only;
# - path tricks (/../, %2e%2e, ...) return the app shell or an error, never a file;
# - /api/health names no version, and the logs hold no errors.
#
#   deploy/test-container.sh <image>
#
# Needs Docker, curl and openssl. Every value here is made up for this run.
set -euo pipefail

image=${1:?Usage: $0 <image>}
# Test only, never shipped. Pinned by tag and digest like the Node base image.
pg_image=postgres:17.11-alpine3.24@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b
port=18080
base="http://127.0.0.1:$port"
db=sa-container-test-db
app=sa-container-test-app
work=$(mktemp -d)
password=$(openssl rand -hex 24)

cleanup() {
  docker rm -f "$app" "$db" >/dev/null 2>&1 || true
  rm -rf -- "$work"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  echo "--- last app log lines ---" >&2
  docker logs "$app" 2>&1 | tail -40 >&2 || true
  exit 1
}
pass() { echo "ok: $*"; }

# TCP sockets listening and UDP sockets bound in a container's network, as "tcp/<hex port>".
listening() {
  local proto
  for proto in tcp tcp6 udp udp6; do
    docker exec "$1" cat "/proc/net/$proto" 2>/dev/null | awk -v proto="$proto" '
      NR > 1 && ((proto ~ /^tcp/ && $4 == "0A") || (proto ~ /^udp/ && $4 == "07")) {
        n = split($2, address, ":"); print substr(proto, 1, 3) "/" address[n]
      }'
  done | sort -u
}

# --- The image's own settings ---
user=$(docker image inspect --format '{{.Config.User}}' "$image")
[ "$user" = node ] || fail "the image runs as '$user', not the non-root user node"
ports=$(docker image inspect --format '{{range $port, $_ := .Config.ExposedPorts}}{{$port}} {{end}}' "$image")
[ "$ports" = "8080/tcp " ] || fail "the image exposes '$ports', not only 8080/tcp"
pass "image user node, exposes 8080/tcp only"

# Even without a read-only file system, the app user can't change the app.
docker run --rm --entrypoint sh "$image" -c \
  'test ! -w /app && test ! -w /app/backend/dist/server.js && test ! -w /app/frontend/dist/index.html && test ! -w /app/node_modules' \
  || fail "the app user can write to /app"
pass "the app user can't write to /app"

# --- A throwaway database. The app shares its network, so it reaches the database on 127.0.0.1
#     (any other host needs TLS) and the published port is set here. ---
docker run -d --name "$db" -p "127.0.0.1:$port:8080" \
  -e POSTGRES_USER=sa -e POSTGRES_DB=sa -e POSTGRES_PASSWORD="$password" "$pg_image" >/dev/null
for _ in $(seq 60); do
  docker exec "$db" pg_isready -q -h 127.0.0.1 -U sa -d sa && break
  sleep 1
done
docker exec "$db" pg_isready -q -h 127.0.0.1 -U sa -d sa || fail "the test database did not start"
before=$(listening "$db")

# --- The app, as a host should run it ---
docker run -d --name "$app" --network "container:$db" \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  -e DATABASE_URL="postgres://sa:$password@127.0.0.1:5432/sa" \
  -e OIDC_ISSUER=https://idp.example.test/tenant-a \
  -e OIDC_CLIENT_ID=11111111-2222-3333-4444-555555555555 \
  -e OIDC_CLIENT_SECRET="$(openssl rand -hex 24)" \
  -e SESSION_SECRET="$(openssl rand -base64 48)" \
  -e APP_DOMAIN=simplearchitecture.example.test \
  -e OIDC_ROLES_CLAIM=roles -e OIDC_ROLE_ADMIN=Admin -e OIDC_ROLE_MODELLER=Modeller -e OIDC_ROLE_VIEWER=Viewer \
  "$image" >/dev/null

for _ in $(seq 90); do
  [ "$(docker inspect --format '{{.State.Running}}' "$app")" = true ] || fail "the app stopped"
  curl -fsS -o /dev/null "$base/api/health" 2>/dev/null && break
  sleep 1
done
health=$(curl -fsS "$base/api/health") || fail "the app did not answer /api/health"
[ "$health" = '{"status":"ok"}' ] || fail "/api/health says more than its status: $health"
pass "started with a read-only root file system; /api/health is {\"status\":\"ok\"}"

# --- The app is up, and anything else is closed to a visitor. ---
code=$(curl -sS -o /dev/null -w '%{http_code}' "$base/api/models")
[ "$code" = 401 ] || fail "/api/models answers $code to a visitor, not 401"
pass "a visitor gets 401 from the API"

# --- Runs as non-root, and can't write anywhere ---
uids=$(docker exec "$app" sh -c "awk '/^Uid:/ { print \$2, \$3, \$4, \$5 }' /proc/1/status")
[ "$uids" = "1000 1000 1000 1000" ] || fail "the app process runs with uids '$uids', not 1000"
for path in /app/probe /tmp/probe /probe; do
  if docker exec "$app" sh -c "touch $path" 2>/dev/null; then fail "the app could write $path"; fi
done
pass "the app process runs as uid 1000 and can't write to the file system"

# --- Listens on 8080 only ---
after=$(listening "$db")
added=$(comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after") | sed '/^$/d')
[ "$added" = "tcp/1F90" ] || fail "the app listens on '$(echo "$added" | tr '\n' ' ')', not only tcp 8080 (1F90)"
pass "the app listens on tcp 8080 only"

# --- The web app, and path tricks ---
code=$(curl -sS -o "$work/index.html" -w '%{http_code}' "$base/")
[ "$code" = 200 ] && grep -q '<div id="root">' "$work/index.html" || fail "/ does not serve the web app ($code)"
pass "serves the web app"

tricks=(
  '/../package.json' '/../../package.json' '/../../../../../../etc/passwd'
  '/assets/../../package.json' '/./../backend/dist/server.js'
  '/%2e%2e/package.json' '/%2E%2E/%2E%2E/etc/passwd' '/%2e%2e%2fpackage.json'
  '/assets/%2e%2e/%2e%2e/backend/dist/config.js' '/assets/..%2f..%2fpackage.json'
  '/..%5cpackage.json' '/..\package.json' '/%252e%252e/package.json' '/%c0%ae%c0%ae/package.json'
  '/..;/package.json' '//etc/passwd' '/package.json' '/backend/dist/server.js'
  '/node_modules/fastify/package.json' '/config/oef-mapping.json' '/.env' '/proc/self/environ'
  '/index.html%00.js'
)
for trick in "${tricks[@]}"; do
  code=$(curl -sS --path-as-is -o "$work/body" -w '%{http_code}' "$base$trick")
  if grep -qE 'root:.*:0:0:|"dependencies"|DATABASE_URL|SESSION_SECRET|"archimate' "$work/body"; then
    fail "$trick returned a file ($code)"
  fi
  case "$code" in
    200) cmp -s "$work/body" "$work/index.html" || fail "$trick returned 200 with something other than the app shell" ;;
    400 | 404) ;;
    *) fail "$trick returned $code" ;;
  esac
done
pass "${#tricks[@]} path tricks return the app shell or 400/404, never a file"

# --- No errors in the logs (e.g. a missing file the build left out) ---
if docker logs "$app" 2>&1 | grep -E '"level":(50|60)'; then fail "the app logged errors"; fi
pass "no errors in the app log"

echo "Container test passed."
