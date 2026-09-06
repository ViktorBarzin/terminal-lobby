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
set -eu

# Shallow CI clones often have no origin/master. Fetch it if we can; if we
# cannot, format nothing rather than failing somebody's release over a missing
# ref.
git fetch --no-tags --quiet origin master 2>/dev/null || true

if ! git rev-parse --verify --quiet origin/master >/dev/null 2>&1; then
  echo "format:changed: no origin/master to compare against, nothing checked."
  exit 0
fi

if ./node_modules/.bin/biome check --changed --since=origin/master \
  --linter-enabled=false src test public; then
  exit 0
fi

cat >&2 <<'MSG'

format:changed failed. Fix it with:

    cd frontend-v2 && npx biome check --changed --since=origin/master --linter-enabled=false --write src test public

That formats only the files this branch changed. Do not run a tree-wide
`biome format --write`: it rewrites 260 of 409 files and takes git blame with it.
MSG
exit 1
