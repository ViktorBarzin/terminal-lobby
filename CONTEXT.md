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
The session→project mapping. Server-side state owned by tmux-api in the
global project store (each project lists its member sessions as
`(owner, name)`), so it follows users across devices and survives tmux
crashes and restores. (Historically per-user layout state; migrated into the
global store on first run of the shared-projects feature.)

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
