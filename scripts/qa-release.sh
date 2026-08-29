#!/usr/bin/env bash
# qa-release.sh — land ONE fix lane and ship it, serialized. Ships to prod:
# the terminal-dev canary was retired 2026-08-16 and there is one tier now.
#
# The QA→fix loop runs lanes in parallel worktrees but releases per lane, so
# without a mutex two lanes would merge and push over each
# other's build. Every lane calls this; flock makes them queue.
#
# It also enforces the release scope the plan fixed
# (docs/plans/2026-08-06-dev-tier-qa-fix-loop.md, decision 2): the SPA,
# session-events and file-api may ship unattended because the vanilla tier
# never calls them. A lane touching tmux-api, clipboard-upload or ttyd is
# LANDED but NOT deployed — those are shared with terminal.viktorbarzin.me and
# with bob/carol, and need Viktor's explicit go.
#
# Usage:
#   scripts/qa-release.sh <branch>            # merge, gate, push, deploy
#   scripts/qa-release.sh <branch> --no-push  # rehearse everything but the push
set -euo pipefail

BRANCH="${1:?usage: qa-release.sh <branch> [--no-push]}"
NO_PUSH=""
[[ "${2:-}" == "--no-push" ]] && NO_PUSH=1

REPO="${QA_REPO:-/home/wizard/code/terminal-lobby}"
LOCK="${QA_RELEASE_LOCK:-/tmp/qa-release.lock}"
LOG_PREFIX="[qa-release ${BRANCH}]"

log() { echo "${LOG_PREFIX} $*"; }
die() { echo "${LOG_PREFIX} FAILED: $*" >&2; exit 1; }
# Indented list output. NOT `sed "s/^/${LOG_PREFIX}   /"`: every lane branch is
# wizard/<topic>, and that slash closes sed's s/// early — the whole script then
# died on the first list it tried to print, under `set -o pipefail`.
# `return 0`: a blank final line would leave the loop's status at 1 and `set -e`
# would kill the script on a purely cosmetic print.
log_list() { while IFS= read -r _l; do [[ -n "$_l" ]] && log "  $_l"; done <<<"$1"; return 0; }

exec 9>"$LOCK"
log "waiting for the release lock…"
flock 9
log "holding the release lock"

cd "$REPO"

# The main checkout is the landing surface; all lane work happens in worktrees,
# so it must be clean. Refuse rather than stash someone else's work.
[[ -z "$(git status --porcelain)" ]] || die "main checkout is dirty — refusing to land"

git fetch -q origin
git checkout -q master
git pull -q --ff-only origin master || die "master is not fast-forwardable"

git rev-parse --verify -q "$BRANCH" >/dev/null || die "no such branch: $BRANCH"

# What does this lane touch? Decides both the gates and the release scope.
#
# THREE dots, deliberately. For git diff, master..BRANCH is tip-to-tip, so a
# branch that is merely BEHIND master is charged with the reversal of everything
# master gained meanwhile. That is not cosmetic: SHARED_HITS is computed from
# this set, so a lane that branched before a clipboard-upload/ or tmux-api/
# landing would match it, print "NOT DEPLOYING - this lane touches shared
# components", and exit 0 looking like a correct policy decision while quietly
# shipping nothing. master...BRANCH asks the merge-base question we actually
# mean: what did THIS lane change?
CHANGED=$(git diff --name-only master..."$BRANCH")
[[ -n "$CHANGED" ]] || die "branch has no changes against master"
log "changed files:"; log_list "$CHANGED"

touches() { echo "$CHANGED" | grep -qE "$1"; }

SHARED_HITS=$(echo "$CHANGED" | grep -E '^(tmux-api|clipboard-upload)/|^devvm/ttyd(\.service|-ro\.service|-local\.patch)' || true)

log "merging into master"
git merge -q --no-ff "$BRANCH" -m "merge($BRANCH): dev-tier QA fix loop" \
  || die "merge conflict — lane partitioning let two lanes share a file"

# ---- gates -----------------------------------------------------------------
if touches '^frontend-v2/'; then
  log "gate: frontend-v2 typecheck + vitest"
  ( cd frontend-v2 && npm run -s typecheck ) || die "tsc --noEmit"
  ( cd frontend-v2 && npm test -- --run ) || die "vitest"
fi
for svc in tmux-api clipboard-upload session-events file-api; do
  if touches "^${svc}/"; then
    log "gate: go test ./${svc}"
    ( cd "$svc" && go test ./... ) || die "go test in ${svc}"
  fi
done
if touches '^scripts/.*\.py$'; then
  log "gate: harness guard tests"
  python3 -m pytest scripts/test_qa_harness.py -q || die "guard tests"
fi
if touches '^scripts/.*\.sh$'; then
  log "gate: shell syntax"
  for s in $(echo "$CHANGED" | grep -E '^scripts/.*\.sh$'); do
    bash -n "$s" || die "bash -n $s"
  done
fi

# ---- push ------------------------------------------------------------------
if [[ -n "$NO_PUSH" ]]; then
  log "--no-push: leaving the merge local"
else
  log "pushing master"
  if ! git push -q origin HEAD:master; then
    log "push rejected (another lane landed first) — rebasing onto origin/master"
    git pull -q --rebase origin master || die "rebase onto origin/master"
    git push -q origin HEAD:master || die "push after rebase"
  fi
fi

# ---- release ---------------------------------------------------------------
if [[ -n "$SHARED_HITS" ]]; then
  log "NOT DEPLOYING — this lane touches shared components:"
  log_list "$SHARED_HITS"
  log "landed on master; deploying it needs Viktor's explicit go (plan decision 2)"
  exit 0
fi

# Deployment is no longer this script's job. A push to master builds the
# package and the box installs it (docs/adr/0013), so landing IS releasing and
# a second path here would race the first — which is the collision the mutex
# above was added for.
#
# What is still worth saying is whether this lane changed anything the box will
# actually ship, so the operator knows whether to expect a release.
if touches '^(frontend-v2|frontend|session-events|file-api|skills-api|tmux-api|clipboard-upload|devvm|packaging|release)/'; then
  log "landed; the package pipeline will build and the box will install it"
  log "watch: gh run list --repo ViktorBarzin/terminal-lobby --workflow=release --limit 1"
else
  log "nothing deployable changed (docs/tests/harness only) — landed, no release"
fi
log "done"
