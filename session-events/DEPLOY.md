# session-events — deploy & the shared-impact gate

`session-events` (pillar #1) is **built, tested, and landed**, but deploying it
*meaningfully* is a **gated** step, because two parts touch shared state on the
multi-user devvm (wizard **and bob**). Do not activate them without Viktor's OK.

## Safe / dormant (auto-deployable)
1. Cross-build + ship the binary and install the unit:
   - `GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o out/session-events ./session-events`
   - scp to the devvm, `install -m0755` → `/usr/local/bin/session-events`
   - `install -m0644 devvm/session-events.service /etc/systemd/system/`, `daemon-reload`, `enable --now`
   - smoke: `curl -s localhost:7685/health` → `ok`
   This is **dormant**: nothing routes to it (no ingress yet) and no hooks post to
   it, so it just idles. Safe on the shared box.

## GATED — needs Viktor's explicit go (shared impact on bob + latency)
2. **Claude Code hook wiring** (org-wide `managed-settings.json`, infra
   `scripts/workstation/`): adding
   - `SessionStart` → `curl -s -m2 localhost:7685/hooks/session-start -d "{\"user\":\"$USER\",\"session_id\":\"$CLAUDE_SESSION_ID\",\"cwd\":\"$PWD\",\"tmux_session\":\"$(tmux display -p '#S')\"}" || true`
   - `PreToolUse` / `PermissionRequest` → POST `/hooks/permission-request` and honor the returned `permissionDecision`.

   **Why gated:** this fires in **every** Claude session of **every** user
   (incl. bob), and the permission hook is *blocking* — a misconfig adds latency
   or (worst case) stalls tool calls box-wide. The service's fail-closed +
   fall-through (ask when no web client) contain it, but the blast radius is shared.
3. **Ingress route** (`infra/stacks/terminal/`): expose only the authed paths
   (`/events`, `/permission`, `/prompt`, `/cancel`) → devvm:7685 behind
   Authentik. **Never** route `/hooks/*`.

## Live promotion
Only meaningful once **pillar #2 (frontend-v2)** consumes the stream. Until then,
keep steps 2–3 unshipped. Presence-claim the devvm before any install; deploy
behind the canary + golden-master gate per the v2 roadmap.
