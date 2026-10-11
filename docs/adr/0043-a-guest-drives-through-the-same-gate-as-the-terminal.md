# A guest drives through the same gate as the terminal

Viktor, 2026-10-11: *"i want 2 users to be able to share a session live. the
goal is to enable both users to be able to type and view the session live."*

A named Share already lets a guest attach the owner's terminal, read-only or
read-write. The Text view and the composer were built for the owner alone:
session-events resolves a session under the caller's own account and sends a
prompt as the caller. A guest who opens a shared session therefore gets a
working terminal and an empty conversation.

Design and the grilling decisions:
[Shared driving](../plans/2026-10-11-shared-driving-design.md).

## What we decided

| Question | Decision |
|---|---|
| Who may reach another account's session | One check: a share row, or project membership (watch only), or admin act-as |
| Who calls it | tmux-api for the terminal attach, kill and rename; session-events for Text view reads and `/prompt` |
| Mode needed | ro to read the conversation; rw to send, answer, rename or kill |
| As whom the guest's actions run | The owner, as the terminal attach does today |
| Sharing onward | Refused for a guest, whatever their mode |
| Read-only tmux clients | Cannot reach `switch-client`, or `detach-client` with a flag: the defaults are wrapped in `if-shell` in `/etc/tmux.conf`, and every such binding in every table on each guest's watch attach, in the owner's running server |
| How a guest's request names the session | `?owner=<account>` on every session-events and `/sessions/{name}` route, the way an administrator's `?as=` names a target |
| Who is present, and what they type | A WebSocket per open tab, `GET /events/{session}/presence`, carrying the room and each person's live draft |
| Who sent a prompt | Recorded by session-events at `/prompt`, sent on the presence socket, matched to messages in the Text view |

## Why one check

The terminal path already decides access in `handleInternalAttach`. Writing a
second check in session-events would give two places to keep in step, and the
first copy already has a gap: it reads only the share store, so a project
member without a share row is refused the terminal. Moving the decision into
one function fixes that and makes the three paths agree by construction.

## Why the guest acts as the owner

A session runs under one uid. Running a guest's prompt as the guest would mean
a second process tree, a second transcript and a second set of credentials,
which is a different feature. A read-write Share has always meant "drive as
me", and the Share dialog says so at invite time.

## Why project membership only watches

Found by the review before release. Every member of a project may edit it, so
the project's attach mode is not the session owner's choice. Letting it grant
rw would have let any member make themselves a driver of another member's
sessions. Viktor chose watch-only membership over a per-session mode set by
each owner, which would have needed a new field and API.

## Why wrap switch-client

tmux enforces read-only per server, not per session, and lets a read-only
client run `switch-client` bindings. A watch guest could move into the owner's
other sessions with `prefix (` or `prefix )`. ADR-0039 noted the gap and closed
it for links by dropping input below tmux. Named Shares go through the lobby's
read-write ttyd, so the fix sits in tmux instead. A binding whose command is
`if-shell` is refused for a read-only client and runs normally for a read-write
one. Every binding that switches, in every table, is wrapped, not only tmux's
defaults: accounts add their own, and this box's oh-my-tmux binds `prefix
BTab` to `switch-client -l`. Tested on tmux 3.4 on 2026-10-11.

## What it costs

- session-events gains an owner parameter on its read and prompt routes and a
  loopback call to tmux-api on every request that names another owner.
- Project members watch every member's sessions in the project, through the
  terminal and the Text view. A project's attach mode no longer grants driving:
  projects are co-equal, any member may set the mode or add a member, and a
  project-wide rw would let one member drive another's session as them without
  that owner agreeing. Driving takes a share the owner made.
- A guest cannot attach files: the store is per account, and the owner's Claude
  cannot read the guest's.
- Each guest's watch attach rewrites the owner's switching bindings to
  if-shell form. They still work for the owner, and list-keys shows them
  wrapped.
- Prompts typed into the terminal cannot be attributed. Only composer sends
  carry a sender.
- A draft reaches everyone on the session as it is typed, including words the
  person deletes before sending. Viktor chose the live preview over a bare
  typing indicator on 2026-10-11.
- A guest's open streams ask tmux-api again every 5 seconds, so a removed guest
  can read for up to that long after the removal.
