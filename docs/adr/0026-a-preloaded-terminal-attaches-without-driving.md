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

### Two limits on that, both found while building this

**The flag only works while another client is attached.** tmux ignores a
flagged client's size only for as long as an unflagged one exists. Measured on
tmux 3.4 on 2026-09-11, the table above reproduces exactly with the phone
attached; with nobody else on the session, the same 200x50 preload moved the
window from 80x40 to 200x49, and re-asserting the flag did not move it back.
The original measurement always had a second client attached, so it did not
cover this. Practical effect: hovering a card for a session with no attached
client reflows it, and it stays reflowed until something attaches. That is what
clicking the card would have done anyway, so we are accepting it; it is written
down here because the flag reads like a stronger guarantee than it is.

**On the DEFAULT path those two limits meet, and the flag has nothing to do.**
Driving the real UI on 2026-09-11 showed why. A
preload that would resolve to Watch mode is dropped rather than attached
(`SessionView` reports `failed`), because a read-only attach would call
`PinGrid` permanently. Watch mode's `unset` resolves to watching exactly when
the session already has a read-write client. So a session with another client
attached never gets a preload, and a session that does get one has no other
client, which is the case where tmux stops honouring the flag. Every one of the
four naturally-attached sessions on the box behaved this way, and reaching the
protected case at all needed a hand-recorded drive choice.

**The path where it does work is an explicit drive choice.** `resolveWatch`
reads `choice ?? driven`, so a card the user has set to drive from its
`Attach as` menu beats the driven count, and a preload then lands on a session
that already has a read-write client. That is the desktop-and-phone case, and it
is the one where a reflow costs the most, so the flag guards the configuration
worth guarding. Read from the code rather than clicked: the measurement reached
it by writing the key the menu writes.

Two other things the flag earns on every path. It keeps a preload out of the
driven mark, so hovering down the sidebar does not restamp every card's timer,
and it is how `POST /sessions/{name}/grid` finds which client to promote.

For the default path, what protects the reachable harm is the fix below, because
a PINNED session with only a watcher attached is not driven, so it does get
preloaded, and its hook is what sizes it.

**A pinned session needed a second fix, in a different file.** `PinGrid` takes
sizing away from tmux (`window-size manual`) and gives it back through a hook
that reads the client list itself and calls `resize-window`. A flag tmux would
have honoured means nothing on that path. The hook filtered `grep -v read-only`
only, and a preload is read-write and the newest client, so it won outright:
measured the same day, a pinned session at 80x39 with its owner attached jumped
to 200x49 the moment a 200x50 preload joined, and stayed there. Since a pin is
never reverted, every session that had ever been watched carried that exposure.

The fix is one more filter in `sessionio/grid.go`'s hook, `grep -v ignore-size`,
plus a bump of `gridHookMark` to `tl-grid-v3` so `repairStaleGridPins` reinstalls
the hook on sessions already pinned by an older build. That mark is the repo's
existing deploy path for a hook change, and this is what it is for.

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

## Amendment — 2026-09-12: the promotion ends the attach MODE, not only the flag

The decision above says a preload "is promoted to a driving client when the user
commits", and what shipped promoted the live tmux client alone:
`POST /sessions/{name}/grid` cleared `ignore-size` on the client the hover had
attached. The browser's own attach mode stayed `pre` for the life of the mount,
because `SessionView` froze it (`untrack`) and `terminal/attach.ts` read
`deps.args` once. That was sound while a socket lasted as long as its mount.

Parking changed the premise. A session off screen for 30 s now drops its socket
(`frontend-v2/src/terminal/battery.ts`), so reconnects are ordinary rather than
rare, and each one re-attached as a preload: `attach -f ignore-size`, which tmux
skips when it sizes a window and which the pin's hook filters out. Coming back
to a parked session therefore left the window wherever the last device to attach
had put it. Measured on the box on 2026-09-12 against a real session, with a
60x20 client standing in for a phone: the desktop returned as
`attached,focused,ignore-size` and drew 144 columns around a 60-column window.
Switching to Text and back was the only way out, because that is another fit and
another grid claim.

The grid claim could not cover the gap on its own. It rides the fit, about
120 ms after the view is shown, while the socket is still reconnecting, so
tmux-api finds no client of this device to promote and, for a pinned session,
nobody driving at all: 409, and nothing retries it. 8 of the 29 grid calls on
the box in the 24 h before the fix were that.

So the amendment is one sentence long. **The attach mode is read at every
connect, and `pre` ends at the click.** The socket already open keeps the args
it was opened with, and its client is still promoted server-side; the next
connect is an ordinary attach, which is what takes the window back. One reading
of the args per attempt (`openSocket`) keeps the `/token` and `/ws` halves in
agreement, which is the red line the positional contract already carries.

A preload that is never clicked is unaffected: `preloading()` is still true, so
its reconnects stay `pre`.

Alongside it, the terminal claims the grid when its socket OPENS, if this
session is the one being read. That is the fourth claim moment, beside a landed
fit, a view coming back on screen and terminal focus, and it is the one a fit
cannot speak for. Landed in v0.53.7.
