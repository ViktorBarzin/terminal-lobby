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

# Nothing this pty receives before tmux owns it should be painted back.
#
# ttyd creates the pty in the line discipline's default state — canonical mode,
# ECHO on — and it stays there until tmux attaches and asks for raw. Measured on
# this box 2026-09-12, that window is ~500 ms of forking, sudo and attach, and
# every byte the browser sends inside it is echoed straight onto the screen:
# keystrokes typed the instant a session opens, and (until the terminal learned
# to drop a dead program's modes, frontend-v2/src/terminal/modes.ts) a pointer
# report per mouse movement. tmux's first redraw wipes the lot, so it reads as
# garbage that flashes and vanishes.
#
# Turning the echo off does not eat the bytes: they stay in the input queue and
# tmux reads them when it starts, so typing into a session that is still opening
# still lands. It only stops the kernel from drawing them in the meantime.
#
# This loses a race it cannot win, and that is fine. bash takes ~30 ms to reach
# this line, so a byte that arrives in the first 30 ms is echoed regardless —
# measured, same day: markers at 50/100/200/350 ms were all silent, the one at
# 0 ms was not. The terminal-side fix is what closes that head, by never
# generating the reports; this covers everything else that might reach a pty
# nobody is reading yet.
#
# `|| true` because of `set -e`: a stdin that is not a tty (a test harness
# piping the script) must not kill the attach over cosmetics.
stty -echo 2>/dev/null || true

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
# A 5th ?arg= is the client's ATTACH-MODE request, one question with three
# answers: absent drives, "ro" watches, "pre" preloads.
#
# "ro" asks to attach without driving. It is a request, never a decision — the
# server resolves it against what the caller is actually allowed
# (downgrade-only: a client may ask for less access than it has, never more),
# and `-r` still comes back from the server's answer. That is why accepting this
# argument does not weaken the exact-argv discipline below: the only thing it
# can do is take access away.
#
# "pre" is a HOVER: the client is attached before the user has said they want
# the session, so the terminal is already drawn if the click lands. It is
# read-write — a click promotes this same client instead of attaching a second
# one — but it carries tmux's ignore-size flag, so it cannot move the session's
# window while it is only a preload (ADR-0026). Two rules follow, both enforced
# below: it is own-sessions-only, and it never creates.
#
# Authorization + the read-only decision come from tmux-api's token-gated
# internal endpoint (which also records this client's tty so a revoke can
# detach exactly it). The tmux argv is FIXED — the only guest-influenced value
# is the NAME_RE-validated session name, and `-r` comes from the server's mode,
# NEVER a client argument. This exact-argv discipline is the whole security
# boundary given the broad sudo tmux grant.
MODE_RE='^(ro|rw|pre)$'
owner_arg="${4:-}"
[[ "$owner_arg" =~ $NAME_RE ]] || owner_arg=""
watch_arg="${5:-}"
[[ "$watch_arg" =~ $MODE_RE ]] || watch_arg=""

# A preload is OWN-SESSIONS-ONLY, by decision (ADR-0026). It fires from a
# pointer resting on a card, so a foreign one would put an /internal/attach
# round trip, a sudo and an audit line on every card the pointer crossed, for
# sessions nobody has asked to open. Refuse it here, the same way an
# unpermitted attach is refused below, rather than letting it reach the server.
# Someone else's session is attached on the click, as it always was.
#
# REFUSED IN SILENCE, AND AT ONCE. Every other denial in this file prints a
# banner and sleeps, because a person is watching an empty terminal and the
# message is the only thing that explains it. A preload has no reader: it is a
# hidden mount the user has not asked for, so the only way the banner can be
# SEEN is for the click to promote that mount into view, and the sleep is
# exactly the window in which that happens. The frontend's own act-as tab
# reaches this branch with no bad intent — /whoami answers with the lens target
# while ttyd resolves the Authentik header to the admin, so a hover on the
# acted-as user's own card builds owner=<target> with mode=pre — and in that
# tab a 5 s hold put "A preload only ever attaches your own session" where the
# session should have been. Exiting immediately closes the socket instead: the
# terminal reports the preload failed, the slot is dropped, and the click that
# follows attaches the ordinary way. The journal line below is the whole record
# of it, which is the right place for a refusal nobody is reading.
#
# Both values on that line are already charset-gated (NAME_RE) where they were
# parsed, which is what the journal-integrity note above requires of anything
# that reaches a logger call.
if [[ "$watch_arg" == "pre" && -n "$owner_arg" && "$owner_arg" != "$os_user" ]]; then
    logger -t ttyd-attach "DENIED: preload is own-sessions-only: guest='$os_user' owner='$owner_arg' name='$name'"
    exit 1
