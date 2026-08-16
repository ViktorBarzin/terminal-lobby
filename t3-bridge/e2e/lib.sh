# shellcheck shell=bash
# lib.sh — shared machinery for run-e2e.sh.
#
# Nothing in here knows what the bridge does; it is the plumbing the steps are
# written on top of: a cleanup registry that fires on every exit path, the two
# HTTP surfaces (t3-serve and tmux-api), a couple of tmux helpers that refuse to
# touch a session this run did not create, and a poller.
#
# The refusal is the important part. This box carries a dozen tmux sessions
# doing real work, and every destructive verb here goes through guard_ours,
# which checks the name against the list of sessions this run made.

set -uo pipefail

# ---------------------------------------------------------------- logging ----

C_OK=$'\033[32m'; C_BAD=$'\033[31m'; C_DIM=$'\033[2m'; C_HDR=$'\033[1;36m'; C_OFF=$'\033[0m'
[ -t 1 ] || { C_OK=; C_BAD=; C_DIM=; C_HDR=; C_OFF=; }

log()  { printf '%s\n' "$*" | tee -a "${RUNLOG:-/dev/null}"; }
note() { printf '%s%s%s\n' "$C_DIM" "$*" "$C_OFF" | tee -a "${RUNLOG:-/dev/null}"; }
hdr()  { printf '\n%s=== %s ===%s\n' "$C_HDR" "$*" "$C_OFF" | tee -a "${RUNLOG:-/dev/null}"; }
die()  { printf '%sABORT: %s%s\n' "$C_BAD" "$*" "$C_OFF" >&2; exit 2; }

# evidence <slug> — echoes a path under $EV to capture raw output into. Every
# claim in the final table has to point at one of these.
evidence() { printf '%s/%s.txt' "$EV" "$1"; }

# record <step> <PASS|FAIL|PARTIAL> <one-line summary>
record() {
    printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$RESULTS"
    case "$2" in
        PASS) printf '  %s[PASS]%s %s — %s\n' "$C_OK"  "$C_OFF" "$1" "$3" ;;
        *)    printf '  %s[%s]%s %s — %s\n'   "$C_BAD" "$2" "$C_OFF" "$1" "$3" ;;
    esac | tee -a "$RUNLOG"
}

# ------------------------------------------------------- cleanup registry ----

# Every resource this run creates registers itself the moment it exists, so a
# failure between "created" and "recorded" cannot leak it.
CLEAN_SESSIONS=()   # tmux session names, all t3e2e-*
CLEAN_PGIDS=()      # process groups (t3-serve, tl-t3-sync)

track_session() { CLEAN_SESSIONS+=("$1"); printf '%s\n' "$1" >> "$WORK/created-sessions"; }
track_pgid()    { CLEAN_PGIDS+=("$1");    printf '%s\n' "$1" >> "$WORK/created-pgids"; }

# guard_ours <session> — hard stop unless this run created the session. The one
# thing that must never regress.
guard_ours() {
    local name=$1 s
    case "$name" in
        t3e2e-*) ;;
        *) die "refusing to touch tmux session '$name': not a t3e2e-* name" ;;
    esac
    for s in ${CLEAN_SESSIONS+"${CLEAN_SESSIONS[@]}"}; do
        [ "$s" = "$name" ] && return 0
    done
    die "refusing to touch tmux session '$name': this run did not create it"
}

