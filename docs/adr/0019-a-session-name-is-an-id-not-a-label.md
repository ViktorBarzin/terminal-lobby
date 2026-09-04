# A session name is an id, not a label

Session titles (2026-08-16) made the tmux name a derived value: you typed a
title, the name was slugged from it, and the name was re-derived on every
retitle so `tmux ls` stayed legible from a shell. That worked because retitling
was a deliberate, occasional act.

Prompt-first sessions (`docs/plans/2026-09-04-prompt-first-sessions-design.md`)
removes the moment where a person types a title at all. The title now arrives
from Claude Code's own conversation summary, seconds after the first prompt. A
derived name would then move on its own, with nobody watching, and every
consequence of a rename would become an ordinary background event rather than
something a person asked for.

## What we decided

**A session's name is an opaque id, minted in the browser at creation, and it
never changes.** Everything a person reads is the title.

The id is 12 characters of base32. Seven independent copies of
`^[a-zA-Z0-9_-]{1,32}$` validate session names — `tmux-api`, `clipboard-upload`,
`t3-sync`, `skills-api`, the frontend's `NAME_RE`, `slug/`, and
`tmux-attach.sh` — and 12 characters satisfies all of them unchanged.

Minting it in the browser preserves a property the lobby protects deliberately:
creating a session reaches no server. The name goes straight into
`?arg=<id>` → `tmux new-session -A -s <id>`, so creation still works while
`tmux-api` is down.

Every session live at the migration is renamed to an id in the same change,
through `rename_cascade.go`, with its old name stamped as its `@title`. One
identity model, not two.

## Considered options

- **Keep deriving the name from the title.** Every summary that landed would
  rename a live session: six stores to carry, a collision to resolve with nobody
  to ask, an iframe re-navigation seconds into the first turn, and a fresh
  instance of the phantom-session trap where a tab holding a stale name
  reconnects through `tmux new-session -A` and creates it as an empty session.
- **A separate `@sid` option, keeping human names on tmux.** The URL, selection
  and per-browser records key off the id while `tmux ls` stays readable. It
  keeps most of the benefit, and it keeps two identifiers for one session
  permanently, which is the thing that made the original design expensive.
- **`#{session_id}` as the stable id.** tmux's own `$0`, `$1` already rides in
  every row and survives a rename (`tmux-api/main.go:135`). It does not survive
  a tmux server restart, and the restore path recreates sessions and already
  renames them to `<name>-<HHMM>` on a clash (`titles.go:196`), so it cannot be
  the durable identity.
- **Ids for new sessions only.** No disruption to anything running, and the
  rename machinery stays alive for as long as any named session does — 17 days
  and counting for the oldest one on this box.

## Consequences

- `tmux ls` from a shell becomes a machine listing. A `tls` alias
  (`tmux ls -F '#{session_name}  #{@title}'`) ships in
  `infra/playbooks/devvm.yml` for every user, and plain `tmux ls` still works.
  This is the main cost of the decision, and it is the property the 2026-08-16
  design was protecting.
- The machinery that existed to move a name retires: the `slug` package and its
  Go/TypeScript mirror with `vectors.json`, `nameForTitle`, `fallbackName`,
  `session-N`, the collision toast, the derived-name hint, and
  `followRenamedSelection`. `rename_cascade.go` stays for the migration and for
  restore's collision path.
- Retitling becomes `POST /sessions/{name}/title` for every caller. The rename
  half of `PATCH /sessions/{name}` has no callers left.
- The phantom-session trap closes rather than being defended against: with no
  renames, there is no stale name for a reconnecting tab to hold.
- A session id appears in URLs, push tags, log lines and the image store path.
  None of those were readable before either, but the id is now what someone
  quotes when reporting a problem, so it is worth showing in the UI somewhere
  copyable.

## What this does not do

The id is not a security boundary. Session names have never been secret — they
are visible to anyone who can list the owner's tmux server — and authorization
still comes from the share store and the owner check, not from the id being hard
to guess. A 60-bit id is chosen against accidental collision, not against
enumeration.

Ids do not survive a session being killed and recreated. A restored session keeps
its id because the name is what `tmux-persist` restores; a session someone kills
and starts again is a new session with a new id, as it was with names.
