# Connection status a client can see

**Status:** built, 2026-09-01 · **ADR:** [0016](../adr/0016-connection-status-in-the-ui.md)

Viktor asked for it in one line: *"clients should be able to see their
connection status (e.g. is websockets working) etc. this should be viewable in
the ui somewhere so it's easy to see the status."*

A client keeps five things alive. Before this, a person could see two.

| Channel | Transport | What a user could see |
|---|---|---|
| Terminal | WebSocket → ttyd, inside the `term.html` iframe | a pill *inside the iframe* |
| Transcript | SSE `/events/<session>` | a badge, **text view only** |
| Session list | HTTP poll, 5 s, backoff to 30 s | nothing |
| Notifications | service worker + push subscription | nothing |
| Build | the deploy healer's asset-id check | nothing |

`SessionView.tsx` already carried a comment explaining why the badge hides on
the Terminal view: a status for a surface you are not looking at reads as the
terminal's. That reasoning was right, and it left the terminal — the thing
actually in front of you — reporting nothing at all.

ADR-0008 has been recording every drop, reconnect and stall to Loki for weeks.
That is the right place for the history and the wrong place for the question:
reading it means opening Grafana, which the person holding the frozen phone
cannot do.

## The shape

```mermaid
flowchart LR
  subgraph P["providers — each already knew this"]
    T["term.html<br/>tl-conn"]
    S["SseClient<br/>onStatus"]
    L["lobby poll<br/>pollHealth"]
    N["push<br/>permission + subscription"]
    B["deploy healer<br/>onUpdatePending"]
  end
  P --> M["status.ts — PURE<br/>5 channels × 3 states<br/>+ unknown"]
  M --> B1["session bar badge<br/>all five"]
  M --> B2["sidebar header badge<br/>list · push · build"]
  M --> PANEL["Right now<br/>Settings → Network"]
  PANEL --> CHK["Run check<br/>5 probes, parallel, 5s cap"]
  PANEL --> FIX["Reconnect · Refresh<br/>Reload · Turn on"]
  CHK --> LOKI["diag.selfcheck → Loki"]
  B1 -.tap.-> PANEL
  B2 -.tap.-> PANEL
```

Nothing new is polled. Every provider was already computing its own health and
had nowhere to say it; the poll's failure ladder and the healer's deferred-update
plan were both entirely internal until now.

## What was decided, and why

| Decision | Chosen | The alternative, and what it cost |
|---|---|---|
| Audience | Verdict first, detail below | End-user-only reads well and still sends you to Grafana for someone else's report |
| Channels | The five that carry work | Adding telemetry and network identity duplicates the page below and adds a row nobody can act on |
| Check | Passive state **and** an active check | Passive alone cannot answer "is push broken?" — a subscription looks healthy right up until nothing arrives |
| Scope | Connections plus build version | A tab on old JavaScript against a new server looks exactly like a broken connection |
| Home | First group of Settings → Network | A second rail page called "Connection" splits one mental model across two adjacent entries |
| Badge | Session bar **and** sidebar header | The mobile list screen is the whole viewport and would otherwise have no status at all |
| Wording | Dot always, word when wrong | An always-on "Connected" spends bar width on the state that is true 99% of the time |
| Push | Read state, send nothing | `/push/test` fans out to every device; a diagnostic that buzzes the phone in your pocket is one you stop running |
| States | Three, plus a neutral `unknown` | Two states collapse "wait" and "act", which is the one distinction a frozen terminal needs |
| Repairs | Per-row, explicitly tapped | A check that repairs as it goes destroys the state its reader came to look at |
| Timing | Parallel, 5 s each, rows land independently | Serial reaches 20-25 s on a bad link; one combined result is a 5 s blank stare |
| History | Since page load, in memory | Persisting costs a storage decision and a Privacy question; Loki already holds the durable copy |
| Reach | This tab, plus two read-only calls about this device | "All your devices" needs new server state and a retention policy — its own project |

## Three states, and one value that is not a state

`working` / `degraded` / `down`, and `unknown`.

`unknown` is the load-bearing one. Every rule skips it rather than counting it as
health or as fault, which is what makes the whole thing safe to build on top of a
provider that might not answer: a booting terminal iframe, a cached older build
that predates the `tl-conn` message, a browser without push, a screen with no
terminal on it. Reporting "everything is connected" on the strength of channels
that have not spoken would be the exact failure this panel exists to remove.
Painting red because one has not spoken would be the other one.

The session list needed its own thinking, because it is the one channel that is
not a persistent connection. "Connected" is a fiction for a 5 s poll, so its row
reports what is true instead: it is working while polls return, degraded while
the backoff ladder climbs, and down after 60 s of failure — two full rungs of a
ladder capped at 30 s.

## The terminal seam, and the port it is waiting for

