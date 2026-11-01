// Package t3client is how tmux-api and agent-api talk to each user's own
// `t3 serve`, through T3's documented MCP endpoint and nothing else
// (docs/plans/2026-10-31-t3-hosts-claude-design.md, ADR-0046).
//
// A Locator finds a user's server: the loopback port, the environment id and
// the public host. Credentials hold one long-lived MCP token per user, made
// headlessly from a t3-mint pairing code and renewed after 20 days or on a
// 401. A Client speaks MCP streamable HTTP in JSON mode over both.
package t3client
