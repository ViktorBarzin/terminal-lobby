# Lobby task queue — 2026-08-22

Five things Viktor asked for in one sitting, tracked here so none of them is
lost between deploys. Each is quoted as it was asked, has its own acceptance
criteria, and carries the commit it landed in.

| # | Task | Status |
|---|---|---|
| 1 | Press-and-hold to drag a session row into a new position | **Landed** `cf5d42e` + `<tail>` |
| 2 | Content stays under the keyboard and the view does not re-render | In progress |
| 3 | The shell must not paint under the bottom menu | In progress |
| 4 | Buffer keystrokes across a network drop and replay them | In progress |
| 5 | Sort sessions by manual order, created time or last active | In progress |

## 1. Press, hold and drag a row to reorder it

> "when I press and hold on a session in the sessions list, I want to be able to
> either open the menu for the session and also drag to reorder it"

Reordering rode HTML5 drag-and-drop, which a touch screen never fires. Viktor
chose how the two share one gesture: the hold opens the menu as it always has,
and moving the finger afterwards closes it and takes the row along.

**Done when:** a held row lifts and follows the finger; the row under it shows
where the drop lands; letting go writes the new order through the same
`store.move` the mouse uses; dropping on a group header moves the session into
that group; the list scrolls itself near its edges; letting go without moving
still leaves the menu open.

## 2. The keyboard covers content that never comes back

> "let's fix the scroll - for some reason it doesn't rerender and a lot of text
> stays below the keyboard and I can't see it"

**Done when:** with the soft keyboard open on a phone, every line of the view
above it is reachable by scrolling, and the view re-lays-out when the keyboard
opens and closes rather than keeping the geometry it had at one instant of the
animation. Measured on a real keyboard, not reasoned about.

**Open question:** which view Viktor was in. The Text view's transcript and the
Terminal view's rows have separate paths to this symptom, so both get measured.

## 3. The shell must not paint under the bottom menu

> "the menu at the bottom of the session screen should be treated as part of the
> screen where we should not paint a shell"

The soft-key toolbar sits at the bottom of a session on a phone. The terminal
must end above it rather than paint rows behind it.

**Done when:** at a phone viewport with the toolbar showing, the terminal's last
row is fully visible above the toolbar, and the tmux grid the shell is fitted to
matches the space actually left for it.

## 4. Keystrokes survive a network drop

> "let's also add some buffering of keyboard presses. in cases where network
> drops, we should cache the keys send before network drop and resend them once
> it recovers"

**Done when:** keys typed while the terminal's WebSocket is down are held rather
than dropped, and are sent in order once it reconnects; the buffer is bounded so
a long outage cannot grow without limit; nothing is replayed twice; and what
happens is visible to the person typing rather than silent.

## 5. Three ways to order the session list

> "allow different ordering of sessions - support manual ordering as well as
> sorting by created time and last active time. default to created time"

**Done when:** the list can be ordered manually (today's drag-and-drop order),
by created time, or by last active time; created time is the default; the choice
is remembered; and the relationship between a sorted list and a manual drag is
decided rather than accidental.
