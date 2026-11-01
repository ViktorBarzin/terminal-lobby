# T3 hosts Claude, the lobby lists it

**Status:** approved 2026-10-31, building · **ADR:**
[0046](../adr/0046-t3-hosts-claude-for-each-user.md) · **Supersedes:**
[ADR-0045](../adr/0045-t3-apps-are-clients-of-lobby-sessions.md) and the
framed view of [ADR-0044](../adr/0044-t3-code-renders-a-session-through-its-own-protocol.md)
· **Scope:** `t3client` (new), `tmux-api`, `agent-api`, `frontend-v2`,
`authuser`, `release/`, `packaging/` and CI in this repo; `wa-bot`; in infra
`stacks/t3code`, `stacks/authentik`, `stacks/terminal`, `stacks/monitoring`,
`stacks/k8s-portal`, `scripts/t3-dispatch`, `scripts/workstation` and
`playbooks/devvm.yml`

Viktor, 2026-10-30: *"i'd like to give t3 code another chance. but i'd like to
make it compatible with my terminal lobby. i think it'd be better to base my
terminal lobby sessions on top of t3 and use t3 as the main client."* Then:
*"i'd be happy to fully switch to T3's backend system for managing claude
processes. but i want to be able to manage my t3 sessions via the terminal ui
as i do today."* The next day: *"can we make it per user from day 1? i'd like
the web app and mobile apps to work."* And on the callers: *"we should
integrate with t3 natively. we can rewrite those plugins and connectors."*

## Where we start from

| Fact | Evidence |
|---|---|
| Each lobby user already has a `t3 serve` of their own | `t3-serve@wizard` on :3773, `t3-serve@emo` on :3774, both T3 v0.1.5, state in `/home/<user>/.t3` |
| One `t3 serve` is one environment for one OS user | `apps/server/src/serverOwnership.ts:47`; agents run as the server's user |
| `t3.viktorbarzin.me` serves `tl-t3-view`, the lobby sidecar | `infra/stacks/t3code/main.tf:47-80,146-177` point at :7690 |
| The sidecar speaks T3's internal client protocol, which keeps changing | `packages/contracts` +1,615/−1,523 lines from v0.1.3 to main; 179 of 203 methods are stubs |
| T3 has a documented MCP endpoint that can list, start, rename, archive and drive threads | `docs/user/outside-agents.md`; 66 tools on v0.1.5 |
| T3 releases an idle Claude process after 30 minutes | `ProviderSessionManager.ts:57` |
| T3's import of Claude sessions is a one-time snapshot from the welcome wizard | `AgentSessionImporter.ts:276-289`; 205 threads were imported on 2026-10-30 |
| The T3 app opens a thread from `t3code://threads/<environmentId>/<threadId>` | `apps/mobile/src/Stack.tsx:726`, `App.tsx:125`; an installed app that is not paired with the environment shows "Thread unavailable" (`ThreadRouteScreen.tsx:291-335`) |
| Native T3 apps never pass through Authentik | `infra/stacks/t3code/main.tf:221-256`: bearer, descriptor and ticket routes skip forward-auth |
| `t3-dispatch` listens on `*:3780` and trusts `X-authentik-username` without the proxy secret, and nothing filters 3780, 3773 or 3774 | `infra/scripts/t3-dispatch/main.go:249-265`; `ss -ltn`; the `devvm_lobby` nft table has rules for 7690 only |

## What we decided

