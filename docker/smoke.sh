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

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "ok: $*"; }

if [[ "$BUILD" == 1 ]]; then
  echo "building $IMAGE..."
  docker build -t "$IMAGE" .
fi

docker run -d --name "$NAME" -p 17681:7681 "$IMAGE" >/dev/null
echo "started $NAME"

# ttyd is last to bind, so waiting on it means everything before it is up.
# The header is required: ttyd runs with -H, so a request without one is 401.
probe() { curl -sf -o /dev/null -H 'X-Forwarded-User: smoke' "http://127.0.0.1:17681/"; }
for _ in $(seq 1 60); do
  probe && break
  sleep 1
done
probe || { docker logs "$NAME" 2>&1 | tail -30 >&2; fail "ttyd never served the lobby on :17681"; }
ok "ttyd serves the lobby"

# Without the header ttyd refuses, which is what makes the header the thing that
# proves a request came through a proxy.
#
# 407, not 401: ttyd's -H mode treats a missing header as "the proxy in front
# did not authenticate", so it answers Proxy Authentication Required. The Go
# services answer 401 for the same condition. Both refuse; the codes differ
# because ttyd is describing the proxy's failure and they are describing the
# request's.
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:17681/")
[[ "$code" == "407" ]] || fail "ttyd answered $code without an identity header, want 407"
ok "ttyd refuses a request with no identity header (407)"

# The point of the mode: whatever the proxy says the username is, every request
# resolves to the container's single account.
who=$(docker exec "$NAME" curl -s -H 'X-Forwarded-User: anyone' \
        http://127.0.0.1:7684/whoami)
echo "$who" | grep -q '"multiUser":false' || fail "whoami is not single-user: $who"
echo "$who" | grep -q '"osUser":"dev"'    || fail "whoami did not resolve to dev: $who"
echo "$who" | grep -q '"admin":false'     || fail "single-user reported an admin: $who"
ok "whoami: single-user, resolves to dev, no admin"

# A different name must land on the same account rather than being refused or
# creating a second one.
other=$(docker exec "$NAME" curl -s -H 'X-Forwarded-User: someone.else' \
          http://127.0.0.1:7684/whoami)
echo "$other" | grep -q '"osUser":"dev"' || fail "a second identity did not resolve to dev: $other"
ok "any identity resolves to the one account"

# Missing identity is still refused: the header's presence is what says the
# request came through a proxy.
code=$(docker exec "$NAME" curl -s -o /dev/null -w '%{http_code}' \
         http://127.0.0.1:7684/whoami)
[[ "$code" == "401" ]] || fail "no identity header got $code, want 401"
ok "a request with no identity header is refused"

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

echo "smoke: all checks passed"
