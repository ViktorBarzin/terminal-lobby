# Client diagnostics ride the usage pipeline, with their own marker

We can answer "which parts of the lobby earn their keep?" (ADR-0006) but not
"why did it feel slow on Tuesday?" or "what broke on bob's phone?". Nothing
records performance yet, and reliability is covered by one event, `app.error`,
which carries a `kind`.

This ADR adds **diagnostics**: per-session performance measurements and a full
record of each failure, from every surface, queryable in Grafana.

```stats
60 s | rollup window, active tabs
5 min | liveness heartbeat when idle
300/min | diagnostics rate budget per user
30 days | Loki retention, unchanged
3 | surfaces, one shared diag.js
12 | record types in the catalog
```

## Where the gap is today

ADR-0006 built a working browser→Loki path and this design reuses all of it.
What that path does not yet carry:

| Signal | State today |
|---|---|
| Any latency measurement | None. `performance.now` appears 15× per frontend, all for internal timing |
| Navigation / resource timing | None. No `PerformanceObserver` anywhere |
| Device and network context | None captured |
| Exception detail | `app.error` records `tl.kind` only — no message, no stack |
| Terminal-surface telemetry | `frontend/term.html` emits nothing. It calls `tlTrack` at `:4737` and `:4743` but never defines it, so those paths raise a `ReferenceError` when a pending self-update record exists |
| Tab correlation | No identifier joins one tab's records together |
| Connection health | WebSocket drops, reconnects and downtime are unrecorded |

The `tlTrack` gap shows the shape of the problem: a latent error on the
post-self-update boot path of the terminal surface, which no current signal
would report.

## Decisions

| Question | Decision |
|---|---|
| Scope | All four: terminal interactivity, reliability/errors, startup performance, backend latency as the client sees it |
| Record shape | Hybrid — windowed rollups for measurements, per-occurrence records for failures |
| Channel | Same `/telemetry` intake and same Go module as ADR-0006; distinct `TLDIAG` marker, own catalog, own rate budget |
| Correlation | Tab id, parent (lobby) id, persistent device id, session name, connection sequence |
| Echo latency | Quiet-gated sampling with an explicit unmatched count |
| Exception detail | Message, source location and stack, unredacted, deduped with a count |
| Cadence | 60 s rollups while active; liveness heartbeat every 5 min while idle or hidden; crash detection via a boot sentinel |
| "Active" | Visible **and** saw traffic. Focus not required |
| Code shape | One `frontend/diag.js`, inlined into all three surfaces at build |
| Server side | Shared middleware on the four Go services, joined to the client by request id |
| Retention | Loki only, 30 days. No Prometheus, no alerting |
| Dashboard | Health rows added to the existing *Terminal Lobby Usage* dashboard, collapsed by default |
| Disclosure | Default on, with a settings toggle and a `?diag=0` per-tab escape hatch |
| Selection JSONL | Folded in — its flight-recorder capability becomes a general TLDIAG feature |
| Rollout | All three surfaces in one pass |

## Architecture

```mermaid
flowchart TD
    subgraph browser["Browser — one diag.js, three surfaces"]
        V1["index.html<br/>vanilla lobby + terminal"]
        TH["term.html<br/>v2 terminal iframe"]
        V2["index-v2.html<br/>v2 SPA"]
    end

    subgraph core["diag.js — shared measurement core"]
        RU["rollup windows<br/>60 s, active only"]
        INC["incident records<br/>per occurrence"]
        RING["event ring<br/>last 30 raw events"]
    end

    subgraph devvm["devvm"]
        API["tmux-api POST /telemetry<br/>auth · catalog · rate cap · sanitiser"]
        MW["shared HTTP middleware<br/>tmux-api · clipboard-upload<br/>file-api · session-events"]
    end

    J["journald"]
    P["promtail.service"]
    L["Loki — 30-day retention"]
    G["Grafana<br/>Terminal Lobby Usage"]

    V1 --> core
    TH --> core
    V2 --> core
    RING -.->|attached on incident| INC
    RU --> API
    INC --> API
    API -->|"TLDIAG + JSON"| J
    MW -->|"TLDIAG api.served"| J
    J --> P --> L --> G
```

