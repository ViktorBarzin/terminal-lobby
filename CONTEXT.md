# Terminal Lobby

Web tmux sessions behind a reverse proxy, isolated per OS user, at
`terminal.viktorbarzin.me`. This context covers the lobby UI, the
tmux-api, and the devvm-side session plumbing.

Authentik gates this deployment, but nothing requires it: since 2026-08-29 the
identity header's name is configuration (`TL_AUTH_HEADER`), so any proxy that
authenticates and names the user works.

## Language

**Session**:
One tmux session belonging to one OS user, listed in the sidebar and
rendered in the terminal pane. Usually runs a Claude Code conversation, but
may be a plain shell. Carries a **name**, which nobody reads, and a
**title**, which is what everybody reads.
_Avoid_: terminal, tab, thread

**Name** (of a session):
The tmux session name. An opaque 12-character id, minted by the browser when
the session is created, and **derived from the title from the first title
onwards** — `Deploy the thing` becomes `deploy-the-thing`, with a `-2` suffix
when a sibling already holds it. What everything is keyed by: tmux targets,
URL segments, store keys, the session-images directory, the `?arg=` attach
contract, the push tag. Unique within one OS user's tmux server, so a
cross-user reference needs the owner too. It is what `tmux ls`, the status
bar and the terminal window title show, which is why it reads as words;
ADR-0022 has the reasoning, and ADR-0019 has the interval when it did not.
Because it moves, anything recording a session across time keys by tmux's
own `session_id` instead, which a rename does not change. That only serves
something which has SEEN the session, and the first rename lands seconds
after creation — often before any poll has listed the session under the id
the browser minted. So the first rename away from an id also records that id
as the session's **birth name**, which is what lets a browser holding the
name it minted find the session under the name it has now.
_Avoid_: label; and any surface that shows a name where it could show a
**title**

**Birth name**:
The minted id a session was created with, kept on the session (the `@tl_born`
tmux option, served as `bornAs`) once the first title has renamed it away from
that id. Written once and only for an id: a session renamed from a readable
**name** has been listed under it all along, and overwriting would replace the
one name a stranded browser is holding. Present only on a session that has
been renamed, which is why nothing may treat it as the session's identity —
`session_id` is that. It answers one question: *what is the session that used
to be called this?*
_Avoid_: original name, old name, alias

**Title**:
The display text for a session — spaces, punctuation, emoji, any script, up
to 64 characters. The only name a session has that anyone reads, and what
every surface shows: sidebar cards, the tab title, the command palette, the
dock, push bodies, confirmations, the restore picker. Usually a **summary**
the lobby adopted rather than text a person typed, and a person may replace
it at any time. Stored on the session itself (the `@title` tmux option), so
everyone who can see the session sees the same title, and a durable copy
(tmux-api `titles.go`) re-stamps it after a restore. That copy is also what
the restore picker reads: it lists sessions that are not running, and a tmux
option died with them. It outlives a deliberate kill too, because the picker
can restore from a snapshot older than the kill. Clearing it hands the session back to the summary. A session with
no title yet shows the first line of the prompt it was created with, or
`New session` — except where a question has to name ONE session and the
answer cannot be taken back, such as a kill confirmation, which falls back
to the **name** instead: `New session` reads the same for every untitled
session, and the id is the only thing that tells them apart.
_Avoid_: label, nickname, display name; and do not confuse with **pane
title**, which is whatever is running in the pane describing itself.

**Summary**:
Claude Code's own one-line description of what a conversation is about, which
it writes into its terminal title and which therefore arrives as the
session's **pane title** behind a glyph prefix. The lobby adopts the first one
that appears as the session's **title** and then leaves it alone, so a
summary that drifts as the conversation moves does not move the title. Not
present for a plain shell, and reads `Claude Code` before the first prompt.
_Avoid_: auto-title, generated name (the thing it becomes is simply the
**title**)

