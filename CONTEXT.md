# Terminal Lobby

Web tmux sessions gated by Authentik, isolated per OS user, at
`terminal.viktorbarzin.me`. This context covers the lobby UI, the
tmux-api, and the devvm-side session plumbing.

## Language

**Session**:
One tmux session belonging to one OS user, listed in the sidebar and
rendered in the terminal pane. Usually runs a Claude Code conversation, but
may be a plain shell. Carries a **name** and, optionally, a **title**.
_Avoid_: terminal, tab, thread

**Name** (of a session):
The tmux session name: `^[a-zA-Z0-9_-]{1,32}$`. The identity everything is
keyed by — tmux targets, URL segments, store keys, the session-images
directory, the `?arg=` attach contract, the push tag. **Derived from the
title, never typed directly**, and re-derived whenever the title changes.
Unique within one OS user's tmux server, so a cross-user reference needs
the owner too.
_Avoid_: slug in anything a user reads (it is the right word in code)

**Title**:
The arbitrary display text a person chose for a session — spaces,
punctuation, emoji, any script, up to 64 characters. What every surface
shows: sidebar cards, the tab title, the command palette, the dock, push
bodies, confirmations. Stored on the session itself (the `@title` tmux
option), so everyone who can see the session sees the same title, and a
durable copy re-stamps it after a restore. Optional — a session without one
shows its **name**, which is where every session predating the feature
sits. Clearing the title returns a session to showing its name.
_Avoid_: label, nickname, display name; and do not confuse with **pane
title**, which is whatever is running in the pane describing itself.

**Project**:
A first-class, server-owned object with a stable **id**, a **name**, an
optional **directory** (base cwd for sessions created in it), a **member**
set (OS users), a blanket session-**attach mode** (ro/rw), and a
**co-owned** flag. Multi-owner: it groups sessions from several members and
appears in every member's sidebar. Governance is co-equal — any member may
rename, re-dir, add/remove members, set the mode, or delete it (delete
dissolves the grouping, never kills sessions). Lives in the global project
store, not any one user's layout. A session belongs to at most one project.
_Avoid_: group, folder, workspace

**Member**:
An OS user belonging to a project. Sees all its sessions, may add their own,
and (co-equal) may edit it.

**Owner** (of a session):
The OS user whose uid the session's process tree runs as — exactly one per
session. A foreign session (owner ≠ the viewer) is attach-only.

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

**Grid**:
The size of a session's tmux window, in columns and rows. Owned exclusively by
its **read-write** clients: a Watch-mode client consumes the Grid and never
changes it, including when no read-write client is attached at all. Enforced by
pinning (`window-size manual` plus hooks that re-derive the size from the live
client list), applied on the first read-only attach and never reverted.
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
What the Claude conversation inside a session is doing: *running* (a
turn is in flight), *awaiting input* (Claude asked something and is
blocked on the user), or *completed* (turn finished, ready for the
next prompt). A session with no live Claude has no state.
_Avoid_: status, activity (tmux "activity" means terminal output, not
Claude turn state)

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
document, uploaded when it is attached and referenced by its absolute
path in the prompt, which is what Claude reads. Up to 25MB it joins the
session's store directory under a `file-` prefix and rides the same
30-day grace as **Session images**; larger, it stays a 7-day transfer
ephemeron in /tmp and carries no chip. Before sending it is a removable
chip in the composer's **tray**; after sending it is drawn where its
path stands in the message. An attachment whose bytes nothing can serve
— another user's store, outside the caller's home, swept — shows its
path instead.
_Avoid_: upload (names the act, not the thing), image (a document is
one too)

**Tray**:
The strip of pending Attachments above the composer's input, with the
unsent message text its other half. Both persist per (session, browser)
so a reload or an evicted tab does not lose a half-written message.
_Avoid_: attachment bar, dropzone (the drop target is the whole window)

### Skills

**Skill**:
A directory under a user's `~/.claude/skills/` containing a `SKILL.md`, loaded
by that user's Claude sessions at start. Belongs to exactly one OS user; a
second user gets it by **installing** a copy. May carry more than prose —
scripts, agents, templates — which is why installing one is an act of trust.
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
so new sessions stop loading it, while the files stay on disk. Distinct from
**remove**, which backs the directory up and deletes it.
_Avoid_: uninstall, turn off

### The text view

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
`mcp_tool_call`, `dynamic_tool_call`. Every tool is classified into one on the
way to the renderer, so the view never branches on a tool's name.
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
