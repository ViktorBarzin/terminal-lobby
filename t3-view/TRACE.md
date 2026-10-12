# T3 view, stage 1: what the real T3 web client asks of its server

Measured on 2026-10-12 against T3 Code `v0.0.46-nightly.20261011.2994`
(commit `d07a07f3`, `ORCHESTRATION_PROTOCOL_VERSION` 2), by running the real
server and web build from that tag on the devvm and driving the web app with
Playwright (desktop 1280x800 and phone 390x844). This replaces the static trace
in `docs/plans/2026-10-12-t3-view-design.md` ("What the web client needs").

Raw captures, with scratch paths replaced by `$SCRATCH` and signed asset
tokens redacted, are under [`trace/`](trace/):

| File | What it holds |
|---|---|
| `trace/rpc/<scenario>.jsonl` | One line per RPC request: tag, full payload, every streamed value, the exit. `orphanStream` lines are values pushed on subscriptions opened in an earlier scenario |
| `trace/serverConfig.snapshot.json` | The first `subscribeServerConfig` value, verbatim |
| `trace/lifecycle.{welcome,ready}.json` | The two `subscribeServerLifecycle` values |
| `trace/http/{env,authsession,shell,bounded}.json` | `/.well-known/t3/environment`, `/api/auth/session`, `/api/orchestration/shell`, `/api/orchestration/threads/:id/bounded?compactTurnItems=1` after ten runs |

## Answers in one table

| Question | Answer from the run |
|---|---|
| Which RPCs fire unprompted | 26 of 193 were called at all. Boot on the wizard page fires `subscribeServerConfig`, `subscribeServerLifecycle`, `orchestration.subscribeShell` and `preview.reportProfiles`; once the app mounts, `subscribeProjectClones` and `server.reportClientActivity` follow; opening a thread adds about 14 more. Full lists below |
| Unregistered method | The real server answers `{"_tag":"Exit","exit":{"_tag":"Failure","cause":[{"_tag":"Die","defect":"Unknown request tag: <tag>"}]}}`. A payload that fails the schema gets the same shape with the decode message (`"Missing key\n  at [\"clientId\"]"`) |
| Stub vs real empty answer | Subscriptions must not die: the client's subscription helper re-raises any failure that is not an expected typed error (`client-runtime/src/rpc/client.ts:340-385`). Stub every observed subscription as an empty or never-ending stream with the shapes listed below, and every observed unary call with a typed empty value |
| FirstRunGate | Shows the wizard only when the workspace is "fresh": 0 projects and 0 threads, or only the cwd auto-bootstrap pair. With 1 project that is not the bootstrap project, or with more than 1 thread, it opens the app and persists `onboardingCompletedAt` in `localStorage` `t3code:client-settings:v1`. The welcome lifecycle event without `bootstrapStatus` counts as authoritative |
| Composer needs | A provider entry with `status: "ready"`, `enabled`, `installed`, `auth.status: "authenticated"`, models with `capabilities.optionDescriptors` (effort select, fast mode, context window), `supportedRuntimeModes: null` (all four modes), `showInteractionModeToggle: true`, `slashCommands` |
| Root `prepare` script | Not needed. A web-only install with `--ignore-scripts` builds a `dist/` byte-identical to the full install's, apart from `third-party-licenses.json` (which lists the installed packages) |

## Build recipe (web only, for CI)

```sh
git -C <t3code clone> archive v0.0.46-nightly.20261011.2994 | tar -x -C t3
cd t3
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 ELECTRON_SKIP_BINARY_DOWNLOAD=1 CI=1 \
  corepack pnpm install --frozen-lockfile --filter '@t3tools/web...' --ignore-scripts
cd apps/web
T3CODE_WEB_SOURCEMAP=0 ./node_modules/.bin/vp build     # output: apps/web/dist
```

Measured on the devvm (Node 24.15, pnpm 11.10.0 via corepack, disk under about
50-70% IO pressure from other work, so treat times as upper bounds):

| Step | Wall time | Size |
|---|---|---|
| `git archive` extract | 6-28 s | 393 MB, 27,978 files (includes `.repos/`, `apps/mobile`) |
| Install, cold store, `t3...` + `@t3tools/web...` filter, scripts on | 141 s | store 1.4 GB, 1,089 packages |
| Install, warm store, `@t3tools/web...` only, `--ignore-scripts` | 380 s (IO bound; 0 downloads) | 1,013 packages |
| `vp build` | 299 s and 327 s | peak RSS 3.3 GB; `dist/` 51 MB, 2,357 files |

Notes:

- Call `vp` directly. `pnpm run build` runs pnpm's deps check first, which
  tries a full unfiltered install and aborts with
  `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`.
- `--filter '@t3tools/web...'` still installs the `electron` and
  `react-native` packages (peers of `@clerk/electron` and `morphicons`).
  `ELECTRON_SKIP_BINARY_DOWNLOAD=1` plus `--ignore-scripts` keeps electron at
  1.2 MB with no binary.
- The root `prepare` (`effect-tsgo patch && vp config --no-agent`) patches
  the native TypeScript compiler for the Effect language service and
  installs git hooks. Neither touches the web build.
