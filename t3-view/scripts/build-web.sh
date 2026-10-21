#!/usr/bin/env bash
# Builds T3 Code's web client at the pinned tag, with t3-view/patches applied,
# and prepares the pinned checkout the sidecar is bundled against.
#
#   build-web.sh <work-dir>              extract, patch, install, build apps/web
#   build-web.sh --deps-only <work-dir>  extract, patch, install (no web build)
#   build-web.sh --print-key             print the artefact key and exit
#
# Output, under <work-dir>:
#   t3/        the pinned checkout with node_modules (link-t3.sh points at it)
#   web/       the built apps/web/dist, plus BUILD_KEY naming what built it
#
# Environment:
#   T3_REPO         git URL or local clone to fetch the tag from
#                   (default: the repo= line of T3_PIN)
#   PNPM_STORE_DIR  pnpm store to reuse (optional)
#
# CI runs exactly this script (t3-web.yml). Nothing here is devvm-specific.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pin_file="$here/T3_PIN"

pin_value() {
	sed -n "s/^$1=//p" "$pin_file" | head -n1
}

tag="$(pin_value tag)"
commit="$(pin_value commit)"
repo="${T3_REPO:-$(pin_value repo)}"
if [[ -z "$tag" || -z "$commit" || -z "$repo" ]]; then
	echo "build-web: T3_PIN must name tag=, commit= and repo=" >&2
	exit 1
fi

# The artefact key: the pinned commit plus a digest of every patch, so a new
# pin or an edited patch builds a new artefact and nothing else does.
patch_digest() {
	local files=("$here"/patches/*.patch)
	if [[ -e "${files[0]}" ]]; then
		cat "${files[@]}" | sha256sum | cut -c1-16
	else
		echo "nopatch"
	fi
}
key="${commit}-$(patch_digest)"

deps_only=0
case "${1:-}" in
--print-key)
	echo "$key"
	exit 0
	;;
--deps-only)
	deps_only=1
	shift
	;;
esac

work="${1:?usage: build-web.sh [--deps-only] <work-dir>}"
mkdir -p "$work"
work="$(cd "$work" && pwd)"
src="$work/t3"
stamp="$src/.t3-view-key"

if [[ -f "$stamp" && "$(cat "$stamp")" == "$key" && -d "$src/node_modules" ]]; then
	echo "build-web: reusing $src ($key)"
else
	echo "build-web: extracting $tag ($commit)"
	rm -rf "$src" "$work/repo"
	git init -q "$work/repo"
	git -C "$work/repo" fetch -q --depth 1 "$repo" "refs/tags/$tag:refs/tags/$tag"
	got="$(git -C "$work/repo" rev-parse "refs/tags/$tag^{commit}")"
	if [[ "$got" != "$commit" ]]; then
		echo "build-web: tag $tag is $got, T3_PIN says $commit" >&2
		exit 1
	fi
	mkdir -p "$src"
	git -C "$work/repo" archive "$commit" | tar -x -C "$src"
	rm -rf "$work/repo"

	# Stop git's repository discovery at the work dir. When the work dir sits
	# inside another checkout (CI builds in out/t3 of the lobby's own clone),
	# git apply otherwise treats $src as a subdirectory of that repo, skips
	# every path outside it and still exits 0, so nothing is patched. The
	# reverse check proves each patch is now in the tree.
	shopt -s nullglob
	for p in "$here"/patches/*.patch; do
		echo "build-web: applying $(basename "$p")"
		GIT_CEILING_DIRECTORIES="$work" git -C "$src" apply --check "$p"
		GIT_CEILING_DIRECTORIES="$work" git -C "$src" apply "$p"
		GIT_CEILING_DIRECTORIES="$work" git -C "$src" apply --reverse --check "$p"
	done
	shopt -u nullglob

	# The web client's own dependency closure, plus the workspace root for
	# typescript and @types/node (the sidecar's typecheck). --ignore-scripts
	# skips the root prepare (git hooks, a tsgo patch) and electron's binary
	# download; neither touches the web build.
	echo "build-web: installing"
	(
		cd "$src"
		COREPACK_ENABLE_DOWNLOAD_PROMPT=0 ELECTRON_SKIP_BINARY_DOWNLOAD=1 CI=1 \
			corepack pnpm install --frozen-lockfile --ignore-scripts \
			--filter '@t3tools/web...' --filter '@t3tools/monorepo' \
			${PNPM_STORE_DIR:+--store-dir "$PNPM_STORE_DIR"}
	)
	echo "$key" >"$stamp"
fi

if [[ "$deps_only" == 1 ]]; then
	exit 0
fi

# An empty repository at the checkout's root, so Tailwind's source scan reads
# T3's .gitignore. Tailwind applies .gitignore only inside a git repository,
# and this tree is a git archive extract: without one it scans every
# node_modules, and T3 v0.1.1's build passed 15 GB in that scan, past what a
# GitHub runner has. Upstream builds in a real checkout and never sees this.
if [[ ! -e "$src/.git" ]]; then
	git init -q "$src"
fi

# vp directly: `pnpm run build` first runs pnpm's dependency check, which wants
# an unfiltered install and aborts without a TTY.
echo "build-web: building apps/web"
(
	cd "$src/apps/web"
	T3CODE_WEB_SOURCEMAP=0 ./node_modules/.bin/vp build
)
rm -rf "$work/web"
cp -a "$src/apps/web/dist" "$work/web"
echo "$key" >"$work/web/BUILD_KEY"
echo "build-web: $work/web ($key)"