CLEANED=0
cleanup() {
    local rc=$? s pg
    [ "$CLEANED" = 1 ] && return $rc
    CLEANED=1
    hdr "cleanup"
    for pg in ${CLEAN_PGIDS+"${CLEAN_PGIDS[@]}"}; do
        kill -TERM "-$pg" 2>/dev/null && note "SIGTERM to process group $pg"
    done
    sleep 1
    for pg in ${CLEAN_PGIDS+"${CLEAN_PGIDS[@]}"}; do
        kill -KILL "-$pg" 2>/dev/null && note "SIGKILL to process group $pg"
    done
    for s in ${CLEAN_SESSIONS+"${CLEAN_SESSIONS[@]}"}; do
        if tmux has-session -t "=$s" 2>/dev/null; then
            tmux kill-session -t "=$s" 2>/dev/null && note "killed tmux session $s"
        fi
    done
    # Anything still RUNNING out of this run's own bin or base dir is ours and
    # is a leak. The pattern is deliberately narrow: a shell that merely mentions
    # the workdir on its command line (a `tail -f` on the log, this script's own
    # supervisor) is not a straggler, and a broad -f pattern would kill it.
    local stragglers
    stragglers=$(pgrep -af -- "$WORK/bin/|--base-dir $WORK|$WORK/t3base" 2>/dev/null || true)
    if [ -n "$stragglers" ]; then
        note "stragglers still running out of $WORK:"; printf '%s\n' "$stragglers" | tee -a "$RUNLOG"
        pkill -KILL -f -- "$WORK/bin/" 2>/dev/null
        pkill -KILL -f -- "$WORK/t3base" 2>/dev/null
    fi
    note "workdir kept for inspection: $WORK"
    return $rc
}

# --------------------------------------------------------------- helpers ----

# free_port <lo> <hi> — first TCP port in the range nothing is listening on.
free_port() {
    local lo=$1 hi=$2 p used
    used=$(ss -ltnH 2>/dev/null | awk '{print $4}' | sed 's/.*://' | sort -u)
    for ((p = lo; p <= hi; p++)); do
        printf '%s\n' "$used" | grep -qx "$p" || { printf '%s' "$p"; return 0; }
    done
    return 1
}

uuid() { cat /proc/sys/kernel/random/uuid; }
now_iso() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }

# count_in <pattern> <file> — matching lines, always a bare integer.
#
# `grep -c` prints 0 and EXITS 1 when nothing matches, so the obvious
# `n=$(grep -c p f || echo 0)` yields the two-line string "0\n0" and every
# later `[ "$n" -ge 1 ]` dies with "integer expression expected". Learned the
# hard way; do not inline grep -c into a comparison.
count_in() {
    local n
    n=$(grep -c -- "$1" "$2" 2>/dev/null | head -1)
    printf '%s' "${n:-0}"
}

# waitfor <seconds> <description> <command...> — poll until the command
# succeeds. Returns 1 on timeout, having said how long it waited.
waitfor() {
    local secs=$1 what=$2; shift 2
    local deadline=$((SECONDS + secs))
    while [ $SECONDS -lt $deadline ]; do
        if "$@" >/dev/null 2>&1; then return 0; fi
        sleep 0.5
    done
    note "timeout after ${secs}s waiting for: $what"
    return 1
}

# ------------------------------------------------------------ t3-serve API ----

# t3_snapshot — GET the orchestration read model.
t3_snapshot() {
    curl -sS --max-time 20 "$T3URL/api/orchestration/snapshot" \
        -H "Authorization: Bearer $BEARER"
}

# verbs whose schema declares createdAt (t3-sync/t3client.go verbsWithCreatedAt)
_verb_has_created_at() {
    case "$1" in
        project.create|thread.create|thread.turn.start|thread.turn.interrupt|thread.session.stop) return 0 ;;
        *) return 1 ;;
    esac
}

# turn_payload <threadId> <text> — a thread.turn.start body T3's HTTP route
# accepts.
#
# The route decodes ClientOrchestrationCommand, and its ClientThreadTurnStartCommand
# declares runtimeMode AND interactionMode as plain required fields — unlike the
# internal ThreadTurnStartCommand, where both carry a decoding default. Omitting
# interactionMode is answered with an empty-bodied HTTP 400, which is what step 4
# measures on the syncer's own payload. This helper always sends both, so a turn
# the harness starts itself is never the thing that failed.
turn_payload() {
    jq -nc --arg th "$1" --arg mid "$(uuid)" --arg text "$2" \
        '{threadId:$th,
          message:{messageId:$mid, role:"user", text:$text, attachments:[]},
          runtimeMode:"full-access",
          interactionMode:"default"}'
}

