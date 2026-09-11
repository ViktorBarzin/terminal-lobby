# Undo takes Ctrl+Z, and a kill waits instead of asking

The lobby's structural actions had no way back. A drag into another project, a
retitle, a project delete, a reorder: each one took effect and that was that.
The one action that did ask, a kill, asked the wrong question. `Kill session
"x"?` interrupts the person who meant it, and for the person who did not it
offers a name that is a minted 12-character id (ADR-0019), which tells two
untitled sessions apart and nothing else.

So the lobby now has an undo stack, and the kill confirm is gone. `Ctrl+Z` and
`Cmd+Z` walk it back, `Ctrl+Shift+Z` and `Cmd+Shift+Z` walk it forward, and a
kill sits dimmed in the sidebar for eight seconds before anything reaches the
server. Eleven kinds of entry cover it: kill, create, retitle, move a session
(into another project, or up and down the list it is already in), reorder
groups, the session-order mode, project create, rename and delete, collapse,
and the watch choice. The stack is `frontend-v2/src/store/undo.ts`, and each
store registers the inverses of its own actions (`undo.kill.ts`,
`undo.layout.ts`, `undo.titles.ts`, `undo.local.ts`).

Built on `wizard/undo-redo`, 2026-09-10 and 11. Nine commits built it and the
rest are repairs from the review that followed; a count here goes stale on the
next one, so the branch is what to read.

## What we decided

**The chord is Ctrl+Z, claimed for the whole page, the terminal included.** Four
rows in `KB_DEFAULT_BINDINGS` (`ctrl+z` and `meta+z` to `edit.undo`, the shifted
pair to `edit.redo`), each carrying `!editing && !overlayOpen && !previewDirty`
(`UNDO_WHEN`; the third leg has a section of its own below). Both spellings of
the modifier are rows of their own because `parseChord` keeps ctrl and meta as
separate flags. A chord the layer matches makes the terminal decline the key
(`terminal/keys.ts`, the `appChord` field), so `Ctrl+Z` no longer reaches the
pty as SIGTSTP. That is the expensive half of this decision, and the owner took
it knowing so when the feature was scoped. The table below is what pays for it.

**The rows are default bindings, not always-on ones.** `KB_ALWAYS_BINDINGS`
holds one row, the kill chord, and it exists because the escape hatch out of a
wedged session must survive the layer being off. Undo is not that. Putting these
four rows in the default table is what lets ⚙ Settings → **Keyboard** → **App
shortcuts** hand `Ctrl+Z` back to the terminal, which is the only reason anyone
who wants SIGTSTP has anywhere to go.

**A focused text field keeps its own undo.** A new `editing` flag on the key
context answers true for a text-bearing input, a textarea, a contenteditable
region and anything inside CodeMirror (`keybindings/editing.ts`). That leg cannot
be moved downstream: the engine's listener is capture-phase on `window` while
CodeMirror's own Mod-z is bubble-phase on its contentDOM, so a match here fires
first and nothing afterwards can give the key back.

The terminal is the exception the flag has to name, because xterm types through
a hidden `<textarea class="xterm-helper-textarea">` and `term.focus()` focuses
exactly that. Read by tag alone the flag is true wherever a session is
attached, which is the terminal-focused leg the options below turn down: `Cmd+Z`
would be inert in a session and `Ctrl+Z` would go on suspending the foreground
job. `isEditingTarget` therefore answers false for anything inside `.xterm`
before it looks at the tag.

**An unsaved file-editor draft blocks the chords too** (`!previewDirty`, the leg
`SWITCH_WHEN` already carried). Undoing a kill re-selects the session the kill
took, and a session switch unmounts the preview store with the draft inside it.
The preview is deliberately not an overlay and focus on its Save button is not a
text field, so without that leg undo was the one session switch with neither a
confirm nor a guard in front of it.

