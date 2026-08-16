# Watch mode — observing a session without disturbing it

**Status:** Shipped 2026-08-16 (dev tier). Backend live on the devvm; v2 SPA on
`terminal-dev.viktorbarzin.me`. **Author:** Viktor Barzin (design), Claude (build).

## What we wanted

One person is working in a session. Someone else — a colleague, or the same
person on a second device — wants to watch it. The watcher should be able to
observe indefinitely without the person working noticing anything at all.

The concern going in was resizing: a second client attaching would reshape the
terminal to its own screen, reflowing the session under whoever was using it.

## What measurement changed

Measurement corrected the premise, and the correction narrowed the work
considerably. Measured on the devvm's tmux 3.4 with real ptys:

| Observation | Result |
|---|---|
| `tmux attach -r` client flags | `attached,focused,ignore-size,read-only,UTF-8` — read-only **implies** `ignore-size` |
| Read-only viewer (80×24) joins an owner (203×53) | Window stays **203×53** — no disturbance |
| Passing `-f ignore-size` explicitly as well | No change; the flag is already set |
| The **last read-write** client detaches | Window snaps to **80×23**, the viewer's size |
| Owner returns at 203×54 | Window snaps back — a second reflow |
| A second plain **read-write** client at 90×30 | Window → **90×29**; the owner *is* squeezed |

So tmux already protects the owner while they are attached. The gap is narrower
and differently shaped: `resize.c`'s `ignore_client_size` skips read-only clients
only *"if there are any attached clients that aren't read-only."* When the last
read-write client goes, that skip lapses.

This happens in ordinary use here. `frontend/term.html` · `tmux-api/driven.go` drops its WebSocket after
tab has been hidden 60 s, to spare a backgrounded phone's radio — a deliberate
and worthwhile behaviour. Its side effect is that pocketing your phone detaches
your client, hands the grid to whoever is watching, and reflows the session
twice: once when you leave, once when you return.

Two further findings shaped the design:

- **A smaller viewer sees a clipped viewport, not scaled or wrapped content** —
  80 of 150 columns delivered. Vertically it follows the cursor, so a watcher
  tracks where the action is for free; horizontally the right-hand columns are
  simply not sent.
- **The share store was empty and every project single-member**, so the
  cross-user read-only path had never run in production. The resize pain in
  practice came from two of the same user's own devices, both read-write — a
  case that had no read-only option at all, since a self-attach always went
  through `new-session -A`.

## The invariant

> **A read-write client owns the grid. A read-only client consumes it and
> changes nothing — including when no read-write client is attached at all.**

Everything below is enforcement of that one sentence. It already holds while
someone is driving; the work is making it hold in the one case where tmux hands
the grid away.

## Decisions

| # | Decision | Why |
|---|---|---|
| 1 | Covers a cross-user guest **and** your own second device | Same tmux mechanism; only the authorization differs |
| 2 | Terminal surface only | Text mode already observes without a tmux client; a foreign Text mode would need session-events to grow an `owner` dimension and read another user's whole `~/.claude` |
| 3 | Grid pinned with `window-size manual` + hooks | The only formulation that survives the owner detaching |
| 4 | The viewer clips — no font scaling, no pan UI | Deliberate scope call; vertical cursor-follow comes free, and server-side pan stays a cheap follow-on |
| 5 | UI toggle → server enforces, downgrade-only | A client may ask for *less* access than it holds, never more |
| 6 | Remembered per (session, device) | Matches how the Text/Terminal view mode already persists |
| 7 | No watcher indicator, in any case | Viktor's call; shares are consent-gated and the box is effectively single-user today |
| 8 | Frontend also blocks input, with a nudge | tmux discards the bytes anyway; without this a watcher types into a terminal that looks alive |
| 9 | Pin applied lazily at the first read-only attach, never reverted | A session nobody watches behaves exactly as before |
| 10 | **Revised:** joining a session someone is already *driving* comes up watching; read-write remains the default when nobody is. Settable ahead of time from the sidebar card's menu (Auto / Watch only / Take control) | The original — set the toggle before the attach — could not be done: v2 is terminal-first, so selecting a session attaches in the same tick |
| 11 | v2 only | v2's cutover is already marked ready |
| 12 | Named **Watch mode** | `Attach mode` is taken — it is the server-side, per-share term |

