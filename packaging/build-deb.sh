#!/usr/bin/env bash
# Build the terminal-lobby Debian package.
#
# This runs in CI on a clean checkout. It does not build the patched terminal
# server or the image viewer: those are their own packages, rebuilt only when
# their own inputs change, and they arrive here as declared dependencies.
#
#   ./packaging/build-deb.sh <version>        # e.g. 0.1.0
#
# VERSION comes from the semver tag svu cut, without the leading v.
set -euo pipefail

VERSION="${1:?usage: build-deb.sh <version>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BUILD="${BUILD_DIR:-$ROOT/out/pkg}"
STAGE="$BUILD/stage"
TREE="$BUILD/tree"
TOOLS="$BUILD/tools"
rm -rf "$BUILD"
mkdir -p "$STAGE/bin" "$STAGE/share" "$STAGE/devvm" "$STAGE/frontend" "$STAGE/frontend-v2/public" "$TOOLS"
CHUNKS="$BUILD/chunks"
mkdir -p "$CHUNKS"

COMMIT="$(git rev-parse --short HEAD)"

# --- Go services -----------------------------------------------------------
# One toolchain, whatever CI installed; -trimpath so the build does not carry
# the path it happened to run in.
echo "==> building Go services (commit $COMMIT)"
LDFLAGS="-X main.buildID=$COMMIT"
for svc in tmux-api clipboard-upload session-events file-api skills-api agent-api tl-session-watch tl-browser; do
  (cd "$svc" && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
    go build -trimpath -ldflags "$LDFLAGS" -o "$STAGE/bin/$svc" .)
done
# tl-users lands in bin/, not the tooling dir: an operator runs it, unlike
# tl-apply and tl-pkg which the pipeline runs.
(cd release && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
  go build -trimpath -o "$STAGE/bin/tl-users" ./cmd/tl-users)

# --- the browser host ------------------------------------------------------
# What tl-browser starts on a session's first browser call (ADR-0035). The
# manifest installs this directory whole, so it holds exactly what runs and
# nothing else: host.mjs, its lib/, the package files, and node_modules from
# the committed lockfile. Tests stay behind. --omit=dev keeps tooling out, and
# --ignore-scripts because no dependency here needs an install script (the one
# lockfile entry with one is fsevents, macOS only) and the build has no reason
# to run code a dependency ships.
echo "==> staging the browser host"
HOST="$STAGE/tl-browser-host"
mkdir -p "$HOST"
cp tl-browser/host/host.mjs tl-browser/host/package.json tl-browser/host/package-lock.json "$HOST/"
cp -a tl-browser/host/lib "$HOST/lib"
(cd "$HOST" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)

# The staged tree has to start, not merely exist. --describe loads every module
# the host imports and prints its MCP handshake without launching Chrome, which
# is what tl-browser runs on a cache miss. A lib file the copy above missed, or
# a dependency --omit=dev dropped, fails here instead of on every box's first
# browser call.
node "$HOST/host.mjs" --describe | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d["initialize"]["serverInfo"], "no serverInfo"
assert any(t["name"] == "browser_close" for t in d["tools"]["tools"]), "no browser_close tool"
' || { echo "build: the staged browser host does not describe itself" >&2; exit 1; }

# --- the lobby's Claude mod (ADR-0036) --------------------------------------
# Staged as a directory marketplace: the manifest under .claude-plugin/ and the
# plugin itself under plugins/terminal-lobby/. Only what Claude loads goes in:
# the plugin manifest and hooks/. The tests, the generated types and the dev
# package file stay behind.
echo "==> staging the Claude mod"
MODS="$STAGE/claude-plugins"
mkdir -p "$MODS/.claude-plugin" "$MODS/plugins/terminal-lobby/.claude-plugin"
cp claude-mod/marketplace.json "$MODS/.claude-plugin/marketplace.json"
cp claude-mod/.claude-plugin/plugin.json "$MODS/plugins/terminal-lobby/.claude-plugin/plugin.json"
cp -a claude-mod/hooks "$MODS/plugins/terminal-lobby/hooks"
# Which build of the mod this is, by content, so it changes only when the mod
# does. tmux-user-attach stamps each pre-warmed slot with it and replaces a slot
# warmed under another one: a Claude loads the mod once, at start, so a slot
# warmed before this deploy would otherwise hand out the old mod.
( cd "$MODS/plugins/terminal-lobby" && find . -type f ! -name .mod-id -print0 | LC_ALL=C sort -z \
    | xargs -0 sha256sum | sha256sum | cut -c1-16 ) > "$MODS/plugins/terminal-lobby/.mod-id"
