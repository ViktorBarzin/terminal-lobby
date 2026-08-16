#!/usr/bin/env bash
# Deploy the two v2-ONLY backends — session-events (:7685) and file-api (:7686)
# — plus the T3 bridge artefacts to the DevVM. Companion to scripts/deploy.sh
# (the vanilla frontend + the SHARED backends) and scripts/deploy-v2.sh (the v2
# SPA + its ttyd-v2).
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
# The T3 bridge half (tl-t3-bridge + tl-t3-sync, see t3-bridge/DEPLOY.md) is in
# scope because it reaches only users who were deliberately enabled: the bridge
# is spawned by a user's own T3 and the syncer runs one per-user unit that an
# operator must enable with a hand-written /etc/tl-t3-sync/<user>.env. This
# script installs and restarts; it never enables a user. SKIP_T3=1 opts out.
#
# A restart is skipped entirely when nothing changed — session-events holds
# every text-view client's SSE stream open, and a no-op deploy must not drop
# them.
#
# Usage:
#   ./scripts/deploy-services.sh                    # build + deploy
#   DEVVM=10.0.10.10 ./scripts/deploy-services.sh   # override host
#   SKIP_BUILD=1 ./scripts/deploy-services.sh       # reuse ./out/ binaries
#   SKIP_T3=1 ./scripts/deploy-services.sh          # services only, no bridge
#
# Requires SSH access as wizard@DEVVM with passwordless sudo (existing setup;
# see devvm/sudoers.d-ttyd-users).
set -euo pipefail

DEVVM="${DEVVM:-10.0.10.10}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SERVICES=(session-events file-api)
# The T3 bridge artefacts, as `<module dir>:<installed binary>`. They carry a
# tl- prefix because they land in /usr/local/bin next to everybody's binaries,
# where "t3-sync" would read as something belonging to T3 itself.
T3_BINARIES=(t3-bridge:tl-t3-bridge t3-sync:tl-t3-sync)

if [[ -z "${SKIP_BUILD:-}" ]]; then
  echo "==> Building Go binaries (linux/amd64)..."
  mkdir -p out
  # buildID rides in via -ldflags exactly as deploy.sh does it, so every usage
  # event carries the release it came from (service.version).
  GO_LDFLAGS="-X main.buildID=$(git -C "$ROOT" rev-parse --short HEAD)"
  for svc in "${SERVICES[@]}"; do
    (cd "$svc" && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -ldflags "$GO_LDFLAGS" -o "../out/$svc" .)
  done
  if [[ -z "${SKIP_T3:-}" ]]; then
    # Same ldflags for both shapes: the linker ignores -X for a symbol the
    # package does not declare, so a binary without main.buildID just skips it.
    for pair in "${T3_BINARIES[@]}"; do
      (cd "${pair%%:*}" && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -ldflags "$GO_LDFLAGS" -o "../out/${pair##*:}" .)
    done
  fi
fi
for svc in "${SERVICES[@]}"; do
  test -f "out/$svc" || { echo "out/$svc missing — build failed (or SKIP_BUILD=1 with no prior build)"; exit 1; }
done
if [[ -z "${SKIP_T3:-}" ]]; then
  for pair in "${T3_BINARIES[@]}"; do
    bin="${pair##*:}"
    test -f "out/$bin" || { echo "out/$bin missing — build failed (or SKIP_BUILD=1 with no prior build)"; exit 1; }
  done
fi

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

