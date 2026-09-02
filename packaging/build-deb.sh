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
mkdir -p "$STAGE/bin" "$STAGE/share" "$STAGE/devvm" "$STAGE/frontend" "$TOOLS"
CHUNKS="$BUILD/chunks"
mkdir -p "$CHUNKS"

COMMIT="$(git rev-parse --short HEAD)"

# --- Go services -----------------------------------------------------------
# One toolchain, whatever CI installed; -trimpath so the build does not carry
# the path it happened to run in.
echo "==> building Go services (commit $COMMIT)"
LDFLAGS="-X main.buildID=$COMMIT"
for svc in tmux-api clipboard-upload session-events file-api skills-api tl-session-watch; do
  (cd "$svc" && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
    go build -trimpath -ldflags "$LDFLAGS" -o "$STAGE/bin/$svc" .)
done
(cd t3-bridge && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
  go build -trimpath -ldflags "$LDFLAGS" -o "$STAGE/bin/tl-t3-bridge" .)
(cd t3-sync && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
  go build -trimpath -ldflags "$LDFLAGS" -o "$STAGE/bin/tl-t3-sync" .)
# tl-users lands in bin/, not the tooling dir: an operator runs it, unlike
# tl-apply and tl-pkg which the pipeline runs.
(cd release && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
  go build -trimpath -o "$STAGE/bin/tl-users" ./cmd/tl-users)

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
# of the diagnostics could not be attributed to a release at all. term.html was
# unaffected because tl-stamp stamps it below, with this same $COMMIT.
(cd frontend-v2 && npm ci --include=dev --no-audit --no-fund && TL_BUILD="$COMMIT" npm run build)

# Stamping happens here, at build time, so the identity a client compares is
# fixed when the artefact is built rather than when someone installs it.
# The chunks vite emitted, plus the content-hashed terminal page tl-stamp writes
# alongside them -- both travel as payload, because dpkg must not own them.
cp -a frontend-v2/dist/assets/. "$CHUNKS/"

"$TOOLS/tl-stamp" \
  -lobby  frontend-v2/dist/index.html \
  -term   frontend/term.html \
  -diag   frontend/diag.js \
  -build  "$COMMIT" \
  -out    "$STAGE/share" \
  -assets "$CHUNKS"

# --- ship-blocking guards on the stamped surfaces --------------------------
# Each of these caught a real production failure under the deploy scripts, so
# they gate the build rather than the deploy now.

# A placeholder that survives stamping ships verbatim to the client, which then
# reads the literal string as a fingerprint. An earlier, narrower pattern let
# __TL_TERM_ASSET__ through exactly that way.
for surface in "$STAGE/share/index.html" "$STAGE/share/term.html"; do
  if grep -qE '__TL_[A-Z_]*__' "$surface"; then
    echo "build: $surface still carries a placeholder after stamping" >&2
    grep -oE '__TL_[A-Z_]*__' "$surface" | sort -u >&2
    exit 1
  fi
done

# The emitted CHUNKS need the same guard. The loop above covers the two surfaces
# tl-stamp writes, and a placeholder that vite compiled INTO the bundle is not on
# either of them — which is how __TL_BUILD__ shipped to every lobby client and
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
TERM_ASSET="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["term_asset"])' "$STAGE/share/stamps.json")"
grep -q "<meta name=\"tl-asset\" content=\"${LOBBY_ASSET}\"" "$STAGE/share/index.html" || {
  echo "build: the lobby lost its tl-asset meta tag" >&2; exit 1; }
grep -q "content=\"${TERM_ASSET}\"" "$STAGE/share/index.html" || {
  echo "build: the lobby does not carry the terminal page fingerprint" >&2; exit 1; }

# Every chunk the lobby references must actually be in the payload. A missing
# entry chunk is a blank lobby.
missing=0
for ref in $(grep -oE '(src|href)="/assets/[^"]+"' "$STAGE/share/index.html" | sed -E 's/.*"\/assets\/([^"]+)"/\1/' | sort -u); do
  [ -f "$CHUNKS/$ref" ] || { echo "build: index.html references /assets/$ref, which is not in the payload" >&2; missing=1; }
done
[ "$missing" -eq 0 ] || exit 1

# The baseline-engine gate, run on the exact bytes about to ship. It has caught
# two separate blank-lobby incidents on iPadOS 15.8.
#
# The fixture audits the page AND every assets/*.js beside it, so the gate needs
# the shipping layout, not just the page: TL_SPA points at a directory where the
# stamped index.html sits next to the chunks that ship with it.
if [ -f scripts/test_frontend_compat.py ]; then
  GATE="$BUILD/gate"
  rm -rf "$GATE" && mkdir -p "$GATE/assets"
  cp "$STAGE/share/index.html" "$GATE/index.html"
  cp -a "$CHUNKS/." "$GATE/assets/"
  TL_SPA="$GATE/index.html" python3 -m pytest scripts/test_frontend_compat.py -k spa -q
fi

# --- devvm helper scripts and units, PWA surface, webfonts -----------------
cp -a devvm/. "$STAGE/devvm/"
cp -a frontend/. "$STAGE/frontend/"

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
