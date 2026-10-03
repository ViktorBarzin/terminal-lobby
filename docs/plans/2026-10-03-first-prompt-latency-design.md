# First prompt latency

Viktor, 2026-10-03: *"once i send a prompt, it takes quite a while to get it
passed to the terminal - why is it so slow. let's review and redesign it so
that it's faster"*. Viktor sees 5 to 10 seconds from Send in the **New-session
composer** to the prompt showing up, on desktop and on the phone.

## What we measured

Each new session's start (the `tmux-user-attach` journal) was joined with
session-events' record of the prompt reaching Claude (`claude.prompt_sent`),
for 2026-09-26 to 2026-10-03, creates that claimed a **pre-warm slot** only:

| first prompt path | n | median | p90 | over 5s |
|---|---|---|---|---|
| typed into the pane, before 2026-10-02 | 26 | 0.9s | 1.9s | 1 |
| through the **Lobby mod**, since 2026-10-02 | 24 | 2.75s | 16.2s | 9 |

The pool itself works well: 50 of 58 Claude creates claimed a slot (86%). The
time goes after the claim.

## Why

Since ADR-0036, a Claude session takes its prompts through its Lobby mod, and
the mod is addressed by the tmux session's **name**. A pre-warm slot's Claude
says hello under the slot's name. Claiming the slot renames the session, so the
first prompt arrives under a name no mod has said hello with yet.

1. **The prompt route waits for a hello nothing has asked for.**
   `servePromptViaMod` waits up to 4s for a hello under the new name. The mod
   only says hello again at a turn start, a refused request, or its own retry
   backoff (1s doubling to 30s). `modHub.follow` already asks the mod to
   reconnect under a new name, and the event stream and agent-api use it, but
   the prompt route does not yet. When a Text view happened to open first, the
   prompt landed in 1.2s; otherwise it waited, up to 23s.
2. **Slots for longer paths never connect.** The mod's hello accepts session
   names of up to 64 characters. The slot name for `~/code/terminal-lobby` is
   69, so that slot's mod said no hello in any of 141 warm-ups, and the
   prompt waited for its backoff after the claim. The older the slot at claim
   time, the longer that backoff had grown: 1.3 to 2.8s for a slot under 10s
   old, 8 to 23s for one 17 to 50s old.
3. **The browser waits 700ms before its first try**, even for a warm slot. The
   rung dates from when the server could not hold a request for a session that
   did not exist yet. It can now, and before 2026-10-02 this wait was most of
   the 0.9s median.

## What we decided

