#!/bin/sh
# The format ratchet. Formatting is checked on the files this branch changed,
# never tree-wide.
#
# Why a ratchet: `biome format --write` over the whole tree rewrites 5,498 lines
# across 260 of 409 files, and every one of those 260 has a commit in the last
# 90 days. A sweep would put one reformatting commit on top of all of them and
# cost every `git blame` in the repo. The ratchet reaches the same end state
# inside a quarter for free, because the files people touch are the files that
# get formatted.
#
# If someone later insists on the sweep anyway, it belongs on the
# wizard/native-parity branch or after that merges, never on master while it is
# open, and the sweep's sha goes in ../.git-blame-ignore-revs.
#
# Who runs this: you do, before you open a PR. No workflow runs it. The only
# workflow in this repo triggers on pushes to master, where the base below
# resolves to the commit being built and the check has nothing to compare, so a
# step there would pass on everything while reading like a gate. See
# CONTRIBUTING.md. TL_FORMAT_SINCE is the hook for wiring it up for real: a job
# that can name the base ref of the change it is building (a pull_request
# workflow's merge base, or a push event's `before` sha) sets it and gets a
# check that means something.
set -eu

SINCE="${TL_FORMAT_SINCE:-origin/master}"

# Shallow clones often have no origin/master. Fetch it if we can; if we cannot,
# format nothing rather than failing somebody's build over a missing ref.
git fetch --no-tags --quiet origin master 2>/dev/null || true

if ! git rev-parse --verify --quiet "$SINCE" >/dev/null 2>&1; then
  echo "format:changed: no $SINCE to compare against, nothing checked."
  exit 0
fi

# --no-errors-on-unmatched: a branch that changed nothing under src/test/public
# leaves biome with an empty file list, which it treats as an error and exits 1
# for. Zero files to check is a pass here, not a failure.
if ./node_modules/.bin/biome check --changed --since="$SINCE" \
  --no-errors-on-unmatched --linter-enabled=false src test public; then
  exit 0
fi

cat >&2 <<MSG

format:changed failed. Fix it with:

    cd frontend-v2 && npx biome check --changed --since="${SINCE}" --linter-enabled=false --write src test public

That formats only the files this branch changed. Do not run a tree-wide
\`biome format --write\`: it rewrites 260 of 409 files and takes git blame with it.
MSG
exit 1
