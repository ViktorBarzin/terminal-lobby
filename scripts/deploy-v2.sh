#!/usr/bin/env bash
# Deploy the v2 (SolidJS) SPA to a SECOND ttyd (:7687) on the DevVM, which the
# terminal-dev.viktorbarzin.me ingress fronts. Companion to scripts/deploy.sh.
#
# STRICTLY ADDITIVE — this script NEVER touches ttyd :7681 (the stable vanilla
# frontend at terminal.viktorbarzin.me) nor the shared backends. The v2 terminal
# iframe (term.html), the PWA assets, and every API (tmux-api / clipboard-upload
# / session-events / file-api) are the SAME shared files + services that
# deploy.sh and the infra `terminal` stack already ship; only the SPA index and
# its own ttyd-v2 unit are new here. So the two frontends serve the SAME tmux
# sessions from one backend.
#
# Usage:
#   ./scripts/deploy-v2.sh                    # build + deploy
#   DEVVM=192.0.2.10 ./scripts/deploy-v2.sh   # override host
#   SKIP_BUILD=1 ./scripts/deploy-v2.sh       # reuse frontend-v2/dist/index.html
set -euo pipefail

DEVVM="${DEVVM:-192.0.2.10}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -z "${SKIP_BUILD:-}" ]]; then
  echo "==> Building v2 SPA (frontend-v2, vite single-file)..."
  # The build is stamped AFTER the fact, not during it (ADR-0007): vite emits
  # the literal __TL_BUILD__/__TL_ASSET__ placeholders so dist/index.html is a
  # pure function of the source, and the fingerprint below is taken over those
  # placeholder-bearing bytes. Baking a git SHA (or the old timestamp fallback)
  # into the build would make every artifact unique and defeat the point.
  # The TL_* proxy URLs in vite.config are dev-only (vite preview) — the
  # production build is origin-relative, so no API env here.
  # --include=dev: the devvm exports NODE_ENV=production, which makes `npm ci`
  # omit devDependencies (vite lives there) → "vite: not found". Force dev deps.
  ( cd frontend-v2 && npm ci --include=dev && npm run build )
fi
test -f frontend-v2/dist/index.html || { echo "frontend-v2/dist/index.html missing — build failed"; exit 1; }

echo "==> Stamping build id + asset fingerprint..."
# Mirrors deploy.sh exactly: TL_BUILD is provenance (git SHA), TL_ASSET is the
# update identity (a fingerprint of the built frontend's own content), so a
# backend-only deploy ships an identical id and no client updates.
REV=$(git -C "$ROOT" rev-parse --short HEAD)
ASSET=$(sha256sum frontend-v2/dist/index.html | cut -c1-12)
mkdir -p out
sed -e "s/__TL_BUILD__/${REV}/g" -e "s/__TL_ASSET__/${ASSET}/g" \
    frontend-v2/dist/index.html > out/index-v2.html
# The meta tag is the one leg that depends on the build tool: if vite ever stops
# copying the head through verbatim, fail the deploy rather than ship a page
# that can never self-update.
grep -q '<meta name="tl-asset" content="'"${ASSET}"'"' out/index-v2.html || {
  echo "deploy-v2.sh: tl-asset meta missing from the built SPA — vite dropped it" >&2
  exit 1
}
if grep -q '__TL_[A-Z]*__' out/index-v2.html; then
  echo "deploy-v2.sh: unsubstituted __TL_*__ placeholder in out/index-v2.html" >&2
  exit 1
fi
echo "    build=${REV} asset=${ASSET}"

echo "==> Staging on $DEVVM..."
scp -o BatchMode=yes \
  out/index-v2.html \
  devvm/ttyd-v2.service \
  "wizard@${DEVVM}:/tmp/"

echo "==> Installing on $DEVVM..."
ssh -o BatchMode=yes "wizard@${DEVVM}" bash -se <<'REMOTE'
  set -euo pipefail
  # The v2 SPA index — served ONLY by ttyd-v2 (:7687). Never overwrites
  # /usr/local/share/ttyd/index.html (that stays the vanilla page on :7681).
  if ! sudo cmp -s /tmp/index-v2.html /usr/local/share/ttyd/index-v2.html; then
    sudo install -m 0644 /tmp/index-v2.html /usr/local/share/ttyd/index-v2.html
  else
    echo "    index-v2.html unchanged — leaving it (and its ETag) alone"
  fi
  sudo install -m 0644 /tmp/ttyd-v2.service /etc/systemd/system/ttyd-v2.service
  # daemon-reload can transiently time out under heavy devvm load; retry once.
  sudo systemctl daemon-reload || { sleep 3; sudo systemctl daemon-reload; }
  sudo systemctl enable --now ttyd-v2
  sudo systemctl restart ttyd-v2
  rm -f /tmp/index-v2.html /tmp/ttyd-v2.service
REMOTE

echo "==> Verifying..."
ssh -o BatchMode=yes "wizard@${DEVVM}" '
  systemctl is-active ttyd-v2
  curl -sf -H "X-authentik-username: alice" http://localhost:7687/ -o /dev/null && echo "ttyd-v2 serving the v2 SPA OK" || { echo "ttyd-v2 NOT serving"; exit 1; }
'
echo "==> Done. v2 SPA live on :7687. Routing lives in infra stacks/terminal (terminal-dev.viktorbarzin.me)."
