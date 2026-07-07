# Sidebar layout is server-side state owned by tmux-api

Projects, session→project assignments, and all sidebar ordering live
in a per-user JSON file on the devvm managed by `tmux-api`
(`/var/lib/tmux-api/<osuser>.json`), exposed via a layout endpoint —
even though tmux-api was previously stateless and tmux itself can hold
per-session metadata.

## Considered Options

- **tmux session options** (`@project` on each session) — elegant
  (state rides the existing `list-sessions -F` call, dies with the
  session) but the tmux server is OOM-killed often enough on this box
  that a Restore button exists for it; options die with the server,
  and making them survive would couple this repo to infra's
  tmux-persist manifest format.
- **localStorage** (like the old drag-order) — per-browser: the lobby
  is used from desktop and phone (PWA), and grouping that doesn't roam
  across devices misses the point.

## Consequences

- Assignments are keyed by session name and are deliberately NOT
  pruned when a session dies outside the UI (OOM, CLI kill): a
  tmux-persist restore recreates sessions under the same names and
  they land back in their projects. Only an explicit UI kill removes
  the entry; a brand-new session reusing a dead name inherits its old
  project (move it if wrong).
- Layout mutations are whole-document PUTs, last-writer-wins — fine
  for single-user personal state, two concurrent tabs racing a drag is
  acceptable loss.
- Collapse state is explicitly NOT in the layout: it is a per-browser
  view preference (localStorage), so phone and desktop can fold
  differently.