python3 - "$MODS" <<'PY' || { echo "build: the staged Claude mod is malformed" >&2; exit 1; }
import json, os, sys
root = sys.argv[1]
market = json.load(open(os.path.join(root, ".claude-plugin/marketplace.json")))
for p in market["plugins"]:
    plugin = os.path.join(root, p["source"])
    json.load(open(os.path.join(plugin, ".claude-plugin/plugin.json")))
    hooks = json.load(open(os.path.join(plugin, "hooks/hooks.json")))
    for m in hooks["modules"]:
        assert os.path.isfile(os.path.join(plugin, "hooks", m)), m
PY

# --- the package's own tooling ---------------------------------------------
(cd release && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
  go build -trimpath -o "$TOOLS/tl-apply" ./cmd/tl-apply)
(cd release && go build -trimpath -o "$TOOLS/tl-stamp" ./cmd/tl-stamp)
(cd release && go build -trimpath -o "$TOOLS/tl-pkg" ./cmd/tl-pkg)

# --- frontend --------------------------------------------------------------
# npm ci installs exactly the committed lockfile. --include=dev because the
# build tool lives in devDependencies and CI may export NODE_ENV=production.
echo "==> building the lobby"
# TL_BUILD is what vite substitutes for the __TL_BUILD__ define. Without it the
# SPA compiled the LITERAL placeholder into its bundle and every lobby
# diagnostics record reported `tl.build: "__TL_BUILD__"` — measured at 100 of
# 100 records over 12h. tl.build is the correlation attribute that says WHICH
# BUILD a client was running when something broke (ADR-0008), so the SPA's half
# of the diagnostics could not be attributed to a release at all. tl-stamp
# substitutes the same $COMMIT into the page below.
(cd frontend-v2 && npm ci --include=dev --no-audit --no-fund && TL_BUILD="$COMMIT" npm run build)

# Stamping happens here, at build time, so the identity a client compares is
# fixed when the artefact is built rather than when someone installs it.
# The chunks vite emitted travel as payload, because dpkg must not own them.
# A content-hashed copy of the framed terminal page went in beside them until
# 2026-09-05; there is one document now, so tl-stamp writes one surface.
cp -a frontend-v2/dist/assets/. "$CHUNKS/"

"$TOOLS/tl-stamp" \
  -lobby  frontend-v2/dist/index.html \
  -diag   frontend/diag.js \
  -build  "$COMMIT" \
  -out    "$STAGE/share"

# --- ship-blocking guards on the stamped surfaces --------------------------
# Each of these caught a real production failure under the deploy scripts, so
# they gate the build rather than the deploy now.

# A placeholder that survives stamping ships verbatim to the client, which then
# reads the literal string as a fingerprint. An earlier, narrower pattern let
# __TL_TERM_ASSET__ through exactly that way -- which is why the pattern is the
# whole __TL_ namespace and not a list of the names we remember.
SURFACE="$STAGE/share/index.html"
if grep -qE '__TL_[A-Z_]*__' "$SURFACE"; then
  echo "build: $SURFACE still carries a placeholder after stamping" >&2
  grep -oE '__TL_[A-Z_]*__' "$SURFACE" | sort -u >&2
  exit 1
fi

# The emitted CHUNKS need the same guard. The check above covers the one surface
# tl-stamp writes, and a placeholder that vite compiled INTO the bundle is not on
# it — which is how __TL_BUILD__ shipped to every lobby client and
# was read back as a literal build fingerprint. `__TL_` is our own namespace, so
# any match here is ours and is a real leak.
if grep -rlE '__TL_[A-Z_]*__' "$CHUNKS" >/dev/null 2>&1; then
  echo "build: a lobby chunk still carries a placeholder" >&2
  grep -rhoE '__TL_[A-Z_]*__' "$CHUNKS" | sort -u >&2
  exit 1
fi

# The meta tag is the one leg that depends on the build tool: if vite stops
# copying the head through verbatim, the page can never self-update.
LOBBY_ASSET="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["lobby_asset"])' "$STAGE/share/stamps.json")"
grep -q "<meta name=\"tl-asset\" content=\"${LOBBY_ASSET}\"" "$STAGE/share/index.html" || {
  echo "build: the lobby lost its tl-asset meta tag" >&2; exit 1; }

# Every chunk the lobby references must actually be in the payload. A missing
# entry chunk is a blank lobby.
missing=0
for ref in $(grep -oE '(src|href)="/assets/[^"]+"' "$STAGE/share/index.html" | sed -E 's/.*"\/assets\/([^"]+)"/\1/' | sort -u); do
  [ -f "$CHUNKS/$ref" ] || { echo "build: index.html references /assets/$ref, which is not in the payload" >&2; missing=1; }
done
[ "$missing" -eq 0 ] || exit 1