## The record vocabulary

A closed catalog, for the reasons ADR-0006 gives: a typo would mint a series
nobody queries, and the intake accepts names from the client.

| Record | When | Carries |
|---|---|---|
| `perf.rollup` | every 60 s while active | input / echo / render latency (n, p50, p95, max), echo unmatched count, long-task count and total, frame jank count, WS bytes and frames, per-endpoint API n/p50/p95/errors |
| `app.alive` | every 5 min while idle or hidden | ids, uptime, `tl.state` (idle\|hidden). No measurements |
| `app.died` | next boot after an unclean exit | previous tab id, uptime, last-seen session |
| `conn.opened` | per occurrence | token-fetch ms, handshake ms, attempt number |
| `conn.dropped` | per occurrence | close code, uptime, reconnect number, downtime ms, `tl.reason` |
| `term.stall` | per occurrence | input sent with no output for longer than the threshold |
| `app.exception` | per occurrence, deduped | message, `file:line:col`, stack, occurrence count, `tl.kind` |
| `api.slow` | per occurrence over threshold | endpoint, status, duration, request id |
| `api.served` | server side, over threshold | endpoint, duration, status, request id |
| `api.rollup` | server side, every 60 s | per-service distribution by endpoint group |
| `app.context` | per boot | navigation timing, transfer size, cache hit, device and network context |
| `term.ready` | per boot | iframe boot → first byte → first paint |
| `diag.incident` | per occurrence | `tl.kind` plus the preceding raw event trace |

Boot context is a diagnostics record of its own rather than an extension of the
usage `app.loaded`, so the whole health vocabulary stays selectable by the
`TLDIAG` marker.

Every record additionally carries `tl.tab`, `tl.parent`, `tl.device`,
`tl.session`, `tl.conn`, `tl.client` and `tl.role`. `tl.client` names the
surface; `tl.role` distinguishes lobby from terminal, because vanilla
`index.html` serves both roles from one file.

## How echo latency is sampled

A keystroke travels `keydown` → `term.onData` → soft-mod wrapper → `sendInput` →
`ws.send` → devvm → inbound `MSG_OUTPUT` frame → `term.write(data, cb)` → render
callback. The flow-control accounting at `term.html:9441+` already registers
those write callbacks, so the render leg costs nothing new.

Input-path cost and render cost are unconfounded. Echo round-trip is not: if
Claude is mid-turn, the next inbound frame is unrelated output rather than an
echo. Sampling is therefore gated.

```mermaid
sequenceDiagram
    participant U as keydown
    participant W as ws.send
    participant S as devvm / tmux / app
    participant X as xterm render

    Note over U,W: gate — no inbound frame for ≥300 ms<br/>AND exactly one keystroke in flight
    U->>W: input path (measured)
    W->>S: 
    S-->>X: first MSG_OUTPUT within 2000 ms
    Note right of X: matched → echo sample<br/>no frame in 2000 ms → discard,<br/>tl.echo.unmatched++
    X->>X: write → callback (render, measured)
```

The rollup reports `tl.echo.unmatched` alongside `tl.echo.n`. A p95 drawn from
47 usable samples out of 165 attempts is a different claim than one drawn from
400, and the record says which it is.

Percentiles come from raw samples held per metric per window, capped at 512 with
reservoir sampling beyond, sorted at window close. Exact for windows of 512
samples or fewer; sampled above that, and bounded in memory either way.

## When a tab measures

```mermaid
stateDiagram-v2
    [*] --> Active: boot, visible
    Active --> Idle: window with no input or output
    Idle --> Active: input or output
    Active --> Hidden: visibilitychange
    Idle --> Hidden: visibilitychange
    Hidden --> Active: visible again
    Active --> [*]: pagehide — final flush, clear sentinel
    Idle --> [*]: pagehide
    Hidden --> [*]: pagehide

    note right of Active
        perf.rollup every 60 s
    end note
    note right of Idle
        app.alive every 5 min
        no measurements
    end note
    note right of Hidden
        app.alive every 5 min
        measurement paused —
        throttled timers and
        stopped rAF would
        distort the numbers
    end note
```