- `T3CODE_WEB_SOURCEMAP=0` drops source maps; with them `dist/` is larger
  (not measured).
- No service worker: `navigator.serviceWorker.getRegistrations()` is empty and
  `caches.keys()` is empty after a full session.

### Reference server (only for tracing)

```sh
# server needs the t3... filter (node-pty etc.), and runs from source
cd <workdir>
HOME=<throwaway> SHELL=/bin/sh PATH=<dir with claude>:/usr/bin:/bin \
  node t3/apps/server/src/bin.ts serve --port <port> --host 127.0.0.1 \
  --base-dir <throwaway>
node t3/apps/server/src/bin.ts auth pairing create --base-dir <same> --ttl 4h --json
```

- The server serves `apps/web/dist` itself (`resolveStaticDir`,
  `apps/server/src/config.ts:256`).
- First boot took about 5.5 minutes here: 61 migrations under IO pressure, and
  a login-shell `PATH` probe that timed out on zsh. `SHELL=/bin/sh` avoids the
  probe.
- The pairing token printed at startup lives 5 minutes; `auth pairing create
  --ttl` mints a longer one. `--scope` (repeatable) limits the grant.
- Claude ran through a wrapper (`HOME=/home/wizard exec ~/.local/bin/claude`)
  so the provider used the existing login. That also loaded the user's Claude
  hooks, which is why one prompt saw `sleep 45` refused.

## Wire format

- `/ws?…&orchestrationProtocol=2`, cookie auth. A wrong protocol on an HTTP
  GET to `/ws` returns 426; a WebSocket without the parameter is refused.
- JSON frames, Effect RPC: client `{"_tag":"Request","id":<n>,"tag":…,"payload":…,"traceId","spanId","sampled","headers":[]}`,
  server `{"_tag":"Chunk","requestId":"<n>","values":[…]}` for streams and
  `{"_tag":"Exit","requestId":"<n>","exit":{"_tag":"Success","value":…}}` for
  unary calls. The client acks every chunk with `{"_tag":"Ack","requestId":…}`
  and pings; the server answers `{"_tag":"Pong"}`.
- HTTP orchestration routes (`/api/orchestration/*`) require the header
  `x-t3-orchestration-protocol: 2`; without it, or with `1`, they return 400.
- The browser posts OTLP traces to `POST /api/observability/v1/traces` every
  few seconds, unconditionally (`apps/web/src/observability/clientTracing.ts`).
  The real server answers 204.

## HTTP requests the client makes

| When | Request | Answer |
|---|---|---|
| Pairing only | `POST /api/auth/browser-session` | 200, sets the session cookie |
| Every load | `GET /api/auth/session` (4 to 5 times) | `{authenticated, auth, scopes, permissions, sessionMethod, expiresAt}` |
| Every load | `GET /.well-known/t3/environment` (twice) | descriptor with `orchestrationProtocolVersion: 2` and `capabilities` |
| Every load | `GET /api/orchestration/shell` | `{schemaVersion: 2, snapshotSequence, threads, archivedThreads, projects}` |
| Thread open with no IndexedDB cache | `GET /api/orchestration/threads/:id/bounded?compactTurnItems=1` | `{snapshotSequence, projection, historyCursor, hasMoreHistory, latestLocalTurnOrdinal, payloadBudgetExceeded, turnItemsOmitLocalVisible}` (163 kB for 10 short runs; 223 kB without `compactTurnItems`) |
| Background | `POST /api/observability/v1/traces` | 204 |
| Images | `GET /apple-touch-icon.png`, `/api/assets/<signed>/project-favicon-missing` | static |

`/api/auth/session` carries both `scopes` (legacy, here
`["orchestration:read","orchestration:operate","terminal:operate","relay:read"]`)
and `permissions` (the granular list). `sessionGrantsScope`
(`contracts/src/auth.ts:180`) reads `permissions` when present.

## RPCs by moment

The client caches thread state in IndexedDB (`t3code:connection-runtime`) and
resumes with `afterSequence: <last seen>` on reload. Opening a thread with a
warm cache sent `orchestration.subscribeThread {afterSequence: 233}` and got
only `{"kind":"synchronized"}`; with the cache cleared it fetched the bounded
snapshot over HTTP first, then subscribed with `afterSequence` equal to the
snapshot's `snapshotSequence`.

### Boot (any page, before a thread opens)

| RPC | Answer the client got |
|---|---|
| `subscribeServerConfig {environmentThemes, usageLimitSources, usageLimitsCommand}` | stream: `snapshot` (full `ServerConfig`), `usageLimitSourcesUpdated {sources: []}`, `environmentThemesUpdated`, later `providerStatuses` |
| `subscribeServerLifecycle {}` | stream: `welcome {environment, cwd, projectName}` (sequence 1), `ready {at, environment}` (sequence 2). Subscribed twice on a thread page |
| `orchestration.subscribeShell {afterSequence, requestCompletionMarker: true}` | stream: `snapshot` when behind, then `{"kind":"synchronized"}`, then `project.updated` / `thread.updated` |
| `preview.reportProfiles {profiles: [], defaultProfileId: "default"}` | `null`, repeated 3 to 20 times per session |
| `subscribeProjectClones {}` | stream: `[]` |
| `server.reportClientActivity {...}` | `null`, every few seconds while the tab is visible |

