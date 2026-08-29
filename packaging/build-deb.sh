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
mkdir -p "$STAGE/bin" "$STAGE/share" "$STAGE/devvm" "$TOOLS"

COMMIT="$(git rev-parse --short HEAD)"

# --- Go services -----------------------------------------------------------
# One toolchain, whatever CI installed; -trimpath so the build does not carry
# the path it happened to run in.
echo "==> building Go services (commit $COMMIT)"
LDFLAGS="-X main.buildID=$COMMIT"
for svc in tmux-api clipboard-upload session-events file-api skills-api; do
  (cd "$svc" && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
    go build -trimpath -ldflags "$LDFLAGS" -o "$STAGE/bin/$svc" .)
done
(cd t3-bridge && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
  go build -trimpath -ldflags "$LDFLAGS" -o "$STAGE/bin/tl-t3-bridge" .)
(cd t3-sync && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
  go build -trimpath -ldflags "$LDFLAGS" -o "$STAGE/bin/tl-t3-sync" .)

# --- the package's own tooling ---------------------------------------------
(cd release && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
  go build -trimpath -o "$TOOLS/tl-apply" ./cmd/tl-apply)
(cd release && go build -trimpath -o "$TOOLS/tl-stamp" ./cmd/tl-stamp)
(cd release && go build -trimpath -o "$TOOLS/tl-pkg" ./cmd/tl-pkg)

# --- frontend --------------------------------------------------------------
# npm ci installs exactly the committed lockfile. --include=dev because the
# build tool lives in devDependencies and CI may export NODE_ENV=production.
echo "==> building the lobby"
(cd frontend-v2 && npm ci --include=dev --no-audit --no-fund && npm run build)

# Stamping happens here, at build time, so the identity a client compares is
# fixed when the artefact is built rather than when someone installs it.
"$TOOLS/tl-stamp" \
  -lobby frontend-v2/dist/index.html \
  -term  frontend/term.html \
  -diag  frontend/diag.js \
  -build "$COMMIT" \
  -out   "$STAGE/share"

# --- devvm helper scripts and units ----------------------------------------
cp -a devvm/. "$STAGE/devvm/"

# --- assemble --------------------------------------------------------------
"$TOOLS/tl-pkg" \
  -stage "$STAGE" -out "$TREE" -tools "$TOOLS" \
  -version "$VERSION" -commit "$COMMIT" \
  -assets frontend-v2/dist/assets

mkdir -p "$ROOT/out"
DEB="$ROOT/out/terminal-lobby_${VERSION}_amd64.deb"
dpkg-deb --root-owner-group --build "$TREE" "$DEB"
echo "==> $DEB"
dpkg-deb -I "$DEB"
