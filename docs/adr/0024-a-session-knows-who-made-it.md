# A session knows who made it

The QA fleet drives the real deployed lobby against the real backends on
purpose: `scripts/qa-harness.py` exists so that what an agent clicks is what
`terminal.viktorbarzin.me` serves. The cost of that faithfulness is that the
fleet's sessions are wizard's sessions. They sit in his sidebar,
`create_claude_session` (`scripts/qa_driver.py:383`) starts a real Claude in
them, and every turn one of them finishes is a completion, so it is also a Web
Push to his phone. t3-bridge's e2e harness reaches the same place by another
route, creating `t3e2e-*` sessions on the default socket where the lobby sees
them.

Nothing in the list could tell those from a session a person opened. A session is
created with a minted 12-character id (ADR-0019) that a title later renames into
words (ADR-0022), and a QA agent driving the ordinary new-session flow gets both
exactly as the composer does.

Measured on the box on 2026-09-06, four of the live sessions were made by tooling:
`qa-slug` from the fleet, and `shell`, `shell-2` and `kbfix-probe`, which match no
harness convention at all and came from a hand or from a script that is not in
this repo. Three in four unattributed is the measurement this design turns on.

## What we decided

**A session records who made it in a tmux option, and the sidebar groups on that
rather than the server filtering on it.**

`@tl_origin` sits beside `@title`, `@last_drive`, `@claude_state` and
`@tl_created`. It holds `user` when the lobby's own create path made the session
and `test` when a harness stamped it. The third state is the ABSENCE of the
option: nobody said. A session is a system session when its origin is not `user`,
or when its name carries a prefix `reservedName` already reserves
(`tmux-api/origin.go`, `tmux-api/migrate_ids.go`).

A tmux option is the same choice ADR-0001 made for `@claude_state`, for the same
reasons: it belongs to the session, it dies with the session, there is no store to
keep in step with tmux, and it rides `tmuxListFmt` (`tmux-api/main.go`) so it
arrives with every other field at no extra fork. One reason is particular to this
option. Its writers are a shell script (`devvm/tmux-user-attach`), a Python
harness (`scripts/qa-harness.py`) and a bash harness (`t3-bridge/e2e/lib.sh`),
none of which can import a Go constant or call a Go API. A tmux option is the one
interface all three already speak. There is precedent for this exact use inside
that first script: `@tl_speculative` (`devvm/tmux-user-attach:298`) is how a
prewarmed slot already records that it was made on spec rather than asked for.

ADR-0019's minted id is true at creation and not afterwards, because ADR-0022
renames a session once its first title lands. Neither half of this design rests
on the name holding still. A tmux option survives a rename, so `@tl_origin`
rides along; and `derivedNameFor` (`tmux-api/name_from_title.go:50`) declines to
rename a `reservedName` at all, so a `qa-` session keeps the prefix the second
half of the predicate reads.

The sidebar half: system sessions collect into a synthesised **System** group at
the foot of the list, a third `GroupKind` beside `project` and `ungrouped`
(`frontend-v2/src/components/lobby.logic.ts`), collapsed by default through the
existing per-browser collapse store under the sentinel key `:system`
(`frontend-v2/src/store/collapse.ts`). `GET /sessions` goes on returning every
session, and attach, prompt, kill and `/?session=<name>` are untouched. The
session someone needs to open is often exactly the one a failed QA run left
behind.

## Considered options

- **A server-side filter on `GET /sessions`, with an opt-in query parameter.**
  The smallest change on paper, and it makes the list lie by default. That list
  is read by more than the sidebar, so a caller that has not heard of the
  parameter silently stops seeing sessions that exist and are still running,
  which is the failure mode hardest to notice and hardest to explain afterwards.
  It also puts the policy in the wrong place. Whether a session is worth showing
  is a view question, and the two views that disagree about it already exist:
  the sidebar folds a system session away, a URL opens it.
  The QA harness is one of those callers, which makes the point concrete: the
  ownership set its mutation guard is built on comes from that same list, so a
  filter there would have had to be argued about again at every call site. The
  group decides it once, at render.
