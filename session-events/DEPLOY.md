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
| Ingress | `terminal.viktorbarzin.me` routes `PathPrefix(/events/)`, `/prompt/`, `/cancel/`, `/earlier/`, `/result/`, `/pane/`, `/keys/`, `/commands/`, `/search/`, `/answer-text/` and `/model/` here behind Authentik (`infra/stacks/terminal/main.tf`). No strip — the service serves those at its root. **`/answer/` is in that rule but not yet live** (checked 2026-09-11): `infra` carries it at `stacks/terminal/main.tf:500`, committed and pushed as `e8a02463`, but that commit's pipeline (`#1633`) errored, and the live IngressRoute still lists the eleven prefixes without it — `kubectl get ingressroute session-events -n terminal` is the check. So nothing needs editing in Terraform; the apply needs to land, and it will not land on its own: `.woodpecker/default.yml` applies only the stacks a commit changed (it diffs against the previous commit on a depth-2 clone), so later green pipelines skip `stacks/terminal/` entirely. Re-running `#1633`, or any new commit touching that stack, is what applies it. **Why `#1633` errored, found 2026-09-11:** Woodpecker could not reach Forgejo to fetch the pipeline config, so no step ran at all. At 22:08:05-22:08:08, the moment of the push, its log has `configFetcher: fallback did not find config` wrapping `dial tcp 10.111.111.95:443: connect: connection refused` against the Forgejo API, repeated on each retry. (The URL is spelled out in Loki; it is elided here because this file's route table is parsed by `TestDeployDocNamesOnlyRegisteredRoutes`, which reads any quoted path as a route this service claims to serve.) That is why no `[terminal] Starting apply...` line exists for it — the apply loop was never reached, and there is no step log to read. The refusal was not Forgejo's: `10.111.111.95` is the `traefik` service's ClusterIP (its websecure port), and the Forgejo pod never restarted, 4d6h uptime at the time of checking. All three Traefik pods and both error-pages pods started at 21:55 that evening, thirteen minutes before the push, rolled by `infra` commit `37ecd1db` "Raise memory limits on loki, traefik, error-pages and reloader" — but the ingress was NOT still rolling when the fetch failed: all three Traefik pods reached Ready by 21:55:56, and Traefik logged 37 lines in the 32 seconds around the refusal, serving other clients 200s at 22:07:41 and 22:08:11. So the rollout is adjacent, not the proximate cause. What fits the evidence is that the refusal was specific to the Woodpecker-to-Traefik path and outlasted the rollout by 45 minutes: `woodpecker-server-0` has run since 2026-09-04 with no restarts, and the Traefik pods changed IPs at 21:55, so stale endpoints looked like the mechanism. They were not, and the real one was already recorded: this is the fourth occurrence of a known Traefik 443 merge-key drift, documented at `infra/stacks/traefik/modules/traefik/main.tf:218`. The service's `websecure` TCP 443 entry and the `websecure-http3` UDP 443 entry share a port number, which Kubernetes uses as the strategic-merge key for service ports, so the two collide and TCP 443 can come back pointing at a target name no TCP container port declares. Endpoints then carry no TCP 443 subset, and a ClusterIP with zero endpoints rejects — the connection refused, exactly. It also explains the confusing part: Traefik kept answering other clients 200 throughout, because HTTP/3 over UDP 443 was unaffected. Rolling the pods is what retriggers it, which is where `37ecd1db` comes in. Recovery was a manual `kubectl patch` on that port, not self-healing. Counting every `connection refused` in that namespace over the seven days to 2026-09-11 gives 26 lines in 15 distinct minutes: one per day at 04:00-04:07 as the drift cron starts, two small pairs on 09-06 and 09-08, and then 09-10 at 21:56, 22:08, 22:33 and 22:40. The first of that run lands one minute after the Traefik pods took their new IPs, the last is 22:40, and nothing follows in the remaining three hours of the window. So the rollout is the trigger, through the drift it retriggers rather than through being in progress, and the run ends where the manual patch went in. The service now shows `websecure` TCP 443 targeting `websecure` with three endpoints, so the path is healthy. The window swallowed three pushes, `e8a02463` at 22:08 and the merges at 22:33 and 22:40, each with the same config-fetch failure, so the 04:00 drift run is worth reading for stacks beyond this one. Traefik and Forgejo are both healthy now, so **a plain re-run of `#1633` is the right action** and should now get its config. (Lock contention would have printed `SKIPPED` and passed, and the only `FAILED (exit 1)` in the window is `[forgejo]` on 2026-09-09, unrelated.) Confirming it never ran: the last two `[terminal] planning...` lines in Loki are 2026-09-09 04:24 and 2026-09-10 04:23, both `OK (no changes)` and both BEFORE the commit at 22:08, so the stack has not been planned since — `homelab logs query '{namespace="woodpecker"} |= "[terminal] planning"' --since 48h` says whether that is still true. Those lines are the daily drift job (`.woodpecker/drift-detection.yml:126`, 04:00 UTC), which plans every stack and alerts on what moved but never applies, so the query lags up to a day and the `kubectl` line above stays the instant check. The first drift run after the commit should print `[terminal] planning... DRIFT DETECTED` rather than `OK (no changes)`, since the repo now carries a prefix the cluster does not. That confirms the diagnosis; it does not fix it. Until it does, a tap on the answer card reaches ttyd's catch-all in prod and is answered 200 with the SPA's index.html, so the card reports the request as failed. The dev proxy and the container's nginx already carry it |
| `SessionStart` hook | wired org-wide: `/usr/local/bin/claude-se-hook session-start` in `/etc/claude-code/managed-settings.json`, installed by `scripts/deploy.sh`. It registers (user, tmux session, transcript) so the SSE handler can find the transcript to tail. The path comes from the hook payload's `transcript_path` — Claude Code files a session under the directory it STARTED in, so a path rebuilt from the session's current cwd is wrong the moment it cds |

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
  (wizard, bob, carol);
- the fall-through that was supposed to contain that is what caused it. This
  file used to describe "fail-closed + fall-through (ask when no web client)"
  as a containment measure; it was the failure mode, and the sentence is
  withdrawn.

Gone with the broker: its hook and resolve routes, `registry.permResolve`,
`fileSource.subscriberCount`, and the ingress route that fronted them.
`claude-se-hook` is session-start-only. The `permission_request` /
`permission_resolved` event kinds survive in `event.go` as unused vocabulary,
as does the client-side `PermissionPanel.tsx` in frontend-v2 (annotated as
inert, kept for a possible gated re-enable). The URL builder it posted to,
`permissionUrl()`, was deleted on 2026-09-06 because the route it addressed is
not routed, so every Allow and Deny it produced was a 404. A gated re-enable
rebuilds it.

**Any `PreToolUse` wiring needs Viktor's explicit go.** It fires in every Claude
session of every user on this box and is *blocking*: a misconfig adds latency or
stalls tool calls box-wide. A revival needs a per-session gate — "only ask when
this session is actually being watched" — designed first.
