#!/usr/bin/env bash
# Invoked by ttyd-link-ro.service and ttyd-link-rw.service, once per WebSocket,
# as the tl-link account. These two ttyds take connections from anyone: they
# serve public links (docs/plans/2026-10-06-public-links-design.md, ADR-0039),
# and the ticket in the URL is the only thing that says the visitor may attach.
#
#   $1  the instance, fixed in the unit's command line: ro or rw
#   $2  the ticket, from the visitor's ?arg= (ttyd -a)
#
# This script holds no credential and attaches nothing itself. It spends the
# ticket at tmux-api, which answers with the session's owner and a single-use
# GRANT, then runs the owner's copy of tmux-link-join with that grant. tl-link's
# sudo grant is that one wrapper and nothing else, so an attacker who controlled
# this account would still need a live link token for every attach.
#
# Every refusal exits at once, with no banner and no sleep. tmux-attach.sh
# holds a denied connection for seconds so a person can read why; here the
# caller is anyone on the internet, and a held connection is a held pty.
set -euo pipefail

# See tmux-attach.sh: nothing typed before tmux owns the pty should be echoed.
stty -echo 2>/dev/null || true

NAME_RE='^[a-zA-Z0-9_-]{1,32}$'
TOKEN_RE='^[A-Za-z0-9_-]{32}$'
TTY_RE='^/dev/[a-zA-Z0-9/]{1,60}$'
API="${TL_TMUX_API:-http://127.0.0.1:7684}"

instance="${1:-}"
ticket="${2:-}"
[[ "$instance" == ro || "$instance" == rw ]] || exit 1
if [[ ! "$ticket" =~ $TOKEN_RE ]]; then
    # The ticket is folded out of the log line: it is request-controlled.
    logger -t ttyd-link "DENIED: malformed ticket on the $instance instance"
    exit 1
fi
my_tty="$(tty 2>/dev/null || true)"
[[ "$my_tty" =~ $TTY_RE ]] || exit 1

resp="$(curl -s -m 5 -w $'\n%{http_code}' -H 'Content-Type: application/json' \
    --data "{\"ticket\":\"${ticket}\",\"tty\":\"${my_tty}\",\"mode\":\"${instance}\"}" \
    "$API/internal/link-attach" 2>/dev/null || true)"
code="$(printf '%s' "$resp" | tail -n1)"
owner="$(printf '%s' "$resp" | sed -n 's/.*"owner"[[:space:]]*:[[:space:]]*"\([a-zA-Z0-9_-]*\)".*/\1/p')"
grant="$(printf '%s' "$resp" | sed -n 's/.*"grant"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_-]*\)".*/\1/p')"

if [[ "$code" != 200 || ! "$owner" =~ $NAME_RE || ! "$grant" =~ $TOKEN_RE ]]; then
    logger -t ttyd-link "DENIED: instance=$instance tty=$my_tty code=${code:-none}"
    printf '\r\n  This link has ended.\r\n'
    exit 1
fi
logger -t ttyd-link "attach: instance=$instance owner=$owner tty=$my_tty"

# The same account in a single-user install or the container, where ttyd-link
# runs as the one user there is and needs no sudo.
if [[ "$owner" == "$(id -un)" ]]; then
    exec /usr/local/bin/tmux-link-join "$grant"
fi
exec sudo -n -u "$owner" /usr/local/bin/tmux-link-join "$grant"
