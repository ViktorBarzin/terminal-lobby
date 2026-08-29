#!/usr/bin/env bash
# Build the image, run it, and prove it came up single-user.
#
# This is the one new test seam in issue #1, and it exists for a specific
# uncertainty: tmux-user-attach re-homes the tmux server into the user's systemd
# scope, and a container has no user manager. The script detects that and falls
# back to a plain attach, but nothing was exercising that path.
#
#   ./docker/smoke.sh                 # build and test
#   IMAGE=ghcr.io/... ./docker/smoke.sh --no-build   # test a published image
set -euo pipefail

IMAGE="${IMAGE:-terminal-lobby:smoke}"
NAME="tl-smoke-$$"
BUILD=1
[[ "${1:-}" == "--no-build" ]] && BUILD=0

cleanup() { docker rm -f "$NAME" "$NAME-auth" >/dev/null 2>&1 || true; }
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "ok: $*"; }

if [[ "$BUILD" == 1 ]]; then
  echo "building $IMAGE..."
  docker build -t "$IMAGE" .
fi

docker run -d --name "$NAME" -p 17681:7681 "$IMAGE" >/dev/null
echo "started $NAME"

# nginx binds last, so waiting on it means everything behind it is up.
probe() { curl -sf -o /dev/null "http://127.0.0.1:17681/"; }
for _ in $(seq 1 60); do probe && break; sleep 1; done
probe || { docker logs "$NAME" 2>&1 | tail -30 >&2; fail "nothing served the lobby on :17681"; }
ok "the lobby is served"

# The gap the first version of this test missed entirely. The SPA calls
# /api/sessions/ on its own origin and nothing published those ports, so the
# terminal worked and the sidebar did not — which is most of the product.
sessions=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:17681/api/sessions/sessions")
[[ "$sessions" == "200" ]] || fail "GET /api/sessions/sessions got $sessions, want 200"
ok "the SPA's session list reaches tmux-api through the proxy"

who=$(curl -s "http://127.0.0.1:17681/api/sessions/whoami")
echo "$who" | grep -q '"multiUser":false' || fail "whoami is not single-user: $who"
echo "$who" | grep -q '"osUser":"dev"'    || fail "whoami did not resolve to dev: $who"
echo "$who" | grep -q '"admin":false'     || fail "single-user reported an admin: $who"
ok "whoami: single-user, resolves to dev, no admin"

for path in /files/list /skills; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:17681$path")
  [[ "$code" != "404" ]] || fail "$path is not routed (404); the SPA surface is incomplete"
  ok "$path is routed ($code)"
done

# The PWA shell must be fetchable without auth or the app cannot install.
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:17681/manifest.webmanifest")
[[ "$code" == "200" ]] || fail "the PWA manifest got $code, want 200"
ok "the PWA shell is served"

# A client cannot choose who it is: nginx sets the identity header itself, so a
# request that arrives carrying one must not be believed.
spoof=$(curl -s -H 'X-Forwarded-User: someone.else' "http://127.0.0.1:17681/api/sessions/whoami")
echo "$spoof" | grep -q '"osUser":"dev"' \
  || fail "a client-supplied identity header changed the answer: $spoof"
ok "a client-supplied identity header is ignored"

# The uncertainty this seam was added for: a session actually starts, which
# means tmux-user-attach took its no-systemd fallback.
docker exec -u dev "$NAME" tmux new-session -d -s smoke 2>/dev/null || true
docker exec -u dev "$NAME" tmux list-sessions | grep -q smoke \
  || fail "tmux could not start a session in the container"
ok "tmux starts a session with no systemd user manager"

# And no sudo anywhere: single-user never escalates, so the image does not ship it.
docker exec "$NAME" sh -c 'command -v sudo' >/dev/null 2>&1 \
  && fail "sudo is present in a single-user image"
ok "no sudo in the image"

# Basic auth is the README's quickstart, and the earlier version of this image
# logged "basic auth enabled" while still handing a shell to anyone sending an
# arbitrary header. Assert the whole flow, not the log line.
AUTH_NAME="$NAME-auth"
docker rm -f "$AUTH_NAME" >/dev/null 2>&1 || true
docker run -d --name "$AUTH_NAME" -p 17682:7681 -e TL_BASIC_AUTH=me:changeme "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  curl -sf -o /dev/null -u me:changeme "http://127.0.0.1:17682/" && break
  sleep 1
done
none=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:17682/")
bad=$(curl -s -o /dev/null -w '%{http_code}' -u me:wrong "http://127.0.0.1:17682/")
good=$(curl -s -o /dev/null -w '%{http_code}' -u me:changeme "http://127.0.0.1:17682/")
authwho=$(curl -s -u me:changeme "http://127.0.0.1:17682/api/sessions/whoami")
docker rm -f "$AUTH_NAME" >/dev/null 2>&1 || true
[[ "$none" == "401" ]] || fail "basic auth: no credentials got $none, want 401"
[[ "$bad"  == "401" ]] || fail "basic auth: wrong credentials got $bad, want 401"
[[ "$good" == "200" ]] || fail "basic auth: correct credentials got $good, want 200"
echo "$authwho" | grep -q '"authentik":"me"' \
  || fail "the signed-in username did not become the identity: $authwho"
ok "basic auth refuses without credentials and carries the username through"

echo "smoke: all checks passed"
