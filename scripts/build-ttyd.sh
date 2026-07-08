#!/usr/bin/env bash
# Build the pixel-size-patched ttyd reproducibly into ./out/ttyd.
#
# Why a patched ttyd at all: tmux only re-emits sixel images to clients
# whose pty reports a pixel size via TIOCGWINSZ, and stock ttyd 1.7.7
# hardcodes ws_xpixel/ws_ypixel to 0 on every resize (src/pty.c). The
# patch (devvm/ttyd-pixel-size.patch — taken verbatim from the validated
# prototype tree, see docs/adr/0004-sixel-images-in-the-terminal.md)
# adds optional "xpixel"/"ypixel" fields to the RESIZE_TERMINAL message
# and forwards them to the pty. Upstream PR planned; until it lands we
# pin tag 1.7.7 and apply the patch on top.
#
# Usage:
#   ./scripts/build-ttyd.sh            # build if out/ttyd is missing/stale
#   ./scripts/build-ttyd.sh --force    # rebuild unconditionally
#
# Idempotent: a marker (out/.ttyd-build-ok) records the patch checksum
# of the last SUCCESSFUL build; matching marker + existing binary = skip.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TTYD_REPO="https://github.com/tsl0922/ttyd.git"
TTYD_TAG="1.7.7"
PATCH="$ROOT/devvm/ttyd-pixel-size.patch"
BUILD_DIR="$ROOT/out/ttyd-build"   # gitignored (out/)
OUT_BIN="$ROOT/out/ttyd"
MARKER="$ROOT/out/.ttyd-build-ok"

FORCE=0
if [[ "${1:-}" == "--force" ]]; then FORCE=1; fi

# --- Preflight: tools + dev packages, with the apt names spelled out ----
missing=()
for tool in git cmake gcc make; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
for pkg in libwebsockets-dev libjson-c-dev; do
  dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
done
if (( ${#missing[@]} > 0 )); then
  echo "ERROR: missing build dependencies: ${missing[*]}" >&2
  echo "Install with: sudo apt install build-essential cmake git libwebsockets-dev libjson-c-dev" >&2
  exit 1
fi

[[ -f "$PATCH" ]] || { echo "ERROR: patch not found: $PATCH" >&2; exit 1; }

# --- Skip if the existing binary was built from this exact patch --------
# The marker keys on tag + patch checksum and is written only AFTER a
# successful build, so an interrupted build can never look complete.
patch_sum="$(sha256sum "$PATCH")"
patch_sum="${patch_sum%% *}"
stamp="ttyd=${TTYD_TAG} patch-sha256=${patch_sum}"
if [[ $FORCE -eq 0 && -x "$OUT_BIN" && -f "$MARKER" ]] && [[ "$(cat "$MARKER")" == "$stamp" ]]; then
  echo "==> out/ttyd is up to date ($stamp) — skipping. Use --force to rebuild."
  "$OUT_BIN" --version
  exit 0
fi

# --- Fresh pinned clone + patch ------------------------------------------
rm -f "$MARKER"
rm -rf "$BUILD_DIR"
mkdir -p "$ROOT/out"
echo "==> Cloning ttyd $TTYD_TAG..."
git clone --depth 1 --branch "$TTYD_TAG" "$TTYD_REPO" "$BUILD_DIR"

echo "==> Applying devvm/ttyd-pixel-size.patch..."
if ! git -C "$BUILD_DIR" apply --verbose "$PATCH"; then
  echo "ERROR: patch failed to apply to ttyd $TTYD_TAG — refusing to build unpatched." >&2
  exit 1
fi

# --- Build ----------------------------------------------------------------
echo "==> Building (cmake Release)..."
cmake -S "$BUILD_DIR" -B "$BUILD_DIR/build" -DCMAKE_BUILD_TYPE=Release
cmake --build "$BUILD_DIR/build" -j "$(nproc)"

install -m 0755 "$BUILD_DIR/build/ttyd" "$OUT_BIN"
printf '%s' "$stamp" > "$MARKER"

echo "==> Built $OUT_BIN"
"$OUT_BIN" --version