fi

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
#
# A "pre" attach of your OWN session is deliberately not on that list. Owning
# the session is what authorizes it, exactly as it authorizes the ordinary
# create path below, and the round trip is a cost the preload exists to avoid:
# it runs once per card the pointer crosses. The foreign case was refused
# outright above, so nothing reaches here asking to preload someone else's.
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
    # being. `tmux attach-session` below fails, which is the safe outcome —
    # and it fails because the target is written `=$name`. A bare -t resolves
    # by PREFIX after an exact miss, so an authorized name that has just died
    # would otherwise land this guest on whichever sibling shares its prefix,
    # which `slug.Free`'s -2/-3 suffixes make an everyday pair. Measured on
    # tmux 3.4 here 2026-09-11: `has-session -t deploy` returned rc=0 against
    # a server running only `deploy-staging`, `-t '=deploy'` returned
    # "can't find session".
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
            exec /usr/bin/tmux attach-session "${ro_flag[@]}" -t "=$name"
        else
            exec sudo -n -H -u "$target_owner" /usr/bin/tmux attach-session "${ro_flag[@]}" -t "=$name"
        fi
    fi
fi

# ---- the preload attach -------------------------------------------------
# `-f ignore-size` is the whole of what makes a hover safe. Measured on tmux 3.4
# on this box 2026-09-11, against a session born at a phone's 80x40 with the
# phone still attached: a plain read-write attach from a 200x50 client moved the
# window to 200x49 and rewrapped the phone's transcript, and the same attach
# with `-f ignore-size` left it at 80x39. The client stays read-write, so the
# click promotes it with `refresh-client -f '!ignore-size'` rather than paying
# for a second attach, and nothing is pinned: `window-size` is untouched
# throughout, unlike the read-only path, whose PinGrid is never reverted.
#
# attach-session, NEVER the `tmux new-session -A` below. -A creates a session
# when the name is absent, and a preload must not bring one into being from a
# mouse movement: a card can only be hovered while it is listed, so a name that
# no longer resolves means the session died in the interval. Letting the attach
# fail is the right answer, and it is the same reasoning that took create away
# from the foreign path above.
#
# `=$name`, and that leading `=` is what makes "fail" true. A bare -t target is
# resolved exact-first, then by PREFIX, then by fnmatch, and prefix siblings are
# this lobby's normal case: slug.Free() appends -2, -3 to a repeated title, so
# `deploy` and `deploy-2` sit in the sidebar together. Measured on tmux 3.4 on
# this box, 2026-09-11, with only `deploy-staging` running:
#
#   tmux has-session -t deploy      rc=0, resolved to deploy-staging
#   tmux has-session -t '=deploy'   rc=1, "can't find session: deploy"
#
# and `attach-session -f ignore-size -t deploy` put a live read-write client on
# `deploy-staging`. So without the `=`, hovering a card whose session has just
# died attaches the NEIGHBOUR instead of failing, and the click promotes that
# mount: every keystroke would land in a session the label does not name. The
# exact form is the only one that means what this branch says it means.
#
# The exact-argv discipline is unchanged: the flag is a fixed literal chosen by
# the branch, and the only guest-influenced value is the NAME_RE-validated
# session name. $watch_arg is MODE_RE-gated, so the logger line is folded by the
# same rule the journal-integrity note above sets out.
if [[ "$watch_arg" == "pre" ]]; then
    # An array like ro_flag, and mutually exclusive with it by construction:
    # MODE_RE yields ONE value, and a "pre" never enters the server block that
    # builds ro_flag — a self preload skips it, a foreign one was refused.
    pre_flag=(-f ignore-size)
    logger -t ttyd-attach "preload-attach: os_user='$os_user' name='$name' mode='$watch_arg' self='$(id -un)'"
    if [[ "$os_user" == "$(id -un)" ]]; then
        exec /usr/bin/tmux attach-session "${pre_flag[@]}" -t "=$name"
    else
        exec sudo -n -H -u "$os_user" /usr/bin/tmux attach-session "${pre_flag[@]}" -t "=$name"
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