**Project**:
A first-class, server-owned object with a stable **id**, a **name**, an
optional **directory** (base cwd for sessions created in it), a **member**
set (OS users), a blanket session-**attach mode** (ro/rw), and a
**co-owned** flag. Multi-owner: it groups sessions from several members and
appears in every member's sidebar. Governance is co-equal — any member may
rename, re-dir, add/remove members, set the mode, or delete it (delete
dissolves the grouping, never kills sessions). Two stores hold a project
between them: identity, membership, attach mode and co-ownership live in the
global project store (`/var/lib/tmux-api/projects.json`,
`tmux-api/projects.go`), shared by every member. A member's own ordering of
projects, and of the sessions inside each one, lives in that member's layout
document (`/var/lib/tmux-api/layout/<user>.json`, `tmux-api/layout.go`), which
is what `PUT /layout` writes. The directory is the one field both stores
carry. `GlobalProject.Dir` belongs to the `/projects` surface, which the SPA
has not been ported to; `Project.Dir` in the member's layout document is the
one the lobby drives, written by `PUT /layout` and validated there
(`layout.go:250-256`), and read by the prewarm matcher (`prewarm.go:129`).
A session belongs to at most one project.
_Avoid_: group, folder, workspace

**Member**:
An OS user belonging to a project. Sees all its sessions, may add their own,
and (co-equal) may edit it.

**Owner** (of a session):
The OS user whose uid the session's process tree runs as — exactly one per
session. A foreign session (owner ≠ the viewer) is attach-only.

**Origin** (of a session):
What made a **Session**, which is a different question from **Owner**. Owner is
whose uid it runs as; origin is what asked for it to exist. A session the
lobby's own create path made is a user session. One a test harness made, and one
nothing accounted for at all, is a **system session**. System sessions collect
in a single group at the foot of the sidebar, **System**, collapsed by default,
where they stay fully addressable: attach, prompt, kill and open by URL all work
as they always did. What they lose is the attention a person's session gets,
since a system session raises no push and is not recorded in telemetry. System
is not a **Project** and cannot become one, but moving a session out of it into
a project is how you say a person made this one after all, and that change
sticks. Absence of an origin counts as system, which only means anything because
the lobby marks what it makes itself.
_Avoid_: creator, source, author (each reads as who is working inside the
session rather than what brought it into being), bot session

**Share**:
A grant letting a named non-owner attach a specific session, read-only
(`tmux attach -r`, watch) or read-write (drive — which runs as the owner).
Server state in the share store; the owner grants, the owner or guest removes.

**Attach mode**:
How a viewer may attach a session that isn't theirs: **ro** (watch) or **rw**
(drive, i.e. run as the owner). Set per-share, or blanket per shared project.
Server-side and per-share — it is the **ceiling** on what an attach may get,
not what a given client asked for. A **Lens** attach has no share row at all:
administering the box is the authorization and the ceiling is **rw**, which the
lens then declines by always asking to watch. _Compare_: Watch mode.

