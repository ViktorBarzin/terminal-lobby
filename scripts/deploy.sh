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
  # buildID rides in via -ldflags so every usage event carries the release it
  # came from (service.version), the same revision the frontend is stamped
  # with below — a behaviour change in the numbers can be traced to a deploy.
  GO_LDFLAGS="-X main.buildID=$(git -C "$ROOT" rev-parse --short HEAD)"
  (cd tmux-api          && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -ldflags "$GO_LDFLAGS" -o ../out/tmux-api          .)
  (cd clipboard-upload  && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -ldflags "$GO_LDFLAGS" -o ../out/clipboard-upload  .)
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

echo "==> Stamping frontend build id + asset fingerprint..."
# TWO stamps, deliberately different things (ADR-0007):
#   TL_BUILD — PROVENANCE. The git short SHA: which commit is deployed. Read by
#     telemetry and printed to the console; it moves on every deploy.
#   TL_ASSET — UPDATE IDENTITY. A fingerprint of the frontend's OWN content,
#     computed from the UNSTAMPED source (both placeholders still in place), so
#     it moves if and only if the page a user runs actually changed. A
#     backend-only deploy therefore ships an identical id and no client updates
#     — which is the whole point: the pill used to fire on every commit,
#     including the 55% that never touched this file. Hashing the SOURCE rather
#     than a git object also catches a deploy of uncommitted frontend edits,
#     which deploy.sh has always supported (it seds the working tree, not HEAD).
REV=$(git -C "$ROOT" rev-parse --short HEAD)
mkdir -p out
# The shared diagnostics core (frontend/diag.js, ADR-0008) is inlined FIRST, and
# the asset id is computed AFTER that but BEFORE the two stamps. That ordering
# is what keeps ADR-0007's rule literally true — the id is a fingerprint of the
# page's own unstamped content — now that part of the page comes from another
# file. Hashing index.html alone would leave the id unmoved by a diagnostics
# change, so no open tab would ever self-update to a fixed diag.js: ADR-0007's
# failure mode inverted. `r` reads the file verbatim, so diag.js needs no
# escaping of &, \ or / the way a sed replacement string would.
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
sed -e '/__TL_DIAG__/{r frontend/diag.js' -e 'd;}' frontend/index.html > out/index.pre
if grep -q '__TL_DIAG__' out/index.pre; then
  echo "deploy.sh: __TL_DIAG__ placeholder survived — diagnostics would be dead" >&2
  exit 1
fi
assert_diag_executable out/index.pre
ASSET=$(sha256sum out/index.pre | cut -c1-12)
sed -e "s/__TL_BUILD__/${REV}/g" -e "s/__TL_ASSET__/${ASSET}/g" out/index.pre > out/index.html
rm -f out/index.pre
# A surviving placeholder means the page ships without an identity: detection
# reads it as "no information" and the app would never self-update again. Fail
# the deploy instead of shipping a silently un-updatable page.
if grep -q '__TL_[A-Z]*__' out/index.html; then
  echo "deploy.sh: unsubstituted __TL_*__ placeholder in out/index.html" >&2
  exit 1
fi
echo "    build=${REV} asset=${ASSET}"

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
  devvm/tmux-user-setfacl \
  devvm/tmux-restore-user \
  devvm/tmux-persist-forget \
  devvm/claude-tmux-state \
  devvm/claude-se-hook \
  devvm/show-image \
  devvm/clipboard-store-clean \
  devvm/tmux.conf.system \
  devvm/sudoers.d-ttyd-users \
  devvm/ttyd.service \
  devvm/ttyd-ro.service \
  devvm/tmux-api.service \
  devvm/clipboard-upload.service \
  devvm/clipboard-cleanup.service \
  devvm/clipboard-cleanup.timer \
  devvm/tl-pool-warm@.service \
  "wizard@${DEVVM}:/tmp/"