**A kill waits eight seconds instead of asking** (`GRACE_MS`, `store/lobby.ts`).
The card stays in the sidebar, dimmed and struck through, with a `↺` arrow in the
slot its `⋯` button gave up, and the DELETE does not go out until the window
elapses. Inside the window an undo is a cancelled timer: nothing reached the
server, so nothing has to be put back, and it cannot fail. The arrow is what
gives a phone a way back at all, and it takes back THE KILL OF THE CARD IT SITS
ON rather than the top of the stack: eight seconds is long enough for a collapse
or a rename to land on top, and pressing the stack from a button drawn on one
card undid that other thing instead, silently, while the session went on dying.
It goes through `store.takeBackKill`, which presses that kill's own entry and
falls back to cancelling the window outright in a tab that has no stack — a lens
tab, the one place the session belongs to somebody else.

**Past the window, undo resurrects rather than cancels.** tmux-api snapshots a
session before killing it and returns the record in the DELETE's body
(`resurrectRecordFor`, `tmux-api/snapshots.go`; the response is `200` with
`{"resurrect": …}` where it used to be `204` with nothing). Undo posts that
record back to `POST /restore`, which recreates the session under its old name
and runs `claude --resume <uuid>` in it. The conversation comes back in full. The
scrollback, the process tree, unsent typed input, any second window or pane and
any process that was not Claude do not, and Claude starts cold. An undo whose
kill left no record refuses with a sentence saying so, rather than promising a
session back and then failing.

**One stack per browser tab, 25 entries, in `sessionStorage`** (`tl:undo:v1`).
Two tabs hold separate histories, a reload keeps yours, and closing the tab is
the end of it.

**An entry is an inverse operation, and it refuses rather than clobbers.**
`PUT /layout` replaces the whole document and carries no etag or version, so
re-PUTting a layout captured before the action would erase whatever another
device did in between. Each entry instead says what to invert, `check` asks
whether the live world still looks the way the entry left it, and an entry that
says no is dropped with its reason toasted by the caller. Undo is silent when it
works.

**A lens tab has no undo.** Switching identity is a navigation in the same tab
(`lib/act-as.ts`), so the `sessionStorage` a `?as=` page reads was written by the
previous identity in that tab. Reading it would offer to undo your own actions
against somebody else's account, and writing it would hand your next page life
theirs. The store is constructed with `enabled: ACT_AS === ""` and a disabled
store never touches the key.

## What taking Ctrl+Z costs, and what pays it

| what it costs | what answers it |
|---|---|
| `Ctrl+Z` no longer suspends a foreground job in a lobby terminal | ⚙ Settings → **Keyboard** → **App shortcuts** hands the whole layer back, `Ctrl+Z` with it |
| that switch is all-or-nothing, so the other chords go too | point `edit.undo` at another chord in `tl:keybindings:v1`. The override is keyed by command, so it frees `ctrl+z` and moves `meta+z` with it |
| a text field's own undo history | the `editing` flag, measured against a real input, textarea and CodeMirror in Chrome |
| a kill can no longer be stopped, only taken back | eight seconds with the card on screen and nothing sent, then a resurrection that keeps the conversation |

What is left over: somebody who lives in `fg`/`bg` inside a lobby terminal and
does not want to give up the rest of the shortcut layer has to write a
keybinding override by hand. There is no per-chord switch in Settings. Only
these four chords are claimed, so `Ctrl+C` and the rest of job control are
untouched.

## Considered options

- **`Alt+Shift+Z`, the namespace every other lobby chord uses.** It costs the
  terminal nothing, it needs no `editing` flag, and it would have needed no
  explaining. It was not chosen because undo is a reflex rather than a command
  people look up: the hands already know `Cmd+Z`, and a chord nobody presses by
  instinct is one nobody remembers exists. This is the owner's call, and the
  cost above is the price of it.
- **Scope the chord to a lobby that has focus, leaving the terminal's `Ctrl+Z`
  alone.** Two things sank it. The kill chord is deliberately reachable
  mid-type (`Alt+Shift+Backspace`, always on), so the kill most likely to want
  undoing is the one taken while the terminal holds focus, and a
  terminal-focused leg would make `Cmd+Z` inert exactly there. And the
  mechanism does not support it: by the time xterm consults `appChord` the
  command has already run (`terminal/keys.ts`), so "run it unless the terminal
  wanted the key" is not a decision the terminal is in a position to make.
- **Keep the confirm and add undo on top.** Two guards for one action, one of
  which interrupts every deliberate kill. The window is a confirmation that
  costs the person who meant it nothing.
