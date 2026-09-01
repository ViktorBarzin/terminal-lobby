# A notification tap asks which window is the lobby

Viktor, 2026-09-01: *"clicking it now doesn't open that exact thread in the pwa
(maybe even the desktop version is affected)."*

When a Web Push notification is tapped, `sw.js` has to hand the switch to one
window. `clients.matchAll({type: 'window'})` returns every same-origin document,
and on this app that includes the nested terminal and dock iframes, which have
neither the message listener nor `activateSession` — both are lobby-only. So the
worker has always had to pick.

It picked by a negative test: a client is the lobby *unless* its URL carries
`?arg=<session>`, which is what a terminal attach looks like. That was true when
it was written, and it read as a safe default — anything unrecognised still
counted as the lobby and still received the switch.

It stopped being true for a reason that had nothing to do with notifications.
The framed attach moved its positional args off the page URL and onto
`iframe.name` (`TERMINAL_FRAME_PREFIX`), because the URL is a cache key: with the
session name in the query, every session was a separate entry for a 1.8 MB
document, measured at 1,796,377 B cold against 300 B for a repeat, so each new
session cost 8.4 to 10.3 s on a 400 kbps link. Afterwards the terminal iframe is
a bare `/assets/term-<hash>.html`. It matched no `?arg=`, so it read as the
lobby. `matchAll` returns the most recently focused client first, and the thing
you were looking at when the notification arrived is the terminal — so the worker
posted the switch to a frame with no listener and returned. The tap foregrounded
the app and did nothing else, on desktop as much as on the phone.

This was the third time tap routing had broken, and the second time the cause was
a URL changing for unrelated reasons.

## What we decided

**Two changes, and the second is the one that matters.**

The test is now positive: a client is a *terminal* if its URL says so, in either
shape (`?arg=<name>`, or a `term.html` / `term-<hash>.html` path), and the lobby
is whatever is left. That restores the safe default in the direction it was meant
to point.

**And the worker stops relying on the answer.** It sends a `MessagePort` with the
switch; the page replies `tl-activate-ack` once it has acted; a client that stays
quiet for 400 ms is passed over for the next candidate. Lobbies are tried
focused-first, so with several windows open the switch lands on the one being
looked at rather than every one of them.

## Why the acknowledgement, when a better predicate would have fixed today's bug

Because the predicate is the part that keeps failing. Any rule that infers a
document's role from its URL is a guess about code that lives somewhere else and
changes for its own reasons. Twice now that guess has been invalidated by a
change whose author had no reason to think about notifications, and both times
the failure was silent: the worker did its work, returned successfully, and
delivered nothing.

The acknowledgement changes what a wrong guess costs. Before, it cost the whole
notification. Now it costs 400 ms and the worker moves on. The routing repairs
itself against page-shape changes nobody has thought of yet.

## Considered and not chosen

**Broadcast to every window.** Delivery would be guaranteed and the code would be
shorter. It also means every open lobby jumps to the notified session, which is
wrong on a desktop with two windows open on purpose.

**`WindowClient.navigate()`.** Rejected before and still rejected: it requires a
*controlled* client and throws on the uncontrolled windows `matchAll` surfaces
right after a fresh registration, its hash-fragment semantics differ on WebKit,
and it can reload the document — tearing down the live terminal iframe and its
WebSocket.

**Have the page register its client id with the worker.** Precise, and it inverts
the dependency the right way. It needs persisting through a worker that can be
killed between events, and it still ends up trusting a stored identifier rather
than a live answer. The acknowledgement gets the same property with less state.

## Consequences

A page too old to reply still **acts** on the message — the listener has shipped
since July and only the reply is new — so a false negative re-posts to the other
lobbies rather than losing the tap. When no lobby answers at all the worker
returns without opening a window, because the app is already up and a second
window is the worse answer; `openWindow` stays reserved for the cold start.

Tap routing now has tests that load the **real** `sw.js` source and drive it
against fake clients. Nothing loaded that file before, which is how all three
breakages reached a device: every one of them was a worker doing something other
than what the code appeared to say. Six of the eleven cases fail against the
worker that shipped before this change.

The repository carries two copies of `sw.js` — `frontend-v2/public/sw.js`, which
Vite serves and the tests drive, and `frontend/sw.js`, which the Debian package
installs (`release/manifest.go`). A test now pins them byte-identical. The copy
that looks canonical, sitting beside the SPA, is the one that does not ship, so
editing only that one would have passed the whole suite and changed nothing in
production.

The cost is up to 400 ms per unresponsive candidate before the tap lands. On a
warm resident PWA, the first candidate is the lobby and answers immediately.
