# T3's apps are clients of lobby sessions

Status: accepted 2026-10-21. Stages 1 to 3 shipped the same day in terminal-lobby 0.128.0 and 0.129.0; the iPhone check and the retirement of `t3-serve` are still to come.

Viktor, 2026-10-20: *"let's try the t3 interoperability again. i think tmux
sessions are not needed anymore. it would be good to be able to see t3 sessions
in terminal lobby and vice versa. so i can try out different UIs for the same
work."* Then, when the design had grown a second host: *"can't we use 1 for
both? I'm worried we will end up maintaining multiple stacks without a good
reason."*

ADR-0044 made T3's web client a third view of a lobby session, inside the lobby
and for admins. This record takes the same arrangement to every T3 client: the
web app at `t3.viktorbarzin.me`, the desktop app and the phone app all connect
to `tl-t3-view` as their only server, for every lobby user. The lobby is the
only place a Claude runs. `t3-serve` stops hosting Claude and is retired.

Design and the full decision list:
[T3 everywhere](../plans/2026-10-21-t3-everywhere-design.md).

## What we decided

| Question | Decision |
|---|---|
| What a session is | One Claude conversation, hosted by the lobby. T3 is a UI over it, not a second host |
| Which clients | T3 web, desktop and phone, plus the lobby's own Terminal, Text and T3 views. All drive the same live process |
| Starting a session | Unchanged on either side. A thread started in any T3 client is a lobby session from its first prompt (ADR-0044 decision 21) |
| Where T3 is served | `t3.viktorbarzin.me`, one environment for all users. `t3view.viktorbarzin.me` keeps serving the sidecar until the iPhone check, so a rollback is one constant in the lobby, and becomes a redirect after it |
| How a T3 app proves who it is | A pairing code the lobby shows as a link and QR code. tmux-api mints the code, exchanges it for a bearer token and checks that token on every request. Tokens are listed and revocable in the lobby |
| Who gets it | Every lobby user. The T3 view stops being admin-only |
| Which sessions cross | Claude only. Codex, pi and plain shells stay in the lobby |
| T3's own controls | The patch hides what `tl-t3-view` does not serve, in full-page use as well as embedded |
| Upstream | Latest stable, checked daily in lobby CI. A release that fails the build or the recorded-session tests is held, and Slack #alerts names it |
| Notifications | T3 web and desktop raise their own from the live stream. Phones keep the lobby's push. T3's hosted relay is not used |
| T3's own server | `t3-serve@`, `t3-dispatch` and their helper units are retired through the devvm playbook; the last `~/.t3` backup is kept. `t3-afk` is unrelated and stays |

## Why one host

The first version of this design had two: T3-born threads ran under `t3 serve`
through the Agent SDK, and lobby sessions in tmux. Each side would have listed
and driven the other's through a different mechanism: the lobby mod watching
inside T3's Claude, T3's outside-agents MCP for sends, and `tl-t3-view` for the
other direction. Every one of those was buildable, and together they made two
stacks that each had to keep up with the other.

With one host, a T3 thread is a lobby session by construction. Nothing has to
list the other side's sessions, follow its renames or carry its kills, and the
lobby's Terminal and Text views work for every session T3 starts. The usage
data made it cheap to choose: Viktor's last T3 message was on 2026-09-19, 999
of his 1,013 T3 threads already ran through the ADR-0009 bridge (so they were
tmux sessions), and emo has 7 threads, the last from 2026-07-28.

It also removes a limit the current native-app route has. The phone app fetches
`/.well-known/t3/environment` before it holds any credential, and fails if the
environment id ever changes, so `t3-dispatch` cannot route a native client to
the right person's `t3 serve`; native access works for one user today
(`infra/stacks/t3code/main.tf`). A single multi-user server answers one
descriptor for everyone and tells users apart by their bearer token.

## The seam, and what it costs

T3 publishes no stable interface that lets an outside session appear live in its
own sidebar. Measured on 2026-10-20 against `v0.1.0`:

| Seam | Stability | Why it does not carry this on its own |
|---|---|---|
| ACP v1 | A versioned open standard | T3 imports an ACP session only when a person clicks Import, and it does not draw turns it did not start (`provider-acp/src/server/adapter.ts:4224`) |
| T3's outside-agents MCP | User docs, no stability statement | Creates and drives threads T3 runs; cannot mirror one it does not |
| T3's client protocol v2 | Internal docs, no stability statement | None: it is the protocol T3's own clients speak |

So `tl-t3-view` stays on the client protocol, as ADR-0044 chose. From the
October pin to `v0.1.0` the contracts moved +275/−20 lines, all additive, and
the methods `tl-t3-view` serves did not change. In the five days after `v0.1.0`
they moved +1,578/−3,083. The daily check and the hold are what keep a change
like that from reaching a person: the sidecar is typechecked against each new
release's contracts and tested over recorded lobby sessions before it ships.

## Consequences

- `tl-t3-view` gains T3's pairing and bearer routes (`/oauth/token`,
  `/api/auth/websocket-ticket`) and answers native clients on an
  Authentik-less route, so its own checks become the only gate on that route.
  tmux-api holds the tokens; the sidecar holds none.
- The lobby gains a "Connect T3" item and a token list.
- Already-paired T3 apps re-pair once, because the environment id changes when
  `t3.viktorbarzin.me` moves to `tl-t3-view`.
- T3 features the sidecar does not serve (its terminal panel, git and worktree
  actions, other providers) are no longer available from T3 clients. They were
  served by `t3 serve`, which is retired.
- Phone notifications from the T3 app itself are out of scope. They would need
  T3's hosted relay, a T3 Connect account per user, thread and project titles
  sent to T3 on every state change, and one hostname per user so the relay does
  not notify everyone linked to the environment.
- The infra repo changes in three places: the `t3code` stack's routes and
  probes, the devvm playbook's T3 units, and the k8s-portal pages that describe
  `t3.viktorbarzin.me` as a web terminal.

## What we did not do

**Two hosts.** Described above under "Why one host".

**A merged proxy.** `tl-t3-view` in front of `t3 serve`, forwarding T3 threads
and adding lobby sessions to the same environment. One pairing per client, but
the proxy would have to merge two snapshot and sequence streams on a protocol
it does not control.

**A provider binary again.** Real T3 with a thread per lobby session, backed by
an ACP agent that attaches to it, plus a list sync. That is ADR-0009's shape,
and ADR-0029 records what it cost to keep.

## Open questions

- The rollout is gated on clients this box can partly test. Web runs in a
  browser, desktop as the Linux AppImage under Xvfb, Android on the shared
  emulator from a GitHub release APK. The iPhone rig was down on 2026-10-20, so
  `t3-serve` is retired only after the iPhone app is checked there or by Viktor.
- How the sidecar names a bearer-authenticated user to session-events is
  settled during implementation planning (see the design's open questions).