# t3_dispatch <verb> <payload-json> — the same envelope Client.Dispatch builds.
t3_dispatch() {
    local verb=$1 payload=$2 body extra='{}'
    _verb_has_created_at "$verb" && extra=$(jq -nc --arg ts "$(now_iso)" '{createdAt:$ts}')
    body=$(jq -nc --arg t "$verb" --arg cid "$(uuid)" --argjson p "$payload" --argjson x "$extra" \
        '$p + {type:$t, commandId:$cid} + $x')
    printf '>>> %s %s\n' "$verb" "$body" >> "$RUNLOG"
    curl -sS --max-time 60 -X POST "$T3URL/api/orchestration/dispatch" \
        -H "Authorization: Bearer $BEARER" -H 'Content-Type: application/json' \
        -d "$body" | tee -a "$RUNLOG"
    printf '\n' >> "$RUNLOG"
}

# ------------------------------------------------------------- t3 sqlite ----

# t3_sql <sql> — read-only query against T3's own store, with a busy timeout
# because t3-serve is writing to it at the same time.
t3_sql() {
    sqlite3 -readonly -cmd '.timeout 8000' "$T3DB" "$1"
}

# thread_messages <threadId> — every projected message on a thread, oldest
# first, flattened to one line each. Columns per T3's own schema:
# projection_thread_messages(message_id, thread_id, turn_id, role, text, …).
thread_messages() {
    t3_sql "SELECT substr(message_id,1,8) || ' | ' || substr(coalesce(turn_id,'-'),1,8) || ' | ' || role || ' | ' ||
                   substr(replace(replace(coalesce(text,''), char(10),' '), char(13),' '), 1, 220)
            FROM projection_thread_messages WHERE thread_id = '$1'
            ORDER BY created_at, message_id;"
}

# assistant_messages <threadId> — only what CLAUDE said.
#
# The distinction matters more than it looks: a check for the word "PONG"
# anywhere in the thread also matches the user message that asked for it, so a
# bridge that mirrors nothing back still looks like it works.
assistant_messages() {
    t3_sql "SELECT substr(message_id,1,8) || ' | ' ||
                   substr(replace(replace(coalesce(text,''), char(10),' '), char(13),' '), 1, 200)
            FROM projection_thread_messages WHERE thread_id = '$1' AND role = 'assistant'
            ORDER BY created_at, message_id;"
}
thread_has_assistant() { assistant_messages "$1" | grep -qE -- "$2"; }

# thread_resume_cursor <threadId> — the session id T3 will resume this thread
# with, out of provider_session_runtime.resume_cursor_json.
#
# NOT projection_thread_sessions.provider_session_id, which stays null for a
# bridged thread; the resume cursor is the field the design's "whatever
# session_id we report in system/init becomes the thread's resume cursor" is
# about, and it is the one that decides what argv the next spawn carries.
thread_resume_cursor() {
    t3_sql "SELECT coalesce(resume_cursor_json,'') FROM provider_session_runtime WHERE thread_id='$1';" |
        sed -n 's/.*"resume":"\([^"]*\)".*/\1/p'
}

# thread_last_error <threadId>
thread_last_error() {
    t3_sql "SELECT coalesce(last_error,'') FROM projection_thread_sessions WHERE thread_id='$1';"
}

# thread_turns <threadId> — one line per turn: state, and whether an assistant
# message was ever attached to it.
thread_turns() {
    t3_sql "SELECT substr(coalesce(turn_id,'-'),1,8) || ' | ' || state ||
                   ' | assistantMessage=' || coalesce(substr(assistant_message_id,1,8),'none') ||
                   ' | ' || requested_at || ' -> ' || coalesce(completed_at,'(open)')
            FROM projection_turns WHERE thread_id='$1' ORDER BY requested_at;"
}

# thread_activities <threadId> — the activity stream beside the messages, which
# is where tool calls and lifecycle entries land.
thread_activities() {
    t3_sql "SELECT substr(activity_id,1,8) || ' | ' || kind || ' | ' ||
                   substr(replace(coalesce(summary,''), char(10),' '), 1, 160)
            FROM projection_thread_activities WHERE thread_id = '$1'
            ORDER BY coalesce(sequence,0), created_at;"
}

