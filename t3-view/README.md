# tl-t3-view

`tl-t3-view` serves T3 Code's web client against lobby sessions. It hosts an
unmodified T3 web build (plus the patches in `patches/`) and implements T3's
orchestration protocol v2 with T3's own `packages/contracts`, so the web
client treats it as a T3 server. T3's own apps (desktop, mobile, a browser on
another origin) pair with it as devices and connect with a bearer. Design:
[ADR-0044](../docs/adr/0044-t3-code-renders-a-session-through-its-own-protocol.md),
[ADR-0045](../docs/adr/0045-t3-apps-are-clients-of-lobby-sessions.md),
[the T3 view design](../docs/plans/2026-10-12-t3-view-design.md) and
[T3 everywhere](../docs/plans/2026-10-21-t3-everywhere-design.md). What the
real client asks of its server was measured in [TRACE.md](TRACE.md).

Status: built on branch, first cut, not released. The shell lists the user's
Claude sessions grouped as the lobby groups them, a thread renders from the
session's lobby stream, and sends, steers, queued messages, Stop, dialog
answers, mode, model and new threads go back to the lobby. History paging and
images are the second cut.

## Layout

| Path | What it is |
|---|---|
| `T3_PIN` | The T3 tag, its commit, and the repo to fetch it from |
| `patches/*.patch` | Applied to the pinned checkout in name order (one today, `embed.patch`; its contract is [EMBED.md](EMBED.md)) |
| `scripts/build-web.sh` | Extracts the pin, applies patches, installs T3's web closure from T3's lockfile, builds `apps/web`. CI runs the same script |
| `scripts/link-t3.sh` | Points `node_modules/` at that checkout. Generated, gitignored |
| `scripts/build-sidecar.sh` | Bundles `src/main.ts` with esbuild into one `tl-t3-view.mjs` for system node |
| `scripts/gen-stubs.sh` | Rewrites `src/rpc/stubs.ts` from the pinned `WsRpcGroup` (below) |
| `scripts/dev-proxy.mjs` | Plays Traefik for local browser testing (below) |
| `src/` | The sidecar |
| `test/` | vitest |
| `trace/`, `TRACE.md` | Stage 1 captures of the real T3 client and server |

## Building

```sh
W=<work dir outside the repo>            # needs about 1.5 GB
T3_REPO=~/src/t3code scripts/build-web.sh "$W"   # or --deps-only to skip the web build
scripts/link-t3.sh "$W"
npm test                                  # vitest, against T3's contracts
npm run typecheck                         # T3's own compiler options
scripts/build-sidecar.sh dist             # dist/tl-t3-view.mjs, about 2 MB
```

`build-web.sh --print-key` prints the artefact key: the pinned commit plus a
digest of `patches/`. The web build only needs rebuilding when that key
changes. On the devvm with a warm pnpm store, the whole script took 2 min 57 s
and peaked at 3.3 GB RSS (`PNPM_STORE_DIR` reuses a store).