`term.html` posts `{type:'tl-conn', state, attempt}` up, and answers `tl-conn-ask`
with its current state. Four call sites: the pill painter, the socket's open
path, the session-ended path, and the battery-saver suspend — which reports
`suspended` and is treated as **working**, because the app closed that socket on
purpose and reopens it on the next visibility change.

Viktor raised the obvious alternative mid-design: render the terminal natively in
the SPA and the seam disappears, because the socket becomes a signal like any
other. That is the right direction and the codebase is already leaning toward it
(`theme.ts`: "once it owns xterm"; `keybindings/engine.ts`: "future xterm merge").

It was deliberately not made a prerequisite. Measured: `term.html` is 1.46 MB, of
which 946 KB is the vendored xterm bundle and **471 KB / 8,111 lines is app
logic** — the reconnect ladder, the liveness watchdog for half-open mobile
sockets, battery suspend, sixel, the mobile keyboard, clipboard, fonts, themes.
The vendor bundle is transpiled to `safari15` because iPadOS 15's WebKit cannot
parse xterm 6's static blocks. Putting a status panel behind that port would
delay it considerably, and the port changes exactly one thing in this design:
where the terminal's status comes from. Written as a provider rather than a
protocol, it is one message type that a native component later replaces with a
local signal.

The panel is also a useful instrument to have *before* the port, since it is what
will say whether a native terminal reconnects as well as the proven one does.

## What Run check actually does

Five probes, all read-only, fired together, each capped at 5 s, each reported the
moment it lands.

| Row | What the probe reads |
|---|---|
| Terminal | asks the frame to re-report; silence means "not reporting", never "dead" |
| Transcript | the session view's current SSE status |
| Session list | the poll's own bookkeeping, plus `/health` to separate "this tab is stuck" from "the API is down" |
| Notifications | permission, service worker, this device's subscription, and `GET /push-subscriptions` — whether the **server** still holds this endpoint |
| Build | whether the healer has a deferred update |

The notifications row is the one with a deliberate limit. Reading four things
that all look right does not prove a notification would arrive; delivery stays
unproven until someone presses "Send a test" on the Notifications page, which is
still there. What it does catch is the silent failure: everything local reads
healthy while the server dropped the endpoint after a 410 and nothing has been
delivered since.

## Privacy

The panel is a local readout and sends nothing. It works with diagnostics
switched off, which follows the principle already written into
`telemetry/diag.ts` — *"Counting is not consent to send"* — and the fact that
`pushRing` in `diag.js` was already ungated while `emit`/`flush` are gated.

One record is added to the ADR-0008 catalog: `diag.selfcheck`, one per Run check,
carrying each row's verdict and its timing, under the same opt-out as everything
else. It is the only record that says what the UI *claimed*, which is what a
support question is actually about.

## What opening the real page changed

Three things were wrong in a way the tests could not see, because each was a
correct implementation of a rule that turned out to be wrong.

1. **The badge read "Offline" on a healthy client.** The browser had never
   subscribed to push, notifications mapped to `down`, and worst-of dutifully
   painted the whole client offline while every connection was fine. Push being
   off is the default state of a fresh browser and a deliberate choice in one
   that refused it — neither is this client failing. Not-set-up is now `unknown`,
   so it never colours the badge; the row still says "off for this device" and
   still offers Turn on.
2. **A terminal that had never dropped reported "dropped once".** Every channel
   starts `unknown` and climbs through `degraded` on the way up, and the history
   rule counted that first connect as a fall. A fault is now a fall *from
   working*, or a channel whose first observation is already `down`.
3. **Switching sessions counted as a drop.** Views stay mounted, so the outgoing
   terminal's `working` fell to the incoming terminal's `connecting` — two
   healthy sockets reported as an outage. A view now withdraws its terminal when
   it leaves the screen, the way it already withdrew its transcript, and asks the
   frame to re-report when it comes back (the frame sends one message per real
   change, so it will not volunteer a state it has already sent).

All three are now covered by tests. The first two were pure-model bugs that a
unit test would have caught had it been written to the right rule — which is the
point: the tests encoded the same wrong assumption the code did.

## What this does not do

- **Report on your other devices.** "Your phone last connected 2h ago" needs new
  server-side state and a retention decision.
- **Persist history across reloads.** The counts reset, and a frozen terminal is
  usually met with a reload. Worth revisiting if that turns out to bite.
- **Prove push delivery.** By design, per above.
- **Show exceptions, slow API calls or stalls.** diag.js collects all of it, and
  a Problems section would turn an answer into a developer console.

## Open questions

- The 60 s degraded→down threshold for the session list is reasoned, not measured
  against how often a real link recovers on the third rung.
- The down-state phrasing has been exercised against induced failures, not
  against a genuinely broken box.
- If "my phone stopped buzzing" keeps arriving after this ships, a device-scoped
  `/push/test` is the next thing to build.
