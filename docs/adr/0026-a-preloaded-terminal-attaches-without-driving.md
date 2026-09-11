# A preloaded terminal attaches without driving

Viktor, 2026-09-11: *"let's preload session data on hover - this will save time
rendering in both terminal and text mode"*

Opening a session the browser has not seen yet costs a serial chain: a lazily
imported xterm chunk, a `/token` round trip, a WebSocket upgrade, a fork and a
`tmux` attach inside `devvm/tmux-attach.sh`, and then a full-screen redraw.
`frontend-v2/src/store/keepalive.ts` exists because that chain used to cost
1,797 ms on every session switch; it solved the *second* open of a given session
by keeping every visited session mounted, and left the first one alone.

Measured against the deployed build on 2026-09-11, in milliseconds from the
click, median of six opens across two page loads:

| | click → readable terminal |
|---|---|
| first open of a page load, chunk from the network | 1,620 |
| first open, chunk from the HTTP cache | 1,192 |
| every later open, chunk already in the module cache | **779** |

The 779 ms breaks down as `/token` answering at 58, the WebSocket opening at 67,
**627 ms of ttyd forking, tmux attaching and redrawing**, and 84 ms to paint.
So 91% of a warm open is the attach itself. Preloading the xterm chunk is worth
413 to 841 ms and only once per page load; moving the attach off the critical
path is worth around 700 ms on every open of a session that is not already
mounted. That is the larger of the two, and it is the only one a hover can buy.

The question this record answers is what a hover is allowed to do to a session
nobody has opened.

## A ttyd connection is a tmux client

`ttyd` runs `devvm/tmux-attach.sh` once per WebSocket, so a preload is not a
fetch — it is a real attached client. tmux sizes an unpinned window to its
latest active client, and an attach counts as activity.

Measured on tmux 3.4 on the devvm, 2026-09-11. A session born at a phone's
80x40, with the phone attached, and a 200x50 desktop client joining as a
plain read-write attach:

```
phone attached alone            80x39
desktop attaches read-write    200x49     <- the phone's transcript rewraps
desktop detaches                80x39     <- and rewraps back
```

Under `keepalive.ts` the preload never detaches, so the second line is where it
stays: a session sits at the width of whichever device last brushed its card in
a sidebar, until its real user touches something.

Two mechanisms avoid that, and they are not equivalent.

`attach -r` is what Watch mode already uses (`?arg=` position 5, value `ro`).
It is read-only, which implies tmux's ignore-size client flag, and on this box
it also calls `sessionio.PinGrid`. `grid.go` is explicit that a pin is **never
reverted**: "a session that has been watched keeps its pin for life". Hovering
would therefore change the sizing behaviour of every card the pointer crossed,
permanently, and a preload that is read-only cannot become the driving client
when the user clicks.

`attach -f ignore-size` is read-write and does not affect the window size.
Measured the same day, same sessions:

| step | command | window |
|---|---|---|
| hover | `attach -f ignore-size` from a 200x50 client | `80x39`, unchanged |
| click | `refresh-client -t <client> -f '!ignore-size'` | `200x49`, the client takes over |
| leave | `refresh-client -t <client> -f 'ignore-size'` | `80x39` |

`window-size` stays at tmux's default throughout, so nothing is pinned and
nothing is left behind.

## What we decided

**A preload attaches read-write with `ignore-size`, and is promoted to a driving
client when the user commits.**

Three things follow from it.

*The attach mode stays in one arg.* `frontend-v2/src/lib/terminal-url.ts` calls
the positional `?arg=` contract red-line-class, because `ttyd -a` maps args to
`$1..$7` by position and a dropped one breaks a shared attach silently. Position
5 already carries the attach mode — empty for drive, `ro` for watch. Preload is
a third value of the same question, `pre`, rather than a new position: drive,
watch and preload are mutually exclusive, so they belong in one slot.

*A preload never creates.* The ordinary path runs `tmux new-session -A`, which
creates a session when the name is absent. A `pre` attach takes the
`attach-session` branch the watch path already uses and fails if the session is
gone, because a card can only be hovered while it is listed, so a name that no
longer resolves means the session died in the interval — and resurrecting it
from a mouse movement would be wrong.

*A preload does not count as driving.* `drivesToStamp` (`tmux-api/lastdrive.go`)
stamps `@last_drive` to now for any session with a read-write client attached,
and an ignore-size client is read-write. Left alone, hovering down the sidebar
would restamp every card's timer. `clientsListFmt` (`tmux-api/driven.go`)
already reads `#{client_flags}`, so excluding ignore-size clients from the
driven mark costs nothing extra — and the same predicate is what
`POST /sessions/{name}/grid` uses to find which client to promote. Watch-mode
clients are already excluded by being read-only.

## What this does not change

Push notifications are unaffected. ADR-0021 moved focus from tmux's client list
to the page's own report, after keepalive's mounted clients held 118 pushes in
four days. A preload attach cannot reach that decision.

The transcript is untouched. `SessionView` defers its `/events` stream until the
Text view is shown, and a preload mounts only `TerminalNative`, so no preload
opens an SSE stream or adds a `watchPanes` subscriber.

## What we are not sure of

The 250 ms dwell and the 60 s slot TTL are starting values, not measurements.
We chose not to instrument preload hit rate, so the way to revisit them is to
measure again rather than to read a dashboard.