Decision 7 is recorded as a deliberate choice rather than an oversight. The
information exists (`tmux list-clients` shows every client, and tmux-api records
each guest's `ClientTty` at attach), so surfacing it later is a UI change, not a
new mechanism.

## How it fits together

```mermaid
flowchart TD
    subgraph browser["Browser (v2 SPA)"]
        T["Watch toggle<br/>session bar"] -->|"per (session, device)<br/>localStorage"| S["watchmode store"]
        S --> U["terminalUrl()<br/>arg5 = ro"]
        U --> IF["terminal iframe<br/>/term.html"]
        IF -->|"/token + /ws<br/>?arg=…&arg=ro"| TTYD
    end

    subgraph devvm["devvm"]
        TTYD["ttyd :7681"] -->|"-a maps ?arg= to \$1..\$5"| SH["tmux-attach.sh"]
        SH -->|"POST /internal/attach<br/>{owner,name,guest,requested}"| API["tmux-api :7684"]
        API -->|"ceiling from the share<br/>(rw when owner == guest)"| DEC{"effectiveMode<br/>downgrade-only"}
        DEC -->|"ro"| PIN["PinGrid<br/>window-size manual + hooks"]
        DEC -->|"{mode}"| SH
        SH -->|"tmux attach-session -r"| TMUX["tmux server<br/>(as the owner)"]
        PIN --> TMUX
    end

    style DEC fill:#2d3748,stroke:#63b3ed,color:#fff
    style PIN fill:#2d3748,stroke:#68d391,color:#fff
```

The client never decides its own access. It states a preference; tmux-api
resolves that against the ceiling and answers with a mode, and `-r` is sourced
from that answer. Since the only thing a client can ask for is *less* access,
accepting the new argument leaves `tmux-attach.sh`'s exact-argv discipline —
the security boundary given the broad `sudo tmux` grant — intact.

### What a read-only attach actually does

```mermaid
sequenceDiagram
    participant D as Desktop (read-write)
    participant TM as tmux
    participant P as Phone (watching)

    D->>TM: attach 200x50
    Note over TM: grid 200x50
    P->>TM: attach -r 80x24
    Note over TM: grid 200x50 — tmux ignores<br/>read-only clients while D is here
    D->>TM: resize to 150x40
    Note over TM: grid 150x40 (hook reads the live client list)
    D--xTM: tab hidden 60s → socket dropped
    Note over TM: grid 150x40 — HELD.<br/>Unpinned, it would snap to 80x23
    D->>TM: attach 175x45
    Note over TM: grid 175x45
```

### The two tmux details that decided the implementation

Both were found by measurement, after a first implementation passed its own
review and failed its tests:

1. **A hook's `#{client_flags}` is the server's *current* client, not the client
   the event happened to.** With a watcher attached, the owner resizing their
   terminal fires `client-resized` carrying the *watcher's* flags and size.
   Guarding on those skips the owner's resize and applies the watcher's size
   instead. The hook therefore reads `list-clients` and filters, which has no
   such ambiguity.
2. **`run-shell` format-expands its command string before running it.** A bare
   `#{client_width}` inside the hook body is substituted with the current
   client's width, so every row of the inner `list-clients` came out identical.
   Doubling to `##{...}` defers evaluation to the inner tmux.

`client-detached` fires but its format context is empty (`detached::` — no tty,
no flags), so a "freeze on the last read-write detach" formulation cannot tell
which client left. The proactive pin does not depend on detach ordering at all,
so it holds however the detach is sequenced.

## What we deliberately did not build

- **Fit-to-grid font scaling or a pan UI.** A watcher on a narrow screen sees
  the left-hand columns and loses the rest. Server-side `refresh-client -L/-R`
  works on a read-only client (verified), so panning is available if this bites.
- **Text mode over a foreign session.** It needs an `owner` dimension in
  session-events plus read access to another user's `~/.claude/projects`, which
  holds every conversation they have rather than the one shared session.
- **A watcher indicator.** Decision 7.

## Known limits

- **Two read-write clients still contend**, as they did before. Watch mode is
  the answer when you want them not to.
- **If you drive from a small screen and watch from a large one**, the grid is
  the small one and the watcher sees blank space around it. That follows from
  the invariant rather than contradicting it.
- **Forgetting the toggle on a new device costs one resize.** The first attach
  is read-write by design (decision 10), and the pin then holds that size. It
  heals on the driving client's next attach *or any resize* — verified — so
  recovery is "resize your window", not "restart the session".
- **`manual` + hooks is not a perfect emulation of `latest`.** `latest` follows
  whichever client you most recently *typed* on; the hooks follow whichever most
  recently *attached or resized*. This is only observable with two read-write
  clients on one session, and only until one of them starts watching.

## Revision — decision 10, and the regression on the way

Decision 10 rested on v2's lazy attach: the toggle would be set before the
Terminal view was first shown. That window does not exist — `viewmode.ts`
defaults to `"terminal"`, so selecting a session shows the Terminal view and
latches the attach in the same tick.

The rule now: **with no explicit choice recorded, a client joins as a viewer
when the session already has a read-write client.** Opening a session nobody is
on is unchanged. It can also be set ahead of time from the sidebar card's
`⋯ → Attach as` menu, and the card carries an 👁 when this device would open the
session as a viewer.

Three states, not two — Auto, Watch only, Take control. *Take control* has to
survive the other device still driving, so it must be storable and distinct from
"never said"; and without a way back to Auto, a session taken control of once
would never auto-join again on that device, so the fix would quietly stop
applying with nothing explaining why.

> [!IMPORTANT]
> The first cut of this shipped and had to be reverted within the hour. `driven`
> counts every read-write client **including the one asking**, and it was wired
> as a live dependency of the attach. So: attach read-write → the next poll
> reports the session as driven → the rule flips the client to watch → the
> re-attach leaves only a read-only client → driven goes false → it flips back.
> Once per poll, re-navigating the terminal iframe each time.
>
> Joining is now a decision taken **once**, latched when a view takes a session
> on, re-taken only on a session change or an explicit choice. It is a memo
> rather than an effect so it re-latches in the same tick, with no window in
> which the previous session's decision is still reported.

`GET /api/sessions` grew `driven` for this: at least one attached client is
read-write. Deliberately not `attached`, which counts watchers too — a session
with two watchers and nobody typing is attached twice and driven by nobody, and
joining that as a viewer would leave it with no one able to type. The sidebar
card prefers the open view's own resolved state over `driven`, since for the
session this browser has open the count includes us.

## Two pinning bugs found while chasing the loop

Both moved a session the moment somebody watched it, which is what the feature
exists to prevent.

**Switching a live window to `manual` does not freeze it where it is.** It
reverts it to the size the window was *created* at, discarding whatever `latest`
had negotiated. Measured: a window born 80x24, grown to 190x55 by its client,
snaps back to 80x24 the instant the option is set. PinGrid now reads the size
first and restores it immediately after.

**The hook resized to the client's raw height.** tmux subtracts the status lines
when it sizes a window, so every pinned session came out one row too tall with
its bottom row behind the status bar. 3.4 has no `#{status_lines}`, so the
subtraction reads `#{status}` — `off`, `on`, or a count — and falls back to 1 on
anything unrecognised rather than breaking the resize.

Neither appeared in the original verification because its fixture created the
scratch session at 200x50 and attached 200x50 clients — birth size and client
size coincided, so the snap was invisible — and ran with the status line off, so
the row was too. The replacement test asserts its own fixture has grown past the
birth size before it trusts its result.

## Verification

| Layer | What it proves | Where |
|---|---|---|
| Real tmux, real ptys | The invariant in all four ways a grid can move, plus idempotency, name-injection refusal, and no prefix-matching onto a neighbouring session | `sessionio/grid_test.go` |
| A guard test | That an **unpinned** session still collapses onto the viewer — so if tmux ever changes, we learn the pin became unnecessary | `sessionio/grid_test.go` |
| tmux-api units | Downgrade-only resolution; self-attach needs no share; an unshared guest is still refused whatever they ask; a missing session never upgrades a guest | `tmux-api/watch_test.go` |
| Shipped browser code | The real `argSuffix` builder lifted out of `term.html` and executed, against both the source and the **deployed** file | `scripts/test_watch_mode_e2e.py` |
| The attach script | Executed with curl/tmux/sudo shimmed; asserts the exact argv, that `-r` comes from the server and not the argument, and that a malformed arg5 is ignored | `scripts/test_watch_mode_e2e.py` |
| Session bar | The toggle is reachable from the Text view, persists per session, reaches the attach builder, and auto-joins on a driven session | `frontend-v2/test/SessionView.watch.test.tsx` |
| Sidebar card | The 👁 marker in all four combinations of choice and driven-ness; that it defers to an open view rather than a count including us; the three-way menu, including the route back to Auto | `frontend-v2/test/SessionCard.watch.test.tsx` |
| The latch | That `driven` changing after a view takes a session on does NOT move the watch state, in both directions — the reverted oscillation, pinned | `frontend-v2/test/watchmode.auto.test.ts` |
| Driving vs attached | A lone watcher is not a driver; several still are not; a watcher beside a driver is; names match exactly | `tmux-api/driven_test.go` |
| Pinning is invisible | That pinning does not move a running session, with a fixture that asserts birth size and current size actually differ; and that the pinned grid equals what tmux would choose, at status on/off/2/3 | `sessionio/grid_test.go` |
| Live round trip | ttyd → `tmux-attach.sh` → tmux-api → tmux, driven exactly as the browser drives it | run 2026-08-16, below |

The live run against the deployed stack, with two real WebSocket clients:

```
1. plain attach (no arg5)         PASS — not read-only
2. watch attach (arg5=ro), 80x24  PASS — one read-only client; grid stayed 200x50
3. window-size after the attach   PASS — manual
4. owner's socket dropped         PASS — grid held at 200x50 with only the watcher left
```

Test counts at landing: 1132 frontend, 111 Python, all Go modules green.

## Open questions

- Whether clipping is tolerable in daily use, or whether the pan control is
  wanted after all. This is the decision most likely to be revisited.
- Whether a watcher indicator becomes desirable once more than one person uses
  the box. The data to render one already exists.

## Files

`sessionio/grid.go` · `tmux-api/shares.go` · `devvm/tmux-attach.sh` ·
`frontend-v2/src/store/watchmode.ts` · `frontend-v2/src/lib/terminal-url.ts` ·
`frontend-v2/src/components/{SessionView,TerminalView,Icons}.tsx` ·
`frontend/term.html`
