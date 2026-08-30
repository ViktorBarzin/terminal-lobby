#!/bin/sh
# Start the lobby under one PID 1.
#
# Not systemd, and not a supervisor either: a handful of long-running processes
# with no ordering between them and no per-service restart policy worth
# expressing. If any of them exits, the container exits, which is what an
# orchestrator wants — it can restart the whole thing, and a half-running lobby
# is not useful.
#
# nginx is in front of all of them. The lobby is not one service: the SPA calls
# /api/sessions/, /files/, /events/ and /skills/ on its own origin, and
# something has to route those to five ports. It is also what authenticates,
# which is the same arrangement as production rather than a second model.
set -eu

TL_USER="${TL_USER:-dev}"
export TL_MULTI_USER="${TL_MULTI_USER:-off}"
export TL_AUTH_HEADER="${TL_AUTH_HEADER:-X-Forwarded-User}"
export TL_BIND="${TL_BIND:-127.0.0.1}"

# What nginx publishes. TL_PORT is the lobby's own name for it; PORT is the
# convention a platform-as-a-service uses to hand a container the port it has
# already routed, so honouring it means an image started by one needs no
# configuration. TL_PORT wins when both are set.
TL_PORT="${TL_PORT:-${PORT:-7681}}"

log() { echo "entrypoint: $*"; }

case "$TL_PORT" in
  ''|*[!0-9]*) echo "entrypoint: TL_PORT must be a number, got '$TL_PORT'" >&2; exit 64 ;;
esac
if [ "$TL_PORT" -lt 1 ] || [ "$TL_PORT" -gt 65535 ]; then
  echo "entrypoint: TL_PORT must be 1-65535, got $TL_PORT" >&2
  exit 64
fi
# The five services and ttyd hold these on loopback. nginx taking one of them
# fails at bind time with a message about an address in use, which does not say
# what to change; say it here instead.
for taken in 7683 7684 7685 7686 7688 7690; do
  if [ "$TL_PORT" = "$taken" ]; then
    echo "entrypoint: TL_PORT $TL_PORT is used by a service inside the container" >&2
    exit 64
  fi
done

# The services run AS the single user. That is what makes the same-user fast
# path apply, so nothing here needs sudo and nothing needs a user map.
pids=""
start() {
  name=$1; shift
  runuser -u "$TL_USER" -- "$@" &
  pids="$pids $!"
  log "started $name (pid $!)"
}

# ---- nginx: routing, and who you are ---------------------------------------

CONF=/etc/nginx/conf.d/default.conf
HDR_VAR="http_$(printf '%s' "$TL_AUTH_HEADER" | tr 'A-Z-' 'a-z_')"

if [ -n "${TL_BASIC_AUTH:-}" ]; then
  # user:pass -> an htpasswd nginx checks. The username becomes the identity
  # every service sees, so signing in as someone is being someone.
  u=$(printf '%s' "$TL_BASIC_AUTH" | cut -d: -f1)
  p=$(printf '%s' "$TL_BASIC_AUTH" | cut -d: -f2-)
  if [ -z "$u" ] || [ -z "$p" ]; then
    echo "entrypoint: TL_BASIC_AUTH must be user:pass" >&2
    exit 64
  fi
  printf '%s:%s\n' "$u" "$(openssl passwd -apr1 "$p")" > /etc/nginx/htpasswd
  chmod 0644 /etc/nginx/htpasswd
  AUTH_BLOCK='auth_basic "terminal-lobby"; auth_basic_user_file /etc/nginx/htpasswd; set $tl_user $remote_user;'
  log "basic auth on for '$u'; open http://localhost:7681 and sign in"
elif [ -n "${TL_TRUST_FORWARDED_USER:-}" ]; then
  # A proxy in front authenticates and sets the header. Taking it is only safe
  # because the operator said the front door is trustworthy.
  AUTH_BLOCK="set \$tl_user \$$HDR_VAR;"
  log "trusting $TL_AUTH_HEADER from the proxy in front"
else
  AUTH_BLOCK="set \$tl_user $TL_USER;"
  log "NO AUTHENTICATION — anything reaching :$TL_PORT gets a shell as $TL_USER."
  log "Set TL_BASIC_AUTH=user:pass for a login prompt, or put a proxy in front"
  log "and set TL_TRUST_FORWARDED_USER=1."
fi

sed -e "s|__AUTH_BLOCK__|$AUTH_BLOCK|" \
    -e "s|__AUTH_HEADER__|$TL_AUTH_HEADER|" \
    -e "s|__PORT__|$TL_PORT|" \
    /etc/nginx/nginx.conf.template > "$CONF"
nginx -t >/dev/null

# ---- the services ----------------------------------------------------------

start tmux-api         /usr/local/bin/tmux-api
start file-api         /usr/local/bin/file-api
start session-events   /usr/local/bin/session-events -addr 127.0.0.1:7685 -home-base /home
start skills-api       /usr/local/bin/skills-api
start clipboard-upload /usr/local/bin/clipboard-upload

# ttyd sits behind nginx on 7690 and always trusts the header, because nginx is
# the only thing that can reach it and nginx sets that header itself.
start ttyd /usr/local/bin/ttyd -W -a -H "$TL_AUTH_HEADER" -P 30 \
  -t enableClipboard=true \
  -I /usr/local/share/ttyd/index.html \
  -p 7690 -i 127.0.0.1 \
  /usr/local/bin/tmux-attach.sh

# Any of them dying takes the container down with it.
for p in $pids; do
  ( while kill -0 "$p" 2>/dev/null; do sleep 5; done; log "a service exited; stopping"; kill 1 ) &
done

log "listening on :$TL_PORT"
exec nginx -g 'daemon off;'