echo "==> Installing on $DEVVM..."
# INCLUDE_TTYD rides the remote command line (the heredoc is quoted, so
# it can't interpolate); guarding on the flag rather than on a /tmp/ttyd
# stat means a stale binary from an aborted earlier run is never installed.
ssh -o BatchMode=yes "wizard@${DEVVM}" "INCLUDE_TTYD=${TTYD_BIN:+1} STAGE_VAPID=${VAPID_ENV:+1} bash -se" <<'REMOTE'
  set -euo pipefail
  # ACL tooling for project co-ownership (idempotent; no-op when already present).
  command -v setfacl >/dev/null 2>&1 || { sudo apt-get update -qq && sudo apt-get install -y acl; }
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
  sudo install -m 0755 /tmp/tmux-user-setfacl /usr/local/bin/tmux-user-setfacl
  sudo install -m 0755 /tmp/tmux-restore-user /usr/local/bin/tmux-restore-user
  sudo install -m 0755 /tmp/tmux-persist-forget /usr/local/bin/tmux-persist-forget
  sudo install -m 0755 /tmp/claude-tmux-state /usr/local/bin/claude-tmux-state
  sudo install -m 0755 /tmp/claude-se-hook    /usr/local/bin/claude-se-hook
  sudo install -m 0755 /tmp/show-image        /usr/local/bin/show-image
  sudo install -m 0755 /tmp/clipboard-store-clean /usr/local/bin/clipboard-store-clean
  # Per-user sidebar layout store — owned by the tmux-api service user.
  sudo install -d -o wizard -g wizard -m 0700 /var/lib/tmux-api /var/lib/tmux-api/layout
  # Per-(user, session) image store — owned by the clipboard-upload service
  # user; world-readable by design (ADR-0005: isolation is API-enforced,
  # OS-level reads follow OS permissions).
  sudo install -d -o wizard -g wizard -m 0755 /var/lib/clipboard-store
  # Skip a byte-identical re-install: ttyd's ETag is size+mtime (NOT a content
  # hash), so an unconditional install bumps mtime and turns every client's
  # cheap 304 poll into a full ~800 KB 200 for no content change.
  # The LOBBY PAGE IS NOT SHIPPED HERE ANY MORE. terminal.viktorbarzin.me now
  # serves the v2 SPA, promoted by `scripts/deploy-v2.sh --prod` — the same
  # artifact that soaked on the canary. Installing frontend/index.html here
  # would silently undo that promotion on the next backend deploy, which is the
  # one way a cutover quietly reverts itself. The vanilla page stays in the repo
  # (and as index.html.prev on the box) purely as the rollback.
  echo "    lobby page: not shipped by deploy.sh — see scripts/deploy-v2.sh --prod"
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
  # NO ttyd-user-map here. `/etc/ttyd-user-map` (and `/etc/ttyd-admins`) are
  # GENERATED from `infra/scripts/workstation/roster.yaml` by roster_engine.py,
  # installed by the hourly t3-provision-users reconcile. This script used to
  # install a copy carried in this repo, which outranked the generated file on
  # every deploy: by 2026-08-17 that copy had gone stale and would have dropped
  # `ancaelena98=carol`, locking that user out of the lobby until the next
  # reconcile. Adding a user is a roster edit; if the map is missing on a fresh
  # box, run the reconcile rather than recreating it from here.
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
  # Pre-warmed session slots. A USER unit (/etc/systemd/user), because a slot
  # lives in the user's own tmux server and must be parented to their manager —
  # the same reason tmux-user-attach exists at all. Installing the template is
  # inert on its own: nothing warms until a user enables an instance for a
  # directory, and the claim in tmux-user-attach simply misses until then.
  sudo install -d -m 0755 /etc/systemd/user
  sudo install -m 0644 /tmp/tl-pool-warm@.service /etc/systemd/user/tl-pool-warm@.service
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
  # User managers hold their own unit cache, so the system reload above does not
  # reach them. Reload each running one so an enabled instance picks up a changed
  # template without waiting for that user to log out.
  for uid in $(loginctl list-users --no-legend 2>/dev/null | awk '{print $1}'); do
    sudo systemctl --machine="$uid@.host" --user daemon-reload 2>/dev/null || true
  done
  sudo systemctl restart ttyd ttyd-ro tmux-api clipboard-upload
  sudo systemctl enable --now clipboard-cleanup.timer
  rm -f /tmp/ttyd /tmp/tmux-api /tmp/clipboard-upload /tmp/tmux-attach.sh /tmp/tmux-user-attach /tmp/tmux-user-dirlist /tmp/tmux-user-setfacl /tmp/tmux-restore-user /tmp/tmux-persist-forget /tmp/claude-tmux-state /tmp/claude-se-hook /tmp/show-image /tmp/clipboard-store-clean /tmp/index.html /tmp/sw.js
  rm -f /tmp/manifest.webmanifest /tmp/icon-192.png /tmp/icon-512.png /tmp/icon-512-maskable.png
  rm -f /tmp/JetBrainsMono-Regular.woff2 /tmp/JetBrainsMono-Bold.woff2 /tmp/JetBrainsMono-Italic.woff2 /tmp/JetBrainsMono-BoldItalic.woff2 /tmp/dm-sans-latin-wght-normal.woff2 /tmp/tl-symbols.woff2
  rm -f /tmp/tmux.conf.system /tmp/sudoers.d-ttyd-users /tmp/vapid.env
  rm -f /tmp/ttyd.service /tmp/ttyd-ro.service /tmp/tmux-api.service
  rm -f /tmp/clipboard-upload.service /tmp/clipboard-cleanup.service /tmp/clipboard-cleanup.timer
  rm -f /tmp/tl-pool-warm@.service
REMOTE

echo "==> Verifying..."
ssh -o BatchMode=yes "wizard@${DEVVM}" '
  systemctl is-active ttyd ttyd-ro tmux-api clipboard-upload
  # The identity map is not ours to install (see the note above), but every
  # service here is useless without it — an absent map denies everyone, with no
  # fallback. Report it rather than let a deploy look clean while nobody can log
  # in; the fix is the infra reconcile, not a file in this repo.
  if [[ -r /etc/ttyd-user-map ]] && grep -qE "^[^#[:space:]]+=" /etc/ttyd-user-map; then
    echo "identity map OK ($(grep -cE "^[^#[:space:]]+=" /etc/ttyd-user-map) users)"
  else
    echo "WARNING: /etc/ttyd-user-map is missing or has no mappings — every login will be denied."
    echo "         It is generated from infra/scripts/workstation/roster.yaml; run"
    echo "         sudo /home/wizard/code/infra/scripts/t3-provision-users.sh to reconcile."
  fi
  curl -sf -H "X-Authentik-Username: alice" http://localhost:7684/whoami >/dev/null && echo "tmux-api OK"
  curl -sf http://localhost:7684/push/vapid-public >/dev/null && echo "Web Push VAPID endpoint OK" || echo "Web Push dark (no VAPID key configured)"
  curl -sf http://localhost:7683/health >/dev/null && echo "clipboard-upload OK"
  curl -sf http://localhost:7683/manifest.webmanifest >/dev/null && curl -sf http://localhost:7683/fonts/JetBrainsMono-Regular.woff2 >/dev/null && curl -sf http://localhost:7683/sw.js >/dev/null && echo "public assets OK"
'
echo "==> Done."