| decision | choice | why |
|---|---|---|
| scope | the three causes, plus telling the mod its new name at claim time | small, and removes the wait rather than shortening it |
| what signals a claim | `tmux-user-attach` posts to session-events right after the rename | the claim script is the one actor that knows the moment; same localhost and peer-credential gates as `/hooks/usage` |
| fallback | the prompt route asks the mod to follow a rename itself | covers a claim signal that was lost, and any rename the signal does not cover |
| long slot names | the mod's hello accepts them | slot names are long on purpose, so the lobby can never address one |
| first try | immediately; the server holds it | the server's hold already covers a session that does not exist yet |
| targets, warm slot, p90 | **Accepted** under 1s, **Shown** under 2s | Claude's own record takes 0.6 to 1.2s after acceptance, which the lobby does not control |
| measuring | one event per first prompt with both durations from the Send press | a regression like 2026-10-02 shows up in Loki the day it ships |
| alerting | none | Viktor's call |
| out of scope | pool misses (14% of creates, ~3s of Claude's own boot); addressing the mod by pane instead of name | |

## The flow

```mermaid
sequenceDiagram
    participant B as Browser
    participant A as attach
    participant E as events
    participant M as Mod

    Note over E,M: warm, hello under slot name
    B->>A: attach ?arg=id
    A->>A: rename slot to id, 9ms
    A-)E: POST /hooks/claimed
    E->>M: revoke token
    M->>E: hello under id
    B->>E: POST /prompt, no wait
    Note over E: hold for the mod
    E->>M: prompt
    M-->>E: ack (Accepted)
    E-->>B: 204
    M->>E: prompt row (Shown)
    E->>E: emit prompt.landed
```

Here `attach` is `tmux-user-attach`, `events` is session-events, and `Mod` is
the Lobby mod inside the slot's Claude. The claim post and the first POST race. Either order works: when the POST comes
first it waits for the hello, and when nothing asked the mod to follow, the
prompt route asks itself.

## Measuring both moments

The browser sees **Accepted** (its POST returns) but cannot see **Shown** unless
a Text view happens to be open. session-events sees both, through the mod. So
the browser sends, with the first prompt only, how long ago Send was pressed
and whether the page was hidden since. session-events adds what it measures
from the request's arrival, and emits one `prompt.landed` event when the row
appears. The name and attributes are the ones the journey telemetry design
(2026-09-12) set out for this question: `tl.session`, `tl.first` (true),
`tl.post_ms` (Send to **Accepted**), `tl.settle_ms` (Send to **Shown**), `tl.n`
(the prompt's length), plus `tl.hidden`. That design emits from the browser; the
first-prompt arm emits from session-events instead, because after a create the
browser usually has no Text view open to see the row. Each part is measured on
one clock. What it leaves out is the request's one-way trip to the server: a
few milliseconds on the house network, half a round trip on a phone's link.

## Verification

- Create sessions from the composer on `terminal.viktorbarzin.me` on desktop,
  on the shared Android emulator, and on the iPhone through `homelab ios`, and
  watch the prompt appear.
- Read `prompt.landed` back from Loki for creates in `~/code` and in
  `~/code/terminal-lobby`, including one claimed from a slot that has been warm
  for over a minute.

## Phase 1 result

Deployed in 0.98.4 at 16:40. The first create through it, at 16:45, read
`prompt.landed` Send to **Accepted** 1,020ms and Send to **Shown** 1,675ms, against
a 2.75s median and 16.2s p90 to the prompt reaching Claude before. Timed hop by
hop from the journal: the claim landed 606ms after Send, the mod said hello under
the new name 249ms after that, and Claude accepted 165ms later.

## Phase 2: slow networks, and claiming at Send

Viktor then added: *"also now it's quite bad, especially on slow networks"*.

The prompt itself leaves the browser one round trip after Send, but it cannot
land before the claim, and the claim waited for the browser's terminal: about
five round trips in sequence on a slow link.

| step before the claim | round trips | iPhone, 7 days |
|---|---|---|
| layout save, awaited before the session opened | 1 | `/api/sessions/layout` slow (≥1.5s) 93 times, p50 3.3s |
| terminal code (phones skip the prefetch) | 1 + 83 KB | |
| `GET /token` | 1 | slow 55 times, p50 2.7s, p90 11.4s |
| WebSocket open | 2-3 | handshake p50 560ms, p90 1.2s (n=831) |

After the claim there is a fixed ~415ms to Accepted and ~1,070ms to Shown, so
Shown under 2s needs the claim within about 900ms of Send. On a phone only a
claim that does not wait for the WebSocket reaches that.

### What we decided

| decision | choice | why |
|---|---|---|
| where the claim happens | also at Send, through tmux-api `POST /sessions/claim`; the attach keeps its own | takes the terminal off the prompt's path; the atomic rename settles the race; a create still works with tmux-api down |
| how it claims | `tmux-user-attach` in a claim-only mode, a sixth argument `claim` | the script's rules and stamps stay in one place; sudo's `env_reset` would strip a variable |
| what it claims for | Claude, no model or effort, a minted id, the user's own project dir or home | what a warm slot can be |
| act-as | refused | an administrator acting as someone never creates their sessions |
| the size | the claim carries the device's last terminal size; tmux-api resizes the window and unsets `window-size` | the first reply wraps to the screen it is read on, with no lasting pin |
| a tab that never attaches | the prompt runs anyway | Viktor: that is what Send means |
| the layout save | no longer awaited before the session opens | it was a round trip in front of the attach |
| duplicate prompts | each first-prompt line carries a request id; session-events sends each id once, joins a retry to the attempt under way, remembers a 504 and forgets 502/503/404 | the browser gives up at 8s while the server may take 4s + 10s, and a request it gave up on left its command queued for the mod |

Two blind challenger reviews ran against the first draft. Both agreed on the
direction and changed four things in it: the claim moved from session-events to
tmux-api and from the prompt request to its own request (so attachments do not
hold it back), the mode became an argument rather than an environment variable,
act-as is refused, and the size is set before the prompt. One reviewer would
have shipped the browser-only changes first and measured; the other measured
that only the claim reaches the phone targets. The ADR is
`docs/adr/0038-a-new-sessions-slot-is-claimed-at-send.md`.

## Phase 2 result

Deployed in 0.99.0 at 17:46 and checked through the deployed SPA, on desktop and
on the shared Android emulator behind a shaped link (+150ms each way, 1 Mbit/s).

| create | claim | prompt accepted, browser | terminal WebSocket open | `prompt.landed` Accepted / Shown |
|---|---|---|---|---|
| desktop | 89ms after Send, answered at 232ms | 577ms | 154ms | 552 / 803ms |
| phone, slow link, terminal code not cached | 606ms after the tap | 1,534ms | 4,474ms | 655 / 899ms |
| phone, slow link, cached | 523ms after the tap | 1,828ms | 1,970ms | 980 / 1,648ms |

In all three the claim at Send won the rename, 343ms to 1.7s before the browser's
attach, and the attach found the session already there. The phone's session
was 47x18 with no `window-size` pin. On the first phone create the terminal did
not open its WebSocket until 4.5s after the tap; before this change the prompt
could not land until after that. The 520-600ms between the synthetic tap and the
first request comes before the composer's Send handler runs: the Send-to-request
time it reported was about 13ms. It is likely the emulator turning a touch into
a click, and it falls outside `prompt.landed`.

## Open questions

- The 0.6 to 1.2s for Claude's own record is from a measurement on 2026-08-18.
  The new event will show whether that still holds on the current Claude Code.
- A first prompt that is itself a slash command may never produce a row, so its
  event never fires. Pending marks expire after two minutes.
- The size a claim carries is the last one this device drew. A device that has
  never shown a terminal sends none, and its first reply wraps at 80 columns
  until the attach.
- The iPhone could not be checked on 2026-10-03: the rig's Mac did not answer
  ssh. Phone checks ran on the shared Android emulator with a shaped link, so
  real Safari on a real mobile network is still unmeasured; `prompt.landed`
  will show it from the next creates on Viktor's phone.
