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

# Optional command KEY from the second ?arg= (lobby "new session runs"
# dropdown). A whitelisted token, never a raw command line — the
# key→command mapping happens AS THE TARGET USER in tmux-user-attach
# (builtins + ~/.config/terminal-lobby/commands). Invalid → empty →
# today's behavior. tmux -A means the key is inert for existing sessions.
CMD_RE='^[a-z0-9_-]{1,16}$'
cmd_key="${2:-}"
[[ "$cmd_key" =~ $CMD_RE ]] || cmd_key=""

home_dir=$(getent passwd "$os_user" | cut -d: -f6)
home_dir="${home_dir:-/}"

# Optional third ?arg= = the base directory for a NEW session (the lobby
# passes a project's dir here). Absolute paths only; anything else — absent,
# relative, over-long — falls back to the user's home. It is forwarded as a
# single argv element (never shell-evaluated) and re-checked for existence AS
# the target user in tmux-user-attach, which drops a stale/unreachable dir
# back to $HOME. `tmux new-session -A` ignores -c for an already-live session,
# so this only takes effect when the session is (re)created.
start_dir="$home_dir"
dir_arg="${3:-}"
if [[ "$dir_arg" == /* && ${#dir_arg} -le 4096 ]]; then
    start_dir="$dir_arg"
fi

# ---- shared / foreign attach --------------------------------------------
# A 4th ?arg= names the session OWNER. When present and different from the
# authenticated guest's OS user, this attaches SOMEONE ELSE's session.
#
# A 5th ?arg= is the client's WATCH-MODE request: "ro" asks to attach without
# driving. It is a request, never a decision — the server resolves it against
# what the caller is actually allowed (downgrade-only: a client may ask for less
# access than it has, never more), and `-r` still comes back from the server's
# answer. That is why accepting this argument does not weaken the exact-argv
# discipline below: the only thing it can do is take access away.
#
# Authorization + the read-only decision come from tmux-api's token-gated
# internal endpoint (which also records this client's tty so a revoke can
# detach exactly it). The tmux argv is FIXED — the only guest-influenced value
# is the NAME_RE-validated session name, and `-r` comes from the server's mode,
# NEVER a client argument. This exact-argv discipline is the whole security
# boundary given the broad sudo tmux grant.
MODE_RE='^(ro|rw)$'
owner_arg="${4:-}"
[[ "$owner_arg" =~ $NAME_RE ]] || owner_arg=""
watch_arg="${5:-}"
[[ "$watch_arg" =~ $MODE_RE ]] || watch_arg=""

# The server is consulted for a FOREIGN attach (as before) and now also for any
# attach that asks to watch — including your own session, which is the
# two-device case and has no share row to authorize it.
if [[ -n "$owner_arg" && "$owner_arg" != "$os_user" ]] || [[ "$watch_arg" == "ro" ]]; then
    target_owner="${owner_arg:-$os_user}"
    guest="$os_user"
    my_tty="$(tty 2>/dev/null || true)"
    [[ "$my_tty" == /dev/* ]] || my_tty=""
    token=""
    [[ -r /var/lib/tmux-api/internal.token ]] && token="$(cat /var/lib/tmux-api/internal.token)"
    resp="$(curl -s -m 5 -w $'\n%{http_code}' \
        -H "X-Internal-Token: ${token}" -H 'Content-Type: application/json' \
        --data "{\"owner\":\"${target_owner}\",\"name\":\"${name}\",\"guest\":\"${guest}\",\"tty\":\"${my_tty}\",\"requested\":\"${watch_arg}\"}" \
        http://127.0.0.1:7684/internal/attach 2>/dev/null || true)"
    code="$(printf '%s' "$resp" | tail -n1)"
    # Tolerate whitespace around the colon. Go's json.Encoder emits compact
    # output today, so the tighter pattern worked — but an unparsed mode fails
    # in two different directions (a foreign attach falls safe to -r, a self
    # attach falls through to CREATING the session), and neither is obvious from
    # the outside. Accepting both spellings removes that silent divergence.
    mode="$(printf '%s' "$resp" | sed -n 's/.*"mode"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p')"
    logger -t ttyd-attach "server-attach: guest='$guest' owner='$target_owner' name='$name' tty='${my_tty:-none}' asked='${watch_arg:-none}' code='$code' mode='${mode:-none}'"
    if [[ "$code" != "200" ]]; then
        # Only reachable for a foreign attach: a self attach is authorized by
        # owning the session, so the server never denies it.
        cat <<EOF

  Access denied
  ─────────────
  '$guest' is not permitted to attach '$target_owner's session '$name'
  (no active share). Ask '$target_owner' to share it from the lobby.

EOF
        sleep 5
        exit 1
    fi
    # Fail SAFE: read-only unless the server explicitly said "rw".
    ro_flag=(-r)
    [[ "$mode" == "rw" ]] && ro_flag=()
    # Attach the ALREADY-RUNNING server as its owner. No systemd scope (the
    # server exists, owned by the owner). Self (owner == the ttyd identity)
    # needs no sudo; otherwise the passwordless per-user tmux grant applies.
    #
    # The one case that does NOT attach here is a WATCH of your own session that
    # is not running yet: the server answers "rw" because there is nothing to
    # watch, and we fall through to the ordinary create path below rather than
    # attaching to a session that does not exist.
    if [[ "$target_owner" != "$os_user" || "$mode" == "ro" ]]; then
        if [[ "$target_owner" == "$(id -un)" ]]; then
            exec /usr/bin/tmux attach-session "${ro_flag[@]}" -t "$name"
        else
            exec sudo -n -H -u "$target_owner" /usr/bin/tmux attach-session "${ro_flag[@]}" -t "$name"
        fi
    fi
fi

logger -t ttyd-attach "spawn: os_user='$os_user' name='$name' dir='$start_dir' cmd='${cmd_key:-<none>}' self='$(id -un)'"

# Launch via tmux-user-attach so the tmux *server* is parented to the OS
# user's own systemd manager (user@<uid>.service), not the ttyd.service
# cgroup. Without this, a `systemctl restart ttyd` kills every session.
if [[ "$os_user" == "$(id -un)" ]]; then
    exec /usr/local/bin/tmux-user-attach "$name" "$start_dir" "$cmd_key"
else
    exec sudo -n -H -u "$os_user" /usr/local/bin/tmux-user-attach "$name" "$start_dir" "$cmd_key"
fi