### Opening a thread (draft or existing)

| RPC | Answer |
|---|---|
| `orchestration.subscribeThread {threadId, afterSequence, requestCompletionMarker, acceptBoundedSnapshot, acceptCompactTurnItems}` | stream: `synchronized`, then `{"kind":"event","sequence":n,"event":…}` |
| `orchestration.getArchivedShellSnapshot {}` | `{schemaVersion, snapshotSequence, projects, threads: []}` |
| `orchestration.dispatchCommand {type: "thread.visit", visitedAt}` | `{sequence}`, then a `thread.visited` event on the thread stream. Sent on every visit and every few seconds of focus |
| `subscribeVcsStatus {cwd[, includeRemote: false]}` | stream: `{"_tag":"snapshot","local":{isRepo,…},"remote":…}`, then `localUpdated` / `remoteUpdated` |
| `vcs.listRefs {cwd, limit[, query]}` | `{refs: [], isRepo, hasPrimaryRemote, nextCursor: null, totalCount: 0}` |
| `server.discoverSourceControl {}` | `{versionControlSystems: [...]}` |
| `projects.readFile {cwd, relativePath: "t3.json"}` | typed failure `ProjectReadFileError` when the file is missing; the client treats that as "no project config" |
| `assets.createUrl {resource: {_tag: "project-favicon", cwd}}` | `{relativeUrl, expiresAt}` |
| `preview.list {threadId}` | `{sessions: [], serverEpoch, revision: 0}` |
| `subscribePreviewEvents {}` | stream, no values |
| `subscribeTerminalMetadata {}` | stream: `{type: "snapshot", terminals: []}` |
| `subscribeDeviceState {}` | stream: one value `{hosts, devices, agentAccessEnabled, hostStatus, …}` |
| `scheduledTasks.subscribe {}` | stream: `{tasks: []}` |
| `server.refreshProviders {instanceId, cwd}` | `{providers: [...]}` |
| `filesystem.getMetadata {paths}` | `{entries: [{kind}]}`; called for the project root and for paths named in plan items |

### Actions

| User action | RPC |
|---|---|
| Wizard: Continue on Agents | `server.refreshProviders {}`, `agentSessions.scan {}` → `{candidates: [], scannedAt}` |
| Add project (palette, Local folder) | `filesystem.browse {partialPath}` per keystroke batch, then `projects.mutate {type: "project.create", commandId, projectId, title, workspaceRoot, …}` |
| Pick model, effort, mode in a draft | nothing; client state until send |
| First message of a new thread | `orchestration.launchThread {commandId, creationSource, threadId, projectId, title, generateTitle, modelSelection, runtimeMode, interactionMode, workspaceStrategy: {type: "root", branch}, initialMessage: {messageId, text, attachments}}` → `{threadId, projection, resumed}` |
| Later messages | `dispatchCommand {type: "message.dispatch", messageId, text, attachments, titleSeed, modelSelection, deliveryIntent, dispatchMode}` → `{sequence}` |
| Effort change | carried in the next `message.dispatch` as `modelSelection.options: [{id: "effort", value: "low"}]`; the server emits `thread.model-selection-updated` |
| Runtime mode change on an existing thread | `dispatchCommand {type: "thread.runtime-mode.set", runtimeMode}` at once |
| Plan toggle (Shift+Tab) | `dispatchCommand {type: "thread.interaction-mode.set", interactionMode: "plan"}` before the message |
| Approve / Decline | `dispatchCommand {type: "runtime-request.respond", requestId, decision: "accept"}` |
| Answer a question | `dispatchCommand {type: "runtime-request.respond", requestId, answers: {"<question id>": "Blue"}}` |
| Stop | `orchestration.getThreadProjection {threadId}`, then `dispatchCommand {type: "run.interrupt", runId}` |
| Implement a plan | `interaction-mode.set default`, then `message.dispatch` with `text: "PLEASE IMPLEMENT THIS PLAN:\n<markdown>"` and `sourcePlanRef {threadId, planId}` |
| Follow-up while running (Enter) | `message.dispatch` with `dispatchMode: {type: "queue_after_active"}` |
| Follow-up while running (Ctrl+Enter) | `message.dispatch` with `dispatchMode: {type: "start_immediately"}, deliveryIntent: "steer"` |

`deliveryIntent` overrides `dispatchMode` on the server
(`apps/server/src/orchestration-v2/CommandPolicy.ts:120-160`): with no active
run anything becomes `start_immediately`; `steer` becomes
`steer_active {targetRunId}`; `restart` becomes `restart_active`; `auto` queues
while the active run is `preparing` or `starting`. The sidecar needs the same
resolution.

## Thread event sequences