There is no second lockfile. `effect` (4.0.4; T3 carries no patch for it at
`v0.1.0`), `@effect/platform-node`,
esbuild, vitest and TypeScript 7 all come from T3's `pnpm-lock.yaml` at the pin.
`link-t3.sh` also links two app packages for single files that import only
contracts: `t3` (the server's `auth/RpcAuthorization.ts`) and `@t3tools/web`
(the first-run gate logic, in tests). Because the web-only install leaves
`apps/server` without `node_modules`, the script gives it `effect` and
`@t3tools/contracts` inside the generated checkout.

The sidecar reports the pinned tag (`T3_PIN`'s `tag=`, without the `v`) as
its `serverVersion`. `build-sidecar.sh`, `gen-stubs.sh` and `vitest.config.ts`
read it from `T3_PIN` and hand it to the bundle as a define, so a pin bump
changes it with nothing else to edit.

### Moving the pin

1. Set `tag=` and `commit=` in `T3_PIN` (the commit is
   `git rev-parse <tag>^{commit}` in a T3 clone).
2. `build-web.sh` and `link-t3.sh` as above. A patch that no longer applies
   stops the build.
3. `scripts/gen-stubs.sh`, then `npm test` and `npm run typecheck`. An RPC
   upstream added is a stub from then on; one the sidecar should answer gets
   a handler in `servedHandlers`, after which `gen-stubs.sh` leaves it out of
   the table.

## Running

Environment variables only:

| Variable | Default | Meaning |
|---|---|---|
| `TL_T3_VIEW_BIND` | `127.0.0.1` | Listen address (production unit: `0.0.0.0`, so Traefik reaches 10.0.10.10 and the release probe reaches loopback) |
| `TL_T3_VIEW_PORT` | `7690` | Listen port |
| `TL_AUTH_HEADER` | `X-Authentik-Username` | Identity header name, shared with every lobby service |
| `TL_T3_VIEW_TMUX_API` | `http://127.0.0.1:7684` | tmux-api |
| `TL_T3_VIEW_SESSION_EVENTS` | `http://127.0.0.1:7685` | session-events (used from stage 3) |
| `TL_T3_VIEW_WEB_DIR` | `/usr/lib/terminal-lobby/tl-t3-view/web` | The built web client |
| `TL_T3_VIEW_LABEL` | host name | The environment's name in T3 |
| `TL_T3_VIEW_STATE_DIR` | `$STATE_DIRECTORY` (systemd), else none | Where prompts awaiting their row (`pending.json`), the thread ids of sessions T3 created (`aliases.json`) and the prompts a T3 Stop held (`held.json`) outlive a restart; without it they are kept in memory |

The sidecar refuses to start when `TL_PROXY_SECRET` is set (see the next
section). The systemd unit can read both lobby config files, so it gets the
same `TL_AUTH_HEADER` as tmux-api, and drop the secret with
`UnsetEnvironment=TL_PROXY_SECRET`.

### Local browser check

```sh
umask 077; sudo sed -n 's/^TL_PROXY_SECRET=//p' /etc/terminal-lobby.local.conf > "$W/proxy-secret"
TL_T3_VIEW_PORT=17690 TL_T3_VIEW_WEB_DIR="$W/web" node dist/tl-t3-view.mjs &
node scripts/dev-proxy.mjs --listen 127.0.0.1:17691 --target 127.0.0.1:17690 \
  --identity <a lobby identity> --secret-file "$W/proxy-secret" &
# open the http://127.0.0.1:17691/?token=... link the proxy prints on stderr
```

The proxy adds the identity header and the real proxy secret to every request
and WebSocket upgrade, as Traefik's middleware does. The sidecar then checks
them with the production tmux-api.

Whoever gets through the proxy acts as that identity, with the real secret,
and every OS user on the devvm can reach a loopback port. So the proxy mints a
random token at startup and prints a link carrying it, once. Opening the link
sets an HttpOnly cookie for that port, and the proxy answers 401 to every
request and upgrade without it, forwarding nothing. Keep the link to
yourself, and stop the proxy when the check is done. Prefer an identity that
maps to a throwaway account over your own where one exists.

## Inbound auth

The devvm's nftables accept loopback and 10.0.10.10, so every local OS user
can reach the sidecar's port. A request is admitted on one of two paths
(`src/access.ts`), chosen by what it carries, and never falls from one to the
other:

| Request carries | Path | Checked by |
|---|---|---|
| `?wsTicket=<ticket>` | bearer | the ticket's bearer, through tmux-api `/whoami` |
| `Authorization: Bearer <token>` | bearer | the bearer, through tmux-api `/whoami` |
| anything else | browser | the identity header and `X-TL-Proxy-Secret`, through tmux-api `/whoami` |

A request with a bearer or a ticket is decided on the bearer path alone: a
forged identity header beside a bad bearer gets the bearer's 401 and the
header gate is never asked.

### Browser path

The identity header alone proves nothing on this box. The lobby's control is
the proxy secret: Traefik adds `X-TL-Proxy-Secret`, and the Go services
compare it with `TL_PROXY_SECRET` ([authuser/resolve.go](../authuser/resolve.go)).
The sidecar verifies the secret without holding it:

```mermaid
sequenceDiagram
  participant B as Browser via Traefik
  participant S as tl-t3-view
  participant T as tmux-api /whoami
  B->>S: request + identity header + X-TL-Proxy-Secret
  alt identity cached and sha256(secret) matches (timingSafeEqual), within 30 s
    S-->>B: served
  else
    S->>T: GET /whoami with the same two headers
    T-->>S: 200 {osUser} / 401 / 403
    S-->>B: served unless acting as someone else, else 401/403
  end
```

- Every route except the credential-less ones below goes through the gate,
  including static files and the `/ws` upgrade. A refused caller gets 401 or
  403 before routing, so it does not learn which paths exist.
- tmux-api does the secret comparison, so the secret stays in tmux-api's
  environment only. The cache holds a SHA-256 digest of an admitted secret,
  keyed by identity, for 30 seconds, compared with `timingSafeEqual`.
- Refusals are never cached. A burst of concurrent requests for the same pair
  (a page load fetches about 280 assets) shares one `/whoami` call.
- Every lobby user is admitted, admin or not. An answer that carries
  `realUser` (acting as someone else) is refused.
- tmux-api unreachable: 502.
- A browser's `/ws` upgrade must carry an `Origin` whose host is the request's
  `Host`, or it gets 403, as session-events' `sameOrigin` does
  (`src/origin.ts`). The Authentik cookie covers the whole `viktorbarzin.me`
  site, so a page on any sibling host would otherwise reach the gate with the
  user's identity. A browser write whose `Sec-Fetch-Site` names another origin
  is refused the same way.

### Bearer path: paired apps

A T3 app pairs with a code the lobby's Settings shows (tmux-api
`POST /devices/pair`), and from then on sends its device token:

```mermaid
sequenceDiagram
  participant A as T3 app
  participant S as tl-t3-view
  participant T as tmux-api
  A->>S: GET /.well-known/t3/environment (no credential)
  A->>S: POST /oauth/token, subject_token=<code>
  S->>T: POST /devices/exchange {code, label, deviceType, os} (loopback)
  T-->>S: {token}
  S-->>A: {access_token, token_type: Bearer, scope}
  A->>S: POST /api/auth/websocket-ticket, Authorization: Bearer
  S->>T: GET /whoami, Authorization: Bearer (cached 30 s by sha256)
  S-->>A: {ticket, expiresAt} (single use, 60 s, memory only)
  A->>S: GET /ws?wsTicket=... (any Origin)
  loop every 60 s, and on any 401 from a lobby call
    S->>T: GET /whoami, Authorization: Bearer
  end
```

- The sidecar holds no credential of its own. Every call it makes for a
  paired app (tmux-api, session-events) carries the app's
  `Authorization: Bearer`, and authuser resolves it there like any bearer.
- `/oauth/token` reaches tmux-api's `POST /devices/exchange` on loopback with
  no forwarding headers, which that route requires. The token has no fixed
  expiry, so `expires_in` is ten years; tmux-api stops a device that is unused
  for 90 days.
- Refusals are T3's JSON errors. A bad or revoked bearer, or a spent or
  expired ticket, is 401 `{_tag: "EnvironmentAuthInvalidError", code:
  "auth_invalid", reason, traceId}`, which makes T3's client offer to pair
  again. tmux-api unreachable is 500 `EnvironmentInternalError`, which the
  client retries.
- Bearer answers carry T3's CORS headers (`Access-Control-Allow-Origin: *`,
  no credentials), and `OPTIONS` on any path is a 204 preflight with T3's
  method and header list: the desktop renderer runs on `t3code://app`. They
  grant no credentials, so a page elsewhere cannot use a browser's cookie
  through them.