| # | Question | Decision |
|---|---|---|
| 1 | Who hosts a Claude session | Each user's own `t3 serve`, for sessions started in T3. The lobby keeps hosting tmux sessions |
| 2 | Who gets it | Every lobby user from day 1, web and mobile apps included |
| 3 | Where New starts Claude | A per-user setting. wizard defaults to T3; everyone else defaults to tmux. "New in T3" is always offered |
| 4 | Which tools move | Claude only. Codex, pi and shells stay in tmux |
| 5 | How the lobby shows a T3 thread | In the same sidebar list as tmux sessions, with a T3 mark and a status badge (working, needs you, done) |
| 6 | Which threads it lists | What T3's sidebar shows by default: top-level, unarchived, unsettled. Subagent threads stay in T3. Settled threads, including the 617 imported from older history, stay in T3's settled shelf |
| 7 | What the lobby can do to one | Start, rename, archive. Close means archive, because T3 has no delete over MCP |
| 8 | Opening one | A new browser tab on the user's T3 host. On a phone, a small sheet offers "Open in T3 app" and "Open in browser" |
| 9 | How the lobby talks to T3 | Only T3's documented `/mcp` endpoint |
| 10 | Hostnames | `t3.viktorbarzin.me` for wizard, `t3-<osuser>.viktorbarzin.me` for everyone else, each in front of that user's own server |
| 11 | Who may use a host | On the web, Authentik admits only the host's owner, and `t3-dispatch` checks it again. Native apps pair with the host itself |
| 12 | Callers (Muse, the WhatsApp bot) | They speak T3's own MCP tools through a pass-through at `terminal-api.viktorbarzin.me/mcp`. They keep their agent-api bearers; agent-api holds an auto-renewed T3 token per user and keeps the per-caller trace. Delegations stay in agent-api |
| 13 | The WhatsApp bot | Rewritten to list, send to, answer and interrupt T3 threads over that pass-through. It keeps session-events for tmux sessions |
| 14 | Lobby features T3 threads do without | The live Terminal view, public share links, guest drive, lobby push, the lobby spend panel |
| 15 | The sidecar | `tl-t3-view`, the framed T3 view, T3 app pairing in lobby Settings and `tl-t3-upstream-check` are retired |
| 16 | T3 versions | T3 updates itself. The lobby exports how its T3 calls fare, and an alert fires when they keep failing |
| 17 | Existing tmux sessions | They keep running until they end. Nothing is moved |
| 18 | The open dispatch port | Closed first: 3780, 3773 and 3774 accept connections from Traefik and loopback only, and `t3-dispatch` requires the lobby proxy secret |

Alternatives we looked at:

- **One hostname for every user.** A server-side probe showed that two servers
  can share one environment id safely, and that each credential is refused by
  the other server. The routing proxy would still have had to track bearers,
  tickets, pairing codes and asset tokens per user, and to learn every new
  credential-less route T3 adds. Per-user hostnames give the same result with
  none of that state.
- **One `t3 serve` for everyone.** T3 has no multi-user mode, and every
  agent would run as one OS user.
- **Keep the sidecar and serve more of T3's protocol.** That is where we are
  today, and the protocol moves faster than the sidecar can follow.
- **Hand a session between T3 and tmux.** Turns made in tmux reach the model
  when T3 resumes, but never T3's thread view, and T3 has no re-sync.
- **agent-api translates its conversation API onto T3.** Caller rules, the
  teams-off settings file and upload directories are claude CLI flags that
  `t3_thread_launch` cannot take, so the translation would have needed a
  dedicated provider instance per user. Callers speaking T3's tools directly
  need none of that.
- **Callers sign in to T3 themselves.** A full-access MCP sign-in lasts 30 days
  with no refresh, so Muse would need re-approving every month. A Supervised
  one cannot launch full-access threads, and MCP cannot approve the permission
  prompts the alternative would raise.
- **The shell snapshot for the list.** `GET /api/orchestration/shell` has the
  richest status, but it is internal (it requires `x-t3-orchestration-protocol:
  2`), builds the whole snapshot on every call (about 1.4 MB for wizard), and
  needs a second credential. `t3_thread_list` reports the same `waiting` state
  for questions and approvals.

## How it fits together