Focus is deliberately not part of "active": a terminal rendering a long Claude
turn in a background window is a real rendering-performance case worth
measuring. Input-latency fields are simply absent from windows where nobody
typed.

Crash detection costs nothing while idle. Boot writes a sentinel to
localStorage; `pagehide` flushes a final partial rollup and clears it. A
sentinel present at the next boot means the previous page life ended without a
`pagehide` — killed rather than closed — and is reported once as `app.died`.

## The flight recorder

The existing selection-diagnostics channel (`?seldebug` →
`_telemetry/<user>.jsonl`) is retired, and the capability that made it valuable
becomes general. It keeps a 30-entry ring of raw input events and flushes it
when a selection anomaly fires; that recording identified the cause after
earlier fixes had not. Reducing it to counts would discard the part that carried
the diagnostic value.

So `diag.js` keeps a rolling ring of recent raw events on every surface, and any
incident — stall, exception, WS drop, selection clear — carries the preceding
trace. One channel, one opt-out, and the recorder now covers every failure class
rather than one.

Measured before deciding: the JSONL channel is live, not dormant —
`bob.jsonl` was written on 2026-08-14 at 09:51 (150 KB) and `wizard.jsonl` is
393 KB. Retiring it removes a working instrument, which is why the capability
is carried across rather than dropped.

## Constraints inherited, and two deliberate relaxations

ADR-0006's constraints all still apply: Loki is a single anonymous tenant with a
global 5000-active-stream cap, so nothing here becomes a label and every
attribute lives inside the JSON line; retention is 30 rolling days; user-supplied
names are JSON-escaped and bounded.

Two rules are relaxed on purpose, both scoped to diagnostics records:

- **`tl.stack` may reach 1024 bytes**, against the 512-byte `MaxValueLen` that
  applies elsewhere. A stack truncated to 512 bytes routinely loses the frames
  that identify the call path.
- **`tl.trace` may be an array**, which `sanitizeAttrs` otherwise drops
  (`telemetry.go:156`). It is validated as a flat array of scalar-valued
  objects, capped at 30 entries and 4 KiB, and permitted only on per-incident
  records — never on a rollup.

Diagnostics gets its own token bucket at 300 events/min/user, separate from the
600/min usage budget, so a diagnostics burst cannot starve usage events or the
reverse. Expected steady-state volume is roughly 2 records/min per active tab.

## Volume

| State | Records |
|---|---|
| Active tab | ~1 rollup/min (lobby) + ~1/min (terminal iframe) |
| Idle or hidden tab | ~12 liveness records/hour |
| Incidents | Per occurrence, deduped by message and top frame within the window |

At two users this sits well inside both the intake cap and the stream budget.

## Where the code lives

One implementation, `frontend/diag.js`, holding the measurement core: quiet-gate
state machine, percentile accumulation, dedupe, event ring and bounded buffer.

- `deploy.sh` and `deploy-v2.sh` substitute it into a `__TL_DIAG__` placeholder
  in `index.html` and `term.html` — plain `sed`, matching how `__TL_BUILD__` and
  `__TL_ASSET__` already work, with the same fail-the-deploy check for surviving
  placeholders.
- `frontend-v2` inlines it through the single-file build it already runs
  (`vite-plugin-singlefile`, `removeViteModuleLoader: true`).
- `frontend-v2/test/` covers it directly. vitest with jsdom is already the
  runner for 65 test files, and a plain-JS module imports into it unchanged.

> [!IMPORTANT]
> The asset fingerprint has to cover `diag.js`. ADR-0007 computes `TL_ASSET`
> from `sha256sum frontend/index.html` on the unstamped source, so a change
> confined to `diag.js` would leave every page's identity unmoved and no tab
> would ever self-update to the corrected code — ADR-0007's failure mode
> inverted. Each surface's fingerprint therefore hashes its own source
> concatenated with `diag.js`.