Per run the server emits, in order: `provider-thread.updated idle`,
`run.created starting`, `run-attempt.created pending`, `node.updated
root_turn pending`, `checkpoint-scope.created root_run`, `message.updated`
(the user message), `turn-item.updated user_message completed`,
`provider-session.updated ready`, `provider-thread.updated active`,
`run.updated running`, `run-attempt.updated running`, `node.updated root_turn
running`, `provider-turn.updated running`, then per item `node.updated
tool_call running` + `turn-item.updated <type> running`, the matching
`completed`, and at the end `provider-turn.updated completed`,
`run-attempt.updated completed`, `run.updated waiting`, `node.updated
root_turn waiting`, `provider-thread.updated idle`, `checkpoint.captured`,
`turn-item.updated checkpoint`, `run.updated completed`, `node.updated
root_turn completed`. Item ordinals are `run ordinal * 1,000,000 + n`.

| Scenario | Items and entities beyond the base sequence |
|---|---|
| Approval (Write, Supervised) | `file_change running`, `node.updated approval_request waiting`, `runtime-request.updated {kind: "file-change", status: "pending"}`, `turn-item.updated approval_request waiting {requestKind, prompt}`; after respond `resolved`, `completed` |
| Question (AskUserQuestion) | `dynamic_tool running`, `node.updated user_input_request waiting`, `runtime-request.updated {kind: "user_input"}`, `turn-item.updated user_input_request waiting {questions: [{id, header, question, options: [{label, description}], multiSelect}]}` |
| Stop | `turn-item.updated run_interrupt_request` (title "Interrupt requested"), `provider-turn.updated interrupted`, `run-attempt.updated interrupted`, `turn-item.updated run_interrupt_result interrupted`, `run.updated interrupted` |
| Plan mode | `file_change` (the plan file), `dynamic_tool` (ToolSearch), `dynamic_tool running` (ExitPlanMode), `node.updated plan completed`, `plan.updated {kind: "proposed_plan", status: "active", markdown}`, `turn-item.updated proposed_plan completed {planId, markdown}`, then ExitPlanMode `dynamic_tool failed`; the run then completes normally and the composer shows "Plan ready" with Implement. On Implement: `plan.updated completed` |
| Queued follow-up | `run.created {status: "queued", ordinal: n+1}`, `run-attempt.created`, `node.updated`, `checkpoint-scope.created`, `message.updated`; no `user_message` item until the run starts, then `turn-item.updated user_message` and `run.updated starting` |
| Steer | `message.updated` + `turn-item.updated user_message` inside the active run, between two tool items |
| Mode change | `thread.runtime-mode-updated`, `provider-session.detached`; the next run re-attaches (`provider-session.attached`) |

The `user_message` item and the `message.updated` entity carry the client's
own `messageId` from `message.dispatch` / `launchThread.initialMessage`.

Assistant text was never streamed in this trace: every `assistant_message`
item arrived once, `completed`, `streaming: false`, including a 200-word reply
(12 s after the prompt). T3's Claude adapter streams only thinking deltas
(`ClaudeAdapterV2.ts:6700-6745`) and emits text per completed content block.
The client setting "Response streaming: Show finished paragraphs"
(`settings.responseStreamingMode: "paragraph"`) governs how text appears.

## ServerConfig

`ServerConfig` (`contracts/src/server.ts:675`) required keys and what the real
server sent (full value in `trace/serverConfig.snapshot.json`):

| Key | Sent |
|---|---|
| `environment` | same descriptor as `/.well-known/t3/environment`, 39 capability flags |
| `auth` | `{policy: "loopback-browser", bootstrapMethods, sessionMethods, sessionCookieName, serverUpdateScope}` |
| `cwd`, `keybindingsConfigPath` | server cwd, path to `keybindings.json` |
| `keybindings` | 82 resolved bindings (`{command, shortcut, whenAst}`) |
| `issues` | `[]` |
| `providers` | 8 entries; only `claudeAgent` is `ready`, `codex` is `error`, the rest `disabled` |
| `availableEditors` | `[]` |
| `observability` | `{logsDirectoryPath, localTracingEnabled: true, otlp*Enabled: false}` |
| `settings` | `ServerSettings`, 55 keys, defaults from `DEFAULT_SERVER_SETTINGS`; notable: `defaultRuntimeMode: "full-access"`, `defaultModelSelection: null`, `responseStreamingMode: "paragraph"`, `textGenerationModelSelection` names codex |
| optional flags sent | `shellResumeCompletionMarker`, `threadResumeCompletionMarker`, `threadSnapshotPagination`, `threadFind`, `threadFindProgressive` all `true`; `remoteOpenTargets`, `directEndpoints: []`, `scratchWorkspaceRoot`, `newProjectsRoot` |

The `claudeAgent` provider entry the composer used:
`{instanceId: "claudeAgent", driver: "claudeAgent", displayName: "Claude",
enabled: true, installed: true, version: "2.1.296", status: "ready",
auth: {status: "authenticated"}, checkedAt, showInteractionModeToggle: true,
reportsContextWindow: true, supportedRuntimeModes: null, continuation:
{groupKey}, models: [13], slashCommands: [71], usageLimits: {windows: [],
unavailable: {reason: "unsupported"}}, versionAdvisory, compatibilityAdvisory}`.

