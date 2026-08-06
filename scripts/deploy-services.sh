#!/usr/bin/env bash
# Deploy the two v2-ONLY backends — session-events (:7685) and file-api (:7686)
# — to the DevVM. Companion to scripts/deploy.sh (the vanilla frontend + the
# SHARED backends) and scripts/deploy-v2.sh (the v2 SPA + its ttyd-v2).
#
# Why a third script: these two services were shipped by NEITHER of the other
# two. Both binaries were installed by hand on 2026-08-03, so until now the only
# way to release a change was to remember the scp. This script is that release
# path.
#
# BLAST RADIUS — deliberately narrow. Only the vanilla page's absence of any
# call to these services makes automated release safe here:
#   session-events  :7685  v2 only — the vanilla page never opens /events
#   file-api        :7686  v2 only — the vanilla page has no file surface
# so restarting either cannot disturb terminal.viktorbarzin.me or another
# user's session. This script therefore NEVER touches ttyd, ttyd-ro, tmux-api
# or clipboard-upload: those are shared with the stable tier and are out of
# scope for automated release (release them with deploy.sh, deliberately).
#
# A restart is skipped entirely when nothing changed — session-events holds
# every text-view client's SSE stream open, and a no-op deploy must not drop
# them.
#
# Usage:
#   ./scripts/deploy-services.sh                    # build + deploy
#   DEVVM=10.0.10.10 ./scripts/deploy-services.sh   # override host
#   SKIP_BUILD=1 ./scripts/deploy-services.sh       # reuse ./out/ binaries
#
# Requires SSH access as wizard@DEVVM with passwordless sudo (existing setup;
# see devvm/sudoers.d-ttyd-users).
set -euo pipefail

DEVVM="${DEVVM:-10.0.10.10}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SERVICES=(session-events file-api)

if [[ -z "${SKIP_BUILD:-}" ]]; then
  echo "==> Building Go binaries (linux/amd64)..."
  mkdir -p out
  # buildID rides in via -ldflags exactly as deploy.sh does it, so every usage
  # event carries the release it came from (service.version).
  GO_LDFLAGS="-X main.buildID=$(git -C "$ROOT" rev-parse --short HEAD)"
  for svc in "${SERVICES[@]}"; do
    (cd "$svc" && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -ldflags "$GO_LDFLAGS" -o "../out/$svc" .)
  done
fi
for svc in "${SERVICES[@]}"; do
  test -f "out/$svc" || { echo "out/$svc missing — build failed (or SKIP_BUILD=1 with no prior build)"; exit 1; }
done

echo "==> Staging on $DEVVM..."
scp -o BatchMode=yes \
  out/session-events \
  out/file-api \
  devvm/session-events.service \
  devvm/file-api.service \
  "wizard@${DEVVM}:/tmp/"

echo "==> Installing on $DEVVM..."
ssh -o BatchMode=yes "wizard@${DEVVM}" bash -se <<'REMOTE'
  set -euo pipefail
  # Per service: install the binary and the unit only when they actually
  # differ, and remember whether either did. A byte-identical re-install is
  # not free — it is what forces the restart below, and a session-events
  # restart drops every open SSE stream (each text-view client reconnects and
  # re-tails its transcript). Same reasoning as deploy-v2.sh's index skip.
  restart=()
  for svc in session-events file-api; do
    changed=0
    if sudo cmp -s "/tmp/$svc" "/usr/local/bin/$svc"; then
      echo "    $svc binary unchanged — leaving it alone"
    else
      sudo install -m 0755 "/tmp/$svc" "/usr/local/bin/$svc"
      changed=1
    fi
    if sudo cmp -s "/tmp/$svc.service" "/etc/systemd/system/$svc.service"; then
      echo "    $svc.service unchanged"
    else
      sudo install -m 0644 "/tmp/$svc.service" "/etc/systemd/system/$svc.service"
      changed=1
    fi
    if [[ "$changed" == "1" ]]; then
      restart+=("$svc")
    fi
  done
  # daemon-reload can transiently time out when the devvm is under heavy
  # interactive load (D-Bus slow to answer); retry once before giving up.
  sudo systemctl daemon-reload || { sleep 3; sudo systemctl daemon-reload; }
  # enable --now unconditionally: a unit that is stopped or was never enabled
  # must come up even on a deploy that changed nothing.
  sudo systemctl enable --now session-events file-api
  if (( ${#restart[@]} > 0 )); then
    echo "    restarting: ${restart[*]}"
    sudo systemctl restart "${restart[@]}"
  else
    echo "    nothing changed — no restart (open SSE streams keep running)"
  fi
  rm -f /tmp/session-events /tmp/file-api /tmp/session-events.service /tmp/file-api.service
REMOTE

echo "==> Verifying..."
# Two probes per service: /health (unauthenticated by design in both — see the
# root mux in session-events/main.go and file-api/main.go) proves the process
# is up, and an unauthenticated hit on the AUTHED surface proves the auth
# middleware is still mounted in front of it. -m bounds every request so a
# wedged service fails the deploy instead of hanging it.
ssh -o BatchMode=yes "wizard@${DEVVM}" '
  set -euo pipefail
  systemctl is-active session-events file-api
  curl -sf -m 5 http://localhost:7685/health >/dev/null && echo "session-events OK" || { echo "session-events /health FAILED"; exit 1; }
  curl -sf -m 5 http://localhost:7686/health >/dev/null && echo "file-api OK"       || { echo "file-api /health FAILED"; exit 1; }
  code=$(curl -s -m 5 -o /dev/null -w "%{http_code}" http://localhost:7685/events/_deploy_probe || echo 000)
  [ "$code" = "401" ] && echo "session-events authed surface gated OK" || { echo "session-events /events unauthenticated -> $code, want 401"; exit 1; }
  code=$(curl -s -m 5 -o /dev/null -w "%{http_code}" "http://localhost:7686/files/list?path=/" || echo 000)
  [ "$code" = "401" ] && echo "file-api authed surface gated OK"       || { echo "file-api /files/list unauthenticated -> $code, want 401"; exit 1; }
'
echo "==> Done. session-events :7685 + file-api :7686 live. Routing lives in infra stacks/terminal (terminal-dev.viktorbarzin.me)."
