# A quiet session gives its memory back

Terminal Lobby holds a Claude Code process open for every session in the
sidebar, for as long as the session exists. That was the right default while a
person had a handful of sessions. It stopped being the right default once the
box filled up with conversations nobody had touched in a week.

Measured on the devvm on 2026-09-19. 38 live claude processes hold 16.5 GiB of
a 31.3 GiB machine, which had 9.3 GiB available and 9.3 of its 14 GiB of swap
already in use, with wizard's `user-1000.slice` at its 4 GiB swap cap. 17 of
those 38 sessions have not been driven for over 72 hours, and they hold
4.6 GiB of it.

A session's real cost is its process tree rather than its claude. Six stdio MCP
children hang off each conversation and die with the parent that spawned them,
so the tree is 781 to 856 MB where claude alone reads 305 to 377 MB. PSS is 93%
of RSS across these trees, so nearly all of it is private and reclaiming one
session reclaims close to the whole figure.

The conversation itself is not in the process. It is in the transcript JSONL on
disk, which is what makes this decision available at all.

```stats
38 | live claude processes
16.5 GiB | they hold
17 | of them untouched for 72 h
4.6 GiB | those 17 hold
0.00 USD | what a resume costs
1.7 to 3.1 s | cold resume to a loaded prompt
```

## What we decided

**A session nobody has driven for 72 hours is suspended. Its claude process is
killed, its tmux session stays in the sidebar marked suspended, and clicking it
runs `claude --resume <uuid>` in the pane it already had.**

Four things follow from it, and each one was a decision of its own.

**The idle signal is `@last_drive` and nothing else.** It is already written by
`tmux-api/lastdrive.go` from the live client list, already on the wire as
`Session.LastDrive`, and already the number the sidebar shows on each card. A
Watch-mode client does not move it and neither does a **Preload attach**
(ADR-0026), so looking at a session does not make it look younger.

A resume writes it too, which makes `resumeSession` the option's second writer
after `stampDrives`. Without it the stamp that made a session a candidate is
still on the session when its claude comes back, and the next sweep five
minutes later suspends it again — the lobby's own click is covered only because
opening the card attaches a client a moment afterwards.

Transcript mtime was the obvious alternative and it was measured and rejected. A
transcript whose last record is dated 2026-08-19 had an mtime 28 minutes old
when it was read on 2026-09-19; the file is written for reasons other than a new
record. Keyed on mtime, 36 of the 38 live sessions read as active within the
hour, against 9 by `@last_drive`. mtime is used nowhere in this feature.
tmux's own `#{session_activity}` moves on any attach, which is the measurement
that produced `@last_drive` in the first place, and `#{client_activity}` is a
client's attach time and does not move on `send-keys`.

**`remain-on-exit` is set on the one session, immediately before the signal.**
Verified on the box the same day: the option is off globally and off on every
window, every lobby session has exactly one window and one pane, and the pane
command is `/bin/zsh -lic "claude ..."`. When claude exits the `-c` list ends,
zsh exits, the pane exits, and a one-pane session dies with the pane. So a
suspend that merely signalled claude would destroy the session it meant to keep.
With the option set on that session alone, the pane goes dead, tmux freezes its
scrollback, `#{pane_dead}` reads 1, and `respawn-pane -k` puts a command back
into it. Setting it globally would stop an ordinary `exit` from closing any
session on the box, for every user, which is why it is per session and why it is
set at the last possible moment.

**Once the signal is away, `remain-on-exit` is never put back.** An earlier
draft turned it off again whenever the kill did not finish inside the 10-second
grace. The SIGTERM is still in flight at that moment, so the moment claude does
exit the pane exits and the one-pane session is destroyed with its scrollback —
reproduced on tmux 3.4, 2026-09-19: option on, unwind, the process exits a
moment later, `list-sessions` answers "no server running". Left on, the cost is
a pane held as a corpse the next time that claude exits by itself, which the
repair pass below turns into a resumable suspended session. The recoverable
outcome is the one we take.