Each model is `{slug, name, aliases, isCustom: false, isDefault?, isLegacy?,
badge?, capabilities: {optionDescriptors}}`. Option descriptors seen:

| id | type | options |
|---|---|---|
| `effort` | select, label "Reasoning" | `low, medium, high, xhigh, max, ultracode, ultrathink` (varies by model); one `isDefault`; `promptInjectedValues: ["ultrathink"]` |
| `fastMode` | boolean | Opus models |
| `contextWindow` | select | `200k, 1m` (Opus 4.6, Sonnet 4.6) |
| `thinking` | boolean | Haiku 4.5 |

The draft composer defaulted to the model marked `isDefault` (Claude Fable
5.1), effort `medium`, and mode from `settings.defaultRuntimeMode`. The mode
menu lists Supervised (`approval-required`), Auto-accept edits, Auto, Full
access when `supportedRuntimeModes` is `null`.

## Findings that change the design

1. **Auth scopes gate actions, not buttons.** A session with only
   `orchestration:read` and `orchestration:operate` still shows "Toggle
   terminal drawer" and "Git action options"; pressing the terminal toggle
   fires no RPC and opens nothing. Scopes alone do not give decision 24's
   result; the embed patch (or CSS in it) has to hide these controls.
   That session also raised a "Permissions have changed for devvm" toast,
   because its `permissions` held only legacy parent scopes
   (`sessionHasLegacyPermissions`, `contracts/src/auth.ts:195`). Granting any
   non-legacy scope, for example `settings:write` or `filesystem:read`, avoids it.
2. **Plan mode is a legacy client setting.** The Build/Plan toggle, `/plan`
   and Shift+Tab appear only with the client setting "Plan mode (legacy)" on
   (`planModeEnabled`, default `false`, stored in `localStorage`
   `t3code:client-settings:v1`). Lobby sessions in plan mode still render
   `proposed_plan` items, but the toggle needs the setting, which the embed
   patch could default on.
3. **T3's plan flow ends the turn.** ExitPlanMode is answered as a failed tool
   and the plan becomes a `proposed_plan` item; Implement is a new
   `message.dispatch` with `sourcePlanRef`. In the lobby the plan is a held
   dialog the mod answers, so Implement maps to answering that dialog, not to
   a new prompt.
4. **Enter queues by default while a run is active.** The default
   "Follow-up behavior" is Queue (`queue_after_active`); Ctrl+Enter steers.
   The queued-without-steering path (challenger change 6) is the common case,
   not an edge case.
5. **Steer arrives as `deliveryIntent: "steer"`** with
   `dispatchMode: start_immediately`, not as `dispatchMode: steer_active`.
6. **Effort travels inside `message.dispatch`.** There is no separate
   command for an effort change; `thread.model-selection.set` was not sent.
7. **`server.probe` did not fire** in about 15 minutes of use. The client calls
   it only as a liveness probe when `capabilities.connectionProbe` is true
   (`client-runtime/src/rpc/session.ts:375`); otherwise it calls
   `server.getConfig`. Cheap to implement, not on the boot path.
8. **`packages/shared` has more dependencies than contracts** (`@noble/*`,
   `jose`, the markdown pipeline, `yaml`). The two modules the sidecar wants
   import only contracts: `@t3tools/shared/orchestrationV2Timeline`
   (visibility) and `packages/client-runtime/src/state/orchestrationV2Projection.ts`
   (`applyOrchestrationV2ProjectionEvent`). Node 24 imports
   `packages/contracts/src/index.ts` directly with type stripping (1,592
   exports, `WsRpcGroup.requests.size === 193`), given `effect` 4.0.2 on the
   resolution path.
9. **The client cache depends on monotonic sequences** (confirms challenger
   change 2). With a warm IndexedDB the client resumes with its last
   `afterSequence`.
10. **The browser posts traces** to `/api/observability/v1/traces`; the
    sidecar needs a 204 there.

## Phone (390x844)

The thread page renders single-column with the composer docked at the bottom;
queued and steered user messages carry "Queued" and "Steer" labels
(screenshot `t3view-30-phone-thread.png` in the stage scratch directory). This
was a resized desktop Chromium, so touch, the soft keyboard and iOS Safari
inside a cross-origin iframe are unverified.

## Not verified

- Behaviour of the real client against a stub that dies on a unary call
  (only an unknown tag and a bad payload were tried against the real server).
- `thread.model-selection.set`, `queued-run.cancel` / `.edit`,
  `restart_active`, history paging (`/history` returned 400 without a cursor),
  images, `getTurnDiff`.
- Whether the client stops posting traces when `observability` is changed.
- Build time on a GitHub runner; these numbers come from a busy devvm.

## Appendix

### Raw RPC lists by scenario

Each line: RPC tag (dispatchCommand sub-type), count in that capture, how the real server answered.

#### 01-pair-boot: pair + first boot