```mermaid
flowchart LR
  subgraph clients[Browser or phone]
    LB[Lobby web app]
    TW[T3 web or app]
  end
  LB -->|/api/sessions| TA[tmux-api]
  TA -->|tmux| TM[tmux sessions]
  TA -->|/mcp| SW[t3-serve@wizard :3773]
  TA -->|/mcp| SE[t3-serve@emo :3774]
  MU[Muse] -->|terminal-api /mcp| AA[agent-api]
  WB[WhatsApp bot] -->|terminal-api /mcp| AA
  WB -->|session-events| TM
  AA -->|/mcp| SW
  TW -->|t3.viktorbarzin.me| SW
  TW -->|t3-emo.viktorbarzin.me| SE
```

### `t3client`, one Go module for both services

- **Where a user's T3 is.** The port comes from `/etc/t3-serve/<user>.env`
  (`T3_PORT`), the environment id from `GET /.well-known/t3/environment`, and
  the public host from the lobby config (`TL_T3_HOSTS`, default
  `t3-<user>.<domain>`, with `wizard=t3.<domain>` set on this box).
- **Credentials.** The client runs `sudo -n /usr/local/bin/t3-mint <user>` for
  a five-minute pairing code with T3's default full scopes, then completes
  T3's MCP sign-in headlessly: `POST /oauth/mcp/register`, `POST
  /oauth/mcp/decision` with `{_tag: "pairing-code", access: "full-access",
  code}`, `POST /oauth/mcp/token`. One code makes one token, because codes are
  single-use. A token lasts 30 days with no refresh, so the client renews it
  after 20 days, or at once on a 401. Each service keeps its own token in its
  state directory, mode 0600, labelled with the service name, and each one
  shows in the user's T3 under Settings > Access.
- **Why full access.** A Supervised token is refused on full-access threads
  (`runtime_mode_escalation_denied`), and every one of wizard's threads runs in
  full-access.
- **Transport.** MCP streamable HTTP in JSON mode, protocol `2025-06-18`. T3
  keeps MCP sessions in memory, so a 404 after a T3 restart means initialize
  again and retry once. `t3_thread_launch` always carries a `clientRequestId`,
  so a retry never makes a second thread, and `t3_thread_wait` always carries
  the `runId` that `t3_thread_send` returned.
- **Metrics.** `tl_t3_calls_total{service,user,tool,result}` and
  `tl_t3_last_success_timestamp_seconds{service,user}`.

### The list

tmux-api polls `t3_thread_list` (`allProjects: true`, `settled: false`, paged at
100) in the background for each user who has asked for the session list in the
last two minutes, every 10 seconds, with a 5-second timeout. `buildSessionsBody`
appends the last good result to the tmux sessions, so a slow or stopped T3
never stalls the lobby. When a user's T3 has not answered, their T3 rows are
left out and their tmux sessions still list.

A T3 row's name is a lobby alias, `t3_` followed by 12 characters derived from
the thread id. T3 ids (`mcp:<uuid>`, 40 characters) do not fit the lobby's
session-name rule (`^[a-zA-Z0-9_-]{1,32}$`, checked at 33 sites), and the alias
does. tmux-api keeps the alias-to-thread map from the last poll. A row also
carries `backend: "t3"`, the thread id, the web URL
(`https://<host>/<environmentId>/<encodeURIComponent(threadId)>`) and the app
URL (`t3code://threads/<environmentId>/<threadId>`).

| T3 thread status | Lobby state |
|---|---|
| `preparing`, `queued`, `starting`, `running` | `running` |
| `waiting` | `awaiting` |
| anything else | `done` |

In the frontend a T3 row opens its URL rather than a terminal, has no hover
preload, and offers rename, archive and the two open actions in its menu.
Restart, share, status, move and the Terminal and Text views stay with tmux
rows.

### New, rename, archive

- **New with the T3 backend.** tmux-api resolves the chosen directory to its git
  toplevel, or to the directory itself outside git. It uses the T3 project with
  that exact workspace root, creating it with `t3_project_create` when there is
  none, and calls `t3_thread_launch` with the prompt, `modelSelection`
  (`instanceId: "claudeAgent"` and the chosen model), `runtimeMode:
  "full-access"` and `workspaceStrategy: {type: "root"}`. The lobby opens the
  returned thread.