**The mark means the claude is gone, not that the pane died.** Both shapes are
on the box. An ordinary `/bin/zsh -lic "claude …"` dies with its claude, while a
session restored by `tmux-persist` runs `…; claude …; echo …; exec bash -l` and
carries on into bash: measured on tmux 3.4, 2026-09-19, `#{pane_dead}` then
reads 0 and `#{pane_current_command}` reads bash, and two of the box's live
sessions had that shape. After a reboot restore it is every session. A
surviving shell holds no conversation and `respawn-pane -k` replaces it, so
such a session is suspended and resumable like any other; the one case the mark
is withheld for is a CLAUDE still under the pane after the kill, which is what
the resume would respawn over. The resume asks the same question rather than
reading `#{pane_dead}` alone.

**The policy is re-read at the moment of the kill.** A pass is not instant —
each candidate costs a /proc walk, three set-options and a wait of up to 10
seconds — so the list a candidate came from can be minutes old by the time its
turn arrives, and somebody can open the session or start a turn in between. The
pane read that the suspend already makes carries `#{session_attached}`,
`@claude_state`, `@tl_suspended` and `@agent_owner` as well, and a suspend is
abandoned when any of them says no.

**A suspend that stops half way is repaired by the next sweep.** Between the
kill and the stamp the `set-option` can fail, or the service can be restarted —
a package upgrade does exactly that. What is left is a dead pane with a resume
command and no timestamp, which no later sweep would look at (its tool reads as
a shell) and no click could resume. Each pass lists the sessions carrying
`@tl_resume_cmd` with a dead pane and no `@tl_suspended`, and stamps them.

**The uuid is resolved from `@claude_transcript`, never from argv.** For 15 of
the 38 live processes the pane's `--session-id` had no matching `<uuid>.jsonl`
on disk while the option pointed at a file that existed.
`sessionio/layout.go:328-330` `ClaudeIDFromTranscript` takes the uuid from that
path's basename. A session whose transcript cannot be resolved is not suspended.

**The trigger is a 5-minute sweep and nothing else.** There is no manual suspend
button and no resume on hover. A click is the only thing that brings a session
back.

**A prompt sent to a suspended session is refused, not delivered.**
`POST /prompt/{session}` reads `@tl_suspended` and answers 409 naming the
session. Every layer below it reports success otherwise: measured on tmux 3.4,
2026-09-19, `send-keys` into a dead pane exits 0 and the text vanishes, and
into a pane whose wrapper shell outlived its claude the message is typed at a
bash prompt and run as a command. The lobby's composer does not rely on that
answer — it holds the message and sends it when the session is back
(`frontend-v2/src/store/suspend-queue.ts`) — so the 409 is for every other
caller.

### The threshold, and the evidence for it

Loki holds 14 days of `user_prompt` events, 2,005 across 235 sessions. Reading
each session's gaps between prompts, with right-censoring corrected so a gap
still open at the end of the window is not counted as one that ended:

| quiet for | resumed within 24 h |
|---|---|
| 1 h | 50% |
| 4 h | 26% (45% among sessions still live) |
| 12 h | 16% |
| 24 h | 8% |
| 48 h | 2% |

Of the gaps that did end in a resume, p50 is 8.4 minutes and 83% are under an
hour. People come back to a conversation quickly or not at all, so a threshold
under 12 hours suspends sessions that were about to be used.

The threshold costs something and the cost is known. 72 hours reclaims 4.6 GiB
where 24 hours would reclaim 8.4 GiB, so the conservative choice gives up
3.8 GiB to avoid interrupting the 8% who return on the second day. Idleness on
this box is bimodal, with 9 sessions touched within 4 hours, 25 untouched for
over a day and nothing between 4 and 12 hours, so the difference between those
two rows is one cluster of sessions rather than a smooth range.

72 hours is past the last point measured. The curve reads 2% at 48 hours and is
still falling.