# The public-link visitor page (ADR-0039).
# Not stamped: it carries no diagnostics core and no self-update identity, since
# a visitor's tab is not a lobby that updates itself. It gets the same two
# guards anyway, against its own chunk prefix: it is served under /s/, so it
# references /s/assets/<name>, which the ingress maps onto the same payload.
LINK_PAGE="$STAGE/share/link.html"
cp frontend-v2/dist/link.html "$LINK_PAGE"
if grep -qE '__TL_[A-Z_]*__' "$LINK_PAGE"; then
  echo "build: $LINK_PAGE carries a placeholder" >&2
  exit 1
fi
for ref in $(grep -oE '(src|href)="/s/assets/[^"]+"' "$LINK_PAGE" | sed -E 's/.*"\/s\/assets\/([^"]+)"/\1/' | sort -u); do
  [ -f "$CHUNKS/$ref" ] || { echo "build: link.html references /s/assets/$ref, which is not in the payload" >&2; missing=1; }
done
[ "$missing" -eq 0 ] || exit 1
grep -q 'src="/s/assets/' "$LINK_PAGE" || { echo "build: link.html loads no script from /s/assets/" >&2; exit 1; }

# The baseline-engine gate, run on the exact bytes about to ship. It has caught
# two separate blank-lobby incidents on iPadOS 15.8.
#
# The fixture audits the page AND every assets/*.js beside it, so the gate needs
# the shipping layout, not just the page: TL_SPA points at a directory where the
# stamped index.html sits next to the chunks that ship with it.
#
# NO SELECTOR. This is the only automated run of that file anywhere in the repo,
# so anything a selector deselects is checked nowhere at all. It used to say
# `-k spa`, which kept four test functions, 13 parameterized cases, and dropped
# the rest: 13 selected against 32 deselected of the 45 the file holds today.
# Among the dropped was the one check that proves the CSS guard found real CSS
# rather than falling back to the small inline #tl-shell block. Staging this
# directory with every assets/*.js and no assets/*.css PASSED `-k spa` 13 of 13
# and FAILED under the whole file, on exactly that check (measured 2026-09-04).
# Running everything cost 5.5s against 4.7s.
#
# WHAT THIS GATE NOW SEES, and it is more than it did. It copies the STAMPED
# $STAGE/share/index.html below, so the ~59 KB of frontend/diag.js that
# release/stamp.go inlines into the shipped page goes through the SPA checks
# along with it. That gap closed on its own when frontend/term.html was deleted
# (2026-09-05): the term.html arm of the guard file read the PRE-STAMP source,
# so the audited bytes and the shipped bytes were not the same bytes.
#
# One reason the regex arm stays narrowed to the SPA rather than being aimed at
# every surface: diag.js:98 builds a lookbehind inside a STRING, which is not a
# parse-time error, and the suite documents that as why the pattern is kept off
# it. The esbuild differential is what actually covers that construct.
# test_the_release_gate_runs_this_whole_file asserts this line stays unnarrowed.
if [ -f scripts/test_frontend_compat.py ]; then
  GATE="$BUILD/gate"
  rm -rf "$GATE" && mkdir -p "$GATE/assets"
  cp "$STAGE/share/index.html" "$GATE/index.html"
  cp -a "$CHUNKS/." "$GATE/assets/"
  TL_SPA="$GATE/index.html" python3 -m pytest scripts/test_frontend_compat.py -q
fi

# --- devvm helper scripts and units, PWA surface, webfonts -----------------
# tl-pkg reads each manifest Src out of this tree, so a source directory the
# manifest names has to arrive here at the path it has in the checkout.
# frontend/ carries diag.js and the six webfonts; frontend-v2/public/ carries
# the PWA surface (sw.js, the manifest, the three icons), which the manifest
# stopped taking from frontend/ on 2026-09-06 when the second copy of those five
# files was deleted. release's TestEveryStagedSourceDirectoryIsCopiedIntoTheStage
# asserts these two lines still cover every Src.
cp -a devvm/. "$STAGE/devvm/"
cp -a frontend/. "$STAGE/frontend/"
cp -a frontend-v2/public/. "$STAGE/frontend-v2/public/"

# --- assemble --------------------------------------------------------------
"$TOOLS/tl-pkg" \
  -stage "$STAGE" -out "$TREE" -tools "$TOOLS" \
  -version "$VERSION" -commit "$COMMIT" \
  -assets "$CHUNKS"

mkdir -p "$ROOT/out"
DEB="$ROOT/out/terminal-lobby_${VERSION}_amd64.deb"
dpkg-deb --root-owner-group --build "$TREE" "$DEB"
echo "==> $DEB"
dpkg-deb -I "$DEB"