- **Rename and close** use the existing routes. A `t3_` alias goes to
  `t3_thread_update` (rename) or `t3_thread_organize` (archive).
- **The setting.** The roamed pref `session.claudeBackend` is `"t3"` or
  `"tmux"`. Its default comes from the lobby config (`TL_T3_DEFAULT_USERS`,
  `wizard` on this box).

### agent-api's MCP pass-through

`POST /mcp` on agent-api accepts a caller's existing bearer, resolves the
caller's OS user, and forwards the JSON-RPC body to that user's T3 `/mcp` with
agent-api's own T3 token. It:

- keeps one T3 MCP session per caller and re-initializes on a 404;
- applies the caller's pins (`TL_CALLER_PINS`) to `t3_thread_launch`: the
  pinned model goes into `modelSelection`, and `bypassPermissions` becomes
  `runtimeMode: "full-access"`;
- writes each call to the caller trace it already keeps for `/v1`.

The `/v1/conversations` routes stay for tmux conversations. Muse's
instructions and the WhatsApp bot move to `/mcp`.

### Hosts and the edge

- `scripts/workstation/roster.yaml` gains `t3_port` and `t3_host` per user.
  The provisioner honours a pinned port, refuses a clash, and writes the host
  into `/etc/t3-serve/dispatch.json`. Terraform reads the same rows and builds
  hosts only for rows that have both.
- For each user, `stacks/t3code` builds the web host through the ingress
  factory, proxied to `t3-dispatch` with the lobby proxy secret, and the native
  routes on the same host straight to that user's `t3 serve`: bearer,
  descriptor and token, ticketed WebSocket, preflight, plus `/api/assets/` and
  `/api/attachments/upload/`, which carry their own signed tokens.
- `stacks/authentik` gains a users-only entry in `forward-auth-apps.json`. It
  binds the host's owner and nothing else, since Home Server Admins includes
  every devvm user. `scripts/check-allowed-groups.py` learns that entry type.
- `t3-dispatch` reads the host, admits a request only when the Authentik user
  owns that host, and refuses requests without the proxy secret. It keeps its
  browser auto-pair and its `/probe`.
- The lobby service user gets a sudoers entry for `t3-mint`, generated with the
  others in `roster_engine.py` and declared in `release/privsurface.go`.

## Rollout

1. **Infra edge.** The firewall and proxy secret for 3780, 3773 and 3774; the
   roster fields; `t3-dispatch` keyed by host; the Authentik bindings; the
   per-user hosts, with `t3.viktorbarzin.me` moving from the sidecar to
   wizard's server. T3 apps paired with the sidecar re-pair once.
2. **Lobby release.** `t3client`, T3 rows, New, rename, archive, the setting,
   the MCP pass-through and its metrics, with the sidecar, framed view, device
   pairing and upstream check removed in the same release.
3. **Callers.** The WhatsApp bot on the pass-through; Muse's instructions
   rewritten.
4. **Infra cleanup.** `t3view.viktorbarzin.me`, the sidecar endpoints and the T3
   hold alerts go; an alert on the lobby's T3 metrics comes in. The 7690
   firewall rules stay, because `acd-demux` claims that port too.

Between steps 1 and 2 the lobby's framed T3 view has nothing to show, since
`t3.viktorbarzin.me` no longer serves lobby sessions. The window is the length
of one release.

## Open questions

- Whether the T3 app's deep link opens reliably from a browser on iOS and
  Android when the app is paired.
- Whether `t3-serve@emo` runs Claude end to end. It has never run a turn (0
  runs, `settings.json` is `{}`), though its Claude credential is in place, so
  the lobby always passes `modelSelection` with an `instanceId`.
- wizard's T3 database is at migration 74 while v0.1.5 defines 72, because a
  nightly build once ran against it. T3's updater may refuse a channel switch
  until a release supports it.