- **A toast carrying an Undo button.** It would put the affordance where the
  eye already is. Toasts here carry a message and a detail and no action, and
  the dimmed card is a better phone target than a toast that times out. The
  card's `↺` is the affordance instead.
- **A per-device stack in `localStorage`.** Then `Cmd+Z` in one tab undoes what
  you did in another, which is not what the person pressing it in this tab
  means. Two lobby tabs open on different projects is an ordinary setup here.
- **Snapshot the layout document and PUT it back.** The cheapest inverse to
  write, and wrong for the reason under "refuses rather than clobbers": a
  whole-document write with no version erases a session another device created
  while the entry sat on the stack.

## Consequences

- The kill confirm is gone from all five entry points (the `⋯` menu, the right
  swipe, the sidebar's Backspace/Delete, the kill chord, the palette), and the
  seams that fed it went with it: `CommandDeps.confirm` and the `confirm` props
  on `SessionCard`, `ProjectGroup` and `Sidebar`. Settings and Skills keep
  theirs.
- Deleting a **project** still asks. That confirm was not part of this change,
  and the action is undoable now, so the question is arguably redundant.
  Removing it is a decision on its own rather than a loose end of this one.
- `DELETE /sessions/{name}` answers `200` with a JSON body instead of `204`.
  Body-blind clients are unaffected: t3-sync accepts any 2xx, `qa_driver`
  returns the status number, and the lobby reads a `204` and a record-less
  `200` alike.
- A kill is no longer instant. For eight seconds the session is alive, its card
  is on screen and the tmux-api list still carries it. A tab that goes away
  mid-window sends the kill from `pagehide` with `keepalive`, so a closed tab
  does not leave a session it promised to kill.
- Undoing a create kills the session it made, at once and with no window of its
  own. Redoing a kill opens an ordinary window, because by then the entry is
  back on the undo stack and a further press can take it back again.
- Anything that grows a new structural action needs an entry kind of its own,
  or it silently sits outside undo. `undo.ts` widens one union and every
  handler switch stays exhaustive, so the compiler asks the question.
- Not covered, deliberately: settings toggles, skill actions, file edits,
  mark-seen (nothing chooses it, so there is nothing to take back) and anything
  typed into a terminal.
- The command palette lists **Undo** and **Redo** only while a press would do
  something: an empty stack and a lens tab show neither. The card's arrow
  follows a different rule, because it presses one known kill rather than the
  stack: it is drawn whenever the window is running, lens tab included.
- A kill's DELETE is in flight for as long as the pre-kill snapshot takes, and a
  press landing in that gap waits for the request rather than reading the
  half-finished state, which used to answer "that session is still running" and
  drop the entry. tmux-api bounds the gap from its end: it asks tmux whether the
  session exists before running anything privileged, runs one snapshot at a time
  and abandons one that outlives `preKillSnapshotBudget`.

## What was driven, and what was not

The chords were driven in a real Chrome: `Ctrl+Z`, `Cmd+Z` and both shifted
forms fired their commands with a button focused and fired nothing at all with
focus in an input, a textarea or a CodeMirror editor, where the field's own undo
took the typing back instead. The terminal was not among those four, and that
gap is what let `editing` read true for xterm's input proxy; it is now covered
by a test that focuses a real xterm-shaped element rather than passing the flag
in as a fixture (`test/undo.keys.test.ts`). The dimmed card was measured against the real
stylesheet in Chrome rather than in jsdom: the arrow at full opacity over a
0.45 row, the strike-through, the danger tint at 10%, and focus landing on the
arrow. A real kill was driven against a scratch tmux-api on loopback, which is
where the fail-soft path (no snapshot available, kill anyway, log it) was
observed.

Three gaps stand. The snapshot's happy path was not driven live: tmux-api
reaches its wrapper at a fixed path, the copy installed on this box predates
the change, and installing a new one is the Debian package's job rather than
something to type on a shared machine. Nobody has driven a full undo of a real
action in a browser against a live tmux-api either, because the local instance
answered 401 for that identity through the dev proxy, so the store's own
interface and its handlers are what the tests drive. And nothing here has been
exercised on a phone: the arrow's size and behaviour are asserted from the
stylesheet and the CSSOM rather than from a finger.
