# Terminal Lobby

Web tmux sessions gated by Authentik, isolated per OS user, at
`terminal.viktorbarzin.me`. This context covers the lobby UI, the
tmux-api, and the devvm-side session plumbing.

## Language

**Session**:
One named tmux session belonging to one OS user, listed in the sidebar
and rendered in the terminal pane. Usually runs a Claude Code
conversation, but may be a plain shell.
_Avoid_: terminal, tab, thread

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
not what a given client asked for. _Compare_: Watch mode.

**Watch mode**:
A client's own choice to attach read-only, so it observes without driving and
without moving the Grid. Three states — watch, drive, or **unset** — set from
the session bar or a sidebar card's `Attach as` menu. Unset resolves
automatically, joining as a viewer when the session already has a read-write
client (**driven**); that decision is taken once, when a view takes the session
on. Per (session, device), remembered in the browser and never sent to the
server as state — the desktop keeps driving while the phone
watches the same session. Applies to your own sessions as well as shared ones;
owning a session is what authorizes watching it. A client may only ever request
**at or below** its Attach mode, so asking to watch can never grant access.
_Avoid_: read-only mode (ambiguous against a share's `ro`), observer mode

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
🖼 gallery in the terminal view. Server-side state like Layout: it
survives reloads and session restores, and outlives a deleted session
by a 30-day grace. Non-image file drops are NOT session images (they
stay 7-day transfer ephemera in /tmp).
_Avoid_: screenshots, attachments (images need not come from pastes)

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