- **A real, auto-created project row.** A project is a first-class server object
  with an id, members, a directory, an attach mode and co-ownership, and any
  member may rename, re-dir or delete one (`tmux-api/projects.go`). None of that
  means anything for System, all of it would have to be defended against, and
  membership would have to be maintained on every create and every rescue.
  Ungrouped is the precedent that says a synthesised group is enough: a name of
  `""`, its own collapse key, hidden while empty, and not a project.
- **A name convention alone**, extending `reservedNamePrefixes` and asking
  nothing else of anybody. It costs one line, and it answers the measurement
  wrongly: it catches `qa-slug` and misses `shell`, `shell-2` and `kbfix-probe`,
  which is one in four. A convention binds only the tools that agreed to it, and
  three of the four sessions came from something that never did. The convention
  is kept anyway, as the second half of the predicate, for two reasons. It is the
  one signal that survives a harness forgetting to stamp, and it closes a window
  the stamping order opens: a QA agent driving `/?session=qa-foo` goes through
  the lobby's own create path and is stamped `user` on the way in, and the
  harness only overwrites that afterwards.

## Consequences

- **The lobby had to start marking its own work.** Making absence mean something
  is an inversion: before this nothing stamped anything, so "unstamped"
  distinguished nobody. `devvm/tmux-user-attach` runs `tmux new-session -A`,
  which attaches or creates and does not report which, so a `has-session` check
  now stands in front of it and a miss is what earns the `user` stamp. A pool
  claim stamps at the rename instead, because after the rename the session
  exists and that check would read it as somebody's session already up.
- **Every session alive at the upgrade is grandfathered in one pass.** Without it
  the deploy would sweep the whole live list into a collapsed group at once and
  silence all of it. `grandfatherSessionOrigins` (`tmux-api/originstamp.go`)
  stamps `user` on every unstamped session with no reserved prefix at start,
  beside `migrateSessionNamesToIDs` (`tmux-api/migrate_ids.go`). Of the 26 live
  sessions measured on 2026-09-06 that is right for 22 and wrong for the three
  strays, which get killed by hand rather than rescued. It needs no marker file:
  a stamped session is skipped by its own stamp, so a second run is a no-op and
  an interrupted run is finished by the next start.
- **A harness stamps second, not first.** An agent that creates a session by
  driving `/?session=<minted-id>` goes through the lobby's create path and is
  stamped `user` on the way in, so a harness has to OVERWRITE its own sessions to
  `test` afterwards. `POST /sessions/{name}/origin`
  (`tmux-api/session_mutate.go`) is what does it, and it is also the rescue:
  dropping a card out of System posts `user`, so the session stops being a system
  session on the server as well as in the arrangement.
- **Push and telemetry read the predicate, not the group.** The push sender drops
  a system session before the edge diff rather than at the send
  (`tmux-api/pushsender.go`), so a rescued session cannot fire once on a stale
  edge. Telemetry drops an event whose `tl.session` names a system session at
  emit, through the drop rule the `telemetry` package now takes
  (`SetDropRule`, `telemetry/telemetry.go`).
- **The collapse store gains a default it did not have.** A key it has never
  seen reads as expanded, and `:system` reads as collapsed
  (`frontend-v2/src/store/collapse.ts`). That is the only change to a store that
  had treated all its keys alike.
- **The collapse default is the thing to watch.** A session that lands in System
  wrongly is one click away rather than in front of you, which is the point of
  the feature and also its failure mode. The group header carries its count while
  collapsed, so a wrong answer is at least one line of evidence rather than
  nothing.

## What this does not do

It does not identify a creator. `user` means "the lobby's create path made this",
not "a human made this", so anything that starts driving that path and never
corrects itself afterwards is indistinguishable from a person. The harnesses
correct themselves. Anything new that creates sessions this way has to do the
same.

It is not a boundary of any kind. A system session stays fully addressable on
purpose, and the option is writable by anyone who can reach the tmux server,
which is the same set that could kill the session outright. What it buys is a
quiet sidebar and a phone that does not buzz for a robot, not isolation.