# --- the T3 bridge -----------------------------------------------------------
# Two binaries and one TEMPLATE unit, a different shape from the two services
# above, and the differences are why this is its own block:
#   tl-t3-bridge  has no unit at all. T3 spawns it per thread from
#                 providerInstances.claudeAgent.config.binaryPath, so a new
#                 build takes effect at the next spawn and there is nothing to
#                 restart.
#   tl-t3-sync    is a per-user template. Enabling an instance needs a
#                 hand-written /etc/tl-t3-sync/<user>.env carrying that user's
#                 port allocation, so enablement stays an operator decision
#                 (t3-bridge/DEPLOY.md). This script only restarts instances
#                 that are ALREADY enabled.
if [[ -z "${SKIP_T3:-}" ]]; then
  echo "==> Staging the T3 bridge on $DEVVM..."
  scp -o BatchMode=yes \
    out/tl-t3-bridge \
    out/tl-t3-sync \
    devvm/tl-t3-sync@.service \
    devvm/tl-t3-sync.env.example \
    "wizard@${DEVVM}:/tmp/"

  echo "==> Installing the T3 bridge on $DEVVM..."
  ssh -o BatchMode=yes "wizard@${DEVVM}" bash -se <<'REMOTE'
    set -euo pipefail
    changed=0
    for bin in tl-t3-bridge tl-t3-sync; do
      if sudo cmp -s "/tmp/$bin" "/usr/local/bin/$bin"; then
        echo "    $bin unchanged — leaving it alone"
      else
        # install(1) unlinks the destination before writing, so replacing a
        # bridge while T3 has one running is safe: that process keeps the inode
        # it was started from until it exits.
        sudo install -m 0755 "/tmp/$bin" "/usr/local/bin/$bin"
        changed=1
      fi
    done
    if sudo cmp -s /tmp/tl-t3-sync@.service /etc/systemd/system/tl-t3-sync@.service; then
      echo "    tl-t3-sync@.service unchanged"
    else
      sudo install -m 0644 /tmp/tl-t3-sync@.service /etc/systemd/system/tl-t3-sync@.service
      changed=1
    fi
    # The annotated example goes on the box so whoever enables the next user has
    # the key list in front of them. Real per-user files are never written from
    # here: each one carries that user's own port allocation and t3 base dir.
    sudo install -d -m 0755 /etc/tl-t3-sync
    sudo install -m 0644 /tmp/tl-t3-sync.env.example /etc/tl-t3-sync/tl-t3-sync.env.example
    sudo systemctl daemon-reload || { sleep 3; sudo systemctl daemon-reload; }
    # The enabled instances are exactly the wants-symlinks; an unmatched glob
    # stays literal in bash, hence the -e guard.
    enabled=()
    for link in /etc/systemd/system/multi-user.target.wants/tl-t3-sync@*.service; do
      [[ -e "$link" ]] || continue
      enabled+=("$(basename "$link")")
    done
    if (( ${#enabled[@]} == 0 )); then
      echo "    no tl-t3-sync@ instance enabled — nothing to restart (t3-bridge/DEPLOY.md enables a user)"
    elif [[ "$changed" == "1" ]]; then
      # A syncer restart is cheap — it re-mints its bearer and reconciles from a
      # fresh snapshot — but not free, so it happens only when something changed.
      echo "    restarting: ${enabled[*]}"
      sudo systemctl restart "${enabled[@]}"
    else
      echo "    nothing changed — leaving ${enabled[*]} running"
    fi
    rm -f /tmp/tl-t3-bridge /tmp/tl-t3-sync /tmp/tl-t3-sync@.service /tmp/tl-t3-sync.env.example
REMOTE
fi

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
if [[ -z "${SKIP_T3:-}" ]]; then
  ssh -o BatchMode=yes "wizard@${DEVVM}" '
    set -euo pipefail
    # T3 probes a provider by running `<binaryPath> --version` and parsing the
    # output, so this is that exact probe: the bridge hands --version to the real
    # claude and must answer with its version string. It runs as wizard, and the
    # bridge resolves claude per-user, so it proves the path for wizard only —
    # re-run it as each enabled user when adding one (t3-bridge/DEPLOY.md).
    ver=$(timeout 30 /usr/local/bin/tl-t3-bridge --version 2>&1) || { echo "tl-t3-bridge --version FAILED: $ver"; exit 1; }
    case "$ver" in
      *"Claude Code"*) echo "tl-t3-bridge health probe OK ($ver)" ;;
      *) echo "tl-t3-bridge --version -> $ver, want a claude version string"; exit 1 ;;
    esac
    systemctl cat tl-t3-sync@.service >/dev/null && echo "tl-t3-sync@.service installed"
    for link in /etc/systemd/system/multi-user.target.wants/tl-t3-sync@*.service; do
      [ -e "$link" ] || continue
      unit=$(basename "$link")
      systemctl is-active --quiet "$unit" && echo "$unit active" || { echo "$unit NOT active"; exit 1; }
    done
  '
fi
echo "==> Done. session-events :7685 + file-api :7686 live. Routing lives in infra stacks/terminal (terminal-dev.viktorbarzin.me)."
if [[ -z "${SKIP_T3:-}" ]]; then
  echo "    T3 bridge: /usr/local/bin/tl-t3-bridge + tl-t3-sync installed, tl-t3-sync@.service reloaded. Enabling a user: t3-bridge/DEPLOY.md."
fi
