#!/bin/bash
# A live terminal-lobby stack built from THIS worktree, for driving in a browser.
#
# Why it exists: the installed services on the box are master's, so a branch's
# tmux-api changes are invisible to them (the /workspaces route shipped dead
# once precisely because nothing exercised it end to end). This builds the
# branch's own tmux-api on a spare port and points a vite dev server at it, so
# the browser sees the code in the worktree.
#
#   ./scripts/devstack.sh start     build + start both, wait until they answer
#   ./scripts/devstack.sh restart   rebuild Go, restart both (use after a Go edit)
#   ./scripts/devstack.sh status    ports, versions, a probe of each
#   ./scripts/devstack.sh stop      stop both
#
# The frontend needs no restart: vite hot-reloads the worktree's sources.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="${TL_DEV_RUN:-/tmp/tl-devstack-$(id -u)}"
API_PORT="${TL_DEV_API_PORT:-7694}"
WEB_PORT="${TL_DEV_WEB_PORT:-5199}"
mkdir -p "$RUN"

secret() {
  # Root-readable by design; the services check it before they read the identity,
  # so without it every call is 401 however good the username is.
  sudo grep '^TL_PROXY_SECRET=' /etc/terminal-lobby.local.conf 2>/dev/null | cut -d= -f2-
}

stop_one() {
  local port="$1" name="$2"
  local pid
  pid="$(ss -ltnp 2>/dev/null | grep ":$port " | grep -oP 'pid=\K[0-9]+' | head -1)"
  if [ -n "$pid" ]; then kill "$pid" 2>/dev/null; echo "stopped $name (pid $pid)"; fi
}

build_api() {
  echo "building tmux-api from the worktree..."
  ( cd "$ROOT/tmux-api" && go build -o "$RUN/tmux-api" . ) || { echo "GO BUILD FAILED"; return 1; }
  echo "built $(stat -c%s "$RUN/tmux-api") bytes"
}

start_api() {
  TMUX_API_ADDR="127.0.0.1:$API_PORT" \
  TL_AUTH_HEADER=X-Authentik-Username \
  TL_PROXY_SECRET="$(secret)" \
  setsid nohup "$RUN/tmux-api" > "$RUN/api.log" 2>&1 < /dev/null &
  disown
}

start_web() {
  ( cd "$ROOT/frontend-v2" && \
    TL_DEV_AUTH=vbarzin \
    TL_AUTH_HEADER=X-Authentik-Username \
    TL_PROXY_SECRET="$(secret)" \
    TL_TMUX_API="http://127.0.0.1:$API_PORT" \
    setsid nohup npx vite --port "$WEB_PORT" --host 127.0.0.1 > "$RUN/web.log" 2>&1 < /dev/null & disown )
}

wait_for() {
  local url="$1" name="$2" i code
  for i in $(seq 1 40); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" 2>/dev/null)"
    [ "$code" = "200" ] && { echo "$name up"; return 0; }
    sleep 2
  done
  echo "$name DID NOT COME UP (last $code)"; return 1
}

case "${1:-status}" in
  start|restart)
    stop_one "$WEB_PORT" vite
    stop_one "$API_PORT" tmux-api
    sleep 1
    build_api || exit 1
    start_api
    start_web
    sleep 3
    wait_for "http://127.0.0.1:$WEB_PORT/" "vite ($WEB_PORT)" || { tail -5 "$RUN/web.log"; exit 1; }
    curl -s --max-time 5 "http://127.0.0.1:$WEB_PORT/api/sessions/workspaces" | head -c 90; echo
    ;;
  stop)
    stop_one "$WEB_PORT" vite
    stop_one "$API_PORT" tmux-api
    ;;
  status)
    ss -ltn 2>/dev/null | grep -E ":$WEB_PORT|:$API_PORT" || echo "(nothing listening)"
    printf 'spa:        '; curl -s -o /dev/null -w '%{http_code}\n' --max-time 4 "http://127.0.0.1:$WEB_PORT/"
    printf 'workspaces: '; curl -s --max-time 4 "http://127.0.0.1:$WEB_PORT/api/sessions/workspaces" | head -c 90; echo
    ;;
  *) echo "usage: $0 {start|restart|stop|status}"; exit 2 ;;
esac
