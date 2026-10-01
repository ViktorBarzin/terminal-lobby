# Each session gets its own browser, started on first use

Viktor, 2026-10-01: *"any time a session uses a browser, we should be able to
see the live browser in the session."* Seeing a session's browser needs the
lobby to know which browser belongs to which session. The shared per-user
`playwright-mcp@<user>` server cannot say: Claude Code sends a plain HTTP MCP
server no session identifier, and its idle connections drop, so mapping sockets
to processes found 2 of 19 sessions on 2026-10-01.

We decided that each Claude session runs its own browser. Its `playwright` MCP
server is `tl-browser`, a small Go launcher over stdio. It answers Claude's
handshake and tool list from a cache, and starts a Node host on the first
browser tool call. The host runs playwright-mcp through `createConnection`
and owns the Chrome. Because the launcher is Claude's child, it inherits
`TMUX_PANE`, so the session is known exactly rather than inferred.

Design: [See the browser a session is driving](../plans/2026-10-01-session-browser-design.md).

## Considered options

| Option | Why not |
|---|---|
| Keep the shared server and match URLs the hooks see against open pages | Two sessions on the same site are indistinguishable |
| A per-user router that starts one backend per pane, with a headers helper tagging requests | Exact, but a new long-running service per user. The launcher reaches the same exactness with no service |
| playwright-mcp per session over stdio, started eagerly | 141 MB resident before Chrome starts, measured. About 4 GB across the 29 Claude processes running on 2026-10-01, with 9 GB available and swap full |
| Embed Playwright's built-in dashboard for viewing | Lists every context rather than one session's, has its own UI, and lives in a 1.61 alpha's internals |

## Consequences

- The browser is a per-session process tree, not a system service, so the
  limits that used to come from `system-playwright\x2dmcp.slice` now come from a
  per-browser `systemd-run --user` scope inside a per-user `tl-browser.slice`.
  `playwright-reaper` watches that slice as well.
- The host pins `@playwright/mcp` and ships with the lobby package, so a
  playwright-mcp upgrade is a lobby release, not a unit file edit in infra.
- Sessions started before the switch keep the shared server until they
  restart, because Claude reads `~/.claude.json` only at start.
- A session that never browses costs a few MB. One that browses pays for Node
  and Chrome until the agent calls `browser_close` or the browser has been
  frozen for 2 hours.
- A `homelab browser` pool run is shown through the same host in attach mode,
  so the lobby has one viewer for both. The pool stays the browser for sites
  that block headless Chrome, not every session's default: it has 6 workers for
  the cluster and a 1-hour limit per pod.
