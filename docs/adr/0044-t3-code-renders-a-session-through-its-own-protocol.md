# T3 Code renders a session through its own protocol

Viktor, 2026-10-12: *"I'm keen on reusing t3 code into my terminal lobby,
especially the text mode. Theo is putting a lot of work into making t3 code and
I'd like to build on top instead of reinventing the wheel."*

The Text view follows T3 Code's design but contains none of its code, so each
improvement T3 ships is ported by hand. T3's components cannot be imported into
another app: nothing but the server bundle is published, and the chat UI is
wired into T3's own stores. T3's whole web client, though, connects to any
server that speaks its WebSocket protocol, which is how app.t3.codes works.

Design and the grilling decisions:
[T3 view](../plans/2026-10-12-t3-view-design.md).

## What we decided

| Question | Decision |
|---|---|
| How T3's UI reaches the lobby | An unmodified T3 web build from a pinned tag, iframed into the session pane as a third view: Terminal · Text · T3 |
| What it talks to | `tl-t3-view`, a Node/TS sidecar that implements T3's protocol (v2) on top of T3's own `packages/contracts`, and translates to session-events and tmux-api |
| What runs behind a thread | The same interactive Claude Code in tmux the terminal shows, through the mod. T3 never spawns a Claude |
| Patches to T3 | One: `?embed` hides T3's sidebar and header and forwards Ctrl-J and Esc to the lobby |
| Where it is served | Its own origin, `t3view.viktorbarzin.me`, behind the lobby's forward-auth and proxy-secret middleware |
| As whom the sidecar acts | The browser's user: it relays the identity header and proxy secret on every call |
| Who sees it | Admins, while Viktor compares it with the Solid Text view; the Solid view stays the default and takes bug fixes only |
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
  (the v2 orchestrator, +9.8k / −3.1k lines in `packages/contracts`).
- Two text renderers exist until Viktor decides between them. The design lists
  the must-haves the T3 view reaches before that decision comes up.
- Guests, public links, pi and codex stay on the Solid view.
- A new hostname, ingress and firewall rule join the terminal stack, and the
  deb gains a Node service built from T3's source in CI.
- T3's own server, `t3-serve@` and `t3-dispatch`, are untouched; this design
  does not use them.
