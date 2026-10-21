# T3 Code renders a session through its own protocol

Status: accepted; first cut released in terminal-lobby 0.125.2 (2026-10-12).

> [!NOTE]
> [ADR-0045](0045-t3-apps-are-clients-of-lobby-sessions.md) (2026-10-21)
> extends this record to T3's own web, desktop and phone apps, and changes
> three of its decisions once built: the T3 view is offered to every user, the
> pin follows T3's latest stable through a daily CI check, and the sidecar is
> served at `t3.viktorbarzin.me`.

Viktor, 2026-10-12: *"I'm keen on reusing t3 code into my terminal lobby,
especially the text mode. Theo is putting a lot of work into making t3 code and
I'd like to build on top instead of reinventing the wheel."*

The Text view follows T3 Code's design but contains none of its code, so each
improvement T3 ships is ported by hand. T3's components cannot be imported into
another app: nothing but the server bundle is published, and the chat UI is
wired into T3's own stores. T3's whole web client, though, connects to any
server that speaks its WebSocket protocol, which is how app.t3.codes works.

Design, the grilling decisions, the challenger changes and what the build
changed: [T3 view](../plans/2026-10-12-t3-view-design.md). What the real
client asks of its server, and the build recipe:
[`t3-view/TRACE.md`](../../t3-view/TRACE.md).

## What we decided

| Question | Decision |
|---|---|
| How T3's UI reaches the lobby | An unmodified T3 web build from a pinned tag (`v0.0.46-nightly.20261011.2994`, protocol v2), iframed into the session pane as a third view: Terminal · Text · T3. At most one T3 frame per tab |
| What it talks to | `tl-t3-view`, a Node/TS sidecar on port 7690 that implements T3's protocol v2 on top of T3's own `packages/contracts`, and translates to session-events and tmux-api |
| What runs behind a thread | The same interactive Claude Code in tmux the terminal shows, through the mod. T3 never spawns a Claude |
| How a session is named to T3 | By a rename-proof key (`bornAs`, else the first-seen name plus tmux's session id), which the sidecar maps to the session's current name before every call |
| Patches to T3 | One embed patch: under `?embed` it hides T3's chrome, forwards the key chords the lobby lists, and reports route changes, over a versioned `postMessage` contract ([`t3-view/EMBED.md`](../../t3-view/EMBED.md)) |
| Where it is served | Its own origin, `t3view.viktorbarzin.me`, behind the lobby's forward-auth and proxy-secret middleware, framable by the lobby's origin only |
| As whom the sidecar acts | The browser's user. It checks every request through tmux-api `/whoami` without holding the proxy secret, and relays the identity header and secret on every lobby call |
| What the lobby gained for it | session-events names the tool call on every dialog and can hold a prompt until the turn ends without steering it (`{wait: true}`); tmux-api's claim can place a session in a project |
| Who sees it | Admins, while Viktor compares it with the Solid Text view; the Solid view stays the default and takes bug fixes only |
| How it is built | T3's web client in its own CI workflow, keyed by pin and patch digest; the sidecar bundled against the pinned checkout's lockfile; both shipped in the lobby's deb |
| Upstream | The pin moves to a new stable release when Viktor asks |

## Why the protocol and not the components

The protocol is the seam T3 itself uses between independently versioned
clients and servers, and it is typed in a package the sidecar can import, so a
contract change breaks the sidecar's build rather than a person's screen. A fork
of the web app would carry patches in the files that change most (153 commits
to `MessagesTimeline.tsx` in 60 days). Running real T3 next to the lobby with an
agent that attaches to tmux would bring back the thread-list sync that ADR-0029
removed.

ADR-0009's point about integrating with software that upgrades nightly still
holds, and it shapes this record too: use a seam the vendor maintains, pin it,
and move the pin on purpose.

## Consequences

- The lobby carries an adapter for a protocol it does not control. A stable
  bump can be small (no contract changes between v0.0.44 and v0.0.45) or large
  (the v2 orchestrator, +9.8k / −3.1k lines in `packages/contracts`). The
  sidecar stubs all 193 RPCs by name, so a bump that adds or removes one fails
  the typecheck or a test.
- The sidecar's tests run on SSE captures of real lobby sessions with semantic
  checks ported from T3's testkit. T3's own fixtures are Claude Agent SDK
  frames and cannot be fed through the sidecar.
- Two text renderers exist until Viktor decides between them. The design lists
  the must-haves the T3 view reaches before that decision comes up, with the
  last live check against each.
- Guests, public links, pi and codex stay on the Solid view.
- A new hostname, ingress, AdminNetworkPolicy port and firewall rule join the
  terminal stack, and the deb gains a Node service built from T3's source in
  CI. Its health check is advisory, so a broken T3 view does not hold lobby
  deploys.
- T3's own server, `t3-serve@` and `t3-dispatch`, are untouched; this design
  does not use them.
