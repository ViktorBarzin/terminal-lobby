#!/usr/bin/env bash
# Manual deploy to the DevVM. This is what `.woodpecker.yml` does inside
# the deploy step — kept as a stand-alone script so it works without CI
# (which is currently TODO; see README).
#
# Usage:
#   ./scripts/deploy.sh                    # full deploy
#   DEVVM=10.0.10.10 ./scripts/deploy.sh   # override host
#   SKIP_BUILD=1 ./scripts/deploy.sh       # use pre-built binaries from ./out/
#
# Requires SSH access as wizard@DEVVM with passwordless sudo (existing
# setup; see devvm/sudoers.d-ttyd-users for the per-user rules).
set -euo pipefail

DEVVM="${DEVVM:-10.0.10.10}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -z "${SKIP_BUILD:-}" ]]; then
  echo "==> Building Go binaries (linux/amd64)..."
  mkdir -p out
  (cd tmux-api          && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o ../out/tmux-api          .)
  (cd clipboard-upload  && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o ../out/clipboard-upload  .)
fi

# Locally-patched ttyd (devvm/ttyd-local.patch: pixel size → pty so tmux
# re-emits sixel, docs/adr/0004-sixel-images-in-the-terminal.md; + honor
# client PAUSE flow control, upstream no-op; + serve the -I index with an
# ETag + Cache-Control: no-cache so boots revalidate instead of
# re-downloading the ~500 KB frontend) is shipped only when a build
# exists. Building is scripts/build-ttyd.sh's explicit job; deploy just
# ships what's there.
TTYD_BIN=""
if [[ -f out/ttyd ]]; then
  TTYD_BIN="out/ttyd"
  echo "==> Including patched ttyd binary (out/ttyd)"
else
  echo "==> No out/ttyd — skipping ttyd binary (./scripts/build-ttyd.sh to build it)"
fi

echo "==> Stamping frontend build id..."
REV=$(git -C "$ROOT" rev-parse --short HEAD)
mkdir -p out
sed "s/__TL_BUILD__/${REV}/" frontend/index.html > out/index.html

# Web Push VAPID keypair (Notifications Part 2): fetched from Vault at deploy
# time and installed as a systemd EnvironmentFile, so the private key never
# lives in the repo or an image. Absent secret → Web Push stays dark (GET
# /push/vapid-public 404s and the frontend falls back to foreground-only
# notifications) and the deploy still succeeds. $VAPID_ENV rides the scp list
# unquoted (empty = zero words = skipped), mirroring $TTYD_BIN.
echo "==> Fetching VAPID keys from Vault..."
VAPID_ENV=""
if vault kv get secret/terminal-lobby/vapid >/dev/null 2>&1; then
  {
    printf 'VAPID_PUBLIC_KEY=%s\n'  "$(vault kv get -field=public_key  secret/terminal-lobby/vapid)"
    printf 'VAPID_PRIVATE_KEY=%s\n' "$(vault kv get -field=private_key secret/terminal-lobby/vapid)"
    printf 'VAPID_SUBJECT=%s\n'     "$(vault kv get -field=subject     secret/terminal-lobby/vapid)"
  } > out/vapid.env
  chmod 600 out/vapid.env
  VAPID_ENV="out/vapid.env"
  echo "==> VAPID keys staged (out/vapid.env) — Web Push enabled"
else
  echo "==> No secret/terminal-lobby/vapid in Vault — Web Push disabled (foreground notifications unaffected)"
fi

echo "==> Staging files on $DEVVM..."
# $TTYD_BIN is intentionally unquoted: empty expands to zero words
# (file skipped), non-empty is a single shell-safe path.
scp -o BatchMode=yes \
  $TTYD_BIN \
  $VAPID_ENV \
  out/tmux-api \
  out/clipboard-upload \
  out/index.html \
  frontend/sw.js \
  frontend/manifest.webmanifest \
  frontend/icon-192.png \
  frontend/icon-512.png \
  frontend/icon-512-maskable.png \
  frontend/fonts/JetBrainsMono-Regular.woff2 \
  frontend/fonts/JetBrainsMono-Bold.woff2 \
  frontend/fonts/JetBrainsMono-Italic.woff2 \
  frontend/fonts/JetBrainsMono-BoldItalic.woff2 \
  frontend/fonts/dm-sans-latin-wght-normal.woff2 \
  frontend/fonts/tl-symbols.woff2 \
  devvm/tmux-attach.sh \
  devvm/tmux-user-attach \
  devvm/tmux-user-dirlist \
  devvm/tmux-restore-user \
  devvm/claude-tmux-state \
  devvm/show-image \
  devvm/clipboard-store-clean \
  devvm/ttyd-user-map \
  devvm/tmux.conf.system \
  devvm/sudoers.d-ttyd-users \
  devvm/ttyd.service \
  devvm/ttyd-ro.service \
  devvm/tmux-api.service \
  devvm/clipboard-upload.service \
  devvm/clipboard-cleanup.service \
  devvm/clipboard-cleanup.timer \
  "wizard@${DEVVM}:/tmp/"

