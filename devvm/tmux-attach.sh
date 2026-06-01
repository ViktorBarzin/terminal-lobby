#!/usr/bin/env bash
# Invoked by ttyd.service per WebSocket connection. ttyd's `-a` flag
# forwards `?arg=<value>` as $1; `-H X-authentik-username` sets
# $TTYD_USER to the Authentik identity.
#
# We map TTYD_USER → OS user via /etc/ttyd-user-map and sudo into that
# user before running tmux, so each Authentik identity gets its own
# kernel-isolated tmux server (one socket per uid). Authentik users
# without a mapping are denied — no fallback to a shared account.
set -euo pipefail

MAP=/etc/ttyd-user-map
NAME_RE='^[a-zA-Z0-9_-]{1,32}$'

auth_user="${TTYD_USER:-}"
auth_local="${auth_user%%@*}"

os_user=""
if [[ -n "$auth_local" && -r "$MAP" ]]; then
    os_user=$(awk -F= -v k="$auth_local" '
        /^[[:space:]]*(#|$)/ {next}
        $1==k {sub(/:.*$/, "", $2); print $2; exit}
    ' "$MAP")
fi

logger -t ttyd-attach "attach: TTYD_USER='${auth_user:-<none>}' arg='${1:-<none>}' os_user='${os_user:-<unresolved>}'"

if [[ -z "$os_user" ]] || ! id "$os_user" >/dev/null 2>&1; then
    logger -t ttyd-attach "DENIED: no os_user mapping for TTYD_USER='${auth_user:-<missing>}'"
    cat <<EOF

  Access denied
  ─────────────
  No terminal account for Authentik user '${auth_user:-<missing header>}'.

  This DevVM maps Authentik identities to OS users via
  /etc/ttyd-user-map. Ask Viktor to add a mapping (and a matching
  /etc/sudoers.d/ttyd-users entry) if you should have access.

EOF
    sleep 10
    exit 1
fi

# Session name from URL ?arg=<name>; default to the OS user's own name.
name="${1:-$os_user}"
[[ "$name" =~ $NAME_RE ]] || name="$os_user"

home_dir=$(getent passwd "$os_user" | cut -d: -f6)
home_dir="${home_dir:-/}"

logger -t ttyd-attach "spawn: os_user='$os_user' name='$name' dir='$home_dir' self='$(id -un)'"

# Launch via tmux-user-attach so the tmux *server* is parented to the OS
# user's own systemd manager (user@<uid>.service), not the ttyd.service
# cgroup. Without this, a `systemctl restart ttyd` kills every session.
if [[ "$os_user" == "$(id -un)" ]]; then
    exec /usr/local/bin/tmux-user-attach "$name" "$home_dir"
else
    exec sudo -n -H -u "$os_user" /usr/local/bin/tmux-user-attach "$name" "$home_dir"
fi
