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
A user-defined named folder in the sidebar that groups sessions.
Created and deleted deliberately (explicit CRUD) and may sit empty.
Purely organizational — no directory semantics, no launcher behavior.
A session belongs to at most one project.
_Avoid_: group, folder, workspace

**Ungrouped**:
The implicit area of the sidebar holding sessions assigned to no
project. Collapsible and reorderable like a project — it occupies a
movable slot among the projects (default: top) — but not a project:
it cannot be renamed or deleted, and it hides while empty (keeping
its slot).
_Avoid_: default project, inbox

**Assignment**:
The session→project mapping. Server-side per-user state owned by
tmux-api, so it follows the user across devices and survives tmux
server crashes and restores.

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