Wiring `diag.js` into `term.html` also supplies the `tlTrack` that its
self-update paths already call, closing the dangling reference at `:4737` and
`:4743`.

## Splitting network from server

The client stamps `X-TL-Req: <tab>-<n>` on API calls. A shared middleware across
`tmux-api`, `clipboard-upload`, `file-api` and `session-events` emits a 60 s
rollup per service by endpoint group, plus an `api.served` record for any
request over the threshold, echoing the request id.

```
client  api.slow   {tl.ep:"/layout", tl.ms:812, tl.req:"f3a91c02-17"}
server  api.served {tl.ep:"/layout", tl.ms:6,   tl.req:"f3a91c02-17"}
```

The 806 ms difference is not devvm handling time. `ttyd` stays uninstrumented —
it is the C binary carrying a local patch, and its health is already visible
through the client-side WebSocket metrics.

## Deploys drop every WebSocket

A deploy restarts `ttyd`, which drops every open WebSocket; tabs reconnect
automatically. Every deploy will therefore produce a `conn.dropped` for every
open tab, and unlabelled that would read as a reliability problem. When the
asset id observed after a reconnect differs from the one before it, the drop
carries `tl.reason:"deploy"` so deploy churn is separable from real instability.

## What is recorded, and what is not

> [!NOTE]
> Diagnostics record how the app performed and how it failed — never what was
> typed into it. The same boundary ADR-0006 set for usage events applies here
> unchanged.

Diagnostics record timings, counts,
close codes, stack traces, device and network characteristics. Never
conversation content, prompt text, file contents, or general typing. The event
ring captures input *geometry and control keys* — pointer positions, wheel
deltas, Enter/Escape/modifier chords — on the same basis the selection channel
already did, not typed characters.

Records carry `user.id` resolved server-side from the Authentik header. The
browser never states who it is.

`tl.device` is a persistent random id in localStorage. It identifies a browser
profile across reloads so device-specific problems are visible, and it adds no
identification beyond the OS-user attribution every record already carries.

## Disclosure

Diagnostics are on by default, with a **Send diagnostics** toggle in the
settings panel and a `?diag=0` escape hatch for a single tab. The toggle is the
disclosure: discoverable by anyone who opens settings, with no banner.

This is a change from ADR-0006, which recorded usage with no in-app surface.
Diagnostics collect more — stack traces, a persistent device id, hardware
and network characteristics — from both users, so the control is visible.

## Consequences

- Adding a diagnostics record means editing the Go catalog, `diag.js`, and the
  vocabulary table above in one commit. Same deliberate duplication as ADR-0006.
- `diag.js` is inlined into three artifacts, so any change to it re-fingerprints
  all three and every open tab self-updates. That is the intended behaviour and
  it makes diagnostics changes more visible than backend-only ones.
- Analysis stays within a rolling 30 days. Long-term drift ("is the terminal
  slower than it was in spring") and alerting both remain unbuilt. The host side
  of that path already works — the devvm runs node_exporter with an active
  textfile collector at `/var/lib/prometheus/node-exporter/` — and the cluster
  side would need a scrape target; none for the devvm appears in
  `infra/stacks/monitoring/` today.
- Retiring the JSONL channel removes on-host raw traces. The ring buffer
  replaces the capability, bounded at 30 entries rather than unbounded on disk.

## Open questions

- The 300 ms quiet gate, 2000 ms match deadline, and stall threshold are
  starting values chosen from the shape of the problem, not from measurement.
  They will need tuning once real distributions exist; `tl.echo.unmatched` is
  the signal for whether the gate is too strict.
- Whether the 5-minute heartbeat is frequent enough to locate a tab death
  usefully is untested. The sentinel makes the *fact* of an unclean exit exact;
  only the timing is bounded by the heartbeat.
- Rollup memory under a very long-lived tab (many days) has not been measured.
  The buffers are bounded by construction, but the bound has not been observed
  in practice.