A system session gets 4 hours instead, on the same predicate the sidebar's
System group already uses (`isSystemSession`, `tmux-api/origin.go:54`). A
harness's leftovers are not a conversation anybody is coming back to, and
reusing the existing predicate means there is no second list to keep in step.

### What is never suspended

Absolute, not weighted against the age: a session whose `@claude_state` is
`running`; a session whose `@claude_state` is `awaiting`, exempt forever
whatever its age; a session with a client attached; a pool slot or any
`reservedName` (`tmux-api/migrate_ids.go:58`); a session whose tool is not
claude (`proc.go` `toolUnder`); a session with no resolvable transcript; and a
conversation agent-api opened, which carries `@agent_owner`.

The agent-api exclusion is the one added after the fact, and it is worth saying
why. Those conversations are driven over HTTP and never attach a tmux client,
so `stampDrives` never moves their `@last_drive`: seeded once from the creation
time, it reports the session as idle since the moment it was made however busy
the caller has been. `isSystemSession` also puts them on the 4-hour fuse,
because agent-api stamps the calling credential as the origin. Together that
suspends a conversation four hours after it was created, and agent-api has no
resume verb, so its caller could not bring it back. Measured on the box
2026-09-19, `session-ready` (`@agent_owner=muse`, state `done`, 34 hours by
`@last_drive`) would have gone on the first sweep. The memory stays held until
agent-api can resume one; in the meantime it reports such a conversation's
state as `suspended` rather than `done` and refuses to write it, so a mark from
any other source cannot be silently written into.

The `awaiting` exemption is the one worth stating rather than listing. A
question that has been waiting three days is not a stale question. It is the
reason somebody will open that session, and the answer is still sitting in the
pane.

## Considered options

- **Suspend at 4 hours.** It is where the memory is, at 9.9 GiB across 28
  sessions, and the 26% resume rate is what rules it out. A quarter of
  suspensions would charge a resume for memory that was about to be wanted, and
  the resume is not free to the person, only to the account. It also removes any
  margin for the signal being wrong, and the signal is a heuristic.
- **Kill the idle session outright.** The reclaim is identical and the feature
  is smaller by everything below the first paragraph. It loses the pane's frozen
  scrollback, drops the layout entry and the manifest row (the **Kill** path
  writes a tombstone on purpose), and turns a decision the machine made on a
  clock into one a person cannot take back except through the restore picker.
  A suspend is reversible by clicking the thing that is still in front of you,
  which is what makes an automatic trigger defensible at all.
- **Resume through the pre-warmed pool.** An in-process `/resume <uuid>` into a
  standing slot takes 0.9 to 1.8 s against the cold path's 1.7 to 3.1 s, so it
  is worth about 1.4 s. Measured on 2026-09-19, four things cost more than that:
  a slot's cwd is fixed at warm time so it can only serve a matching directory,
  which is under half the sessions; one slot serves one resume at a time;
  claiming a slot leaves the create path cold for 2.7 s, moving the cost onto
  whoever makes the next session; and the slot carries the previous conversation
  forward, with one process going 308 MB to 530 MB across three swaps. Trading
  memory for 1.4 s in a feature whose purpose is memory is the wrong direction.
  Viktor chose the cold path knowing the number.
- **A manual suspend button.** Nobody would press it. The 17 sessions in the
  measurement are idle precisely because nobody is thinking about them, so a
  control that needs attention cannot reach the sessions that need suspending.
  It is also a second way to make a session stop, next to a kill, with a
  difference that is hard to explain on a card.
- **Resume on hover.** ADR-0026 decided what a hover may do to a session, and
  the answer was an attach that takes nothing from anybody: read-write but
  ignore-size, not counted as driving, never creating a session that has gone
  away. Starting a process is a different class of act, and running the pointer
  down the sidebar would start every suspended session it crossed. This decision
  deliberately does not extend ADR-0026, and the hover contract is unchanged.