# bridges — one line per LIVE bridge process: "<pid> <flag> <uuid>".
#
# This, not projection_thread_sessions, is the authority on which Claude session
# id T3 handed a bridge: the projection row is written only once the provider
# session settles, and the question here is what T3 decided at spawn time.
# Matched on argv[0] so the syncer — whose own command line carries the bridge's
# path in -bridge — is not mistaken for one.
bridges() {
    ps -eo pid= -o args= | awk -v b="$BRIDGE_BIN" '
        $2 == b {
            pid = $1; flag = ""; id = ""
            for (i = 3; i < NF; i++)
                if ($i == "--session-id" || $i == "--resume") { flag = $i; id = $(i+1) }
            if (id != "") print pid, flag, id
        }'
}

# bridge_session_id — the uuid on the single live bridge, or "" if there is not
# exactly one.
bridge_session_id() {
    local lines; lines=$(bridges)
    [ "$(printf '%s\n' "$lines" | grep -c .)" = 1 ] || return 0
    printf '%s' "$lines" | awk '{print $3}'
}

# thread_session <threadId> — T3's own record of the provider session behind a
# thread: the session id it handed the bridge, and which instance ran it.
thread_session() {
    t3_sql "SELECT 'status=' || status || ' instance=' || coalesce(provider_instance_id,'-') ||
                   ' providerSessionId=' || coalesce(provider_session_id,'-') ||
                   ' activeTurn=' || coalesce(active_turn_id,'-') ||
                   ' lastError=' || coalesce(last_error,'-')
            FROM projection_thread_sessions WHERE thread_id = '$1';"
}

# ---------------------------------------------------------------- tmux ------
#
# Targeting, measured on tmux 3.4 — the "=" exact-match prefix is NOT uniformly
# honoured, and the ways it fails are all silent:
#
#   has-session   -t "=name"   exact, as documented
#   kill-session  -t "=name"   exact, as documented
#   list-panes -s -t "=Counc"  matched Council-tax     — prefix, NOT exact
#   show-options  -t "=name"   returned nothing at all — with -q, indistinguishable
#   display-message / capture-pane / send-keys -t "=name"
#                              `can't find pane: =name`
#
# A harness sharing a tmux server with real work cannot rely on a prefix match,
# and a silent empty read is worse than an error — it reads as "the option is
# unset", which is exactly the answer these checks turn on. So exactness is done
# here instead: every session name is matched with grep -x against the session
# list, and every pane operation targets a pane id (%N, globally unique) that
# was resolved by an exact name comparison.

tmux_names() { tmux list-sessions -F '#{session_name}' 2>/dev/null | sort; }
tmux_alive() { tmux_names | grep -qxF -- "$1"; }

# pane_of <session> — the active pane's id, resolved by EXACT session name.
pane_of() {
    tmux list-panes -a -F '#{session_name}'$'\t''#{pane_active}'$'\t''#{pane_id}' 2>/dev/null |
        awk -F'\t' -v s="$1" '$1 == s && $2 == 1 { print $3; exit }'
}

# tmux_opt <session> <@option> — a session option, read through the session's
# own pane so the answer cannot come from a different session.
tmux_opt() {
    local p; p=$(pane_of "$1"); [ -n "$p" ] || return 1
    tmux display-message -p -t "$p" "#{$2}" 2>/dev/null
}

pane_text() {
    local p; p=$(pane_of "$1"); [ -n "$p" ] || return 1
    tmux capture-pane -p -t "$p" -S -"${2:-60}" 2>/dev/null
}

# new_e2e_session <name> <dir> — a detached login shell, tracked for cleanup.
new_e2e_session() {
    local name=$1 dir=$2
    case "$name" in t3e2e-*) ;; *) die "e2e sessions must be named t3e2e-*: $name" ;; esac
    tmux new-session -d -s "$name" -c "$dir" || die "could not create tmux session $name"
    track_session "$name"
}

# kill_e2e_session <name> — direct tmux kill (NOT through tmux-api), which is
# how this harness simulates a death that crosses nothing.
kill_e2e_session() { guard_ours "$1"; tmux kill-session -t "=$1" 2>/dev/null; }

