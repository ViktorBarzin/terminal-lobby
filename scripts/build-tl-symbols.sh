#!/usr/bin/env bash
# build-tl-symbols.sh — build frontend/fonts/tl-symbols.woff2 ('TL Symbols').
#
# WHY THIS FACE EXISTS: JetBrains Mono 2.304 ships NO braille (U+2800-28FF)
# and none of Claude Code's spinner/status glyphs ✢✳✻✽⏺⎿✔☐☒⏵◼※ (fc-query
# verified 2026-07-10 — see docs/plans/2026-07-11-t3-ux-parity-analysis.md,
# critic probe 1). Shipping the JBM webfont alone would regress those glyphs
# to OS-fallback tofu. Iosevka covers all of them, so we subset just the
# symbol ranges into a tiny fallback face loaded after JBM. The subset can
# never shadow JBM's ASCII metrics: it contains no ASCII, and the frontend
# additionally guards it with a matching unicode-range at FontFace load time.
#
# SOURCE / PROVENANCE: the GitHub release asset PkgTTF-Iosevka-<ver>.zip from
# https://github.com/be5invis/Iosevka/releases — the ONLY distribution of
# built Iosevka TTFs (jsdelivr /gh/ mirrors the source tree, which ships no
# built fonts). Iosevka is licensed OFL-1.1; subsetting + embedding is
# explicitly permitted (the Reserved Font Name is not used as a family name:
# the face is renamed by usage to 'TL Symbols' via CSS font-family only).
#
# IDEMPOTENT: the ~158 MB ZIP download is cached under out/ (gitignored) and
# reused; the subset step always re-runs (cheap, deterministic).
set -euo pipefail

IOSEVKA_VERSION="34.7.0"
# Claude Code TUI symbol coverage (keep in sync with the unicodeRange the
# frontend passes to the 'TL Symbols' FontFace in frontend/term.html):
#   U+2300-23FF  Miscellaneous Technical  (⏺ ⎿ ⏵ spinner/status, ⌘-class keys)
#   U+2700-27BF  Dingbats                 (✢ ✳ ✻ ✽ ✔ live-spinner frames)
#   U+2800-28FF  Braille patterns         (⠋⠙⠹… spinners)
#   U+203B ※ / U+2610 ☐ / U+2612 ☒ / U+25FC ◼  individual status glyphs
UNICODES="U+2300-23FF,U+2700-27BF,U+2800-28FF,U+203B,U+2610,U+2612,U+25FC"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_DIR="$REPO_ROOT/out/tl-symbols-cache"
OUT_FILE="$REPO_ROOT/frontend/fonts/tl-symbols.woff2"
ZIP_NAME="PkgTTF-Iosevka-$IOSEVKA_VERSION.zip"
ZIP_URL="https://github.com/be5invis/Iosevka/releases/download/v$IOSEVKA_VERSION/$ZIP_NAME"

command -v pyftsubset >/dev/null || {
    echo "ERROR: pyftsubset not found (pip install 'fonttools[woff]' brotli)" >&2
    exit 1
}
command -v unzip >/dev/null || { echo "ERROR: unzip not found" >&2; exit 1; }

mkdir -p "$CACHE_DIR" "$(dirname "$OUT_FILE")"

if [ ! -s "$CACHE_DIR/$ZIP_NAME" ]; then
    echo "Downloading $ZIP_URL (~158 MB, cached in out/) ..."
    curl -fSL --retry 3 -o "$CACHE_DIR/$ZIP_NAME.part" "$ZIP_URL"
    mv "$CACHE_DIR/$ZIP_NAME.part" "$CACHE_DIR/$ZIP_NAME"
else
    echo "Using cached $CACHE_DIR/$ZIP_NAME"
fi

# The TTF sits at the ZIP root in current releases; tolerate a subdir too.
TTF_ENTRY="$(unzip -Z1 "$CACHE_DIR/$ZIP_NAME" | grep -E '(^|/)Iosevka-Regular\.ttf$' | head -1)"
[ -n "$TTF_ENTRY" ] || { echo "ERROR: Iosevka-Regular.ttf not found in ZIP" >&2; exit 1; }
unzip -o -q "$CACHE_DIR/$ZIP_NAME" "$TTF_ENTRY" -d "$CACHE_DIR"

pyftsubset "$CACHE_DIR/$TTF_ENTRY" \
    --unicodes="$UNICODES" \
    --flavor=woff2 \
    --no-hinting \
    --layout-features='' \
    --name-IDs=0,1,2,3,13,14 \
    --output-file="$OUT_FILE"

# Self-check: every glyph the Claude Code TUI battery needs must be in the cmap.
python3 - "$OUT_FILE" <<'EOF'
import sys
from fontTools.ttLib import TTFont
font = TTFont(sys.argv[1])
cmap = font.getBestCmap()
battery = "✢✳✻✽⏺⎿✔☐☒⏵◼※" + "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
missing = [c for c in battery if ord(c) not in cmap]
if missing:
    sys.exit("ERROR: subset is missing glyphs: " + " ".join(missing))
print(f"OK: {len(cmap)} codepoints, all battery glyphs present")
EOF

echo "Built $OUT_FILE ($(stat -c%s "$OUT_FILE") bytes)"
