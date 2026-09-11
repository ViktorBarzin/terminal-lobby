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

# Single-user: one account, and it is whoever ttyd runs as. TL_MULTI_USER=off
# says so outright; "auto" (the default) infers it from the absence of a map,
# which is the same rule the Go services apply. The identity header still has to
# be present — that is what proves the request came through a proxy — but its
# value names nobody here.
mode_cfg="${TL_MULTI_USER:-auto}"
single_user=false
case "$mode_cfg" in
    off|false|0|no) single_user=true ;;
    on|true|1|yes)  single_user=false ;;
    # -e, not -r: the Go gate decides "auto" with os.Stat (exists). An
    # existing-but-unreadable map would otherwise make the terminal single-user
    # while the APIs stayed multi-user, dropping every identity into the ttyd
    # account while the sidebar still showed their own sessions.
    *)              [[ -e "$MAP" ]] || single_user=true ;;
esac

os_user=""
if [[ "$single_user" == true ]]; then
    if [[ -n "$auth_user" ]]; then
        os_user="$(id -un)"
    fi
elif [[ -n "$auth_local" && -r "$MAP" ]]; then
    os_user=$(awk -F= -v k="$auth_local" '
        /^[[:space:]]*(#|$)/ {next}
        $1==k {sub(/:.*$/, "", $2); print $2; exit}
    ' "$MAP")
fi

# Journal integrity (TL-23). Three request-controlled values reach a logger
# call in this script before any charset gate has constrained them: $1, the
# URL's ?arg=; TTYD_USER, the identity header; and $3, the ?arg= start
# directory printed on the spawn line at the bottom of the file. The NAME_RE
# gate that constrains $1 sits 20-odd lines further down, past a DENIED branch
# that exits before ever reaching it, and the start directory is only ever
# gated on a leading / and a length cap, because it is a path rather than a
# name. That matters because the telemetry selector is `|= "TLEVENT"`, which
# matches on line CONTENT rather than on the syslog tag, so a crafted arg can
# plant a record attributed to anyone.
#
# Each of the three is folded to its own charset at the point where it is
# printed. A case/if, no fork and no jq: ttyd runs this once per WebSocket
# connection. The two placeholders stay distinct so the line still tells "no
# header arrived" apart from "a header arrived that we decline to print".
# Everything else that gets logged is already gated where it is parsed: the
# session name by NAME_RE, the command key by CMD_RE, the owner by NAME_RE, the
# watch mode by MODE_RE.
#
# A fold is a printing rule only, never an authorization gate. The map lookup
# above is that, and a folded copy is never the value that reaches exec.
LOG_USER_RE='^[a-zA-Z0-9_@.-]{1,64}$'
LOG_DIR_RE='^/[A-Za-z0-9_./-]{0,4095}$'
lv=""
fold_log() {
    if [[ -z "$1" ]]; then
        lv="<none>"
    elif [[ "$1" =~ $2 ]]; then
        lv="$1"
    else
        lv="<invalid>"
    fi
}
fold_log "$auth_user" "$LOG_USER_RE"
log_user="$lv"
fold_log "${1:-}" "$NAME_RE"
log_arg="$lv"

logger -t ttyd-attach "attach: TTYD_USER='$log_user' arg='$log_arg' os_user='${os_user:-<unresolved>}'"

if [[ -z "$os_user" ]] || ! id "$os_user" >/dev/null 2>&1; then
    logger -t ttyd-attach "DENIED: no os_user mapping for TTYD_USER='$log_user'"
    cat <<EOF

  Access denied
  ─────────────
  No terminal account for '${auth_user:-<missing identity header>}'.

  This box maps identities to OS users via /etc/ttyd-user-map. Either the
  header your proxy sends is not in it, or no identity header arrived at
  all — check TL_AUTH_HEADER in /etc/terminal-lobby.conf names the header
  your proxy actually sets.

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

# ---- the model and effort a NEW session launches on ----------------------
# A 6th and 7th ?arg=, forwarded to tmux-user-attach, which turns them into
# flags on the command it starts. They are whitelisted TOKENS and nothing else:
# the command line they join is run through `$SHELL -lic`, so a value carrying a
# quote, a space or a `$` would be code rather than a name. Both classes are
# re-checked there — this gate is the first of two, in the same belt-and-braces
# the command key already gets.
#
# Like the command key, they are inert for a session that already exists:
# `tmux new-session -A` ignores the command entirely when it attaches.
MODEL_ARG_RE='^[a-z0-9][a-z0-9._-]{0,31}(\[[a-z0-9]{1,4}\])?$'
EFFORT_ARG_RE='^[a-z]{1,12}$'
model_arg="${6:-}"
[[ "$model_arg" =~ $MODEL_ARG_RE ]] || model_arg=""
effort_arg="${7:-}"
[[ "$effort_arg" =~ $EFFORT_ARG_RE ]] || effort_arg=""

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
    # The token goes in on STDIN (`-H @-`), never on the command line. /proc here
    # is mounted without hidepid, so a header in argv is readable out of
    # /proc/<pid>/cmdline by every account on the box for as long as the request
    # is in flight, which makes the 0600 mode on the token file worth nothing.
    # The body stays in argv: it carries no secret, only names the server
    # already knows.
    resp="$(printf 'X-Internal-Token: %s\n' "$token" \
        | curl -s -m 5 -w $'\n%{http_code}' \
        -H @- -H 'Content-Type: application/json' \
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
    # A FOREIGN attach only ever ATTACHES. It used to be able to create, too:
    # the server answered create=true when the caller held the owner's own
    # access and the session was missing, and this script then started one under
    # their account. On 2026-08-17 that put wizard's `Council-tax` inside bob's
    # account from a session name the switched page still remembered, read-write
    # and indistinguishable from their own work. The server no longer sends that
    # answer, and there is no branch here to act on it: a session that is not
    # running in someone else's account is not something this path brings into
    # being. `tmux attach-session` below fails, which is the safe outcome.
    #
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

# Print-only copy of the start directory, folded like the two values above.
# $start_dir itself is untouched and is what the exec below passes on.
fold_log "$start_dir" "$LOG_DIR_RE"
log_dir="$lv"

logger -t ttyd-attach "spawn: os_user='$os_user' name='$name' dir='$log_dir' cmd='${cmd_key:-<none>}' model='${model_arg:-<none>}' effort='${effort_arg:-<none>}' self='$(id -un)'"

# Launch via tmux-user-attach so the tmux *server* is parented to the OS
# user's own systemd manager (user@<uid>.service), not the ttyd.service
# cgroup. Without this, a `systemctl restart ttyd` kills every session.
if [[ "$os_user" == "$(id -un)" ]]; then
    exec /usr/local/bin/tmux-user-attach "$name" "$start_dir" "$cmd_key" "$model_arg" "$effort_arg"
else
    exec sudo -n -H -u "$os_user" /usr/local/bin/tmux-user-attach \
        "$name" "$start_dir" "$cmd_key" "$model_arg" "$effort_arg"
fi
