#!/usr/bin/env bash
# run-e2e.sh — drive the terminal-lobby ↔ T3 Code bridge end to end against a
# real t3-serve, a real claude and real tmux sessions, and report what actually
# happened.
#
# Everything the modules' own tests cover is a fake talking to a fake. This is
# the pass that says whether the design works: one throwaway T3 instance, one
# throwaway tmux session per scenario, and twelve checks that each print the
# evidence they judged — sqlite rows, capture-pane text, `tmux ls` output.
#
# WHAT IT TOUCHES, AND WHAT IT WILL NOT
#
#   - Its own t3-serve, on a free port with its own --base-dir under a temp
#     directory. /home/<user>/.t3 is never opened; step 12 proves it.
#   - tmux sessions named t3e2e-*, on the user's DEFAULT socket, and only ever
#     ones this run created (lib.sh guard_ours refuses anything else).
#
#     The default socket rather than an isolated `-L` server is a deliberate
#     trade. @claude_transcript is stamped by the org-wide SessionStart hook →
#     session-events, which drives the default socket; an isolated server would
#     mean standing in a fake for the one component that makes a session
#     discoverable, and the syncer's kill path would reach the real tmux-api and
#     get a 404 it treats as success. Both would turn real checks green for the
#     wrong reason. The cost is that the syncer can SEE the box's other
#     sessions, so it is started with an ignore list computed as the complement
#     of "t3e2e-" (see build_ignore): every name that is not one of ours is
#     ignored, by construction rather than by hope.
#
#   - The lobby's live tmux-api, read/write, for exactly one verb: killing a
#     t3e2e-* session when its thread is deleted. That is the real code path and
#     the reason the sessions are on the default socket.
#
# Re-runnable: every run gets a fresh temp workdir, a fresh port and a fresh
# base dir. Self-cleaning: trap EXIT tears down the t3 instance, both daemons
# and every tmux session it made, on success, on failure and on Ctrl-C.
#
# Usage:  ./run-e2e.sh [--keep] [--only N[,N...]]

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 2
E2E_DIR=$PWD
REPO=$(cd ../.. && pwd)

ONLY=""
for arg in "$@"; do
    case "$arg" in
        --only) shift; ONLY=${1:-} ;;
        --only=*) ONLY=${arg#--only=} ;;
        --keep) ;;                       # workdirs are always kept
        -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    esac
done
want() { [ -z "$ONLY" ] || printf ',%s,' "$ONLY" | grep -q ",$1,"; }

# ------------------------------------------------------------ guardrails ----

AVAIL=$(free -g | awk '/^Mem:/ {print $7}')
if [ "${AVAIL:-0}" -lt 4 ]; then
    echo "ABORT: only ${AVAIL} GB available; this run starts a t3-serve and up to two claude"
    echo "       processes, and earlyoom has already fired on this box today. Wait and retry."
    exit 3
fi

command -v tmux    >/dev/null || { echo "ABORT: tmux not on PATH"; exit 3; }
command -v jq      >/dev/null || { echo "ABORT: jq not on PATH"; exit 3; }
command -v sqlite3 >/dev/null || { echo "ABORT: sqlite3 not on PATH"; exit 3; }
command -v t3      >/dev/null || { echo "ABORT: t3 not on PATH"; exit 3; }
command -v go      >/dev/null || { echo "ABORT: go not on PATH"; exit 3; }

# --------------------------------------------------------------- workdir ----

# /var/tmp, not /tmp: /tmp on this box is a 2 GB tmpfs that is routinely ~95%
# full, and it is RAM — the resource this run is most careful with. /var/tmp is
# on the root filesystem. Override with TL_E2E_TMPDIR.
#
# The template has NO DOT in it, deliberately. Claude Code slugifies a session's
# cwd into its transcript directory by rewriting BOTH "/" and "." to "-", while
# sessionio.TranscriptPath rewrites only "/" — so a workdir named
# `tl-t3-e2e.AbCd` makes every @claude_transcript stamp point at a file that
# does not exist, and every mirroring check below fails for that reason instead
# of its own. That mismatch is a finding in its own right (it also hits any real
# session under `.worktrees/`); this template keeps it from masking the others.
WORK=$(mktemp -d "${TL_E2E_TMPDIR:-/var/tmp}/tl-t3-e2e-XXXXXXXX")
EV="$WORK/evidence"; LOGD="$WORK/logs"; BIN="$WORK/bin"; STATE="$WORK/state"
T3_BASE="$WORK/t3base"; RUNLOG="$WORK/run.log"; RESULTS="$WORK/results.tsv"
mkdir -p "$EV" "$LOGD" "$BIN" "$STATE" "$T3_BASE" "$WORK/ws"
: > "$RUNLOG"; : > "$RESULTS"

# shellcheck source=lib.sh
. "$E2E_DIR/lib.sh"
# A signal handler must END the run, not just tidy up: bash resumes the script
# after a trap returns, so `trap cleanup TERM` alone leaves a torn-down run
# still executing against a workdir that no longer exists.
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

RUN_START=$(date '+%Y-%m-%d %H:%M:%S')
hdr "terminal-lobby ↔ T3 bridge · end-to-end"
note "workdir     $WORK"
note "started     $RUN_START"
note "memory      ${AVAIL} GB available"
note "t3          $(t3 --version 2>&1 | head -1)"
note "claude      $(claude --version 2>&1 | head -1)"
note "tmux        $(tmux -V)"
note "commit      $(git -C "$REPO" rev-parse --short HEAD)"

# The two baselines step 12 judges against, taken before anything starts.
tmux_names > "$WORK/tmux-baseline.txt"
BASELINE_N=$(wc -l < "$WORK/tmux-baseline.txt")
note "tmux        $BASELINE_N pre-existing sessions recorded as the baseline"
LIVE_T3=/home/$USER/.t3
find "$LIVE_T3" -printf '%T@ %p\n' 2>/dev/null | sort > "$WORK/livet3-baseline.txt"
note "live .t3    $(wc -l < "$WORK/livet3-baseline.txt") paths fingerprinted (must not move)"

# --------------------------------------------------------------- toolkit ----

hdr "build"
( cd "$REPO/t3-bridge" && go build -o "$BIN/tl-t3-bridge" . ) || die "cannot build tl-t3-bridge"
( cd "$REPO/t3-sync"   && go build -o "$BIN/tl-t3-sync"   . ) || die "cannot build tl-t3-sync"
BRIDGE_BIN="$BIN/tl-t3-bridge"
note "built $BRIDGE_BIN and $BIN/tl-t3-sync"

# The tap. T3 spawns whatever binaryPath names, so pointing it at a wrapper that
# copies both directions to disk is the only way to see the bytes on the seam —
# and when T3 says a provider stream failed, the bytes are the whole answer.
# stdbuf keeps tee from holding a line back; pipefail keeps the bridge's own exit
# status, which T3's --version health probe reads.
BRIDGE_TAP="$BIN/tl-t3-bridge-tap"
cat > "$BRIDGE_TAP" <<TAP
#!/bin/bash
set -o pipefail
exec 2>>"$LOGD/bridge.stderr.log"
stdbuf -i0 -o0 tee -a "$LOGD/bridge.stdin.jsonl" \
  | "$BRIDGE_BIN" "\$@" \
  | stdbuf -i0 -o0 tee -a "$LOGD/bridge.stdout.jsonl"
TAP
chmod +x "$BRIDGE_TAP"
note "tap         $BRIDGE_TAP -> $LOGD/bridge.std{in,out}.jsonl" 

# The real claude, resolved the way the login shell resolves it — the wrapper is
# a zsh function, so `whence -p` is what skips it.
REAL_CLAUDE=$(zsh -lic 'whence -p claude' 2>/dev/null | tail -1)
[ -x "$REAL_CLAUDE" ] || REAL_CLAUDE="$HOME/.local/bin/claude"
[ -x "$REAL_CLAUDE" ] || die "cannot find the real claude binary"
note "real claude $REAL_CLAUDE"

# build_ignore — the complement of "t3e2e-" over tmux's name alphabet.
#
# The syncer has an ignore list, not an allow list, and this run shares a tmux
# server with sessions doing real work. Enumerating every one-character
# divergence from our own prefix produces a finite prefix set that matches every
# name except ours, so no session on this box can become an adoption candidate
# by accident — including one created while the run is in progress, which an
# ignore list built from `tmux ls` would miss. The live names are appended too,
# for anything outside the alphabet.
build_ignore() {
    python3 - <<'PY'
import string
alpha = string.ascii_letters + string.digits + "_-."
target = "t3e2e-"
out = [target[:i] + c for i, ch in enumerate(target) for c in alpha if c != ch]
print(",".join(out), end="")
PY
    tmux list-sessions -F '#{session_name}' 2>/dev/null | while read -r n; do printf ',%s' "$n"; done
}
IGNORE=$(build_ignore)
note "ignore list $(printf '%s' "$IGNORE" | tr ',' '\n' | wc -l) prefixes (everything that is not t3e2e-*)"

