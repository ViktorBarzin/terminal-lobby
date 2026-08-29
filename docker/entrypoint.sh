#!/bin/sh
# Start the lobby's six processes under one PID 1.
#
# Not systemd, and not a supervisor either: six long-running processes with no
# ordering between them and no per-service restart policy worth expressing. If
# any of them exits, the container exits, which is what an orchestrator wants —
# it can restart the whole thing, and a half-running lobby is not useful.
set -eu

TL_USER="${TL_USER:-dev}"
export TL_MULTI_USER="${TL_MULTI_USER:-off}"
export TL_AUTH_HEADER="${TL_AUTH_HEADER:-X-Forwarded-User}"
export TL_BIND="${TL_BIND:-0.0.0.0}"

log() { echo "entrypoint: $*"; }

# The services run AS the single user. That is what makes the same-user fast
# path apply, so nothing in the container needs sudo and nothing needs a user
# map. runuser rather than su: no PAM session, no login shell, no TTY wanted.
as_user() { runuser -u "$TL_USER" -- "$@"; }

pids=""
start() {
  name=$1; shift
  as_user "$@" &
  pids="$pids $!"
  log "started $name (pid $!)"
}

start tmux-api         /usr/local/bin/tmux-api
start file-api         /usr/local/bin/file-api
start session-events   /usr/local/bin/session-events -addr :7685 -home-base /home
start skills-api       /usr/local/bin/skills-api
start clipboard-upload /usr/local/bin/clipboard-upload

# ttyd is the one that must be PID-1-adjacent, because losing it is losing the
# product. It runs last and in the foreground.
set -- ttyd -W -a -H "$TL_AUTH_HEADER" -P 30 \
       -t enableClipboard=true \
       -I /usr/local/share/ttyd/index.html \
       -p 7681

# With no proxy in front there is nothing authenticating the request, so this is
# the shortest way not to publish an open shell. Optional because the supported
# arrangement is a proxy that sets TL_AUTH_HEADER.
if [ -n "${TL_TTYD_CREDENTIAL:-}" ]; then
  set -- "$@" -c "$TL_TTYD_CREDENTIAL"
  log "ttyd basic auth enabled"
else
  log "no TL_TTYD_CREDENTIAL set — put a proxy in front that sets $TL_AUTH_HEADER,"
  log "or set TL_TTYD_CREDENTIAL=user:pass, or anything reaching :7681 gets a shell"
fi

# Any service dying takes the container down with it.
for p in $pids; do
  ( while kill -0 "$p" 2>/dev/null; do sleep 5; done; log "a service exited; stopping"; kill 1 ) &
done

log "ttyd listening on :7681 as $TL_USER"
# runuser directly, not the as_user helper: exec cannot run a shell function.
exec runuser -u "$TL_USER" -- "$@" /usr/local/bin/tmux-attach.sh
