#!/usr/bin/env bash
# Deploy the SolidJS SPA as THE lobby: /usr/local/share/ttyd/index.html, served
# by ttyd :7681 (-I) at terminal.viktorbarzin.me. Companion to scripts/deploy.sh.
#
# There is one tier. The terminal-dev canary (ttyd-v2 :7687, index-v2.html) was
# retired on 2026-08-16 once the SPA became the daily driver — everything ships
# straight to prod now (Viktor's call). --prod is still accepted so existing
# muscle memory and docs keep working; --canary is refused rather than silently
# doing something else.
#
# RESTARTS ONLY ttyd — never ttyd-ro, never a shared backend. What it installs
# is two files: the SPA index (index.html) and term.html.
#
# WHO SHIPS WHAT:
#   this script          index.html (the lobby SPA), term.html
#   deploy.sh            the SHARED backends (ttyd, ttyd-ro, tmux-api,
#                        clipboard-upload) + PWA assets. It does NOT install the
#                        lobby page — that would revert whatever is deployed here.
#   deploy-services.sh   session-events (:7685) + file-api (:7686) — SPA-only
#                        backends that NEITHER of the other two scripts ships
#
# term.html lands in the SHARED asset dir (/usr/local/share/ttyd, which
# clipboard-upload serves from) and the ingress routes Path(`/term.html`) there.
# The SPA fetches it as its terminal frame (config.TERMINAL_BASE). No service is
# restarted for it; clipboard-upload re-reads the file per request.
#
# Usage:
#   ./scripts/deploy-v2.sh                    # build + deploy
#   DEVVM=192.0.2.10 ./scripts/deploy-v2.sh   # override host
#   SKIP_BUILD=1 ./scripts/deploy-v2.sh       # reuse frontend-v2/dist/{index,term}.html
#
# Roll back: the previous index is kept as index.html.prev (see the tail).
set -euo pipefail

# One destination. --prod is a no-op kept for compatibility with older docs and
# habits; --canary names a tier that no longer exists, so it fails loudly rather
# than quietly deploying to prod under a name that promises it will not.
for a in "$@"; do
  case "$a" in
    --prod) ;;
    --canary)
      echo "deploy-v2.sh: the terminal-dev canary (ttyd-v2 :7687) was retired" >&2
      echo "  on 2026-08-16 — there is only the prod tier now. Drop the flag." >&2
      exit 2 ;;
    *) echo "deploy-v2.sh: unknown argument $a" >&2; exit 2 ;;
  esac
done
REMOTE_INDEX="index.html"      # ttyd :7681 serves this (-I), terminal.viktorbarzin.me
REMOTE_UNIT="ttyd"
REMOTE_PORT=7681

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
  #
  # npm ci is the slow half of this script and it reinstalls a byte-identical
  # tree on every run. Skip it when node_modules is already there AND
  # package-lock.json still hashes to whatever the last successful install ran
  # against. The stamp lives INSIDE node_modules on purpose: `rm -rf
  # node_modules` (or npm ci's own wipe, which is why the stamp is written
  # after) takes the stamp with it, so a hand-cleared tree reinstalls. Any
  # lockfile edit changes the hash and the install runs.
  LOCK_HASH=$(sha256sum frontend-v2/package-lock.json | cut -d' ' -f1)
  LOCK_STAMP=frontend-v2/node_modules/.tl-lock-hash
  if [[ -d frontend-v2/node_modules && -f "$LOCK_STAMP" && "$(cat "$LOCK_STAMP")" == "$LOCK_HASH" ]]; then
    echo "    package-lock.json unchanged since the last install — skipping npm ci"
  else
    ( cd frontend-v2 && npm ci --include=dev )
    printf '%s\n' "$LOCK_HASH" > "$LOCK_STAMP"
  fi
  ( cd frontend-v2 && npm run build )
fi
test -f frontend-v2/dist/index.html || { echo "frontend-v2/dist/index.html missing — build failed"; exit 1; }
# The terminal-mode iframe page, emitted by the copyTermHtml plugin in
# frontend-v2/vite.config.ts (source: frontend/term.html). The SPA's Terminal
# view is an iframe of this file, so a build that dropped it ships a v2 with no
# terminal at all.
test -f frontend-v2/dist/term.html || { echo "frontend-v2/dist/term.html missing — the copyTermHtml plugin did not run"; exit 1; }

