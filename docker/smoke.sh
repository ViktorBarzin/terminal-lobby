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

cleanup() { docker rm -f "$NAME" "$NAME-auth" "$NAME-port" >/dev/null 2>&1 || true; }
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

# /term.html was the terminal, in an iframe, until the lobby started drawing
# its own. The page is deleted and the path now redirects, so what this checks
# is that the route still REACHES clipboard-upload: ttyd does not know the path,
# and an unrouted one gets ttyd's own 404 instead of the redirect. A bookmark or
# an installed home-screen icon would then be a dead end rather than a lobby.
#
# Asserted against the container's nginx on purpose. The route lives in
# docker/nginx.conf.template and is separate from the cluster's Traefik table,
# so the redirect can hold in production and be missing here.
term=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:17681/term.html")
[[ "$term" == "302" ]] || fail "GET /term.html got $term, want 302; a stale terminal link is a dead end"
loc=$(curl -s -o /dev/null -w '%{redirect_url}' "http://127.0.0.1:17681/term.html")
[[ "$loc" == *"/" ]] || fail "GET /term.html redirects to '$loc', want the lobby"
# The session name has to survive the hop, which is the half a plain 302 would
# lose: the page took it as the first positional ?arg=, the lobby reads
# ?session=, and a bookmark that named a session must land on it.
loc=$(curl -s -o /dev/null -w '%{redirect_url}' "http://127.0.0.1:17681/term.html?arg=smoke1&arg=default")
[[ "$loc" == *"?session=smoke1" ]] \
  || fail "GET /term.html?arg=smoke1 redirects to '$loc', want ?session=smoke1"
ok "a stale /term.html link redirects to the lobby, session name and all"

# The PWA shell must be fetchable without auth or the app cannot install.
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:17681/manifest.webmanifest")
[[ "$code" == "200" ]] || fail "the PWA manifest got $code, want 200"
ok "the PWA shell is served"

# Public links (ADR-0039) are reachable without signing in, and the redeem
# route is the only piece of tmux-api that is: an unknown token is a 404 from
# tmux-api, not a sign-in challenge, and /s/api/ is not a way into the rest.
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:17681/s/")
[[ "$code" == "200" ]] || fail "the visitor page at /s/ got $code, want 200"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -d '{"token":"AAAAAAAAAAAAAAAAAAAAAA"}' "http://127.0.0.1:17681/s/api/link/redeem")
[[ "$code" == "404" ]] || fail "redeeming an unknown link got $code, want 404"
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:17681/s/api/sessions")
[[ "$code" != "200" ]] || fail "/s/api/sessions answered 200; the link carve-out reaches more of tmux-api than redeem"
ok "public links: the page is served, redeem answers, nothing else of tmux-api is"

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

# And the lobby must SEE it. Asserting only that tmux works, and separately that
# /sessions answers 200, missed a build where every row was dropped in parsing
# and the sidebar was permanently empty: with no UTF-8 locale set, tmux renders
# the tab separating the -F fields as "_", so the 11 fields arrived as 1. The
# list is the product, so the test asks for the session by name.
sleep 6  # the session list is cached for 5s and this one was made behind the API
listed=$(curl -s "http://127.0.0.1:17681/api/sessions/sessions")
echo "$listed" | grep -q '"name":"smoke"' \
  || fail "the API does not list a session that tmux has: $listed"
ok "a running session appears in the lobby's session list"

# The per-session routes. Status alone cannot tell these apart: a route the
# proxy does not know falls through to ttyd, which answers 404, and so does
# session-events for a session it has not registered — this one was made behind
# its back with tmux directly. So the assertion is on WHO answered. ttyd's 404
# is an HTML page linking /error.css; session-events replies in plain text.
# /commands/, the session's slash commands, shipped unrouted and looked like a
# feature that simply returned nothing.
for path in /commands/smoke /pane/smoke; do
  hits=$(curl -s "http://127.0.0.1:17681$path" | grep -c "error.css" || true)
  [[ "$hits" == "0" ]] || fail "$path is not routed; ttyd's error page answered it"
  ok "$path reaches session-events"
done

# The session browser's viewer stream (ADR-0035) checks that the WebSocket's
# Origin names the same host and port the request was sent to. The container is
# reached on a published port (17681 here, 7681 by default), so this holds only
# if nginx forwards the Host header WITH the port: nginx's $host drops it, and
# every stream was then refused 403 while the prod ingress, which forwards Host
# unchanged, worked.
#
# A session with no browser answers 404 before the origin is ever checked, so
# the check needs a host socket to reach. Perl (perl-base, always present) plays
# the host: it accepts, writes a hello, and holds the connection briefly.
dev_uid=$(docker exec -u dev "$NAME" id -u)
fake_dir="/tmp/tl-browser-$dev_uid"
fake_sock="$fake_dir/s0.sock"
docker exec -u dev "$NAME" sh -c "install -d -m 0700 '$fake_dir' && rm -f '$fake_sock'"
docker exec -d -u dev "$NAME" perl -MIO::Socket::UNIX -e '
  my $s = IO::Socket::UNIX->new(Type => SOCK_STREAM(), Local => $ARGV[0], Listen => 5) or die $!;
  chmod 0600, $ARGV[0];
  while (my $c = $s->accept) {
    $c->autoflush(1);
    print $c "{\"t\":\"hello\",\"state\":\"live\",\"tabs\":[],\"agentTab\":null,\"control\":{\"holder\":null,\"since\":null,\"lapseAt\":null},\"viewport\":{\"w\":1280,\"h\":800}}\n";
    sleep 2; close $c;
  }' "$fake_sock"
