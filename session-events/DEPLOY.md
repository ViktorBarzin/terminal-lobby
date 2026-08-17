# session-events — deploy & the shared-impact gate

`session-events` (pillar #1) backs the v2 SPA's Text view: the normalized SSE
transcript stream plus the prompt/cancel control channel. It is **deployed and
live** on `terminal.viktorbarzin.me`. The vanilla page never
calls it, which is what keeps its blast radius to v2 only.

## Release path

`./scripts/deploy-services.sh` cross-builds and installs session-events (and
file-api) on the devvm. It skips the restart when the binary is unchanged —
this service holds every Text-view client's SSE stream open, so a no-op deploy
must not drop them.

```bash
./scripts/deploy-services.sh                  # cross-build + install both
SKIP_BUILD=1 ./scripts/deploy-services.sh     # reuse ./out/ binaries
```

The unit file is `devvm/session-events.service`; smoke with
`curl -s localhost:7685/health` → `ok`. Presence-claim the devvm before any
install.

## What is wired today

| Piece | State |
|---|---|
| systemd unit on the devvm | installed, `enable --now`, listening on `:7685` |
| Ingress | `terminal.viktorbarzin.me` routes `PathPrefix(/events/)`, `/prompt/`, `/cancel/`, `/earlier/`, `/result/`, `/pane/`, `/keys/` and `/commands/` here behind Authentik (`infra/stacks/terminal/main.tf`). No strip — the service serves those at its root |
| `SessionStart` hook | wired org-wide: `/usr/local/bin/claude-se-hook session-start` in `/etc/claude-code/managed-settings.json`, installed by `scripts/deploy.sh`. It registers (user, tmux session) so the SSE handler can find the transcript to tail |

`/hooks/*` is **never** routed publicly, and the session-start handler is
additionally hard-gated to loopback in `main.go` — it runs as the OS user on
this box, so the ingress is not its only guard.

## Removed: web-mediated permissions (575d4f5, 2026-07-21)

The `PreToolUse` half of this service — a broker that asked the web client to
approve each tool call — was **removed**, not disabled. Earlier revisions of
this file told operators to wire a permission-request hook and to expose the
resolve route through the ingress. Do not follow that from the history:

- the broker answered "ask" for any session nobody was watching in Text mode,
  and a `PreToolUse` "ask" **overrides** the allowlist / permission mode rather
  than deferring to the normal flow — so with v2 paused it forced a permission
  prompt on **every** tool call in **every** session on the shared devvm
  (wizard, emo, ancamilea);
- the fall-through that was supposed to contain that is what caused it. This
  file used to describe "fail-closed + fall-through (ask when no web client)"
  as a containment measure; it was the failure mode, and the sentence is
  withdrawn.

Gone with the broker: its hook and resolve routes, `registry.permResolve`,
`fileSource.subscriberCount`, and the ingress route that fronted them.
`claude-se-hook` is session-start-only. The `permission_request` /
`permission_resolved` event kinds survive in `event.go` as unused vocabulary,
as do the client-side `PermissionPanel.tsx` + `permissionUrl()` in frontend-v2
(both annotated as inert, kept for a possible gated re-enable).

**Any `PreToolUse` wiring needs Viktor's explicit go.** It fires in every Claude
session of every user on this box and is *blocking*: a misconfig adds latency or
stalls tool calls box-wide. A revival needs a per-session gate — "only ask when
this session is actually being watched" — designed first.
