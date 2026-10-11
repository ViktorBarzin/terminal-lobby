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
| Who may reach another account's session | One check: a share row, or project membership at the project's attach mode, or admin act-as |
| Who calls it | tmux-api for the terminal attach, kill and rename; session-events for Text view reads and `/prompt` |
| Mode needed | ro to read the conversation; rw to send, answer, rename or kill |
| As whom the guest's actions run | The owner, as the terminal attach does today |
| Sharing onward | Refused for a guest, whatever their mode |
| Read-only tmux clients | Cannot reach `switch-client`; the default bindings are wrapped in `if-shell` in `/etc/tmux.conf` |

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

## Why wrap switch-client

tmux enforces read-only per server, not per session, and lets a read-only
client run `switch-client` bindings. A watch guest could move into the owner's
other sessions with `prefix (` or `prefix )`. ADR-0039 noted the gap and closed
it for links by dropping input below tmux. Named Shares go through the lobby's
read-write ttyd, so the fix sits in tmux instead. A binding whose command is
`if-shell` is refused for a read-only client and runs normally for a read-write
one. Tested on tmux 3.4 on 2026-10-11.

## What it costs

- session-events gains an owner parameter on its read and prompt routes and a
  loopback call to tmux-api on every request that names another owner.
- Project members get the composer and Text view along with the terminal. A
  project shared with attach mode rw now means co-driving through every
  surface.
- The tmux fix applies at each server's next start unless the deploy sources
  the file into running servers. A user's own `~/.tmux.conf` can rebind the
  keys and reopen the gap for their sessions.
- Prompts typed into the terminal cannot be attributed. Only composer sends
  carry a sender.