echo "==> Installing on $DEVVM..."
# INCLUDE_TTYD rides the remote command line (the heredoc is quoted, so
# it can't interpolate); guarding on the flag rather than on a /tmp/ttyd
# stat means a stale binary from an aborted earlier run is never installed.
ssh -o BatchMode=yes "wizard@${DEVVM}" "INCLUDE_TTYD=${TTYD_BIN:+1} STAGE_VAPID=${VAPID_ENV:+1} bash -se" <<'REMOTE'
  set -euo pipefail
  if [[ "${INCLUDE_TTYD:-}" == "1" ]]; then
    # Locally-patched ttyd (sixel pixel-size ADR 0004 + PAUSE flow control
    # + -I index ETag/no-cache, devvm/ttyd-local.patch) — the systemctl
    # restarts below already cover
    # ttyd + ttyd-ro, so no extra restart needed. Keep the previous binary
    # aside first: /usr/local/bin/ttyd.prev is the fastest rollback channel
    # (reinstall it + restart ttyd ttyd-ro — no rebuild needed).
    if [[ -f /usr/local/bin/ttyd ]]; then
      sudo cp -f /usr/local/bin/ttyd /usr/local/bin/ttyd.prev
    fi
    sudo install -m 0755 /tmp/ttyd /usr/local/bin/ttyd
    rm -f /tmp/ttyd
  fi
  sudo install -m 0755 /tmp/tmux-api         /usr/local/bin/tmux-api
  sudo install -m 0755 /tmp/clipboard-upload /usr/local/bin/clipboard-upload
  sudo install -m 0755 /tmp/tmux-attach.sh   /usr/local/bin/tmux-attach.sh
  sudo install -m 0755 /tmp/tmux-user-attach /usr/local/bin/tmux-user-attach
  sudo install -m 0755 /tmp/tmux-user-dirlist /usr/local/bin/tmux-user-dirlist
  sudo install -m 0755 /tmp/tmux-restore-user /usr/local/bin/tmux-restore-user
  sudo install -m 0755 /tmp/claude-tmux-state /usr/local/bin/claude-tmux-state
  sudo install -m 0755 /tmp/show-image        /usr/local/bin/show-image
  sudo install -m 0755 /tmp/clipboard-store-clean /usr/local/bin/clipboard-store-clean
  # Per-user sidebar layout store — owned by the tmux-api service user.
  sudo install -d -o wizard -g wizard -m 0700 /var/lib/tmux-api /var/lib/tmux-api/layout
  # Per-(user, session) image store — owned by the clipboard-upload service
  # user; world-readable by design (ADR-0005: isolation is API-enforced,
  # OS-level reads follow OS permissions).
  sudo install -d -o wizard -g wizard -m 0755 /var/lib/clipboard-store
  sudo install -m 0644 /tmp/index.html               /usr/local/share/ttyd/index.html
  # Push service worker (Item 4): served no-cache by clipboard-upload's
  # /sw.js whitelist entry, reached through the public asset ingress route.
  sudo install -m 0644 /tmp/sw.js                    /usr/local/share/ttyd/sw.js
  sudo install -m 0644 /tmp/manifest.webmanifest     /usr/local/share/ttyd/manifest.webmanifest
  sudo install -m 0644 /tmp/icon-192.png             /usr/local/share/ttyd/icon-192.png
  sudo install -m 0644 /tmp/icon-512.png             /usr/local/share/ttyd/icon-512.png
  sudo install -m 0644 /tmp/icon-512-maskable.png    /usr/local/share/ttyd/icon-512-maskable.png
  # Vendored webfonts (repo frontend/fonts/*.woff2): the SAME files back the
  # repo's @font-face sources and clipboard-upload's exact-path /fonts/ asset
  # whitelist (+ the public ingress carve-out). tl-symbols.woff2 ships for
  # parity but is data-URI-embedded in the page and never served by URL.
  sudo install -d -m 0755 /usr/local/share/ttyd/fonts
  sudo install -m 0644 \
    /tmp/JetBrainsMono-Regular.woff2 \
    /tmp/JetBrainsMono-Bold.woff2 \
    /tmp/JetBrainsMono-Italic.woff2 \
    /tmp/JetBrainsMono-BoldItalic.woff2 \
    /tmp/dm-sans-latin-wght-normal.woff2 \
    /tmp/tl-symbols.woff2 \
    /usr/local/share/ttyd/fonts/
  sudo install -m 0644 /tmp/ttyd-user-map    /etc/ttyd-user-map
  # System tmux conf: RGB terminal feature for xterm* clients (Task 1.14;
  # tmux otherwise down-converts 24-bit SGR to 256 colours for the lobby).
  # Additive — loads before user confs; running servers apply it on their
  # next server start.
  sudo install -m 0644 /tmp/tmux.conf.system /etc/tmux.conf
  sudo install -m 0440 -o root -g root /tmp/sudoers.d-ttyd-users /etc/sudoers.d/ttyd-users
  sudo visudo -cf /etc/sudoers.d/ttyd-users
  for u in ttyd ttyd-ro tmux-api clipboard-upload clipboard-cleanup; do
    sudo install -m 0644 /tmp/$u.service /etc/systemd/system/$u.service
  done
  sudo install -m 0644 /tmp/clipboard-cleanup.timer /etc/systemd/system/clipboard-cleanup.timer
  # VAPID EnvironmentFile for tmux-api (Web Push, Notifications Part 2).
  # Root-owned 0600: systemd reads it before dropping to User=wizard, so the
  # private key isn't readable by the service user. Absent → the unit's
  # EnvironmentFile=- makes it optional (push stays dark).
  sudo install -d -m 0755 /etc/tmux-api
  if [[ "${STAGE_VAPID:-}" == "1" ]]; then
    sudo install -m 0600 -o root -g root /tmp/vapid.env /etc/tmux-api/vapid.env
    rm -f /tmp/vapid.env
  fi
  # daemon-reload can transiently time out when the devvm is under heavy
  # interactive load (D-Bus slow to answer); retry once before giving up.
  sudo systemctl daemon-reload || { sleep 3; sudo systemctl daemon-reload; }
  sudo systemctl restart ttyd ttyd-ro tmux-api clipboard-upload
  sudo systemctl enable --now clipboard-cleanup.timer
  rm -f /tmp/ttyd /tmp/tmux-api /tmp/clipboard-upload /tmp/tmux-attach.sh /tmp/tmux-user-attach /tmp/tmux-user-dirlist /tmp/tmux-restore-user /tmp/claude-tmux-state /tmp/show-image /tmp/clipboard-store-clean /tmp/index.html /tmp/sw.js
  rm -f /tmp/manifest.webmanifest /tmp/icon-192.png /tmp/icon-512.png /tmp/icon-512-maskable.png
  rm -f /tmp/JetBrainsMono-Regular.woff2 /tmp/JetBrainsMono-Bold.woff2 /tmp/JetBrainsMono-Italic.woff2 /tmp/JetBrainsMono-BoldItalic.woff2 /tmp/dm-sans-latin-wght-normal.woff2 /tmp/tl-symbols.woff2
  rm -f /tmp/ttyd-user-map /tmp/tmux.conf.system /tmp/sudoers.d-ttyd-users /tmp/vapid.env
  rm -f /tmp/ttyd.service /tmp/ttyd-ro.service /tmp/tmux-api.service
  rm -f /tmp/clipboard-upload.service /tmp/clipboard-cleanup.service /tmp/clipboard-cleanup.timer
REMOTE

echo "==> Verifying..."
ssh -o BatchMode=yes "wizard@${DEVVM}" '
  systemctl is-active ttyd ttyd-ro tmux-api clipboard-upload
  curl -sf -H "X-Authentik-Username: vbarzin" http://localhost:7684/whoami >/dev/null && echo "tmux-api OK"
  curl -sf http://localhost:7684/push/vapid-public >/dev/null && echo "Web Push VAPID endpoint OK" || echo "Web Push dark (no VAPID key configured)"
  curl -sf http://localhost:7683/health >/dev/null && echo "clipboard-upload OK"
  curl -sf http://localhost:7683/manifest.webmanifest >/dev/null && curl -sf http://localhost:7683/fonts/JetBrainsMono-Regular.woff2 >/dev/null && curl -sf http://localhost:7683/sw.js >/dev/null && echo "public assets OK"
'
echo "==> Done."