- A bearer request skips the origin and cross-site checks. A page cannot make
  a browser attach someone's bearer, and a ticket is issued only to a bearer.
- Tickets and tokens are never logged.

### Revocation and shared streams

Each open WebSocket that came in on a bearer is checked again every 60 s, and
at once when a lobby call made with that bearer answers 401
(`src/revocation.ts`). When tmux-api now refuses the bearer, its sockets close
with code 4401 and the hub forgets the credential.

A thread's upstream stream from session-events is shared by every client of
that (OS user, session), so it runs under one client's credential
(`src/hub.ts`, `src/threads/live.ts`):

- Each WebSocket holds its credential with the user's hub while it is open. An
  HTTP request only marks its credential as the most recent.
- A stream opens under the newest held credential, or the most recent one
  when no socket is open, and remembers which.
- Whenever the set of held credentials changes, a stream whose credential no
  open socket holds is ended and reopened under a held one, resuming from its
  last event id. So one device closing its app never ends another client's
  view, and while any socket is open no stream runs on a credential nobody is
  re-checking.
- A revoked credential is dropped from the holders, and its streams move the
  same way. With no other client left, they stay closed until one connects;
  without a subscriber they are forgotten after 60 s as before.

Caches of lobby data are keyed by OS user first (`src/hub.ts` keeps one
`UserHub` per OS user), and a live thread by (OS user, thread id).

## Protocol