for _ in $(seq 1 20); do docker exec -u dev "$NAME" test -S "$fake_sock" && break; sleep 0.25; done
docker exec -u dev "$NAME" tmux set-option -t smoke @tl_browser live
docker exec -u dev "$NAME" tmux set-option -t smoke @tl_browser_sock "$fake_sock"
ws_handshake() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 3 \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    -H "Origin: $1" "http://127.0.0.1:17681/browser/smoke/stream" || true
}
same=$(ws_handshake "http://127.0.0.1:17681")
other=$(ws_handshake "http://elsewhere.example:17681")
docker exec -u dev "$NAME" tmux set-option -u -t smoke @tl_browser || true
docker exec -u dev "$NAME" tmux set-option -u -t smoke @tl_browser_sock || true
docker exec -u dev "$NAME" pkill -f IO::Socket::UNIX || true
[[ "$same" == "101" ]] \
  || fail "the browser stream from its own origin on :17681 got $same, want 101; nginx must forward Host with the port"
[[ "$other" == "403" ]] \
  || fail "the browser stream from a foreign origin got $other, want 403"
ok "the browser stream opens from its own origin on a published port, and refuses a foreign one"

# The services write projects, layout, titles and pasted images under /var/lib.
# Those directories have to exist and belong to the user the services run as, or
# every write fails and the failures are only visible in the log.
for d in /var/lib/tmux-api /var/lib/clipboard-store; do
  docker exec -u dev "$NAME" test -w "$d" \
    || fail "$d is not writable by the user the services run as"
  ok "$d is writable"
done

# The new session row defaults to Claude, so the image carries it. Checked
# through a login+interactive shell because that is exactly how the command
# reaches tmux: tmux-user-attach runs "$user_shell" -lic "$cmd". And checked to
# be OUTSIDE the home, because the quickstart mounts a volume over /home/dev and
# anything installed under that home would vanish the moment someone did.
claude_path=$(docker exec -u dev "$NAME" bash -lic 'command -v claude' 2>/dev/null | tr -d '\r')
[[ -n "$claude_path" ]] || fail "claude is not on the PATH of a login shell; the default new session would die"
case "$claude_path" in
  /home/*) fail "claude is at $claude_path, inside the home a volume mounts over" ;;
esac
docker exec -u dev "$NAME" bash -lic 'claude --version' >/dev/null 2>&1 \
  || fail "claude is on the PATH at $claude_path but does not run"
ok "claude runs from a login shell, at $claude_path"

# What the new-session dropdown greys out. The image has Claude and a shell and
# does not have Codex, so this is the one place where all three answers exist at
# once — and it is the assertion that would fail if the probe stopped reaching
# the login shell, which is where the answer for a shell function lives.
probe=$(curl -s "http://127.0.0.1:17681/api/sessions/new-commands")
echo "$probe" | grep -q '"claude":true' || fail "new-commands did not report claude: $probe"
echo "$probe" | grep -q '"shell":true'  || fail "new-commands did not report shell: $probe"
echo "$probe" | grep -q '"codex":false' || fail "new-commands did not report codex missing: $probe"
ok "new-commands: claude and shell run here, codex does not"

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

# A PaaS hands the container a port in the environment rather than letting it
# choose one. TL_PORT is the lobby's own name for it and wins; PORT is the
# convention Heroku, Cloud Run, Railway, Render and Fly all use, so an image
# started by one of them needs no configuration at all. Setting both here
# proves the precedence in a single run.
PORT_NAME="$NAME-port"
docker rm -f "$PORT_NAME" >/dev/null 2>&1 || true
docker run -d --name "$PORT_NAME" -p 17683:9090 -e PORT=8080 -e TL_PORT=9090 "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  curl -sf -o /dev/null "http://127.0.0.1:17683/" && break
  sleep 1
done
ported=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:17683/" || echo none)
docker rm -f "$PORT_NAME" >/dev/null 2>&1 || true
[[ "$ported" == "200" ]] || fail "TL_PORT=9090 did not move the listener there (got $ported)"
ok "the listen port comes from the environment, TL_PORT over PORT"

echo "smoke: all checks passed"