T3_PORT=$(free_port 3800 3899)   || die "no free port in 3800-3899"
NOTIFY_PORT=$(free_port 7695 7699) || die "no free port in the 7695-7699 notify block"
T3URL="http://127.0.0.1:$T3_PORT"
note "t3 port     $T3_PORT      notify port $NOTIFY_PORT"

# ============================================================================
# 1 — an isolated t3, a bearer, and a snapshot that answers
# ============================================================================
hdr "1 · isolated t3-serve, bearer, snapshot"

env -u TMUX -u TMUX_PANE XDG_STATE_HOME="$STATE" T3CODE_HOME="$T3_BASE" \
    setsid t3 serve --host 127.0.0.1 --port "$T3_PORT" --base-dir "$T3_BASE" --no-browser \
    > "$LOGD/t3-serve.log" 2>&1 &
T3_PID=$!
sleep 0.5
track_pgid "$(ps -o pgid= -p "$T3_PID" 2>/dev/null | tr -d ' ')"

waitfor 90 "t3-serve to listen on $T3_PORT" \
    bash -c "ss -ltnH 'sport = :$T3_PORT' | grep -q ':$T3_PORT'" \
    || { cat "$LOGD/t3-serve.log" | tail -30; die "t3-serve never listened"; }

# --token-only still prints a trailing blank line, so pick the JWT out by shape
# rather than by position.
BEARER=$(t3 auth session issue --token-only --ttl 1d --base-dir "$T3_BASE" 2>>"$RUNLOG" \
         | tr -d '\r' | grep -Eom1 '^[A-Za-z0-9_.-]{40,}$')
[ -n "$BEARER" ] || { tail -20 "$LOGD/t3-serve.log"; die "could not mint a bearer"; }

waitfor 60 "the snapshot route to answer 200" \
    bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' '$T3URL/api/orchestration/snapshot' -H 'Authorization: Bearer $BEARER')\" = 200 ]"
SNAP_CODE=$(curl -s -o "$(evidence 01-snapshot)" -w '%{http_code}' "$T3URL/api/orchestration/snapshot" -H "Authorization: Bearer $BEARER")
{
    echo "port        $T3_PORT"
    echo "base-dir    $T3_BASE"
    echo "bearer      ${BEARER:0:12}…(${#BEARER} chars)"
    echo "GET /api/orchestration/snapshot -> HTTP $SNAP_CODE"
    jq -c '{snapshotSequence, projects: (.projects|length), threads: (.threads|length)}' \
        "$(evidence 01-snapshot)" 2>/dev/null
} >> "$(evidence 01-summary)"
cat "$(evidence 01-summary)" | tee -a "$RUNLOG"