| Route | Answer |
|---|---|
| `GET /.well-known/t3/environment` | Descriptor, no credential needed: `orchestrationProtocolVersion: 2`, a host-derived stable `environmentId`, `serverVersion` from the pin |
| `GET /.well-known/t3/thread/:key` | The user's thread id for the key the lobby frames a session by; 404 when none |
| `GET /.well-known/t3/session/:threadId` | The other way: `{ key, name }`, the lobby key and the session's name now, for one of the user's own threads; 404 for someone else's or an unknown one. The embed patch's `tl-route` reports use it |
| `GET /api/auth/session` | `authenticated: true`, `sessionMethod` `browser-session-cookie` or `bearer-access-token`; permissions `orchestration:read`, `orchestration:operate`, `filesystem:read`. No credential, or a refused bearer: 200 `authenticated: false`, as T3's server answers |
| `POST /api/auth/browser-session` | A browser opening `/pair#token=...` while signed in: the same success, no cookie issued, the code not spent |
| `POST /oauth/token` | No credential needed: T3's token exchange, a pairing code for a device token (above); bad code 401, malformed 400 |
| `POST /api/auth/websocket-ticket` | Bearer only: `{ticket, expiresAt}`, one upgrade within 60 s |
| `GET /api/orchestration/shell` | Shell snapshot; 400 without `x-t3-orchestration-protocol: 2` |
| `GET /api/orchestration/threads/:id/bounded` | The thread's projection; the window is the whole projection for now (`hasMoreHistory: false`); 404 for a thread the lobby does not list |
| `GET /api/orchestration/threads/:id/history` | An empty page: there is no older history to fetch until paging lands |
| `GET /api/orchestration/threads/:id/transcript` | `{threadId, title, updatedAt, items}` from the projection's visible rows, as T3's server builds it; 400 `thread_transcript_too_large` past T3's 50 MB attachment limit, 404 for a thread the lobby does not list |
| `POST /api/observability/v1/traces` | 204 (the client posts traces unconditionally) |
| `GET /ws?orchestrationProtocol=2` | Effect RPC, `RpcSerialization.layerJson`; 426 on any other version. A browser upgrade must be same-origin; a ticket or bearer upgrade may come from any origin |
| `OPTIONS *` | CORS preflight, 204 |
| `GET *` | The web build; `index.html` for app routes, and a 302 to the thread's id for `/{environmentId}/{key}` named by another key; other `/api/`, `/ws`, `/.well-known/` paths 404 |

RPC (`src/rpc/`):

- `stubs.ts` is generated by `scripts/gen-stubs.sh`: every RPC of the pinned
  `WsRpcGroup` (193 at `v0.1.0`) that `servedHandlers` does not answer,
  mapped to a fallback (`fallback.ts`). A unary RPC dies with "tl-t3-view does
  not serve <tag>" and logs a warning; a subscription stays open and silent,
  because the client re-raises a failed subscription. A pin bump that adds an
  RPC is a type error in `handlers.ts` until the table is regenerated, and
  `test/stubs.test.ts` fails while the committed file differs from what the
  generator writes.
- `handlers.ts` (`servedHandlers`) has the real handlers: config, lifecycle, probe, shell,
  archived shell, `thread.visit`, and honest empty answers for what the client
  calls unprompted (previews, VCS status, refs, source control, scheduled
  tasks, project clones, file metadata, `t3.json`, project favicons).
- `authorization.ts` is T3's own `RpcScopeAuthorization` table applied to the
  granted permissions, so terminal RPCs and source-control writes fail before
  any handler runs. Refusals are logged with the RPC tag.

The granted permissions leave out `terminal:*` and `source-control:write`, but
the client still draws the terminal drawer toggle (TRACE.md finding 1); the
embed patch hides it.

### Sequence numbers

The client caches threads in IndexedDB and resumes with the last sequence it
applied, dropping any event at or below it. One process-wide clock starts at
the startup time in microseconds (`SequenceClock`), so a restart starts above
any sequence an earlier run handed out. `EventLog.resume` answers a resume from
another run, from ahead of this run, or from before events already dropped
with a full snapshot.

## Read path

```mermaid
flowchart LR
  T["tmux-api<br/>/sessions, /layout"] --> D["SessionDirectory<br/>thread id = rename-proof key"]
  D --> SH["UserHub shell rows<br/>shell EventLog"]
  E["session-events<br/>GET /events/{name}?rev=1"] --> L["LiveThread<br/>one stream per (user, session)"]
  L --> M["ThreadModel<br/>frames -> ThreadMapper -> domain events"]
  M --> P["T3 client reducer<br/>applyOrchestrationV2ProjectionEvent"]
  M --> LOG["thread EventLog"]
  SH --> B["browser: subscribeShell"]
  P --> B2["browser: bounded snapshot,<br/>subscribeThread"]
  LOG --> B2
```