**Watch mode**:
A client's own choice to attach read-only, so it observes without driving,
without moving the Grid, and without moving **Last driven**. Three states — watch, drive, or **unset** — set from
the session bar or a sidebar card's `Attach as` menu. Unset resolves
automatically, joining as a viewer when the session already has a read-write
client (**driven**); that decision is taken once, when a view takes the session
on. Per (session, device), remembered in the browser and never sent to the
server as state — the desktop keeps driving while the phone
watches the same session. Applies to your own sessions as well as shared ones;
owning a session is what authorizes watching it. A client may only ever request
**at or below** its Attach mode, so asking to watch can never grant access. In a
**Lens** it is **locked** on: the choice is gone, the controls that type are
disabled, and nothing is recorded (the stored choice is keyed by session name, so
a lens that wrote would change how your own session of that name opens).
_Avoid_: read-only mode (ambiguous against a share's `ro`), observer mode

**Lens**:
A browser tab acting as another OS user — an administrator's view of someone
else's lobby, carried as `?as=<osUser>` and confirmed by `/whoami` answering with
a **realUser**. Everything the tab shows belongs to the target: their sessions,
Layout, Projects, prefs, files and gallery. It watches: every attach it makes is
read-only (Watch mode locked), and it cannot start a session in their account.
Per tab, so another tab stays you. Acting as yourself is not a lens. Two surfaces
resolve the real caller instead of the target — push subscriptions, and
telemetry, which records both identities.
_Avoid_: impersonation, sudo mode, admin mode (the switch is one tab's view, not
a state of the app)

**Created**:
When a Session became somebody's, which is not when the tmux session was
made. A create that claims a **Pre-warm slot** renames a session that
already existed, and tmux's own `session_created` goes on reading the
slot's age: measured 2026-09-04, a standing slot read 4h33m stale. So the
claim stamps the session's `@tl_created` tmux option, and that wins
wherever it is present, with `session_created` the fallback for every
session that predates it. It is what the sidebar's Created ordering sorts
on, and so the answer to "which of these did I just make"; it also seeds
**Last driven** until a first driver is seen, and dates the window the
auto-title rule watches in.
_Avoid_: session start, birth time, and anything that suggests it is tmux's
`session_created`

**Pre-warm slot**:
A detached session with Claude already booted, started for a directory
before anyone has committed to making a session there, so a create can skip
the boot. Two lifetimes: a standing slot, refilled after each claim and
never collected, and a speculative one, warmed when a create input opens
and collected by TTL if nobody commits. A claim is a `tmux rename-session`
onto the slot, which is atomic and refuses a name already in use, and that
is the whole concurrency story. Slots are named past the length limit a
client may address, so the lobby never lists one; the rename is also why a
claimed session's **Created** cannot be tmux's own `session_created`.
_Avoid_: pool session, warm session, spare session

**Last driven**:
When a human last had hands on a Session — the newest moment a **read-write**
client was attached. The relative time the sidebar shows, and the answer to "has
anyone touched this today". A **Watch mode** client deliberately does not move it:
watching a session leaves it as it was found, the clock included. Derived from the
client list and kept in the session's `@last_drive` option, so it survives a
tmux-api restart and a driver who attached from a shell counts like any other.
Seeded from a session's creation time until its first driver is seen, so it is
never empty.
_Avoid_: last active (that is tmux's `session_activity`, which any attach bumps —
a read-only one included — and which nothing displays)

**Channel**:
One of the five things a client keeps alive: its **terminal** socket, its
**transcript** stream, the **session list** poll, **notifications**, and the
**build** it is running. Each is in one of three states — working, degraded
(reconnecting, retrying, an update waiting: reason to wait), or down (reason to
act) — or `unknown`, which is not a state but the absence of one, and which
every rule skips rather than counting as either health or fault. The word is for
this document, the ADR and the code: on screen the five are simply labelled, and
no surface ever says "channel". A **badge** shows the worst of the channels its
surface can honestly report; Settings → Network shows all of them.
_Avoid_: connection (taken: Settings → Network calls the network link "this
connection"), transport, service, stream (that is one channel, not the set)

**Grid**:
The size of a session's tmux window, in columns and rows. Owned exclusively by
its **read-write** clients: a Watch-mode client consumes the Grid and never
changes it, including when no read-write client is attached at all. Enforced by
pinning (`window-size manual` plus hooks that re-derive the size from the live
client list, newest activity first), applied on the first read-only attach and
never reverted. Among several read-write clients the Grid belongs to the one
being used, which is what tmux's own `window-size latest` does — but the hooks
only fire on a client attaching, detaching or resizing, so a device that is
merely READING a session claims the Grid explicitly
(`POST /sessions/{name}/grid`).
_Avoid_: window size (means the browser's), canvas, viewport

**Co-ownership**:
POSIX-ACL grant giving all a project's members rwX on its directory, applied
when co-ownership is enabled. Independent of attach mode (a project can be
attach-ro yet co-owned on disk).

**Ungrouped**:
The implicit area of the sidebar holding sessions assigned to no
project. Collapsible and reorderable like a project — it occupies a
movable slot among the projects (default: top) — but not a project:
it cannot be renamed or deleted, and it hides while empty (keeping
its slot).
_Avoid_: default project, inbox

**Assignment**:
The session→project mapping. Server-side state owned by tmux-api, so it
follows users across devices and survives tmux crashes and restores. It is
read from two stores, in this order: the per-user **Layout**, which is the
arrangement the sidebar renders and keeps referencing a session after it
dies; and the **global project store**, which lists each project's member
sessions as `(owner, name)` and covers sessions grouped through sharing. A
third, narrower store — `assignments/<user>.json` — remembers what a
deliberate kill drops from the layout, so restoring a session later puts it
back in its project rather than Ungrouped.

**Layout**:
The per-user sidebar arrangement owned by tmux-api: the ordered list
of projects, each project's ordered member sessions, the Ungrouped
order, and the Ungrouped section's slot among the projects. Collapse
state is NOT part of the layout — it is a per-browser view preference.

**Session state**:
What the Claude conversation inside a session is doing: *running* (it is
working and will produce more output), *awaiting input* (Claude asked
something and is blocked on the user), or *completed* (finished, ready
for the next prompt). A session with no live Claude has no state. Note
that *running* is not the same as "a turn is in flight": a session with
**Outstanding work** is running with nobody talking.
_Avoid_: status, activity (tmux "activity" means terminal output, not
Claude turn state)

**Outstanding work**:
Background tasks a session launched that have not reported back —
background subagents, **Workflow** runs and background commands. A
session with any is *running* rather than *completed*, because it will
produce more output without anyone prompting it, and the sidebar names
what it is waiting on ("2 agents", "1 workflow"). Kept as the set of
task ids in the session's `@claude_bg` option: a launch that returns
`async_launched` adds one, and it is removed either by that id's
task-notification or, at the end of any turn, by no longer appearing in
the harness's own list of live tasks. The second path is the load-bearing
one: a notification for a task that finished mid-turn is absorbed into
that turn and never arrives as a prompt. Nothing expires, so a person
typing into the session also re-derives it — the same recovery path a
stale **Session state** has. Only the main
thread's own launches count: a subagent's background tasks report back
to the subagent, so counting one would leave an id nothing can retire.
_Avoid_: pending tasks, background jobs (both read as shell job control),
and any wording that makes it a fourth **Session state**

**Session images**:
The per-(user, session) store of images the session visually touched —
pasted, uploaded, drag-dropped, or rendered via `show-image` — owned by
clipboard-upload under `/var/lib/clipboard-store/` and browsed from the
🖼 gallery, which is reachable from either view. Server-side state like
Layout: it survives reloads and session restores, and outlives a
deleted session by a 30-day grace. The same directory also holds
**Attachments**, which are not session images: the gallery lists only
the `pasted-` and `displayed-` prefixes, so a document is never drawn
as a thumbnail.
_Avoid_: screenshots (images need not come from pastes)

**Attachment**:
A file carried by one message in the **Text view** — a photo or a
document, referenced by its absolute path in the prompt, which is what
Claude reads. Up to 25MB it joins the session's store directory under a
`file-` prefix and rides the same 30-day grace as **Session images**;
larger, it stays a 7-day transfer ephemeron in /tmp and carries no chip.
Before sending it is a removable chip in the composer's **tray**; after
sending it is drawn where its path stands in the message. An attachment
whose bytes nothing can serve — another user's store, outside the
caller's home, swept — shows its path instead.
The upload happens when the file is attached in a live **Composer**, and
on send in the **New-session composer**, which has no session to upload
into until Enter creates one.
_Avoid_: upload (names the act, not the thing), image (a document is
one too)

**Tray**:
The strip of pending Attachments above the composer's input, with the
unsent message text its other half. Both persist per (session, browser)
so a reload or an evicted tab does not lose a half-written message. In
the **New-session composer** only the text persists: its files are still
`File` objects in the tab, which JSON cannot carry, so a reloaded tab
shows the prose with an empty tray.
_Avoid_: attachment bar, dropzone (the drop target is the whole window)

### Skills

Managed from the **Skills** overlay — its own dialog off the shell bar, beside
Settings — backed by `skills-api`
(`docs/adr/0011-skills-move-between-users-by-copy.md`). It began as a group
inside Settings and moved out on 2026-08-19: the lists are long enough that they
need a tab each.

**Skill**:
A named bundle of instructions a Claude session can invoke, usually a directory
containing a `SKILL.md`. Most live under a user's `~/.claude/skills/` and belong
to exactly one OS user, who a second user gets a copy from by **installing** it;
a **bundled** skill ships with the CLI and belongs to nobody, so it is invoked
the same way but is not on disk under that path and cannot be installed, edited
or removed. A skill may carry more than prose — scripts, agents, templates —
which is why installing one is an act of trust.

Invoking a skill INJECTS its whole `SKILL.md` into the transcript, at that
moment rather than at session start: 364 loads across this box's transcripts,
median 3.1 kB and up to 23.3 kB, which the text view collapses to a card naming
the skill (`sessionio/skill.go`).
_Avoid_: plugin (that is the marketplace-installed kind, see below), command

**Plugin**:
A marketplace-installed bundle (`<name>@<marketplace>`) cached under
`~/.claude/plugins/cache/`, which may ship skills, commands, agents and hooks
under its own namespace. Listed beside skills in the Skills settings group, and
switched on and off through the same `enabledPlugins` key, but never copied
between users.
_Avoid_: skill, extension

**Install** (a skill):
Copying another user's skill into your own `~/.claude/skills/<name>` as a real
directory, recording where it came from and the source's hash in
`.manager.json`. Always initiated by the recipient. A copy, so it never changes
under you: divergence later shows as **update available** (the owner's changed)
or **locally modified** (yours has).
_Avoid_: sync, share, push

**Disable** (a skill or plugin):
Setting `enabledPlugins["<id>"] = false` in the user's `~/.claude/settings.json`
so new sessions stop loading it, while the files stay on disk.
_Avoid_: uninstall, turn off

**Edit** (a skill):
Writing your own `~/.claude/skills/<name>/SKILL.md` back from the panel, in the
row that lists it. Only ever your own: a peer's skill can be read there, and
**install** is what makes one yours to change. New sessions read the change;
running ones keep the text they loaded.
_Avoid_: update (that one takes the owner's newer copy)

**Remove** (a skill):
Copying the directory to `.backup/<name>-<timestamp>/` and deleting it. The row
goes; the bytes do not. Recoverable by hand.
_Avoid_: delete, uninstall

**Delete** (a skill):
The permanent one: the directory, **every backup of it**, its enabled state and
its provenance. Nothing is left to recover from. A symlinked entry loses the
link only — what it points at belongs to whatever put it there.
_Avoid_: remove (that one keeps a copy)

**Uninstall** (a plugin):
`claude plugin uninstall <id>` — the CLI drops the `installed_plugins.json`
entry and the `enabledPlugins` key, then marks the cached files `.orphaned_at`
rather than deleting them; the manager reclaims those afterwards, since `claude
plugin prune` only covers auto-installed dependencies. Re-installable from its
marketplace, so it is less final than a skill **delete**.
_Avoid_: remove, delete

### The text view

**Prompt field**:
The surface a prompt is written on: multi-line, Enter to send and Shift+Enter
for a newline, `/` and `@` completion, an attachment **tray**, and an unsent
draft kept per browser. One component, mounted by both composers.
_Avoid_: input box, message box

**Composer**:
The prompt field for a LIVE Session, with the things that only mean something
once there is a session to talk to around it — the permission panel, the
prompts Claude has queued, the permission-mode chip, the context meter and
Stop.
_Avoid_: chat box, prompt bar

**New-session composer**:
The prompt field for a session that does not exist yet, shown wherever nothing
is selected and on a phone as the landing view. You type what you want to do,
press Enter, and the session is created with your text as its first prompt.
Four choices sit under it: which **project** it lands in, which command runs,
which model, and how hard it thinks. Choosing a plain shell turns it back into
a name box, because a shell has no prompt to receive.
_Avoid_: create row, new-session form, session wizard

**First prompt**:
What the **New-session composer** sends to a session it has just created: the
message, and nothing else. It carried a `/model` line ahead of the message
until 2026-09-06; the model and the effort are now flags on the process the
attach starts, so they cost no round trip and leave no command in a
conversation nobody has begun. It waits for the
session to be READY rather than merely reachable — a session tmux has made
accepts input for seconds before the Claude in its pane is ready to read any,
and text sent into that window is dropped with `POST /prompt` still answering
204. The wait happens server-side, where the evidence is: `POST /prompt` takes
an `awaitReady` flag and holds the injection until the pane draws Claude's own
prompt character and holds still, answering 503 until then. The retry ladder
carries the retries, and its last rung asks for no wait, so a pane that never
draws one still gets the text.
_Avoid_: initial message, seed prompt

**Text view**:
The structured rendering of a Session, read from its Claude Code transcript
rather than its pty — the other of the two views the session bar switches
between. It renders the same conversation the Terminal view shows live, as a
foldable timeline with a composer. Not a second session and not a second
Claude.
_Avoid_: chat view, console view, text mode (the mode is the switch's state,
the view is the thing rendered)

**Item type**:
What a tool call *did*, independent of which tool did it: `file_read`,
`file_change`, `command_execution`, `web_search`, `image_view`,
`mcp_tool_call`, `skill`, `dynamic_tool_call`. Every tool is classified into one
on the way to the renderer, so the view never branches on a tool's name.
_Avoid_: tool kind, category

**Work log**:
The stream of things a turn *did* — tool calls, approvals, thinking, errors —
kept separate from the turn's message text and merged with it only at render.
Each entry carries a **tone** (`info` / `tool` / `approval` / `error`).
_Avoid_: activity feed, events (Event is the wire type)

**Working row**:
The live row standing for a turn in flight: the tool currently running, an
elapsed timer, and the step count so far. It exists only while a turn is
unsettled, and is what the view shows in place of streaming text.

**Blocking prompt**:
Something the CLI is waiting on a human for, which the transcript does not
report while it is pending — a permission prompt, or an `AskUserQuestion`
menu. The text view mirrors it as a card and answers it by injecting keys into
the pty (ADR-0010). Distinct from **Session state** *awaiting input*, which is
the sidebar's coarser signal that some prompt exists.

### T3 interoperability

**Thread**:
T3 Code's unit of conversation, the counterpart of a Session. A
*bridged* thread is backed by one Session; a thread of any other
provider is not, and never appears in the lobby.
_Avoid_: session, chat, conversation

**T3 workspace**:
T3's own grouping: a title plus one absolute **workspace root**, at most
one active workspace per root. Not a lobby Project — it has no members,
no attach mode and no co-ownership, and its root is mandatory where a
Project's directory is optional.
_Avoid_: t3 project (ambiguous against Project)

**Bridge**:
The binary T3 spawns in place of `claude`. It runs as the OS user who
owns the T3 instance, speaks the Agent SDK's stdio protocol upward, and
downward attaches to a Session rather than starting a Claude of its own —
so a bridged thread and its Session are one conversation in one process.
_Avoid_: adapter, proxy, shim

**Syncer**:
The per-user reconciler that keeps a user's Threads in step with their
Sessions: adopting new ones, following renames, and carrying destruction
across in both directions.
_Avoid_: sync daemon, mirror

**Adoption**:
Making an existing Session visible in T3 as a Thread. The Session keeps
running throughout — adoption creates a view, never a second Claude.
_Avoid_: import, migration

**Warm-up**:
The sentinel turn the Syncer dispatches at adoption. It exists only to
make T3 spawn the Bridge, since nothing else can put content into a
Thread; the Bridge recognises it and never passes it to the Session.

**Kill**:
Deliberate destruction of a Session by a person, which crosses to the
other surface: killing in the lobby archives the Thread, deleting the
Thread kills the Session. A process merely *exiting* — OOM, a reboot, a
reaped Bridge — is not a kill and crosses nothing.
_Avoid_: stop, end, close

**Data used**:
What Terminal Lobby cost a **device** in **wire bytes** over a period — today,
the last 7 days, this calendar month, last calendar month, and **Since** —
split into five feature **buckets** and across the **networks** the bytes
crossed. Per browser profile,
never per account: every tab on a device adds into one figure. Read in Settings; the counter runs whether or not
diagnostics are being sent, because it never leaves the browser.
_Avoid_: bandwidth, traffic, network usage (each ambiguous between what
travelled and what the app received)

**Network**:
One operator's network as the server names it from the address a request
arrived over: `lan` for anything that reached the internal ingress without
crossing the public internet, `as8374` for a resolved operator, an opaque digest
when the lookup fails. Keyed by ASN, so two hotels on the same operator are one
row. Carries a **label** and a registered country — registration, not location:
it says where the AS is registered, not where the device is. Named, never
categorised: whether an operator is WiFi or cellular is not knowable from its
name, so the panel shows the name and the reader supplies the rest.
_Avoid_: ISP, carrier (either may be both), connection type, SSID (never visible
to the browser)

**Unknown network**:
**Wire bytes** counted while no fresh answer was available — a backgrounded tab,
mostly, since the poll that carries the answer is parked while a tab is hidden
and the counter deliberately is not. Stops growing the moment someone looks at
the tab again. In the totals and in no named network.
_Avoid_: unattributed (that reads as a mistake rather than a bounded gap)

**Earlier**:
**Wire bytes** counted before any of this was measured, lifted from an older
schema. Never grows, and ages out with everything else.
_Avoid_: legacy, historic

**Since**:
The one period whose start a person sets, by resetting it. Sits alongside today,
the last 7 days and the two calendar months, and carries the same **network**
rows as any of them. Resetting it leaves every other figure standing; **Reset
counters** is the separate control that discards all history.
_Avoid_: trip, session

**Wire bytes**:
Bytes that actually crossed the link, after compression. Distinct from what the
browser hands the application, which for the two compressed streams — the
terminal WebSocket and the Text view's SSE — is the inflated form and can be
more than an order of magnitude larger. A **measured** figure comes from
`transferSize`; a **modelled** one comes from the mirror and is marked as such
wherever it is shown.
_Avoid_: raw bytes, actual bytes

**Bucket**:
One of the five parts Data used is split into — Terminal, App code, Text view,
Files & images, API. Named after a feature someone could change rather than
after an endpoint, because the breakdown exists to be acted on. Every request
lands in exactly one, decided from its path.
_Avoid_: category, class

**Mirror**:
The estimator behind a **modelled** figure: the same bytes fed through the same
compression the server used, in parallel with the application, so a stream the
browser inflates before anything can measure it still has a **wire bytes**
number. An estimate by construction — it reproduces the server's algorithm, not
its exact state.
_Avoid_: shadow, proxy

### Agent spend

What the agents inside the sessions cost, read in Settings and in one figure
beside the gear
(`docs/adr/0023-agent-spend-via-a-statusline-wrapper.md`, design in
`docs/plans/2026-09-06-agent-spend-panel-design.md`). The words below are close
enough to **Data used** to be worth keeping apart deliberately, so each entry
says which side it is on.

**Agent spend**:
What one OS user's Claude Code and Codex conversations have consumed over a
period, kept server-side in `/var/lib/tmux-api/spend/<user>.json` and served by
`GET /agent-spend`. Distinct from **Data used** in every respect worth naming:
that is **wire bytes** a browser moved, counted per browser profile and never
leaving the device; this is what the agents themselves cost, counted per OS
user, and it follows the person to any browser they sign in from. The two tools
are kept apart all the way down, because Claude Code reports dollars and a
ChatGPT plan reports none.
_Avoid_: usage (taken: **Data used** owns it, and Codex's rollout spends the
same word on tokens alone, in `total_token_usage`), cost tracking, billing
(nothing here bills anyone). The ban is on what a person reads and on new
names. The recording path was built under the vendor's own word for the slot it
sits in and keeps it, so `devvm/tl-usage-record`, `POST /hooks/usage`,
`TL_USAGE_ENDPOINT` and `@tl_usage_cost` all say "usage" and all mean spend.
Renaming them would mean changing the managed-settings entry in the infra repo
in the same breath, so they stand — grep for `usage` and expect both meanings.

**Spend**:
Dollars, and only for Claude Code, which computes `total_cost_usd` itself and
hands it to the **Recorder** on every render. Never derived here: pricing
tokens ourselves would mean a rate table with no signal when it went stale.
A Codex session has no spend figure at all, so its rows carry tokens and stop
there.
_Avoid_: cost (fine in prose, but the field a person reads is spend), price

**Limit window**:
One rate-limit window a vendor reports: how much of it is gone as a percentage,
and when it resets. Codex reports up to two on every turn and labels each from
the length it declares, which is where **5-hour limit** and **weekly limit**
come from; a rollout may carry only one. Claude Code reports `five_hour`,
`seven_day` and `spend_limit` only for a Claude.ai seat or a gateway carrying a
spend limit, so an enterprise seat shows spend and no windows. A window whose
reset has already passed describes a window that no longer exists, so it is
dropped rather than shown as current. Each vendor's own words are the labels,
because the person reading them will meet the same words in the CLI.
_Avoid_: quota, allowance, subscription (taken: a **subscription** in this repo
is the Web Push registration on the Notifications page, which has nothing to do
with a vendor's limits)

**Plan**:
The vendor account tier a tool reports for itself, such as ChatGPT `plus` from
a Codex rollout. Shown as a fact beside the limits, next to the **credit
balance** when the account has one, and read from nowhere but the tool's own
output.
_Avoid_: subscription (see **Limit window**), tier, seat (Claude's word for it,
which the panel never has to print)

**Recorder**:
`devvm/tl-usage-record`, which sits in Claude Code's statusLine slot, posts the
payload to `POST /hooks/usage` and then runs whatever statusLine the user
already had with the same JSON on stdin. It is the only place the CLI hands out
its own cost arithmetic. Everything it does on the recording side is a silent
no-op on failure and runs in a background subshell, because a statusline that
breaks somebody's prompt is worse than no feature. Codex has no counterpart and
needs none: its rollout files already carry what the panel reads.
_Avoid_: hook (no hook payload carries cost, which is the whole reason this
exists), agent, collector

**Reading**:
One statusLine payload as recorded: the conversation's RUNNING TOTAL, not a
turn's delta. So a write REPLACES that session's row and moves the day's total
by the difference, and a dropped post costs nothing as long as a later one
lands.
_Avoid_: sample, event, tick

**Day rollup**:
The per-day total a **reading** rolls its difference into. The rollups are the
complete record, which is what lets **All time** be answered from the days
alone; the session rows are the detail view of the last 30 days.
_Avoid_: aggregate, bucket (taken: a **bucket** is one of Data used's five
features)

**Retired row**:
A session row past the 30-day window. It keeps the conversation's id and its
running totals and loses its name and model, and the page stops listing it. The
totals are why it stays: the next **reading** from that conversation is
differenced against them, and a row that had been deleted outright would make a
resumed conversation contribute its whole history to the day it came back. The
row cap (2,000, retired rows included) is the one place a baseline is dropped
for good.
_Avoid_: expired, archived, tombstone (nothing here marks a deletion)

### Release

How a commit becomes the code running on the devvm
(`docs/adr/0013-the-box-installs-the-lobby-nobody-ships-it.md`, design in
`docs/plans/2026-08-29-iac-native-deployment-design.md`). Designed 2026-08-29;
the vocabulary below describes the target, and the three deploy scripts hold the
ground until it lands.

**Package**:
The unit of release: a Debian package built by GitHub Actions and installed by
`apt` on the devvm. `terminal-lobby` carries the whole application — the Go
services, the SPA, the helper scripts and the units — at one
**version**, which is what makes frontend/backend skew unreachable. It
deliberately carries NO identity data: the sudo grant, the user map and the
admin list belong to whoever owns the accounts on that box. `ttyd-devvm` and `viu` are separate packages because they are slow
to build and rarely change.
_Avoid_: build, artefact, release bundle

**Version**:
The semver a release is known by, cut automatically by `svu` from conventional
commits and pushed back to Forgejo as a `vX.Y.Z` tag. Monotonic by construction,
which is what lets the box track latest with no pin. Distinct from a **stamp**,
which identifies an artefact's content rather than a release.
_Avoid_: build id (that is `__TL_BUILD__`), tag (ambiguous against a push tag)

**Stamp**:
An artefact's own identity, independent of its **version**: `__TL_BUILD__` (the
git SHA, provenance) and `__TL_ASSET__` (a fingerprint of the artefact's
unstamped content plus `frontend/diag.js`, which decides whether an open tab
self-updates — ADR-0007, ADR-0008). One per surface. Computed at build time
rather than deploy time.
_Avoid_: hash, fingerprint on its own (say which one)

**Trigger**:
The push that tells the box a new **version** exists — GitHub Actions to the
Woodpecker API to one SSH forced command. It carries no bytes; the package
itself still arrives over `apt`. A dropped trigger leaves the box stale, which
is what the divergence alert watches for.
_Avoid_: deploy, webhook

**Reconcile**:
What the box does when triggered: install changed files, restart only the units
whose bytes actually moved, then verify. The only writer of application state on
the box, which is what serialises releases without anyone coordinating.
_Avoid_: deploy, sync

**Verify**:
The smoke tests `postinst` runs after installing — `/health` per service, an
unauthenticated request to each authed surface that must answer `401`,
`/whoami`, the public assets. Its result is exported to Prometheus. A failure
triggers the **hold**.
_Avoid_: healthcheck (that is the per-service endpoint), test

**Hold**:
The automatic brake: on a failed **verify**, the box reinstalls the previous
package from apt's cache and marks it held, so the next **trigger** cannot
re-break it. An emergency mechanism, not a workflow — the normal way back is
fix-forward, because the box tracks latest and a hand-run downgrade is undone by
the next push.
_Avoid_: rollback (that names the outcome, and the normal rollback is a new
version), pin

**Identity header**:
The request header carrying the authenticated username, named by
`TL_AUTH_HEADER` and set by whatever reverse proxy sits in front. Its NAME is
configuration; its presence is what proves a request came through that proxy.
The services never trust one a client supplies directly — in the container,
nginx sets it and discards any that arrives.
_Avoid_: the Authentik header (Authentik is one proxy among several since
2026-08-29), auth header (it carries identity, not authorisation)

**Proxy secret**:
The optional shared secret in `X-TL-Proxy-Secret`, compared in constant time.
When set, a request without it is refused BEFORE the identity header is read, so
an unauthenticated caller never reaches identity resolution. Unset — the default
— means the check is off and anything that can reach the ports may assert any
identity.
_Avoid_: API key, token (it authenticates the proxy, not a user or a client)

**Single-user mode**:
One account, and it is whoever the services run as. No user map, no sudo, no
ACLs: the same-user fast path applies to every request, so the privilege layer
is never entered. The default for a fresh install and the only mode the
container runs. **Share**, **member** and the act-as switch are absent rather
than empty, because there is nobody else to be.
_Avoid_: solo mode, personal mode

**Multi-user mode**:
Several people, kernel-isolated per Unix user, reached by `sudo -u`. Turned on
by `TL_MULTI_USER`, whose `auto` default means "a user map exists". This is what
**share**, **project** membership and **lens** are for.
_Avoid_: shared mode (that names sharing a session, which is a **share**),
team mode