T3DB=$(find "$T3_BASE" -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' 2>/dev/null | head -1)
INDEX_JSON="$STATE/terminal-lobby/t3-bridge/index.json"
note "t3 sqlite   ${T3DB:-<not found yet>}"
note "index       $INDEX_JSON"

if [ "$SNAP_CODE" = 200 ]; then
    record 1 PASS "t3-serve up on :$T3_PORT, bearer minted, snapshot HTTP 200 ($(jq -r '.projects|length' "$(evidence 01-snapshot)") projects / $(jq -r '.threads|length' "$(evidence 01-snapshot)") threads)"
else
    record 1 FAIL "snapshot answered HTTP $SNAP_CODE"
    die "no usable t3; nothing below can run"
fi

# ============================================================================
# 2 & 3 — the settings merge, and T3's provider health probe
# ============================================================================
SETTINGS="$T3_BASE/userdata/settings.json"

run_syncer() {   # run_syncer <extra args...> — starts it, tracks it, returns
    env -u TMUX -u TMUX_PANE XDG_STATE_HOME="$STATE" setsid "$BIN/tl-t3-sync" \
        -endpoint "$T3URL" -base-dir "$T3_BASE" -interval 3s \
        -ignore "$IGNORE" -notify-addr "127.0.0.1:$NOTIFY_PORT" \
        -bridge "$BRIDGE_TAP" -claude "$REAL_CLAUDE" \
        -tmux-api http://127.0.0.1:7684 "$@" \
        >> "$LOGD/t3-sync.log" 2>&1 &
    SYNCER_PID=$!
    sleep 0.5
    SYNCER_PGID=$(ps -o pgid= -p "$SYNCER_PID" 2>/dev/null | tr -d ' ')
    [ -n "$SYNCER_PGID" ] && track_pgid "$SYNCER_PGID"
}
stop_syncer() {
    [ -n "${SYNCER_PGID:-}" ] && kill -TERM "-$SYNCER_PGID" 2>/dev/null
    sleep 1
    [ -n "${SYNCER_PGID:-}" ] && kill -KILL "-$SYNCER_PGID" 2>/dev/null
    SYNCER_PGID=""
    return 0
}

if want 2; then
hdr "2 · the provider-instance merge into settings.json"

    note "settings.json before: $( [ -f "$SETTINGS" ] && echo "exists, $(wc -c < "$SETTINGS") bytes" || echo "absent" )"
    run_syncer -dry-run
    waitfor 40 "the syncer to write providerInstances" test -f "$SETTINGS"
    sleep 2
    cp "$SETTINGS" "$WORK/settings-after-first.json" 2>/dev/null
    FIRST_SUM=$(sha256sum "$SETTINGS" 2>/dev/null | cut -d' ' -f1)
    FIRST_MTIME=$(stat -c %Y "$SETTINGS" 2>/dev/null)
    stop_syncer

    sleep 1
    run_syncer -dry-run
    sleep 6
    SECOND_SUM=$(sha256sum "$SETTINGS" 2>/dev/null | cut -d' ' -f1)
    SECOND_MTIME=$(stat -c %Y "$SETTINGS" 2>/dev/null)
    stop_syncer

    {
        echo "--- providerInstances after the first merge ---"
        jq '.providerInstances | {claudeAgent, claudeStock}' "$SETTINGS" 2>/dev/null
        echo
        echo "bridge built at : $BIN/tl-t3-bridge"
        echo "real claude at  : $REAL_CLAUDE"
        echo
        echo "first  run: sha256=$FIRST_SUM  mtime=$FIRST_MTIME"
        echo "second run: sha256=$SECOND_SUM  mtime=$SECOND_MTIME"
    } > "$(evidence 02-settings)"
    cat "$(evidence 02-settings)" | tee -a "$RUNLOG"

    GOT_BRIDGE=$(jq -r '.providerInstances.claudeAgent.config.binaryPath // "MISSING"' "$SETTINGS" 2>/dev/null)
    GOT_STOCK=$(jq -r '.providerInstances.claudeStock.config.binaryPath // "MISSING"' "$SETTINGS" 2>/dev/null)
    GOT_DRIVER=$(jq -r '.providerInstances.claudeAgent.driver // "MISSING"' "$SETTINGS" 2>/dev/null)

    if [ "$GOT_BRIDGE" = "$BRIDGE_TAP" ] && [ "$GOT_STOCK" = "$REAL_CLAUDE" ] &&
       [ "$GOT_DRIVER" = claudeAgent ] && [ -n "$FIRST_SUM" ] &&
       [ "$FIRST_SUM" = "$SECOND_SUM" ] && [ "$FIRST_MTIME" = "$SECOND_MTIME" ]; then
        record 2 PASS "claudeAgent→the bridge (via this run's tap wrapper), claudeStock→$REAL_CLAUDE; second run byte-identical AND did not rewrite the file (mtime unchanged)"
    else
        record 2 FAIL "claudeAgent=$GOT_BRIDGE claudeStock=$GOT_STOCK driver=$GOT_DRIVER sums=$FIRST_SUM/$SECOND_SUM mtimes=$FIRST_MTIME/$SECOND_MTIME"
    fi
fi

if want 3; then
hdr "3 · T3's provider health probe"
    # T3 probes a provider by running `<binaryPath> --version` and parsing it.
    {
        echo "\$ $REAL_CLAUDE --version";        "$REAL_CLAUDE" --version 2>&1
        echo "\$ $BIN/tl-t3-bridge --version";   "$BIN/tl-t3-bridge" --version 2>&1
        echo "exit=$?"
    } > "$(evidence 03-version)"
    # …and the handshake probe the syncer runs on the same argv T3 uses.
    printf '{"type":"control_request","request_id":"req_1","request":{"subtype":"initialize","hooks":null}}\n' \
      | env TL_T3_BRIDGE_PROBE=1 "$BIN/tl-t3-bridge" \
            --output-format stream-json --input-format stream-json --verbose \
            --setting-sources=user,project,local --session-id "$(uuid)" \
            >> "$(evidence 03-version)" 2>>"$(evidence 03-version)"
    cat "$(evidence 03-version)" | tee -a "$RUNLOG"

    BRIDGE_V=$("$BIN/tl-t3-bridge" --version 2>&1 | head -1)
    CLAUDE_V=$("$REAL_CLAUDE" --version 2>&1 | head -1)
    if [ "$BRIDGE_V" = "$CLAUDE_V" ] && grep -q '"subtype":"init"' "$(evidence 03-version)"; then
        record 3 PASS "\`tl-t3-bridge --version\` = \`claude --version\` = '$BRIDGE_V'; handshake probe answers initialize + system/init"
    else
        record 3 FAIL "bridge --version='$BRIDGE_V' claude --version='$CLAUDE_V'"
    fi
fi

# ============================================================================
# S2 — the transcript slug rule, checked against what Claude Code actually did
#
# Free, deterministic, and needs nothing running: it reads the directories
# Claude Code has already created under this user's projects root. Every one of
# them is a cwd with "/" AND "." rewritten to "-", so a cwd containing a dot
# lands in a directory sessionio.TranscriptPath (layout.go, "/" only) will never
# name. The tell-tale is "--" in a directory name, which is what ".worktrees"
# becomes — and worktrees are this project's standing workflow.
# ============================================================================
if want S2; then
hdr "S2 · does TranscriptPath agree with Claude Code's own cwd slug?"

    PROJ=/home/$USER/.claude/projects
    {
        echo "project directories under $PROJ: $(find "$PROJ" -maxdepth 1 -type d | tail -n +2 | wc -l)"
        echo "…that contain a literal '.': $(find "$PROJ" -maxdepth 1 -type d -name '*.*' | wc -l)"
        echo "…that contain '--', the shape a leading-dot path component takes:"
        find "$PROJ" -maxdepth 1 -type d -name '*--*' -printf '  %f\n' | head -8
        echo
        echo "So for a session whose cwd is, say, ~/code/terminal-lobby/.worktrees/t3-bridge:"
        echo "  Claude Code writes to : $PROJ/-home-$USER-code-terminal-lobby--worktrees-t3-bridge/"
        echo "  TranscriptPath stamps : $PROJ/-home-$USER-code-terminal-lobby-.worktrees-t3-bridge/"
        echo "  (sessionio/layout.go: strings.ReplaceAll(cwd, \"/\", \"-\") — the dot is left alone)"
    } > "$(evidence S2-slug)"
    cat "$(evidence S2-slug)" | tee -a "$RUNLOG"

    DOTTED=$(find "$PROJ" -maxdepth 1 -type d -name '*.*' | wc -l)
    DASHED=$(find "$PROJ" -maxdepth 1 -type d -name '*--*' | wc -l)
    if [ "$DOTTED" -eq 0 ] && [ "$DASHED" -ge 1 ]; then
        record S2 FAIL "Claude Code rewrites '.' to '-' in the cwd slug and sessionio.TranscriptPath does not: $DASHED of this user's project directories carry the rewritten form and not one of $(find "$PROJ" -maxdepth 1 -type d | tail -n +2 | wc -l) contains a dot. Any session whose cwd has a dot in it — every worktree under .worktrees/ — is stamped with a transcript path nothing ever writes, so its text view and its bridge both read an absent file."
    elif [ "$DOTTED" -ge 1 ]; then
        record S2 PASS "Claude Code keeps dots in the cwd slug on this build ($DOTTED directories carry one), so TranscriptPath's '/'-only rewrite agrees with it"
    else
        record S2 SKIP "no project directory here has a dot or a '--' in it; nothing to compare"
    fi
fi

# ============================================================================
# 4 — ADOPTION
# ============================================================================
# Every workspace root is named t3e2e-* on purpose. When the bridge has to
# create a tmux session it names it Slug(basename(cwd)) — the workspace root's
# own name — so making the ROOT a t3e2e- name keeps anything the bridge invents
# inside this harness's namespace, where guard_ours can reach it and step 12 can
# account for it.
ADOPT_WS="$WORK/ws/t3e2e-adopt"; mkdir -p "$ADOPT_WS"
ADOPT_SESSION=t3e2e-adopt
ADOPT_THREAD=""
ADOPT_UUID=""

if want 4; then
hdr "4 · adoption of a session that is already running"

    new_e2e_session "$ADOPT_SESSION" "$ADOPT_WS"
    # Through the login shell, so the claude-session.zsh wrapper stamps
    # --session-id and the SessionStart hook registers the transcript.
    type_prompt "$ADOPT_SESSION" "claude --dangerously-skip-permissions --model haiku"
    waitfor 120 "claude to come up and be stamped with @claude_transcript" claude_ready "$ADOPT_SESSION" \
        || pane_text "$ADOPT_SESSION" > "$(evidence 04-pane-failed)"

    ADOPT_TRANSCRIPT=$(tmux_opt "$ADOPT_SESSION" @claude_transcript)
    ADOPT_UUID=$(basename "${ADOPT_TRANSCRIPT:-none}" .jsonl)
    note "claude session uuid $ADOPT_UUID"
    note "transcript          $ADOPT_TRANSCRIPT"

    sleep 3
    type_prompt "$ADOPT_SESSION" "Reply with exactly the word PING"
    waitfor 120 "PING to come back in the pane" pane_has "$ADOPT_SESSION" 'PING'
    waitfor 60 "the turn to settle" claude_settled "$ADOPT_SESSION"

    # S — does the stamp name a file that is actually there?
    #
    # Checked after the first turn, because Claude Code creates the transcript
    # when it writes its first record rather than at SessionStart. Everything
    # downstream — the replay, the live tail, every assistant message — reads
    # this one path, so a stamp pointing at nothing makes each of those fail for
    # a reason that has nothing to do with them.
    waitfor 30 "the stamped transcript to exist" test -f "$ADOPT_TRANSCRIPT"
    if [ -f "$ADOPT_TRANSCRIPT" ]; then
        record S PASS "@claude_transcript names a file that exists ($(wc -l < "$ADOPT_TRANSCRIPT") records after one turn)"
    else
        record S FAIL "@claude_transcript names $ADOPT_TRANSCRIPT, which does not exist 30s after Claude answered. Claude Code slugifies a cwd by rewriting BOTH '/' and '.' to '-'; sessionio.TranscriptPath (layout.go) rewrites only '/', so any cwd containing a dot — every worktree under .worktrees/, for one — is stamped with a path nothing ever writes. What Claude did create: $(ls -d /home/"$USER"/.claude/projects/*"$(basename "$WORK")"* 2>/dev/null | tr '\n' ' ')"
    fi

    pane_text "$ADOPT_SESSION" 40 > "$(evidence 04a-pane-before-adoption)"
    note "--- pane before adoption (real history for the replay to carry) ---"
    tail -12 "$(evidence 04a-pane-before-adoption)" | tee -a "$RUNLOG"

    run_syncer
    waitfor 90 "the syncer to adopt $ADOPT_SESSION" adopted "$ADOPT_SESSION"
    ADOPT_THREAD=$(tmux_opt "$ADOPT_SESSION" @t3_thread)
    note "@t3_thread          ${ADOPT_THREAD:-<unstamped>}"

    t3_snapshot > "$(evidence 04b-snapshot)"
    {
        echo "--- tmux options on $ADOPT_SESSION ---"
        for o in @claude_transcript @claude_state @t3_thread; do
            printf '%-20s %s\n' "$o" "$(tmux_opt "$ADOPT_SESSION" "$o")"
        done
        echo
        echo "--- binding index ---"; cat "$INDEX_JSON" 2>/dev/null
        echo
        echo "--- T3 projects ---"
        jq -c '.projects[] | {id, title, workspaceRoot}' "$(evidence 04b-snapshot)" 2>/dev/null
        echo "--- T3 threads ---"
        jq -c '.threads[] | {id, projectId, title, archivedAt, deletedAt}' "$(evidence 04b-snapshot)" 2>/dev/null
    } > "$(evidence 04c-state)"
    cat "$(evidence 04c-state)" | tee -a "$RUNLOG"

    # 4a — the bookkeeping half.
    WS_OK=$(jq -r --arg d "$ADOPT_WS" '[.projects[] | select(.workspaceRoot == $d)] | length' "$(evidence 04b-snapshot)")
    TH_OK=$(jq -r --arg t "$ADOPT_SESSION" '[.threads[] | select(.title == $t)] | length' "$(evidence 04b-snapshot)")
    IDX_OK=$(count_in "$ADOPT_THREAD" "$INDEX_JSON")
    if [ "$WS_OK" -ge 1 ] && [ "$TH_OK" -ge 1 ] && [ -n "$ADOPT_THREAD" ] && [ "$IDX_OK" -ge 1 ]; then
        record 4a PASS "workspace created for $ADOPT_WS; thread '$ADOPT_SESSION' = $ADOPT_THREAD; @t3_thread stamped on the session; binding written to the index"
    else
        record 4a FAIL "workspace=$WS_OK thread=$TH_OK @t3_thread='$ADOPT_THREAD' index-entry=$IDX_OK"
    fi

    # 4b — the warm-up turn. Only a process T3 spawns can put content into a
    # thread, so this is what decides whether an adopted session reads as itself
    # in T3 or as a blank thread (decision 11).
    if [ -n "$ADOPT_THREAD" ]; then
        waitfor 60 "the warm-up turn's replay to reach projection_thread_messages" \
            thread_any_message "$ADOPT_THREAD"
        thread_messages "$ADOPT_THREAD" > "$(evidence 04d-thread-messages)"
        WARMUP_ERR=$(grep -m1 'warm-up turn' "$LOGD/t3-sync.log")
        WARM_N=$(wc -l < "$(evidence 04d-thread-messages)")
        {
            echo "--- projection_thread_messages after the syncer's own warm-up (count $WARM_N) ---"
            cat "$(evidence 04d-thread-messages)"
            echo; echo "--- syncer log ---"; tail -4 "$LOGD/t3-sync.log"
        } > "$(evidence 04e-warmup)"
        cat "$(evidence 04e-warmup)" | tee -a "$RUNLOG"

        if [ "$WARM_N" -ge 1 ]; then
            record 4b PASS "the syncer's warm-up turn spawned the bridge; $WARM_N messages in the thread"
        else
            record 4b FAIL "the syncer's warm-up turn was rejected — ${WARMUP_ERR:-no warm-up line in the syncer log}. The thread stays bound and empty, and Plan() finds @t3_thread stamped on the next tick so it never retries."
        fi

        # 4c — what the warm-up actually attaches to. This is the question the
        # whole adoption story turns on: does the bridge T3 spawns for this
        # thread land on the SESSION THAT IS ALREADY RUNNING, or somewhere else?
        # The warm-up is re-issued here with the one field the syncer omits, so
        # the answer is about binding rather than about the 400.
        note "dispatching the sentinel warm-up WITH interactionMode, to see what the bridge binds to"
        BEFORE_NAMES=$(tmux_names)
        t3_dispatch thread.turn.start \
            "$(turn_payload "$ADOPT_THREAD" '[terminal-lobby] adopting this session — mirroring its transcript into this thread.')" \
            > "$(evidence 04f-warmup-dispatch)"
        # 20s is enough for T3 to spawn the bridge and for the bridge to decide
        # what it is attaching to, which is the whole question here.
        sleep 20
        BRIDGE_LINES=$(bridges)
        SPAWN_ID=$(bridge_session_id)
        sleep 20
        sweep_sessions
        thread_messages "$ADOPT_THREAD" > "$(evidence 04g-thread-messages)"
        T3_SID=$(t3_sql "SELECT coalesce(provider_session_id,'') FROM projection_thread_sessions WHERE thread_id='$ADOPT_THREAD';")
        NEW_NAMES=$(comm -13 <(printf '%s\n' "$BEFORE_NAMES") <(tmux_names) | tr '\n' ' ')
        {
            echo "the session that is already running : $ADOPT_SESSION, claude uuid $ADOPT_UUID"
            echo "the id T3 spawned the bridge with   : ${SPAWN_ID:-<no single bridge seen>}"
            echo "T3's projection provider_session_id : ${T3_SID:-<not yet written>}"
            echo "ids agree                           : $( [ -n "$SPAWN_ID" ] && [ "$SPAWN_ID" = "$ADOPT_UUID" ] && echo YES || echo NO )"
            echo
            echo "bridge processes (pid, flag, uuid):"; printf '%s\n' "${BRIDGE_LINES:-  none}" | sed 's/^/  /'
            echo
            echo "tmux sessions that appeared during the warm-up: ${NEW_NAMES:-(none)}"
            echo
            echo "claude processes now running under this run's workspace:"
            ps -eo pid= -o args= | grep -F "$ADOPT_WS" | grep -F "$REAL_CLAUDE" | cut -c1-150
            echo
            echo "thread messages (count $(wc -l < "$(evidence 04g-thread-messages)")):"
            cat "$(evidence 04g-thread-messages)"
        } > "$(evidence 04h-binding)"
        cat "$(evidence 04h-binding)" | tee -a "$RUNLOG"

        PING_OK=$(count_in 'PING' "$(evidence 04g-thread-messages)")
        if [ "$SPAWN_ID" = "$ADOPT_UUID" ] && [ "$PING_OK" -ge 1 ]; then
            record 4c PASS "the bridge attached to the running session and replayed its history, PING included"
        elif [ -n "$SPAWN_ID" ] && [ "$SPAWN_ID" != "$ADOPT_UUID" ]; then
            record 4c FAIL "T3 spawned the bridge with --session-id $SPAWN_ID, a uuid it invented, not the adopted conversation $ADOPT_UUID. Nothing in thread.create carries the Claude session id, so T3 treats the thread as new; the bridge finds no binding for that uuid and starts a SECOND claude${NEW_NAMES:+ in a new tmux session: $NEW_NAMES}. Replay lines carrying PING: $PING_OK."
        else
            record 4c FAIL "no bridge seen for the warm-up turn; replay lines carrying PING: $PING_OK"
        fi
    fi
fi

# ============================================================================
# 11 — A THREAD BORN IN T3
#
# Run here, out of numeric order, for two reasons: step 9a deletes this thread
# and kills its session, and — because step 4c shows an adopted thread is not
# bound to its conversation — this is the only path that produces a thread and
# a tmux session that agree on a Claude session id. Steps 5 to 9a need such a
# pair to be measuring their own mechanism rather than step 4c's defect.
# ============================================================================
BORN_WS="$WORK/ws/t3e2e-born"; mkdir -p "$BORN_WS"
BORN_SESSION=""; BORN_THREAD=""; BORN_UUID=""

if want 11; then
hdr "11 · a thread created in T3 gets a real tmux session"

    BORN_PROJECT=$(uuid); BORN_THREAD=$(uuid)
    t3_dispatch project.create "$(jq -nc --arg p "$BORN_PROJECT" --arg r "$BORN_WS" \
        '{projectId:$p, title:"t3e2e-born", workspaceRoot:$r}')" > "$(evidence 11a-project)"
    t3_dispatch thread.create "$(jq -nc --arg th "$BORN_THREAD" --arg p "$BORN_PROJECT" \
        '{threadId:$th, projectId:$p, title:"born in t3", modelSelection:{instanceId:"claudeAgent", model:"claude-opus-5"}, runtimeMode:"full-access", branch:null, worktreePath:null}')" \
        > "$(evidence 11b-thread)"
    t3_dispatch thread.turn.start "$(turn_payload "$BORN_THREAD" 'Reply with exactly the word BORN')" \
        > "$(evidence 11c-turn)"

    waitfor 150 "a tmux session to appear for the T3-born thread" session_exists_like 't3e2e-born'
    BORN_SESSION=$(session_matching 't3e2e-born')
    sweep_sessions
    if [ -n "$BORN_SESSION" ]; then
        waitfor 120 "the T3-born session to be stamped" claude_ready "$BORN_SESSION"
        BORN_UUID=$(basename "$(tmux_opt "$BORN_SESSION" @claude_transcript)" .jsonl)
        waitfor 180 "BORN to reach the thread" thread_has "$BORN_THREAD" 'BORN'
        pane_text "$BORN_SESSION" 30 > "$(evidence 11d-pane)"
    fi
    sleep 10     # let the syncer see the new session and decide about its name
    t3_snapshot > "$(evidence 11e-snapshot)"
    T3_BORN_SID=$(t3_sql "SELECT coalesce(provider_session_id,'') FROM projection_thread_sessions WHERE thread_id='$BORN_THREAD';")
    BORN_SPAWN_ID=$(bridge_session_id)
    BORN_CURSOR=$(thread_resume_cursor "$BORN_THREAD")
    [ -n "$T3_BORN_SID" ] || T3_BORN_SID=$BORN_CURSOR
    [ -n "$T3_BORN_SID" ] || T3_BORN_SID=$BORN_SPAWN_ID
    BORN_TITLE=$(jq -r --arg t "$BORN_THREAD" '[.threads[]|select(.id==$t)|.title] | first // "?"' "$(evidence 11e-snapshot)")
    {
        echo "thread created in T3     : $BORN_THREAD (title '$BORN_TITLE')"
        echo "tmux session that appeared: ${BORN_SESSION:-<none>}"
        echo "claude uuid in that pane : ${BORN_UUID:-<none>}"
        echo "id T3 spawned the bridge with: ${BORN_SPAWN_ID:-<none>}"
        echo "T3's resume cursor       : ${BORN_CURSOR:-<none>}  (provider_session_runtime.resume_cursor_json)"
        echo "T3's provider_session_id : ${T3_BORN_SID:-<none>}"
        echo "ids agree                : $( [ -n "$BORN_UUID" ] && [ "$BORN_UUID" = "$T3_BORN_SID" ] && echo YES || echo NO )"
        echo
        echo "bridge processes (pid, flag, uuid):"; bridges | sed 's/^/  /'
        echo
        echo "claude argv in the pane:"
        ps -eo pid,args | grep -F -- "--session-id ${BORN_UUID:-nope}" | grep -v grep | cut -c1-200
        echo
        echo "--- pane ---"; tail -14 "$(evidence 11d-pane)" 2>/dev/null
        echo
        echo "--- thread messages ---"; thread_messages "$BORN_THREAD" | tail -6
        echo
        echo "--- projection_thread_sessions ---"; thread_session "$BORN_THREAD"
        echo
        echo "decision 7's other half: the thread title is '$BORN_TITLE' and the session is"
        echo "'${BORN_SESSION:-none}'. CONTRACT.md §9.4 records the T3-title→tmux-rename"
        echo "direction as unimplemented (TmuxAPI.Rename has no caller); the session name comes"
        echo "from Slug(basename(workspace root)) in main.go protoOpenSide, not from the title."
        echo
        echo "threads under this project (a second one would mean the syncer re-adopted it):"
        jq -c --arg p "$BORN_PROJECT" '.threads[] | select(.projectId==$p) | {id,title}' "$(evidence 11e-snapshot)"
        echo "@t3_thread on the session: '$(tmux_opt "${BORN_SESSION:-none}" @t3_thread)'"
        echo "--- binding index ---"; cat "$INDEX_JSON" 2>/dev/null
    } > "$(evidence 11f-summary)"
    cat "$(evidence 11f-summary)" | tee -a "$RUNLOG"

    BORN_MSG=$(thread_messages "$BORN_THREAD" 2>/dev/null | grep -c BORN)
    if [ -n "$BORN_SESSION" ] && [ "$BORN_MSG" -ge 1 ] && [ "$BORN_UUID" = "$T3_BORN_SID" ]; then
        record 11 PASS "tmux session '$BORN_SESSION' appeared running claude $BORN_UUID — the id T3 recorded as provider_session_id — and the answer reached the thread. The session name comes from the workspace root, not the thread title; the title→tmux rename half of decision 7 is unimplemented."
    elif [ -n "$BORN_SESSION" ] && [ "$BORN_MSG" -ge 1 ]; then
        record 11 PARTIAL "session '$BORN_SESSION' came up and answered, but tmux uuid=$BORN_UUID vs T3 provider_session_id=$T3_BORN_SID"
    else
        record 11 FAIL "session='${BORN_SESSION:-none}' answers-in-thread=$BORN_MSG t3-session-id=${T3_BORN_SID:-none}"
    fi
fi

# The pair steps 5-9a drive. The T3-born thread when there is one, because it is
# the only pair whose two halves agree on a session id; the adopted one
# otherwise, so a run with --only still exercises something.
DRIVEN_SESSION=${BORN_SESSION:-$ADOPT_SESSION}
DRIVEN_THREAD=${BORN_THREAD:-$ADOPT_THREAD}
DRIVEN_UUID=${BORN_UUID:-$ADOPT_UUID}
note "steps 5-9a drive: session '$DRIVEN_SESSION', thread '$DRIVEN_THREAD', uuid '$DRIVEN_UUID'"

# ============================================================================
# 5 — DRIVE FROM T3
# ============================================================================
if want 5 && [ -n "$DRIVEN_THREAD" ]; then
hdr "5 · a turn started in T3 reaches the pty"

    t3_dispatch thread.turn.start "$(turn_payload "$DRIVEN_THREAD" 'Reply with exactly the word PONG')" \
        > "$(evidence 05a-dispatch)"
    waitfor 90 "the prompt to appear in the pane" pane_has "$DRIVEN_SESSION" 'exactly the word PONG'
    pane_text "$DRIVEN_SESSION" 45 > "$(evidence 05b-pane)"
    note "--- pane after the T3-initiated turn ---"; tail -14 "$(evidence 05b-pane)" | tee -a "$RUNLOG"

    waitfor 150 "Claude's PONG to come back as an assistant message" thread_has_assistant "$DRIVEN_THREAD" 'PONG'
    thread_messages "$DRIVEN_THREAD" > "$(evidence 05c-thread-messages)"
    assistant_messages "$DRIVEN_THREAD" > "$(evidence 05d-assistant-messages)"
    {
        echo "--- every message on the thread, with its role ---"
        t3_sql "SELECT role || ' | ' || substr(replace(text,char(10),' '),1,140) FROM projection_thread_messages WHERE thread_id='$DRIVEN_THREAD' ORDER BY created_at;"
        echo
        echo "--- assistant messages only (the half the bridge is responsible for) ---"
        cat "$(evidence 05d-assistant-messages)"; echo "(count $(wc -l < "$(evidence 05d-assistant-messages)"))"
        echo
        echo "--- turns ---"; thread_turns "$DRIVEN_THREAD"
        echo "--- session last_error ---"; thread_last_error "$DRIVEN_THREAD"
        echo "--- activities ---"; thread_activities "$DRIVEN_THREAD"
    } > "$(evidence 05e-summary)"
    cat "$(evidence 05e-summary)" | tee -a "$RUNLOG"

    PTY_OK=$(count_in 'exactly the word PONG' "$(evidence 05b-pane)")
    ASSIST_OK=$(count_in 'PONG' "$(evidence 05d-assistant-messages)")
    if [ "$PTY_OK" -ge 1 ] && [ "$ASSIST_OK" -ge 1 ]; then
        record 5 PASS "capture-pane shows the T3 prompt arriving in the pty of $DRIVEN_SESSION, and Claude's answer came back as an assistant message in the thread"
    elif [ "$PTY_OK" -ge 1 ]; then
        record 5 FAIL "the prompt reached the pty and Claude answered in the pane, but NO assistant message reached the thread — the T3→tmux direction works and the tmux→T3 direction does not (session last_error: '$(thread_last_error "$DRIVEN_THREAD")')"
    else
        record 5 FAIL "the prompt never appeared in the pane; assistant messages in the thread: $ASSIST_OK"
    fi
elif want 5; then
    record 5 SKIP "no thread to drive"
fi

# ============================================================================
# 6 — LIVE MIRRORING (out of turn)
# ============================================================================
if want 6 && [ -n "$DRIVEN_THREAD" ]; then
hdr "6 · a prompt typed in the terminal shows up in the thread"

    BEFORE_N=$(t3_sql "SELECT count(*) FROM projection_thread_messages WHERE thread_id='$DRIVEN_THREAD';")
    ps -eo pid,args | grep "$BIN/tl-t3-bridge" | grep -v grep | cut -c1-120 > "$(evidence 06a-bridges)"
    note "bridges alive: $(wc -l < "$(evidence 06a-bridges)")"

    type_prompt "$DRIVEN_SESSION" "Reply with exactly the word MIRROR"
    waitfor 120 "MIRROR to come back in the pane" pane_has "$DRIVEN_SESSION" 'MIRROR'
    pane_text "$DRIVEN_SESSION" 40 > "$(evidence 06b-pane)"
    waitfor 150 "MIRROR to reach the thread with no T3 turn behind it" thread_has_assistant "$DRIVEN_THREAD" 'MIRROR'
    AFTER_N=$(t3_sql "SELECT count(*) FROM projection_thread_messages WHERE thread_id='$DRIVEN_THREAD';")
    thread_messages "$DRIVEN_THREAD" > "$(evidence 06c-thread-messages)"
    {
        echo "nothing was dispatched to T3 for this turn — it was typed into the pane."
        echo "messages before: $BEFORE_N   after: $AFTER_N"
        echo "--- tail ---"; tail -6 "$(evidence 06c-thread-messages)"
        echo "--- activities tail ---"; thread_activities "$DRIVEN_THREAD" | tail -6
    } > "$(evidence 06d-summary)"
    cat "$(evidence 06d-summary)" | tee -a "$RUNLOG"

    assistant_messages "$DRIVEN_THREAD" > "$(evidence 06e-assistant-messages)"
    if grep -q MIRROR "$(evidence 06e-assistant-messages)"; then
        record 6 PASS "typed in the pane only; Claude's reply reached the thread out of turn ($BEFORE_N → $AFTER_N messages)"
    else
        record 6 FAIL "the pane answered MIRROR but no assistant message reached the thread ($BEFORE_N → $AFTER_N messages, $(wc -l < "$(evidence 06e-assistant-messages)") of them from the assistant)"
    fi
elif want 6; then
    record 6 SKIP "no thread to drive"
fi

# ============================================================================
# 7 — INTERRUPT
# ============================================================================
if want 7 && [ -n "$DRIVEN_THREAD" ]; then
hdr "7 · interrupting a turn from T3"

    t3_dispatch thread.turn.start "$(turn_payload "$DRIVEN_THREAD" 'Count from 1 to 400, one number per line, and do not stop early.')" \
        > "$(evidence 07a-start)"
    waitfor 90 "the long turn to start running" state_is "$DRIVEN_SESSION" running
    sleep 5
    pane_text "$DRIVEN_SESSION" 25 > "$(evidence 07b-pane-running)"

    t3_dispatch thread.turn.interrupt "$(jq -nc --arg th "$DRIVEN_THREAD" '{threadId:$th}')" \
        > "$(evidence 07c-interrupt)"
    waitfor 60 "the turn to settle after the interrupt" state_not "$DRIVEN_SESSION" running
    sleep 3
    pane_text "$DRIVEN_SESSION" 35 > "$(evidence 07d-pane-interrupted)"
    STATE_AFTER=$(tmux_opt "$DRIVEN_SESSION" @claude_state)
    {
        echo "--- pane while the turn was running ---"; tail -8 "$(evidence 07b-pane-running)"
        echo
        echo "interrupt dispatch -> $(cat "$(evidence 07c-interrupt)")"
        echo "@claude_state after the interrupt: '$STATE_AFTER'"
        echo "--- pane after ---"; tail -16 "$(evidence 07d-pane-interrupted)"
        echo "--- last thread messages ---"; thread_messages "$DRIVEN_THREAD" | tail -3
    } > "$(evidence 07e-summary)"
    cat "$(evidence 07e-summary)" | tee -a "$RUNLOG"

    # What an interrupt looks like from outside: @claude_state leaves "running"
    # (the bridge's Cancel re-derives it, because Ctrl-C never fires the Stop
    # hook), and Claude Code puts the cancelled prompt BACK on its input line.
    # The signature Claude Code itself leaves is the "[Request interrupted by
    # user]" record in the transcript, which is what sessionio.InterruptNotice
    # keys on and what the bridge mirrors upward. Checking that rather than the
    # pane's wording keeps this from breaking on a TUI restyle.
    NOTICE=$(count_in 'Request interrupted by user' "$LOGD/bridge.stdout.jsonl")
    PROMPT_BACK=$(count_in 'Count from 1 to 400' "$(evidence 07d-pane-interrupted)")
    if [ "$STATE_AFTER" != running ] && [ "$NOTICE" -ge 1 ]; then
        record 7 PASS "the interrupt reached the pty: @claude_state went running → '$STATE_AFTER' and the bridge mirrored Claude's own '[Request interrupted by user]' record upward"
    elif [ "$STATE_AFTER" != running ]; then
        record 7 PARTIAL "@claude_state went running → '$STATE_AFTER', but no interrupt notice crossed the wire (prompt-back-on-input-line: $PROMPT_BACK)"
    else
        record 7 FAIL "@claude_state stayed '$STATE_AFTER' after thread.turn.interrupt"
    fi
elif want 7; then
    record 7 SKIP "no thread to drive"
fi

# ============================================================================
# 8 — RESURRECTION
# ============================================================================
if want 8 && [ -n "$DRIVEN_THREAD" ]; then
hdr "8 · a turn against a session that is gone brings it back"

    UUID_BEFORE=$(basename "$(tmux_opt "$DRIVEN_SESSION" @claude_transcript)" .jsonl)
    BEFORE_NAMES=$(tmux_names)
    kill_e2e_session "$DRIVEN_SESSION"
    sleep 3
    tmux_names > "$(evidence 08a-tmux-after-kill)"
    note "killed $DRIVEN_SESSION directly (no tmux-api, so nothing crosses); alive=$(tmux_alive "$DRIVEN_SESSION" && echo yes || echo no)"

    t3_dispatch thread.turn.start "$(turn_payload "$DRIVEN_THREAD" 'Reply with exactly the word BACK')" \
        > "$(evidence 08b-dispatch)"
    waitfor 180 "a tmux session to come back for this conversation" session_exists_like "$DRIVEN_SESSION"
    RESURRECTED=$(session_matching "$DRIVEN_SESSION")
    sweep_sessions
    note "resurrected as: ${RESURRECTED:-<nothing>}"

    UUID_AFTER=""
    if [ -n "$RESURRECTED" ]; then
        waitfor 120 "the resurrected session to be stamped" claude_ready "$RESURRECTED"
        UUID_AFTER=$(basename "$(tmux_opt "$RESURRECTED" @claude_transcript)" .jsonl)
        waitfor 180 "BACK to reach the same thread" thread_has "$DRIVEN_THREAD" 'BACK'
        pane_text "$RESURRECTED" 40 > "$(evidence 08c-pane)"
    fi
    {
        echo "tmux ls right after the kill:"; grep -c . "$(evidence 08a-tmux-after-kill)"
        grep "$DRIVEN_SESSION" "$(evidence 08a-tmux-after-kill)" || echo "  ($DRIVEN_SESSION absent, as expected)"
        echo
        echo "session before : $DRIVEN_SESSION   claude uuid $UUID_BEFORE"
        echo "session after  : ${RESURRECTED:-none}   claude uuid ${UUID_AFTER:-none}"
        echo "same uuid      : $( [ -n "$UUID_AFTER" ] && [ "$UUID_AFTER" = "$UUID_BEFORE" ] && echo YES || echo NO )"
        echo "new names during the resurrection: $(comm -13 <(printf '%s\n' "$BEFORE_NAMES") <(tmux_names) | tr '\n' ' ')"
        echo
        echo "claude argv in the resurrected pane:"
        ps -eo pid,args | grep -F -- "$UUID_BEFORE" | grep -F claude | grep -v grep | cut -c1-200
        echo
        echo "--- pane ---"; tail -14 "$(evidence 08c-pane)" 2>/dev/null
        echo "--- thread messages tail ---"; thread_messages "$DRIVEN_THREAD" | tail -5
        echo
        echo "binding index AFTER the resurrection (threadId is the field to watch):"
        cat "$INDEX_JSON" 2>/dev/null
        echo "@t3_thread on the resurrected session: '$(tmux_opt "${RESURRECTED:-none}" @t3_thread)'"
    } > "$(evidence 08d-summary)"
    cat "$(evidence 08d-summary)" | tee -a "$RUNLOG"

    BRIDGE_ERR=$(grep -c 'send failed' "$LOGD/bridge.stderr.log")
    if [ -n "$RESURRECTED" ] && [ "$UUID_AFTER" = "$UUID_BEFORE" ] && thread_has_assistant "$DRIVEN_THREAD" 'BACK'; then
        record 8 PASS "the session came back as '$RESURRECTED' resuming $UUID_BEFORE, and the answer landed in the same thread $DRIVEN_THREAD"
    elif [ "$BRIDGE_ERR" -ge 1 ]; then
        record 8 FAIL "no session came back. T3 routed the new turn to the bridge process it ALREADY had for this thread, and that bridge is still bound to the session that just died: it sent to a gone pane, logged 'send failed: exit status 1' and reported error_during_execution into the thread. Resurrection lives in the bridge's STARTUP path (protoOpenSide), so it can only happen on a spawn — and a live provider session means there is no spawn."
    else
        record 8 FAIL "resurrected='${RESURRECTED:-none}' uuid before=$UUID_BEFORE after=${UUID_AFTER:-none}"
    fi

    # 8b — the same prompt again, after telling T3 to drop the provider session.
    # If resurrection only needs a fresh spawn, this is the difference between a
    # broken decision 10 and a decision 10 that needs one more signal.
    if [ -z "$RESURRECTED" ]; then
        note "8b: dispatching thread.session.stop, then the same turn again"
        t3_dispatch thread.session.stop "$(jq -nc --arg th "$DRIVEN_THREAD" '{threadId:$th}')" > "$(evidence 08e-session-stop)"
        sleep 5
        t3_dispatch thread.turn.start "$(turn_payload "$DRIVEN_THREAD" 'Reply with exactly the word BACK')" \
            > "$(evidence 08f-retry)"
        waitfor 180 "a session to come back after the provider session was stopped" \
            session_exists_like "$DRIVEN_SESSION"
        RESURRECTED=$(session_matching "$DRIVEN_SESSION")
        sweep_sessions
        if [ -n "$RESURRECTED" ]; then
            waitfor 120 "the resurrected session to be stamped" claude_ready "$RESURRECTED"
            UUID_AFTER=$(basename "$(tmux_opt "$RESURRECTED" @claude_transcript)" .jsonl)
            waitfor 180 "BACK to reach the same thread" thread_has_assistant "$DRIVEN_THREAD" 'BACK'
            pane_text "$RESURRECTED" 30 > "$(evidence 08g-pane)"
        fi
        {
            echo "thread.session.stop -> $(cat "$(evidence 08e-session-stop)")"
            echo "turn.start          -> $(cat "$(evidence 08f-retry)")"
            echo "session after       : ${RESURRECTED:-none}   claude uuid ${UUID_AFTER:-none}"
            echo "same uuid as before : $( [ -n "$UUID_AFTER" ] && [ "$UUID_AFTER" = "$UUID_BEFORE" ] && echo YES || echo NO )"
            echo "claude argv:"; ps -eo pid= -o args= | grep -F -- "$UUID_BEFORE" | grep -F claude | cut -c1-190
            echo "--- pane ---"; tail -12 "$(evidence 08g-pane)" 2>/dev/null
            echo "--- assistant messages ---"; assistant_messages "$DRIVEN_THREAD" | tail -3
        } > "$(evidence 08h-after-stop)"
        cat "$(evidence 08h-after-stop)" | tee -a "$RUNLOG"

        if [ -n "$RESURRECTED" ] && [ "$UUID_AFTER" = "$UUID_BEFORE" ]; then
            record 8b PASS "after thread.session.stop the next turn DID resurrect: session '$RESURRECTED' came back on claude --resume $UUID_BEFORE. Resurrection works; what it needs is a spawn, and a live provider session prevents one."
        else
            record 8b FAIL "even after thread.session.stop nothing came back (session='${RESURRECTED:-none}')"
        fi
    fi
    DRIVEN_SESSION=${RESURRECTED:-$DRIVEN_SESSION}
elif want 8; then
    record 8 SKIP "no thread to drive"
fi

# ============================================================================
# 9 — KILL SYMMETRY, both directions
# ============================================================================
if want 9 && [ -n "$DRIVEN_THREAD" ]; then
hdr "9a · deleting the thread in T3 kills the tmux session"

    ALIVE_BEFORE=$(tmux_alive "$DRIVEN_SESSION" && echo yes || echo no)
    if [ "$ALIVE_BEFORE" = no ]; then
        record 9a SKIP "step 8 left no live session for the thread, so a thread.delete would have nothing to kill and a 'gone' answer would prove nothing (tmux-api 404 counts as success on purpose)"
    fi
    t3_dispatch thread.delete "$(jq -nc --arg th "$DRIVEN_THREAD" '{threadId:$th}')" > "$(evidence 09a-delete)"
    waitfor 90 "the syncer to kill $DRIVEN_SESSION" session_gone "$DRIVEN_SESSION"
    ALIVE_AFTER=$(tmux_alive "$DRIVEN_SESSION" && echo yes || echo no)
    BOUND_THREAD=$(bound_thread_for "$DRIVEN_SESSION" "$INDEX_JSON")
    {
        echo "thread.delete -> $(cat "$(evidence 09a-delete)")"
        echo "session $DRIVEN_SESSION alive before=$ALIVE_BEFORE after=$ALIVE_AFTER"
        echo
        echo "thread that was deleted            : $DRIVEN_THREAD"
        echo "thread the index binds the session to: ${BOUND_THREAD:-<none>}"
        echo "  (different = the syncer re-adopted the session into a thread of its own,"
        echo "   and Plan() reads that one, so a delete of the first has nothing to cross)"
        echo
        echo "every thread T3 holds:"
        t3_sql "SELECT substr(thread_id,1,8) || ' | ' || title || ' | archived=' || coalesce(archived_at,'-') || ' | deleted=' || coalesce(deleted_at,'-') FROM projection_threads;"
        echo "the kill goes through the live tmux-api on :7684, which is the lobby's writer of record."
        echo "--- syncer log tail ---"; tail -8 "$LOGD/t3-sync.log"
        echo "--- tmux ls ---"; tmux_names
    } > "$(evidence 09b-summary)"
    cat "$(evidence 09b-summary)" | tee -a "$RUNLOG"
    if [ "$ALIVE_BEFORE" = no ]; then
        : # already recorded SKIP above
    elif [ "$ALIVE_BEFORE" = yes ] && [ "$ALIVE_AFTER" = no ]; then
        record 9a PASS "thread.delete -> the syncer called tmux-api DELETE /sessions/$DRIVEN_SESSION and the session is gone"
    elif [ -n "$BOUND_THREAD" ] && [ "$BOUND_THREAD" != "$DRIVEN_THREAD" ]; then
        record 9a FAIL "$DRIVEN_SESSION survived the delete of thread $DRIVEN_THREAD because the index binds that session to $BOUND_THREAD instead - a thread the SYNCER created by re-adopting it. A bridge-made session is never stamped with @t3_thread, and Bindings.Record writes threadId=\"\" over the pairing on every attach, so the next reconcile sees an unadopted session and makes a second thread for it. The kill path then reads the wrong one."
    else
        record 9a FAIL "alive before=$ALIVE_BEFORE after=$ALIVE_AFTER; the index binds the session to thread '${BOUND_THREAD:-none}' and the deleted thread was $DRIVEN_THREAD"
    fi
fi

if want 9; then
hdr "9b · a lobby kill archives the thread, and never deletes it"

    KILL_SESSION=t3e2e-kill; KILL_WS="$WORK/ws/t3e2e-kill"; mkdir -p "$KILL_WS"
    new_e2e_session "$KILL_SESSION" "$KILL_WS"
    type_prompt "$KILL_SESSION" "claude --dangerously-skip-permissions --model haiku"
    waitfor 120 "the kill-test session's claude to be stamped" claude_ready "$KILL_SESSION"
    waitfor 120 "the syncer to adopt $KILL_SESSION" adopted "$KILL_SESSION"
    KILL_THREAD=$(tmux_opt "$KILL_SESSION" @t3_thread)
    note "adopted as thread ${KILL_THREAD:-<none>}"

    # The producing half: the LIVE tmux-api's DELETE /sessions/<name>, which is
    # what a lobby kill actually is.
    AUTH_USER=$(awk -F= -v u="$USER" '$0 !~ /^#/ && $2 ~ u {print $1; exit}' /etc/ttyd-user-map 2>/dev/null)
    [ -n "$AUTH_USER" ] || AUTH_USER=$USER
    KILL_CODE=$(curl -sS -o "$(evidence 09c-tmuxapi-body)" -w '%{http_code}' \
        -X DELETE "http://127.0.0.1:7684/sessions/$KILL_SESSION" \
        -H "X-Authentik-Username: $AUTH_USER")
    sleep 3
    KILLED=$(tmux_alive "$KILL_SESSION" && echo alive || echo gone)
    note "DELETE /sessions/$KILL_SESSION via the live tmux-api -> HTTP $KILL_CODE; session $KILLED"

    # The consuming half. The DEPLOYED tmux-api predates killnotify.go and sends
    # nothing, so the notice is delivered here in the exact shape CONTRACT §8.2
    # and TestKillNoticeWireMatchesTmuxAPI pin, to exercise the syncer's listener.
    DEPLOYED_NOTIFY=$(strings /usr/local/bin/tmux-api 2>/dev/null | grep -c TL_T3_SYNC_NOTIFY_PORT)
    NOTIFY_CODE=$(curl -sS -o /dev/null -w '%{http_code}' \
        -X POST "http://127.0.0.1:$NOTIFY_PORT/notify/kill" -H 'Content-Type: application/json' \
        -d "$(jq -nc --arg u "$USER" --arg s "$KILL_SESSION" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
              '{osUser:$u, session:$s, killedAt:$at, source:"tmux-api"}')")
    waitfor 60 "the thread to be archived" thread_archived "$KILL_THREAD"
    t3_snapshot > "$(evidence 09e-snapshot)"
    ARCHIVED=$(t3_sql "SELECT coalesce(archived_at,'') FROM projection_threads WHERE thread_id='$KILL_THREAD';")
    DELETED=$(t3_sql "SELECT coalesce(deleted_at,'') FROM projection_threads WHERE thread_id='$KILL_THREAD';")
    {
        echo "PRODUCER: /etc/tl-t3-sync exists: $( [ -d /etc/tl-t3-sync ] && echo yes || echo no )"
        echo "PRODUCER: the deployed /usr/local/bin/tmux-api mentions TL_T3_SYNC_NOTIFY_PORT $DEPLOYED_NOTIFY times"
        echo "          (0 = the kill-notify producer is not in the running build; killnotify.go is new in this commit)"
        echo "tmux-api DELETE -> HTTP $KILL_CODE, session now: $KILLED"
        echo "notice POST /notify/kill -> HTTP $NOTIFY_CODE (CONTRACT §8.2 expects 204)"
        echo
        echo "thread $KILL_THREAD  archived_at='$ARCHIVED'  deleted_at='$DELETED'"
        jq -c --arg t "$KILL_THREAD" '.threads[] | select(.id==$t) | {id,title,archivedAt,deletedAt}' "$(evidence 09e-snapshot)"
        echo "--- syncer log tail ---"; tail -6 "$LOGD/t3-sync.log"
    } > "$(evidence 09f-summary)"
    cat "$(evidence 09f-summary)" | tee -a "$RUNLOG"

    if [ "$KILLED" = gone ] && [ "$NOTIFY_CODE" = 204 ] && [ -n "$ARCHIVED" ] && [ -z "$DELETED" ]; then
        record 9b PASS "lobby kill → notice accepted 204 → thread archived_at=$ARCHIVED, deleted_at empty. The producing half is not in the deployed tmux-api yet ($DEPLOYED_NOTIFY hits), so the notice was delivered by this harness in the pinned wire shape."
    else
        record 9b FAIL "session=$KILLED notify=$NOTIFY_CODE archived_at='$ARCHIVED' deleted_at='$DELETED'"
    fi
fi

# ============================================================================
# 10 — VANISH IS NOT A KILL
# ============================================================================
if want 10; then
hdr "10 · a claude that dies without tmux-api leaves its thread alone"

    OOM_SESSION=t3e2e-oom; OOM_WS="$WORK/ws/t3e2e-oom"; mkdir -p "$OOM_WS"
    new_e2e_session "$OOM_SESSION" "$OOM_WS"
    type_prompt "$OOM_SESSION" "claude --dangerously-skip-permissions --model haiku"
    waitfor 120 "the oom-test session's claude to be stamped" claude_ready "$OOM_SESSION"
    waitfor 120 "the syncer to adopt $OOM_SESSION" adopted "$OOM_SESSION"
    OOM_THREAD=$(tmux_opt "$OOM_SESSION" @t3_thread)
    OOM_UUID=$(basename "$(tmux_opt "$OOM_SESSION" @claude_transcript)" .jsonl)
    note "adopted as thread ${OOM_THREAD:-<none>} (uuid $OOM_UUID)"

    BEFORE_ARCH=$(t3_sql "SELECT coalesce(archived_at,'') FROM projection_threads WHERE thread_id='$OOM_THREAD';")
    BEFORE_DEL=$(t3_sql "SELECT coalesce(deleted_at,'')  FROM projection_threads WHERE thread_id='$OOM_THREAD';")
    OOM_PID=$(pgrep -f -- "--session-id $OOM_UUID" | head -1)
    [ -n "$OOM_PID" ] || OOM_PID=$(tmux list-panes -a -F '#{session_name}'$'\t''#{pane_pid}' | awk -F'\t' -v s="$OOM_SESSION" '$1==s{print $2; exit}')
    note "SIGKILL to pid $OOM_PID — earlyoom's shape exactly: no tmux-api, so no notice"
    kill -9 "$OOM_PID" 2>/dev/null
    sleep 15    # five reconcile ticks at 3s

    AFTER_ARCH=$(t3_sql "SELECT coalesce(archived_at,'') FROM projection_threads WHERE thread_id='$OOM_THREAD';")
    AFTER_DEL=$(t3_sql "SELECT coalesce(deleted_at,'')  FROM projection_threads WHERE thread_id='$OOM_THREAD';")
    STILL=$(tmux_alive "$OOM_SESSION" && echo yes || echo no)
    {
        echo "thread $OOM_THREAD"
        echo "before the SIGKILL : archived_at='$BEFORE_ARCH' deleted_at='$BEFORE_DEL'"
        echo "after  the SIGKILL : archived_at='$AFTER_ARCH' deleted_at='$AFTER_DEL'"
        echo "tmux session still listed: $STILL"
        echo "binding index still holds the pairing (a resurrection needs it):"
        cat "$INDEX_JSON" 2>/dev/null | grep -A4 "$OOM_UUID" || echo "  (entry absent)"
        echo "--- syncer log tail: no archive line for this thread ---"
        tail -12 "$LOGD/t3-sync.log"
    } > "$(evidence 10-summary)"
    cat "$(evidence 10-summary)" | tee -a "$RUNLOG"

    if [ -z "$AFTER_ARCH" ] && [ -z "$AFTER_DEL" ]; then
        record 10 PASS "claude SIGKILLed outside tmux-api: thread $OOM_THREAD still archived_at empty, deleted_at empty — the death crossed nothing"
    else
        record 10 FAIL "the thread moved on a non-kill: archived_at='$AFTER_ARCH' deleted_at='$AFTER_DEL'"
    fi
    tmux_alive "$OOM_SESSION" && kill_e2e_session "$OOM_SESSION"
fi

# ============================================================================
# 12 — NO COLLATERAL DAMAGE
# ============================================================================
hdr "12 · nothing of the box's own was touched"

stop_syncer
sweep_sessions
for s in ${CLEAN_SESSIONS+"${CLEAN_SESSIONS[@]}"}; do
    tmux_alive "$s" && kill_e2e_session "$s"
done
sleep 3
tmux_names > "$WORK/tmux-final.txt"
find "$LIVE_T3" -printf '%T@ %p\n' 2>/dev/null | sort > "$WORK/livet3-final.txt"

# The live t3-serve on :3773 is a running daemon that appends to its own trace
# log the whole time, with or without this run. Its log directory is reported
# but not judged; every other path under the live base dir is.
LIVE_STATE_TOUCHED=$(find "$LIVE_T3" -newermt "$RUN_START" -type f 2>/dev/null | grep -vc '/userdata/logs/')
{
    echo "--- tmux sessions: baseline vs final (diff must be empty) ---"
    diff "$WORK/tmux-baseline.txt" "$WORK/tmux-final.txt" && echo "(identical: $(wc -l < "$WORK/tmux-final.txt") sessions)"
    echo
    echo "--- every tmux session this run created, and how it ended ---"
    for s in ${CLEAN_SESSIONS+"${CLEAN_SESSIONS[@]}"}; do
        printf '  %-16s %s\n' "$s" "$(tmux_alive "$s" && echo 'STILL ALIVE — leak' || echo gone)"
    done
    echo
    echo "--- $LIVE_T3: any path whose mtime moved during the run ---"
    diff "$WORK/livet3-baseline.txt" "$WORK/livet3-final.txt" && echo "(identical: $(wc -l < "$WORK/livet3-final.txt") paths, no mtime moved)"
    echo
    echo "--- everything under $LIVE_T3 written since the run started ---"
    find "$LIVE_T3" -newermt "$RUN_START" -type f -printf '%TY-%Tm-%Td %TH:%TM:%TS %p\n' 2>/dev/null | sort | head -20
    echo "(the live t3-serve on :3773 appends to userdata/logs/*.ndjson on its own schedule;"
    echo " state files OUTSIDE userdata/logs/ written during the run: $LIVE_STATE_TOUCHED)"
} > "$(evidence 12-collateral)"
cat "$(evidence 12-collateral)" | tee -a "$RUNLOG"

TMUX_SAME=$(diff -q "$WORK/tmux-baseline.txt" "$WORK/tmux-final.txt" >/dev/null && echo yes || echo no)
if [ "$TMUX_SAME" = yes ] && [ "$LIVE_STATE_TOUCHED" -eq 0 ]; then
    record 12 PASS "$BASELINE_N pre-existing tmux sessions unchanged by name and count; every t3e2e-* session this run made is gone; 0 state files under $LIVE_T3 written since $RUN_START"
else
    record 12 FAIL "tmux identical=$TMUX_SAME; $LIVE_STATE_TOUCHED state files under $LIVE_T3 modified during the run"
fi

# ============================================================================
# The seam itself — what actually crossed between T3 and the bridge
# ============================================================================
hdr "the wire, as captured by the tap"
{
    echo "T3 -> bridge ($(grep -c . "$LOGD/bridge.stdin.jsonl" 2>/dev/null || echo 0) lines):"
    cut -c1-200 "$LOGD/bridge.stdin.jsonl" 2>/dev/null | sed 's/^/  /'
    echo
    echo "bridge -> T3 ($(grep -c . "$LOGD/bridge.stdout.jsonl" 2>/dev/null || echo 0) lines):"
    cut -c1-300 "$LOGD/bridge.stdout.jsonl" 2>/dev/null | sed 's/^/  /'
    echo
    echo "frame types the bridge emitted, by count:"
    jq -r '.type' "$LOGD/bridge.stdout.jsonl" 2>/dev/null | sort | uniq -c | sed 's/^/  /'
    echo
    echo "bridge stderr:"; sed 's/^/  /' "$LOGD/bridge.stderr.log" 2>/dev/null | tail -40
} > "$(evidence 99-wire)"
cat "$(evidence 99-wire)" | tee -a "$RUNLOG"

# ------------------------------------------------------------- the table ----
hdr "results"
printf '%-6s %-8s %s\n' STEP RESULT EVIDENCE | tee -a "$RUNLOG"
sort -V "$RESULTS" | while IFS=$'\t' read -r step result summary; do
    printf '%-6s %-8s %s\n' "$step" "$result" "$summary"
done | tee -a "$RUNLOG"
note ""
note "evidence  $EV"
note "logs      $LOGD"
note "transcript of this run: $RUNLOG"
grep -qE $'\tFAIL\t' "$RESULTS" && exit 1
exit 0
