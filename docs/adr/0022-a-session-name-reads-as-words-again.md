# A session name reads as words again

[ADR-0019](0019-a-session-name-is-an-id-not-a-label.md) made a tmux session name
an opaque 12-character id and moved everything a person reads into `@title`.
Inside the lobby that worked: cards, the tab title, the palette, the dock and
the push bodies all show titles, and the id sits underneath as an identity that
does not move.

Outside the lobby it did not. `tmux ls`, the status bar's `#S`, the terminal
window title from `set-titles-string`, and `choose-tree` all show a **name**,
and none of them can be taught to show a title without editing each user's own
configuration. Viktor, 2026-09-06: *"let's use the human readable name in the
tmux session name. now I see the tmux session name is the uuid style one."*

ADR-0019 shipped a `tls` command for the `tmux ls` case, which covers one
surface out of four and only for someone who knows to type it.

## What we decided

**A title carries the tmux name with it.** When a title lands, tmux-api derives
a name from it and renames the session, carrying the rename into everything
keyed by the old name. The rule lives in `tmux-api/name_from_title.go` and fires
from the two places a title can arrive: `POST /sessions/{name}/title`, and the
auto-title pass that adopts Claude Code's conversation summary.

A session is still **created** with a minted id, in the browser, reaching no
server. It keeps that id until its first title, which for a fresh session is
seconds into the first turn. So the id is still the identity a session starts
with, and it is still what an untitled session is called.

Four properties make the derivation safe to run on every title:

- **It is a fixed point.** `derivedNameFor` returns "no change" when the name is
  already what the title produces, including the `-N` variants a collision
  produces. Without that, a session that lost the base name to a sibling would
  walk `deploy-2` → `deploy-3` → `deploy-4` on every poll.
- **A collision suffixes.** tmux refuses a duplicate session name outright, so
  two sessions with the same title get `deploy` and `deploy-2` rather than one
  session or an error.
- **An unusable title changes nothing.** A CJK or emoji-only title, or an empty
  one, derives nothing, and the session keeps the name it has. Clearing a title
  therefore leaves the name where the last title put it.
- **Machine-made sessions are left alone.** `reservedName` covers the `qa-`,
  `t3e2e-`, `tlp-t` and pool-slot prefixes, which other services recognise by
  name.

A session titled BEFORE this rule existed is never reached by it — nothing
retitles a conversation that has been running for a week, and on the day this
landed that was 29 of wizard's sessions, every one of them still reading as an
id. `backfillDerivedNames` runs on each listing and covers them, and covers a
session restored under an id. It is restricted to **minted ids**: the retitle
path renames whatever the old name was, because someone asking for a new title
is asking for it, while this pass acts on a title nobody just touched and may
only replace a name that says nothing. A shell somebody called `beads` keeps
that name whatever its title says.

## What this costs, and what pays it

ADR-0019 listed the costs of a derived name. They are real, and this is what
answers each one.

| ADR-0019's objection | what answers it |
|---|---|
| six stores keyed by the name | `carryRenameAcrossStores`, which stayed in the tree for the migration and repins the grid hooks tmux itself holds |
| a collision with nobody to ask | `slug.Free`'s suffix walk, backed by tmux refusing duplicates |
| the terminal iframe re-navigating mid-turn | `followRenamedSelection` moves the selection by tmux session id, which a rename does not change |
| the phantom-session trap | narrowed, not closed. See below. |

**The phantom-session trap is the one that stays open.** A tab holding
`?arg=<old name>` reconnects through `tmux new-session -A -s <name>`, which
CREATES the old name as an empty session and leaves the person looking at a
blank shell while their conversation runs on under the new name.
`followRenamedSelection` is what narrows it: the selection moves onto the new
name, which re-navigates the terminal, and both retitle paths refresh
immediately rather than waiting out a poll. The window is one round trip for a
typed title and one poll for a summary. A tab that is asleep through both, and
reconnects before its next poll, can still land on a phantom.

Closing it properly means the attach contract carrying something that survives a
rename — tmux's `#{session_id}`, or a lookup step between `?arg=` and
`new-session`. That is a change to ttyd's spawn path and is not made here.

## Considered options

- **Show the title on tmux's own surfaces instead.**
  `#{?#{@title},#{@title},#S}` renders correctly on tmux 3.4 today, and would
  have given readable status bars and window titles with nothing renaming. It
  was offered and not chosen: the status bar and `set-titles-string` live in
  each user's own `~/.tmux.conf` (oh-my-tmux here), so the fix would have to be
  repeated per user and per surface, and `tmux ls` would still print ids.
- **Rename only once, at the first title.** Cheaper in renames, and it hits the
  worst case anyway: the first title is exactly the one that arrives seconds
  into the first turn while a tab is holding the old name.
- **Keep ADR-0019 and extend `tls`.** One more surface covered, three not.

## Consequences

- `tmux ls` reads as words, and so does everything else that prints `#S`. `tls`
  keeps working and is now mostly redundant for titled sessions; it still earns
  its place for untitled ones, where it prints the id beside an empty title.
- Renaming is an ordinary background event again, so anything keyed by a session
  name has to either follow the rename or key by something else. The six stores
  follow. Per-browser records key by tmux's session id already.
- Two sessions can no longer be told apart by name alone in the way an id
  guaranteed: `deploy` and `deploy-2` are two conversations about deploying. The
  id is gone from the name once a title lands, which is the trade this makes.
- `slug.FromTitle` / `Free` / `MaxNameLen` have the lobby as a consumer again,
  alongside t3-bridge.
- The `session.renamed` event now carries `tl.client` values `api` (a typed
  title) and `autotitle` (an adopted summary), alongside the existing `migrate`.