echo "==> Stamping build id + asset fingerprint..."
# Mirrors deploy.sh exactly: TL_BUILD is provenance (git SHA), TL_ASSET is the
# update identity (a fingerprint of the built frontend's own content), so a
# backend-only deploy ships an identical id and no client updates.
REV=$(git -C "$ROOT" rev-parse --short HEAD)
mkdir -p out
# The shared diagnostics core (frontend/diag.js, ADR-0008) is inlined FIRST and
# the asset id computed AFTER it but BEFORE the stamps, exactly as deploy.sh
# does. The id must move when diag.js moves, or no open tab would self-update to
# a fixed diagnostics build — ADR-0007's failure mode inverted.
# diag.js must land INSIDE a script block. sed's `d` deletes the whole matched
# line, so a placeholder sharing its line with the tags takes them with it and
# the core ships as inert text — present, greppable, never executed. Assert the
# core is genuinely inside an open script element.
assert_diag_executable() {
  awk '
    /<script/  { inscript = 1 }
    /<\/script>/ { inscript = 0 }
    /globalThis\.tlDiag = \(function/ {
      found = 1
      if (!inscript) { print "diag.js is not inside a <script> block"; exit 1 }
    }
    END { if (!found) { print "diag.js core not found in the page"; exit 1 } }
  ' "$1" || {
    echo "deploy: $1 would ship diagnostics that never run" >&2
    exit 1
  }
}
# diag.js is inlined into a classic script block, which the HTML tokenizer ends
# at the first `</script`. A literal script tag anywhere in the file — even in a
# comment — would truncate the page mid-JavaScript, so refuse to ship one.
if grep -qi '</script\|<script' frontend/diag.js; then
  echo "deploy: frontend/diag.js contains a literal script tag; inlining it would truncate the page" >&2
  exit 1
fi
sed -e '/__TL_DIAG__/{r frontend/diag.js' -e 'd;}' \
    frontend-v2/dist/index.html > out/index.pre
if grep -q '__TL_DIAG__' out/index.pre; then
  echo "deploy-v2.sh: __TL_DIAG__ survived in the SPA — diagnostics would be dead" >&2
  exit 1
fi
assert_diag_executable out/index.pre
ASSET=$(sha256sum out/index.pre | cut -c1-12)
sed -e "s/__TL_BUILD__/${REV}/g" -e "s/__TL_ASSET__/${ASSET}/g" \
    out/index.pre > out/index.html
rm -f out/index.pre
# The meta tag is the one leg that depends on the build tool: if vite ever stops
# copying the head through verbatim, fail the deploy rather than ship a page
# that can never self-update.
grep -q '<meta name="tl-asset" content="'"${ASSET}"'"' out/index.html || {
  echo "deploy-v2.sh: tl-asset meta missing from the built SPA — vite dropped it" >&2
  exit 1
}
if grep -q '__TL_[A-Z]*__' out/index.html; then
  echo "deploy-v2.sh: unsubstituted __TL_*__ placeholder in out/index.html" >&2
  exit 1
fi
echo "    build=${REV} asset=${ASSET}"

# term.html is a SEPARATE artifact with its OWN update identity, and it needs
# the same two stamps. vite's copyTermHtml plugin passes the source through
# with both placeholders intact (BUILD_ID defaults to the literal
# `__TL_BUILD__`), so dist/term.html is a pure function of frontend/term.html
# and can be fingerprinted the same way index.html is.
# Stamping is not cosmetic here: term.html runs the shared zero-touch
# self-update healer, whose parseAssetId() returns null for any id still
# containing `__TL_` — "no information", never "a new build". An unstamped
# term.html is a terminal page that can never notice a deploy. Its id is its
# own, not the SPA's: the two files change independently.
sed -e '/__TL_DIAG__/{r frontend/diag.js' -e 'd;}' \
    frontend-v2/dist/term.html > out/term.pre
if grep -q '__TL_DIAG__' out/term.pre; then
  echo "deploy-v2.sh: __TL_DIAG__ survived in term.html — diagnostics would be dead" >&2
  exit 1
fi
assert_diag_executable out/term.pre
TERM_ASSET=$(sha256sum out/term.pre | cut -c1-12)
sed -e "s/__TL_BUILD__/${REV}/g" -e "s/__TL_ASSET__/${TERM_ASSET}/g" \
    out/term.pre > out/term.html
rm -f out/term.pre
grep -q '<meta name="tl-asset" content="'"${TERM_ASSET}"'"' out/term.html || {
  echo "deploy-v2.sh: tl-asset meta missing from term.html — self-update would be dead" >&2
  exit 1
}
if grep -q '__TL_[A-Z]*__' out/term.html; then
  echo "deploy-v2.sh: unsubstituted __TL_*__ placeholder in out/term.html" >&2
  exit 1
fi
echo "    term.html asset=${TERM_ASSET}"

echo "==> Staging on $DEVVM..."
# Staged under distinct names: /tmp/index.html on a SHARED devvm is somebody
# else's file waiting to happen.
scp -o BatchMode=yes out/index.html "wizard@${DEVVM}:/tmp/tl-deploy-index.html"
scp -o BatchMode=yes out/term.html  "wizard@${DEVVM}:/tmp/tl-deploy-term.html"

