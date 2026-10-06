# A public link attaches through a ticket and a grant

Viktor, 2026-10-06: *"i want to create public urls which i can share to users
that are not signed in. we can share in both read only or read write mode."*

Every other way into a session starts from an identity the proxy vouches for:
the identity header names an account, the account is in the user map, and a
share or ownership decides the rest. A public link has none of that. Whoever
holds the URL attaches, so the URL is the credential, and the path from it to a
tmux client is the first one on this box that an anonymous request can walk.

Design and the grilling decisions:
[Public links](../plans/2026-10-06-public-links-design.md).

## What we decided

| Question | Decision |
|---|---|
| What the URL carries | A 128-bit token in the fragment (`/s/#<token>`), so no request line or access log holds it |
| What is stored | The token's SHA-256 only, in `/var/lib/tmux-api/links.json` |
| What reaches ttyd | A single-use ticket, minted by `POST /link/redeem`, valid 30 s |
| Who serves it | Two ttyd instances with no `-H`: `ttyd-link-ro` (:7692, `/s`, no `-W`) and `ttyd-link-rw` (:7693, `/s/rw`, `-W`) |
| As whom they run | `tl-link`, a system account whose only sudo grant is `tmux-link-join` as any user but root |
| How the attach happens | Ticket → `/internal/link-attach` → grant → `sudo -u <owner> tmux-link-join <grant>` → `/internal/link-join` → `tmux attach-session [-r] -t '$N'` |
| What a link is pinned to | tmux's `session_id` and `session_created` together |

## Why two ttyd instances

A read-only tmux client still runs keys bound to `switch-client`, and the
default bindings include `prefix (` and `prefix )`. A watcher attached with
`-r` through a ttyd started with `-W` could therefore press the prefix and
move to the owner's other sessions. Both design reviewers reproduced it on
tmux 3.4. ttyd without `-W` drops every input frame before it reaches the pty,
which closes it at the layer below tmux, so read-only links are served only by
the instance that takes no input. tmux-api refuses a ticket on the instance
that does not match its link's mode.

The same gap exists for read-only named Shares, which attach through the
lobby's ttyd with `-W`. This ADR does not change that path.

## Why a ticket and a grant

The ttyd instances take connections from the internet, so the account they run
as is the one an attacker would hold after a bug in ttyd or libwebsockets. The
lobby's ttyd runs as the service account, which on this box has sudo to every
account, so running the link servers there would make that bug a root
compromise.

`tl-link` holds no credential of its own. Its script spends the visitor's
ticket and receives a grant. The grant is single use, valid 15 s, and bound to
the owner and the tty, and the only thing `tl-link` may run as another account
is `tmux-link-join`. That wrapper spends the grant from inside the owner's
account and attaches only the target tmux-api names. An attacker controlling
`tl-link` would still need a live link token for every attach.

## Why session_id and session_created

A session name is freed when the session dies and taken by the next session
with the same title, so a name is not an identity. `session_id` alone is not
one either: tmux numbers sessions from `$0` again after a server restart. The
pair is unique for the life of the box. Named Shares moved to the same pair in
the same change, which closes a gap where a grant outlived its session and
passed to the next session with that name.

## What it costs

- Two more long-running ttyd processes and a system account.
- A link dies with its session. A session restored from a snapshot gets a new
  `session_id`, so links and named Shares on it have to be made again.
- The visitor page's chunks are served under `/s/assets/` without sign-in,
  which makes the lobby's own chunks fetchable too. They are application code
  and carry no user data.
- tmux-api keeps tickets and grants in memory. A restart drops them, and the
  visitor page redeems again on its next connect. Visitor records are written
  to `/var/lib/tmux-api/link-visitors.json`, so a revoke after a restart can
  still detach them.