- Thread ids (`src/shell/directory.ts`): a session's birth name (`bornAs`),
  else for a hand-named session the name it had when first seen, followed by
  tmux's session id; a session T3 created keeps the id T3 minted for it
  (`src/shell/aliases.ts`); someone else's session is `<owner>~<key>`. The
  directory maps the id to the session's current name before every call.
- Grouping follows the lobby's sidebar: layout projects, a session's own
  `project`, Ungrouped, one System project for harness and Caller sessions,
  one project per owner for shared sessions. Claude sessions only. T3 merges
  projects that share a workspace root, so a project after the first in a
  folder gets that folder written with a leading `/.` per clash
  (`/./home/wizard`); Ungrouped keeps the plain path.
- `LiveThread` (`src/threads/live.ts`) keeps one upstream stream per (OS user,
  session), resumes it with `lastEventId` and `epoch`, follows renames through
  the directory on a 404, and rebuilds the model (clients get one snapshot)
  when `ready` names another log. At every `ready` it reads the mode off the
  pane (session-events `GET /pane`, as the Solid view does), since the `state`
  frame's mode can be stale. It closes 60 s after its last subscriber.
- `ThreadModel` (`src/threads/model.ts`) buffers `back` frames until `ready`,
  folds `state` (mode, model; the queue is reconciled at `ready`), and passes
  stored events and deltas to `ThreadMapper`. Its log starts at a floor taken
  from the clock, so a client holding a sequence from a rebuilt log gets a
  snapshot.
- `ThreadMapper` (`src/threads/mapper.ts`) is the lobby-to-T3 mapping. How
  the lobby's stream maps onto runs is described at the top of that file; the
  tool table is T3's own (`src/threads/tools.ts`). Held dialogs become live
  runtime requests keyed by the tool call (`request:<toolId>`).

Tests: `test/threadModel.test.ts` feeds SSE captures of scratch sessions
(`test/fixtures/lobby/`) through the model and checks the projections with
the semantic integrity rules ported from T3's testkit (`test/helpers/projection.ts`).

## Commands

`src/commands/dispatch.ts`; the table at the top of that file lists each T3
command and the lobby request it becomes. Every send records messageId -> text
first (`src/threads/pending.ts`), so the user row Claude writes comes back
under the browser's own message id. `deliveryIntent` is resolved with T3's own
rule (`src/commands/policy.ts`). Two lobby additions back this:

- session-events `POST /prompt {wait: true}` holds a prompt until the turn
  ends instead of steering it (`queue_after_active`), and the held and asking
  dialog bodies name their tool call.
- tmux-api `POST /sessions/claim {project}` places a new session in a layout
  project under the layout lock (`launchThread`).

A thread launched from T3 is put in the mode the person chose before its
first prompt is sent. A pre-warm slot starts in `bypassPermissions`, so the
sidecar asks `POST /model {mode}` until the walk applies (a pane still starting
answers `unreadable` for a few seconds), and fails the launch without sending
the prompt when it does not.

T3's Stop sends `run.interrupt` with `holdQueue`. The sidecar then stops the
turn with `POST /cancel {restoreQueue}`, so session-events hands its held
prompts back instead of sending them at the turn's end, and keeps them as
queued runs with `queueHeld: true`, as T3's own server does. `queue.resume`
sends them again with `wait`, oldest first, under their own runs and message
ids. While a run is held only the sidecar has its text, so cancelling or
editing it changes it there without a lobby call. The held set of each
thread is written to `held.json` (`src/threads/held.ts`, keyed by OS user and
thread id) whenever it changes. A model built again from the log (a sidecar
restart, a stream rebuild, a thread reopened after it went idle) reads the
hand-back as each prompt leaving the queue, so at its first `ready` it holds
those runs again, and makes a held run for a prompt the bounded log no
longer shows.

The composer's models are the lobby's catalogue (`src/models.ts`, a copy of
frontend-v2's) plus, as a row named by its slug, each model one of the user's
live sessions is on that the catalogue lacks (for example `claude-haiku-5-5`
from a pre-warm alias). A change is sent on `subscribeServerConfig` as
`providerStatuses`. A send's model selection is applied only when the
session's model was among the rows the user was offered, so the composer's
fallback default is never applied as a choice.

## Open questions

- History paging and images (second cut): the bounded snapshot carries the
  whole window the lobby's reverse open delivered (about 100 KB of events).
- Touch input, the soft keyboard and iOS Safari inside a cross-origin iframe
  are unverified; the phone check so far is a resized desktop Chromium.