echo "==> Installing on $DEVVM (${REMOTE_UNIT} :${REMOTE_PORT})..."
ssh -o BatchMode=yes "wizard@${DEVVM}" \
  REMOTE_INDEX="$REMOTE_INDEX" REMOTE_UNIT="$REMOTE_UNIT" \
  bash -se <<'REMOTE'
  set -euo pipefail
  # restart_ttyd tracks whether anything ttyd actually SERVES changed. A restart
  # drops every attached terminal's WebSocket, so it must not happen on a deploy
  # that shipped identical bytes — and the `cmp` below already knows.
  restart_ttyd=0
  DEST="/usr/local/share/ttyd/${REMOTE_INDEX}"
  # The SPA index: index.html, the page ttyd :7681 serves at
  # terminal.viktorbarzin.me.
  if ! sudo cmp -s /tmp/tl-deploy-index.html "$DEST"; then
    # Keep the outgoing page as the rollback channel before overwriting it —
    # the same pattern ttyd.prev uses for the binary. On the promotion itself
    # this captures the vanilla lobby, so backing the cutover out is one
    # install + restart, with no rebuild and no checkout.
    [[ -f "$DEST" ]] && sudo cp -f "$DEST" "${DEST}.prev"
    sudo install -m 0644 /tmp/tl-deploy-index.html "$DEST"
    restart_ttyd=1
  else
    echo "    ${REMOTE_INDEX} unchanged — leaving it (and its ETag) alone"
  fi
  # No unit is installed here. ttyd.service belongs to deploy.sh and its
  # ExecStart already points at index.html, so shipping the lobby swaps the
  # FILE, not the unit — which is what keeps the rollback a single install.
  # term.html — the terminal-mode iframe page. Served by CLIPBOARD-UPLOAD out
  # of its exact-path asset whitelist (assetDir = /usr/local/share/ttyd), not
  # by ttyd, so it is deliberately NOT part of restart_ttyd: no process
  # caches it, the next request reads the new file.
  if ! sudo cmp -s /tmp/tl-deploy-term.html /usr/local/share/ttyd/term.html; then
    sudo install -m 0644 /tmp/tl-deploy-term.html /usr/local/share/ttyd/term.html
  else
    echo "    term.html unchanged — leaving it alone"
  fi
  # daemon-reload can transiently time out under heavy devvm load; retry once.
  sudo systemctl daemon-reload || { sleep 3; sudo systemctl daemon-reload; }
  # enable --now regardless — a stopped or never-enabled unit must come up even
  # when nothing changed. The restart is the conditional part.
  sudo systemctl enable --now "$REMOTE_UNIT"
  if [[ "$restart_ttyd" == "1" ]]; then
    sudo systemctl restart "$REMOTE_UNIT"
  else
    echo "    nothing ${REMOTE_UNIT} serves changed — skipping restart (attached terminals keep their WebSocket)"
  fi
  rm -f /tmp/tl-deploy-index.html /tmp/tl-deploy-term.html
REMOTE

echo "==> Verifying..."
ssh -o BatchMode=yes "wizard@${DEVVM}" \
  REMOTE_UNIT="$REMOTE_UNIT" REMOTE_PORT="$REMOTE_PORT" bash -s <<'VERIFY'
  set -euo pipefail
  systemctl is-active "$REMOTE_UNIT"
  # Poll, do not probe once. A restart takes ttyd a moment to bind its port, and
  # index.html changes on EVERY deploy (TL_BUILD carries the git SHA, so the
  # bytes differ even when TL_ASSET — the identity clients compare — does not),
  # which means the restart branch is the normal path and a single immediate
  # curl races it. That race reported "NOT serving" for a deploy that had in
  # fact succeeded.
  ok=0
  for _ in $(seq 1 30); do
    if curl -sf -m 3 -H "X-authentik-username: alice" http://localhost:${REMOTE_PORT}/ -o /dev/null; then
      ok=1; break
    fi
    sleep 0.5
  done
  [ "$ok" = "1" ] && echo "${REMOTE_UNIT} serving the lobby SPA OK" || { echo "${REMOTE_UNIT} NOT serving after 15s"; exit 1; }
  test -f /usr/local/share/ttyd/term.html || { echo "term.html NOT installed"; exit 1; }
  # Installing term.html is what this script does; SERVING it is clipboard-upload
  # (:7683), whose exact-path whitelist must carry a /term.html entry. That
  # service is shared with the stable tier and is released by deploy.sh, not
  # here — so report the status, do not gate the deploy on it. A curl that
  # cannot connect at all reports 000 rather than failing a deploy that already
  # succeeded: this script does not own that service.
  code=$(curl -s -m 5 -o /dev/null -w "%{http_code}" http://localhost:7683/term.html || echo 000)
  [ "$code" = "200" ] && echo "clipboard-upload serving /term.html OK" || echo "NOTE: /term.html -> $code — installed, but clipboard-upload has not been released with the whitelist entry yet (the SPA Terminal view stays blank until it is)"
VERIFY
echo "==> Done. The lobby SPA is live on :${REMOTE_PORT} (terminal.viktorbarzin.me)."
echo "    Roll back: sudo install -m 0644 /usr/local/share/ttyd/index.html.prev \\"
echo "                 /usr/local/share/ttyd/index.html && sudo systemctl restart ttyd"