## Consequences

- **The session list gains a state that has no live Claude behind it.**
  `stateSuspended` joins `knownStates`, and `parseSessions` forces it whenever
  `@tl_suspended` is above zero. `clearDeadStates` (`proc.go:172-190`) has to
  learn about it, because it blanks `State` whenever `/proc` shows no claude
  under the pane, which is exactly what a suspended session looks like.
- **Three tmux options join the ones a session already carries.**
  `@tl_suspended`, `@tl_resume_cmd` and `@tl_suspend_state`, written only by
  tmux-api, beside `@title`, `@last_drive`, `@claude_state`, `@tl_created` and
  `@tl_origin`. They die with the session, which is right for all three.
- **`@tl_suspended` is written only after the process it describes is gone.**
  The mark is what a suspended row is, and clicking that row runs
  `respawn-pane -k`, which replaces whatever is in the pane. So a mark over a
  live claude would be one click from losing a conversation. The two options
  the resume needs are written before the kill, since neither changes how the
  session reads; the mark itself waits for the process to exit, and any failure
  after `remain-on-exit` was set puts that option back. The resume endpoint
  checks `#{pane_dead}` as well and refuses a live pane, so the invariant holds
  from both sides.
- **The kill goes through the session's own tmux server.** tmux-api runs as
  `wizard` and the sweep covers every mapped user; measured on the box on
  2026-09-19, an unprivileged kill from `wizard` against `emo`'s claude returns
  `EPERM`, and `emo` owns 20 of the sessions on it. `tmux run-shell` executes
  as the server's user and needs no new sudoers grant, because `/usr/bin/tmux`
  is already granted per target user. It reports nothing back (tmux 3.4, no
  attached client: exit 0 and no output either way), so the outcome is read
  from `/proc`.
- **`tmuxListFmt` grows a column, and `pane_title` stays last.** `listFields`
  goes 17 to 18. `pane_title` is text an application writes for itself and
  `SplitN` hands the final field every leftover tab, so a column parsed out of
  the tail would be whatever the pane last said. The same reasoning already
  governs `bgColumn`, `bornColumn`, `createdColumn` and `originColumn`.
- **Two new telemetry events, and they are what revisits the threshold.**
  `session.suspended` carries `tl.session`, `tl.idleSeconds` and `tl.rssBytes`;
  `session.resumed` carries `tl.session`, `tl.suspendedSeconds` and
  `tl.resumeMs`. Reclaimed bytes against how long the guess held is the pair
  that says whether 72 hours was right, which is why the number does not have to
  be right on the first try.
- **The first run reclaims mostly one person's memory.** emo owns 12 of the 17
  sessions past three days. The design does not treat users differently and
  nothing here depends on that split, but it is worth him hearing before the
  sweep runs rather than after.
- **A resume is a cold start a person will notice.** 1.7 s for an empty
  transcript, 2.8 s at 4.7 MB, 3.1 s at 24.4 MB, against the 779 ms ADR-0026
  measured for opening a live session. It costs no money: the readout stayed at
  $0.00 and a transcript carrying a `totalCostUSD` of 398.25 displayed that
  figure restored from the file rather than charged again.

## Open questions

- Whether a suspended mark survives a reboot is not measured. A tmux-persist
  restore would have to bring back both the session options and a pane in the
  dead state, and neither half has been checked. Whether closing that needs an
  infra change is the unknown part.
- 72 hours is the number for a person's session and 4 hours for tooling's, and
  a conversation driven purely over HTTP is neither: it looks idle by
  `@last_drive` however busy it is, so it is excluded rather than timed. The
  open part is what should replace that — agent-api resuming a conversation
  itself before it delivers a message is the obvious answer, and it needs a
  resume verb this API does not have yet.
- 72 hours is read off a curve whose last measured point is 48 hours. The first
  month of `session.resumed` events answers it directly, and 24 hours is the
  candidate the data would have to justify.
