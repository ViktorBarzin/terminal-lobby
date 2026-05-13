#!/usr/bin/env bash
# Manual deploy to the DevVM. This is what `.woodpecker.yml` does inside
# the deploy step — kept as a stand-alone script so it works without CI
# (which is currently TODO; see README).
#
# Usage:
#   ./scripts/deploy.sh                    # full deploy
#   DEVVM=192.0.2.10 ./scripts/deploy.sh   # override host
#   SKIP_BUILD=1 ./scripts/deploy.sh       # use pre-built binaries from ./out/
#
# Requires SSH access as wizard@DEVVM with passwordless sudo (existing
# setup; see devvm/sudoers.d-ttyd-users for the per-user rules).
set -euo pipefail

DEVVM="${DEVVM:-192.0.2.10}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -z "${SKIP_BUILD:-}" ]]; then
  echo "==> Building Go binaries (linux/amd64)..."
  mkdir -p out
  (cd tmux-api          && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o ../out/tmux-api          .)
  (cd clipboard-upload  && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o ../out/clipboard-upload  .)
fi

echo "==> Staging files on $DEVVM..."
scp -o BatchMode=yes \
  out/tmux-api \
  out/clipboard-upload \
  frontend/index.html \
  devvm/tmux-attach.sh \
  devvm/ttyd-user-map \
  devvm/sudoers.d-ttyd-users \
  devvm/ttyd.service \
  devvm/ttyd-ro.service \
  devvm/tmux-api.service \
  devvm/clipboard-upload.service \
  devvm/clipboard-cleanup.service \
  devvm/clipboard-cleanup.timer \
  "wizard@${DEVVM}:/tmp/"

echo "==> Installing on $DEVVM..."
ssh -o BatchMode=yes "wizard@${DEVVM}" 'bash -se' <<'REMOTE'
  set -euo pipefail
  sudo install -m 0755 /tmp/tmux-api         /usr/local/bin/tmux-api
  sudo install -m 0755 /tmp/clipboard-upload /usr/local/bin/clipboard-upload
  sudo install -m 0755 /tmp/tmux-attach.sh   /usr/local/bin/tmux-attach.sh
  sudo install -m 0644 /tmp/index.html       /usr/local/share/ttyd/index.html
  sudo install -m 0644 /tmp/ttyd-user-map    /etc/ttyd-user-map
  sudo install -m 0440 -o root -g root /tmp/sudoers.d-ttyd-users /etc/sudoers.d/ttyd-users
  sudo visudo -cf /etc/sudoers.d/ttyd-users
  for u in ttyd ttyd-ro tmux-api clipboard-upload clipboard-cleanup; do
    sudo install -m 0644 /tmp/$u.service /etc/systemd/system/$u.service
  done
  sudo install -m 0644 /tmp/clipboard-cleanup.timer /etc/systemd/system/clipboard-cleanup.timer
  sudo systemctl daemon-reload
  sudo systemctl restart ttyd ttyd-ro tmux-api clipboard-upload
  sudo systemctl enable --now clipboard-cleanup.timer
  rm -f /tmp/tmux-api /tmp/clipboard-upload /tmp/tmux-attach.sh /tmp/index.html
  rm -f /tmp/ttyd-user-map /tmp/sudoers.d-ttyd-users
  rm -f /tmp/ttyd.service /tmp/ttyd-ro.service /tmp/tmux-api.service
  rm -f /tmp/clipboard-upload.service /tmp/clipboard-cleanup.service /tmp/clipboard-cleanup.timer
REMOTE

echo "==> Verifying..."
ssh -o BatchMode=yes "wizard@${DEVVM}" '
  systemctl is-active ttyd ttyd-ro tmux-api clipboard-upload
  curl -sf -H "X-Authentik-Username: alice" http://localhost:7684/whoami >/dev/null && echo "tmux-api OK"
  curl -sf http://localhost:7683/health >/dev/null && echo "clipboard-upload OK"
'
echo "==> Done."