```
subscribeServerConfig                                      x1   stream
subscribeServerLifecycle                                   x1   stream
preview.reportProfiles                                     x3   Success
orchestration.subscribeShell                               x1   stream
```

#### 02-reload-welcome: reload on /welcome (boot, empty workspace)

```
subscribeServerConfig                                      x1   stream
subscribeServerLifecycle                                   x1   stream
preview.reportProfiles                                     x3   Success
orchestration.subscribeShell                               x1   stream
```

#### 03-welcome-flow: first-run wizard steps

```
server.refreshProviders                                    x1   Success
preview.reportProfiles                                     x4   Success
agentSessions.scan                                         x1   Success
subscribeServerLifecycle                                   x1   stream
subscribeProjectClones                                     x1   stream
server.reportClientActivity                                x1   Success
```

#### 04-add-project: add project, open draft thread

```
server.discoverSourceControl                               x1   Success
filesystem.browse                                          x3   Success
projects.mutate                                            x1   Success
projects.readFile                                          x1   Failure:Fail:ProjectReadFileError
server.refreshProviders                                    x1   Success
subscribeVcsStatus                                         x1   stream
subscribeDeviceState                                       x1   stream
subscribePreviewEvents                                     x1   stream
subscribeTerminalMetadata                                  x1   stream
assets.createUrl                                           x1   Success
preview.list                                               x3   Success
vcs.listRefs                                               x2   Success
server.reportClientActivity                                x1   Success
preview.reportProfiles                                     x1   Success
```

#### 06-send-first-prompt: first prompt (launchThread), Bash tool

```
orchestration.launchThread                                 x1   Success
orchestration.dispatchCommand [thread.visit]               x4   Success
subscribeVcsStatus                                         x4   stream, stream (ended by server Interrupt on resubscribe)
orchestration.subscribeThread                              x1   stream
scheduledTasks.subscribe                                   x1   stream
orchestration.getArchivedShellSnapshot                     x1   Success
server.reportClientActivity                                x4   Success
```

#### 07-approval: second prompt, Write tool approval

```
orchestration.dispatchCommand [message.dispatch]           x1   Success
orchestration.dispatchCommand [thread.visit]               x3   Success
server.reportClientActivity                                x3   Success
orchestration.dispatchCommand [runtime-request.respond]    x1   Success
subscribeVcsStatus                                         x2   stream, stream (ended by server Interrupt on resubscribe)
```

#### 08-mode-effort: runtime mode + effort change, prompt

```
orchestration.dispatchCommand [thread.runtime-mode.set]    x1   Success
orchestration.dispatchCommand [message.dispatch]           x1   Success
orchestration.dispatchCommand [thread.visit]               x4   Success
server.reportClientActivity                                x5   Success
subscribeVcsStatus                                         x2   stream, stream (ended by server Interrupt on resubscribe)
```

#### 09-interrupt: prompt then Stop

```
server.reportClientActivity                                x3   Success
orchestration.dispatchCommand [message.dispatch]           x1   Success
orchestration.dispatchCommand [thread.visit]               x2   Success
orchestration.getThreadProjection                          x1   Success
orchestration.dispatchCommand [run.interrupt]              x1   Success
subscribeVcsStatus                                         x1   stream
```

#### 10-streaming: 200-word reply

```
orchestration.dispatchCommand [message.dispatch]           x1   Success
server.reportClientActivity                                x2   Success
orchestration.dispatchCommand [thread.visit]               x2   Success
subscribeVcsStatus                                         x1   stream
```

#### 11-question: AskUserQuestion

```
orchestration.dispatchCommand [message.dispatch]           x1   Success
orchestration.dispatchCommand [thread.visit]               x3   Success
orchestration.dispatchCommand [runtime-request.respond]    x1   Success
preview.reportProfiles                                     x2   Success
subscribeVcsStatus                                         x1   stream
server.reportClientActivity                                x1   Success
```

#### 14-thread-open-cold: reload on thread URL (IndexedDB cache warm)

```
subscribeServerConfig                                      x1   stream
subscribeServerLifecycle                                   x2   stream
subscribeProjectClones                                     x1   stream
subscribeVcsStatus                                         x2   stream
subscribeDeviceState                                       x1   stream
scheduledTasks.subscribe                                   x1   stream
orchestration.subscribeThread                              x1   stream
subscribePreviewEvents                                     x1   stream
subscribeTerminalMetadata                                  x1   stream
vcs.listRefs                                               x2   Success
preview.reportProfiles                                     x3   Success
assets.createUrl                                           x1   Success
server.discoverSourceControl                               x1   Success
orchestration.getArchivedShellSnapshot                     x1   Success
preview.list                                               x1   Success
projects.readFile                                          x1   Failure:Fail:ProjectReadFileError
orchestration.subscribeShell                               x1   stream
server.reportClientActivity                                x1   Success
```

#### 15-plan: plan mode prompt (legacy toggle on)

```
server.refreshProviders                                    x1   Success
orchestration.dispatchCommand [thread.interaction-mode.set] x1   Success
orchestration.dispatchCommand [message.dispatch]           x1   Success
orchestration.dispatchCommand [thread.visit]               x3   Success
preview.reportProfiles                                     x1   Success
server.reportClientActivity                                x3   Success
subscribeVcsStatus                                         x2   stream, stream (ended by server Interrupt on resubscribe)
filesystem.getMetadata                                     x2   Success
```

