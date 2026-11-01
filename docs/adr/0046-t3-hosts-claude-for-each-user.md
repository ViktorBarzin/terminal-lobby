# T3 hosts Claude for each user, and the lobby lists it

Status: accepted 2026-10-31. Supersedes
[ADR-0045](0045-t3-apps-are-clients-of-lobby-sessions.md) and the framed view
of [ADR-0044](0044-t3-code-renders-a-session-through-its-own-protocol.md).

Viktor, 2026-10-30: *"i think it'd be better to base my terminal lobby sessions
on top of t3 and use t3 as the main client."* Then: *"i'd be happy to fully
switch to T3's backend system for managing claude processes. but i want to be
able to manage my t3 sessions via the terminal ui as i do today."*

ADR-0045 made the lobby the only host and served its sessions to T3's apps
through `tl-t3-view`, a sidecar speaking T3's internal client protocol. That
protocol changed faster than the sidecar could follow, and T3 clients reached
none of T3's own features (worktrees, git, previews, orchestration tools,
other providers). This record reverses the direction: each user's own
`t3 serve` hosts the Claude sessions started in T3, and the lobby lists and
manages them over T3's documented MCP endpoint.

Design and the full decision list:
[T3 hosts Claude](../plans/2026-10-31-t3-hosts-claude-design.md).

## What we decided

| Question | Decision |
|---|---|
| Host | Each user's own `t3 serve` for T3 sessions; tmux for everything else |
| Users | Everyone from day 1. New starts Claude in T3 for wizard and in tmux for others by default, and either is one click away |
| Lobby | T3 threads in the same list with a T3 mark and status; start, rename, archive; open in a T3 tab or the T3 app |
| Seam | T3's `/mcp` only. No internal protocol |
| Hosts | `t3.viktorbarzin.me` for wizard, `t3-<user>.viktorbarzin.me` for others; Authentik admits only the owner on the web |
| Callers | Muse and the WhatsApp bot speak T3's MCP tools through agent-api's `/mcp` pass-through, which holds the T3 credential |
| Retired | `tl-t3-view`, the framed T3 view, device pairing in lobby Settings, `tl-t3-upstream-check` |

## Consequences

- T3 threads have no Terminal view, share links, guest drive, lobby push or
  spend panel.
- The lobby depends on T3's MCP tool names and shapes. T3 publishes no
  stability statement for them; the lobby counts its T3 calls and an alert
  fires when they keep failing.
- Each lobby service holds a full-access T3 token per user, renewed every 20
  days and visible in that user's T3 Settings > Access.
- Two stacks remain while anyone defaults to tmux, which ADR-0045 set out to
  avoid. Moving everyone is a change to one setting's default.