# sweep_sessions — adopt into the cleanup registry any t3e2e-* session that
# appeared without this harness calling new_e2e_session.
#
# The bridge creates tmux sessions of its own, named Slug(basename(cwd)) — so
# every workspace root here is a t3e2e- name, and this picks up whatever the
# bridge made under one. Without it a resurrection or a T3-born thread leaves a
# session and a claude behind on a box where memory is the binding constraint.
sweep_sessions() {
    local name known s
    while read -r name; do
        case "$name" in t3e2e-*) ;; *) continue ;; esac
        known=0
        for s in ${CLEAN_SESSIONS+"${CLEAN_SESSIONS[@]}"}; do
            [ "$s" = "$name" ] && { known=1; break; }
        done
        [ "$known" = 1 ] && continue
        note "sweep: $name appeared without this harness creating it (the bridge made it); tracking it for cleanup"
        track_session "$name"
    done < <(tmux_names)
}

# type_prompt <session> <text> — what a human does in the pane: the text, a
# beat for Claude's TUI to take it, then Enter on its own.
type_prompt() {
    guard_ours "$1"
    local p; p=$(pane_of "$1") || return 1
    [ -n "$p" ] || { note "type_prompt: no pane for $1"; return 1; }
    tmux send-keys -t "$p" -l -- "$2" || return 1
    sleep 0.6
    tmux send-keys -t "$p" Enter
}

# ------------------------------------------------------------ predicates ----
# waitfor runs these in-process, so they are functions rather than `bash -c`
# strings: one less layer of quoting between a check and what it checks.

# claude_ready <session> — the SessionStart hook has run and session-events has
# stamped the transcript, which is the same signal every other reader uses.
claude_ready()   { [ -n "$(tmux_opt "$1" @claude_transcript)" ]; }
claude_settled() { [ "$(tmux_opt "$1" @claude_state)" = "done" ]; }
state_is()       { [ "$(tmux_opt "$1" @claude_state)" = "$2" ]; }
state_not()      { [ "$(tmux_opt "$1" @claude_state)" != "$2" ]; }
adopted()        { [ -n "$(tmux_opt "$1" @t3_thread)" ]; }
session_gone()   { ! tmux_alive "$1"; }

# pane_has <session> <regex> — the pane's recent scrollback matches.
pane_has() { pane_text "$1" 80 2>/dev/null | grep -qE -- "$2"; }

# session_matching <prefix> — the first live session name with this prefix.
session_matching() { tmux_names | grep -m1 -- "^$1"; }
session_exists_like() { [ -n "$(session_matching "$1")" ]; }

# thread_has <threadId> <regex> — the thread's projected messages match.
thread_has() { thread_messages "$1" 2>/dev/null | grep -qE -- "$2"; }
thread_any_message() { [ "$(t3_sql "SELECT count(*) FROM projection_thread_messages WHERE thread_id='$1';")" != 0 ]; }

# thread_archived <threadId> — T3's own projection says the thread is archived.
thread_archived() {
    [ -n "$(t3_sql "SELECT coalesce(archived_at,'') FROM projection_threads WHERE thread_id='$1';")" ]
}

# transcript_has <session> <regex>
transcript_has() {
    local t; t=$(tmux_opt "$1" @claude_transcript)
    [ -n "$t" ] && [ -f "$t" ] && grep -qE -- "$2" "$t"
}

# bound_thread_for <tmux session> <index.json> — the thread id the durable
# binding index pairs a session name with, or "" when nothing does.
#
# Reversing the index by name rather than by uuid is what the syncer's own
# threadForSession does, and it is how a "the kill did not cross" answer gets
# turned into "…because the session is bound to a different thread".
bound_thread_for() {
    python3 - "$1" "$2" <<'PY'
import json, sys
name, path = sys.argv[1], sys.argv[2]
try:
    bindings = json.load(open(path)).get("bindings", {})
except Exception:
    sys.exit()
print(" ".join(v["threadId"] for v in bindings.values()
                if v.get("tmuxName") == name and v.get("threadId")))
PY
}