#### 16-plan-implement: Implement plan

```
orchestration.dispatchCommand [thread.interaction-mode.set] x1   Success
orchestration.dispatchCommand [message.dispatch]           x1   Success
orchestration.dispatchCommand [thread.visit]               x3   Success
subscribeVcsStatus                                         x3   stream, stream (ended by server Interrupt on resubscribe)
server.reportClientActivity                                x4   Success
```

#### 17-queue-steer: queued follow-up + Ctrl+Enter steer

```
orchestration.dispatchCommand [message.dispatch]           x3   Success
orchestration.dispatchCommand [thread.visit]               x3   Success
subscribeVcsStatus                                         x4   stream, stream (ended by server Interrupt on resubscribe)
server.reportClientActivity                                x5   Success
```

#### 18-phone-cold-thread: 390x844, IndexedDB cleared, open thread

```
subscribeServerConfig                                      x1   stream
subscribeServerLifecycle                                   x2   stream
preview.reportProfiles                                     x3   Success
subscribeProjectClones                                     x1   stream
orchestration.subscribeShell                               x1   stream
subscribeVcsStatus                                         x2   stream, stream (ended by server Interrupt on resubscribe)
subscribeDeviceState                                       x1   stream
subscribePreviewEvents                                     x1   stream
subscribeTerminalMetadata                                  x1   stream
assets.createUrl                                           x1   Success
preview.list                                               x1   Success
projects.readFile                                          x1   Failure:Fail:ProjectReadFileError
orchestration.subscribeThread                              x1   stream
filesystem.getMetadata                                     x1   Success
server.reportClientActivity                                x1   Success
```

#### 19-scoped: session with only orchestration:read/operate

```
subscribeServerConfig                                      x2   stream
subscribeServerLifecycle                                   x2   stream
subscribeProjectClones                                     x1   stream
orchestration.subscribeShell                               x1   stream
subscribeVcsStatus                                         x3   stream, stream (ended by server Interrupt on resubscribe)
subscribeDeviceState                                       x1   stream
vcs.listRefs                                               x2   Success
scheduledTasks.subscribe                                   x1   stream
assets.createUrl                                           x1   Success
server.discoverSourceControl                               x1   Success
orchestration.getArchivedShellSnapshot                     x1   Success
orchestration.subscribeThread                              x1   stream
server.reportClientActivity                                x1   Success
```

### All 193 RPCs in WsRpcGroup at the pin

S = stream, U = unary. "seen" = the web client called it during this trace.

```
U server.probe                                                 
U server.getConfig                                             
U server.refreshProviders                                      seen: Success
U server.updateProvider                                        
U provider.consumeResetCredit                                  
U provider.auth.start                                          
U provider.auth.complete                                       
U provider.chatgpt.reconnect-profile                           
U provider.chatgpt.import-profile                              
S provider.chatgpt.handoff.subscribe                           
S provider.codex.auth-callback.subscribe                       
U provider.auth.respond                                        
U provider.auth.cancel                                         
U provider.auth.logout                                         
S provider.auth.subscribe                                      
U provider.install.start                                       
U provider.install.cancel                                      
S provider.install.subscribe                                   
U provider.install.remove                                      
U server.updateServer                                          
S server.updateServerWithProgress                              
U server.commitDesktopUpdate                                   
U server.upsertKeybinding                                      
U server.removeKeybinding                                      
U server.runStorageCleanup                                     
S server.getStorageCleanupReport                               
U server.getSettings                                           
U server.updateSettings                                        
U server.discoverSourceControl                                 seen: Success
U server.searchAcpRegistry                                     
U server.prepareAcpRegistryAgent                               
U server.uninstallAcpRegistryManagedBinary                     
U server.acceptAcpRegistryUrlAuth                              
U server.listAcpRegistrySessions                               
U server.importAcpRegistrySession                              
U server.deleteAcpRegistrySession                              
U server.listAcpRegistryProviders                              
U server.setAcpRegistryProvider                                
U server.disableAcpRegistryProvider                            
U server.logoutAcpRegistry                                     
U server.getTraceDiagnostics                                   
U server.getProcessDiagnostics                                 
U server.getHostResources                                      
U server.getProcessResourceHistory                             
U server.getResourceTelemetryHistory                           
U server.retryResourceTelemetry                                
U server.checkOtlpEndpoint                                     
U server.getUsageSummary                                       
U server.refreshUsageRates                                     
U server.signalProcess                                         
U scheduledTasks.list                                          
S scheduledTasks.subscribe                                     seen: stream
U scheduledTasks.upsert                                        
U scheduledTasks.setEnabled                                    
U scheduledTasks.delete                                        
U scheduledTasks.runNow                                        
U scheduledTasks.rotateWebhookToken                            
U secrets.answerRequest                                        
U scheduledTasks.listWebhookDeliveries                         
U scheduledTasks.getWebhookDelivery                            
U server.reportClientActivity                                  seen: Success
U server.reportHostPowerState                                  
U server.getBackgroundPolicy                                   
U cloud.getRelayClientStatus                                   
S cloud.installRelayClient                                     
U pullRequests.list                                            
U pullRequests.listStats                                       
U pullRequests.summary                                         
U pullRequests.routing                                         
U pullRequests.routingIdentity                                 
U pullRequests.stack                                           
U pullRequests.linkedThreads                                   
U pullRequests.detail                                          
U pullRequests.preview                                         
U pullRequests.checks                                          
U pullRequests.activity                                        
U pullRequests.reviewGuide                                     
U pullRequests.generateReviewGuide                             
U pullRequests.threadComments                                  
U pullRequests.diffFileContents                                
U pullRequests.filesViewed                                     
U pullRequests.setFilesViewed                                  
U pullRequests.runAction                                       
U pullRequests.update                                          
U pullRequests.comment                                         
U pullRequests.updateComment                                   
U pullRequests.submitReview                                    
U pullRequests.replyToThread                                   
U pullRequests.setThreadResolution                             
U pullRequests.setReaction                                     
U pullRequests.invalidate                                      
U pullRequests.reportState                                     
S pullRequests.subscribeRefreshes                              
U pullRequests.reviewerCandidates                              
U pullRequests.requestReviewers                                
U pullRequests.labelCandidates                                 
U pullRequests.setLabels                                       
U sourceControl.lookupRepository                               
U sourceControl.cloneRepository                                
U sourceControl.publishRepository                              
U projectClone.start                                           
U projectClone.cancel                                          
U projectClone.retry                                           
S subscribeProjectClones                                       seen: stream
U projects.listEntries                                         
U projects.readFile                                            seen: Failure:Fail:ProjectReadFileError
U projects.searchContents                                      
U projects.searchEntries                                       
U projects.ensureScratch                                       
U projects.createNew                                           
U projects.writeFile                                           
U projects.mutate                                              seen: Success
U shell.openInEditor                                           
U filesystem.browse                                            seen: Success
U filesystem.getMetadata                                       seen: Success
U agentSessions.scan                                           seen: Success
U agentSessions.import                                         
U assets.createUrl                                             seen: Success
U assets.persistChatAttachments                                
U attachments.createUploadUrl                                  
U attachments.delete                                           
U mcpApps.callTool                                             
U mcpApps.toolInfo                                             
U mcpApps.readResource                                         
U mcpApps.updateModelContext                                   
U provider.uploadFeedback                                      
S subscribeVcsStatus                                           seen: stream, stream (ended by server Interrupt on resubscribe)
S subscribeWorktreeSetup                                       
U worktreeSetup.cancel                                         
U vcs.pull                                                     
U vcs.refreshStatus                                            
S git.runStackedAction                                         
U git.resolvePullRequest                                       
U git.preparePullRequestThread                                 
U vcs.listRefs                                                 seen: Success
U vcs.createWorktree                                           
U vcs.removeWorktree                                           
U vcs.createRef                                                
U vcs.switchRef                                                
U vcs.init                                                     
U review.getDiffPreview                                        
U review.getDiffFileContents                                   
U terminal.open                                                
S terminal.attach                                              
S terminal.observe                                             
U terminal.write                                               
U terminal.resize                                              
U terminal.clear                                               
U terminal.restart                                             
U terminal.close                                               
S subscribeTerminalEvents                                      
S subscribeTerminalMetadata                                    seen: stream
U preview.open                                                 
U preview.navigate                                             
U preview.resize                                               
U preview.adjust                                               
U preview.refresh                                              
U preview.close                                                
U preview.list                                                 seen: Success
U preview.clearProfile                                         
U preview.reportProfiles                                       seen: Success
U preview.reportStatus                                         
S subscribePreviewEvents                                       seen: stream
S subscribeDiscoveredLocalServers                              
U device.configure                                             
U device.list                                                  
U device.testHost                                              
U device.open                                                  
U device.close                                                 
U device.shutdown                                              
U device.detail                                                
U device.action                                                
S subscribeDeviceState                                         seen: stream
S subscribeServerConfig                                        seen: stream
S subscribeServerLifecycle                                     seen: stream
S subscribeAuthAccess                                          
S subscribeBackgroundPolicy                                    
S subscribeResourceTelemetry                                   
U orchestration.dispatchCommand                                seen: Success
U orchestration.getWorkflowScript                              
U orchestration.stopWorkflow                                   
U orchestration.getTurnItem                                    
U orchestration.getTurnDiff                                    
U orchestration.getFullThreadDiff                              
U orchestration.searchThreads                                  
U orchestration.searchThread                                   
S orchestration.searchThreadStream                             
U orchestration.getArchivedShellSnapshot                       seen: Success
U orchestration.getThreadProjection                            seen: Success
U orchestration.launchThread                                   seen: Success
S orchestration.subscribeArchivedShell                         
S orchestration.subscribeShell                                 seen: stream
S orchestration.subscribeThread                                seen: stream
```

