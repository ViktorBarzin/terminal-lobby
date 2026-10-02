# Claude speaks to the lobby through a mod

Viktor, 2026-10-02: *"I think this opens the opportunity for massively
simplifying how terminal lobby handles events from Claude … the goal will be to
simplify how we handle Claude events, especially in text mode so that the
experience we have in text mode is better."*

Claude Code 2.1.287 (2026-10-01) ships **mods**: TypeScript function hooks that
run inside the Claude process and see its events as data. The lobby now learns
everything about a Claude session from one mod, `terminal-lobby@terminal-lobby`,
and acts on a session through the same mod. It replaces the transcript tail, the
state hooks, the session-start and question hooks, the pane watcher, and the key
drivers for dialogs.

pi and codex sessions are unchanged. Mods exist only in Claude Code.

## What it replaces

| Before | With the mod |
|---|---|
| Tail the transcript JSONL every 200 ms, through a privileged reader for other users' homes | The mod forwards every row as Claude stores it (`session.append`) |
| Whole messages only: a long answer appears at once | `turn.step` text and thinking deltas, coalesced to about 50 ms |
| Turn ends guessed from `stop_reason` and interrupt notices | `turn.start` / `turn.complete`, with `isAborted` |
| `claude-tmux-state` (849 lines of shell) stamping tmux options | session-events stamps the same options from mod events |
| `claude-se-hook session-start` binding a tmux session to a transcript | The mod's hello names its session id, pane and transcript |
| `claude-se-hook question` holding AskUserQuestion (ADR-0034) | The mod races the drawn dialog against the web answer |
| 2 s pane scrape for plan and permission dialogs | `tool.check` reports them before they draw |
| Key injection to approve a plan or a permission prompt | The mod draws its own dialog and races it against the web answer |
| Key injection to send a prompt or interrupt | `$.prompt.submit`, `$.turn.abort` |
| A nested `claude -p` firing hooks against its parent's pane | A non-interactive Claude's mod stays inert |

## Decisions

**Full replacement.** The mod is the only channel for a Claude session. History
after a reconnect comes from the mod too (`$.session.messages()`), not from
the transcript file. On-demand reads of large blobs that the wire never carries
(a truncated tool result, a picture) still open the transcript file by the row
id the mod reported, because those ids are the same in the file.

**session-events is the server, the mod is the client.** A mod cannot listen on
a socket. It POSTs events and long-polls for commands over loopback HTTP. Each
`$.http.fetch` is capped at 30 s by Claude Code, so a poll holds for 25 s.

**Plan approval and permission prompts are drawn by the mod.** Once Claude
draws its native menu, a mod has no handle on it. So when `tool.check` resolves
to `ask`, the mod draws its own Approve / Reject dialog with `$.ui.ask` and
races it against the web answer. The cost: approving a plan from either side
lands in Claude's default mode. The native menu's "accept edits" and "clear
context" choices are not reachable from a mod.

**AskUserQuestion keeps Claude's own dialog.** `tool.call` races `next(e)`,
which draws the native menu, against the web answer. When the web wins, the mod
returns `{result: {questions, answers, annotations}}` and Claude takes the menu
down.

**Only interactive sessions talk.** `session.start` carries `isInteractive`. A
nested `claude -p` loads the mod too, with its parent's `TMUX_PANE`, so the mod
does nothing at all when the session is not interactive.

**Rollout restarts sessions that are safe to restart.** A session that started
before the mod existed has no event stream. session-events restarts it with
`claude --resume <id>` once it is safe: Claude idle, no background work, an empty
input line, and no dialog up. Busy sessions are restarted the next time they are
safe.

## Facts this rests on

Measured on 2.1.287 on this box, 2026-10-02:

- A user-tier mod cannot hook `classic.*` events here: the managed settings seat
  `cc-plugin-sec-default` outermost and it bypasses them. Everything below uses
  `tool.call`, `tool.check`, `turn.*`, `session.*` and `prompt.submit`, which
  fire normally.
- Text deltas arrive one to three words at a time, 20 to 30 ms apart. A loopback
  POST from the mod lands in 2 to 5 ms.
- `$.prompt.submit` starts a turn at once when idle and queues behind a running
  turn.
- `$.turn.abort` stops the turn cleanly; `turn.complete` fires with
  `isAborted: true`.
- `tool.call` sees AskUserQuestion's questions before the dialog draws. A
  `{result}` returned while the dialog is up takes it down.
- `tool.check` resolves to `ask` for ExitPlanMode and for a tool that needs
  permission. Holding it keeps Claude's menu off the screen. `allow` approves,
  `deny` with a reason rejects and passes the reason to the model.
- `$.session.id()`, `TMUX` and `TMUX_PANE` identify the session.

## Wire protocol (version 1)

All routes are on session-events' loopback listener and refuse anything that is
not loopback.

### `POST /mod/v1/hello`

Identifies the caller by peer credentials (the OS account that opened the
socket), the way the hook routes do.

```json
{"sid": "uuid", "pane": "%12", "tmux": "/tmp/tmux-1000/default,123,0",
 "session": "tmux-session-name", "cwd": "/home/u/code", "transcript": "/home/u/.claude/projects/-home-u-code/uuid.jsonl",
 "model": "claude-opus-5-5", "version": "2.1.287", "mod": "0.1.0"}
```

Answer: `{"token": "…", "history": true|false}`. The token authenticates every
later call for this sid. `history: true` asks the mod to send what the session
already holds, because session-events has no log for it (it restarted, or this
is a resumed conversation).

### `POST /mod/v1/events`

`{"token": "…", "events": [ … ]}`. One request in flight per session, so events
arrive in order. Every event has `type` and `t` (epoch ms).

| type | fields | from |
|---|---|---|
| `history` | `messages` (as `$.session.messages()` returns them), `running` (a main-thread turn is in flight) | answer to hello |
| `row` | `uuid`, `door`, `origin`, `agentId?`, `message` {`type`, `name?`, `role?`, `isMeta?`, `content`} | `session.append` |
| `result` | `toolId`, `tool`, `agentId?`, `result`, `text`, `isError?` | `tool.call` after `next` |
| `turn_start` | `turnId`, `agentId?`, `text?` | `turn.start` |
| `delta` | `turnId`, `agentId?`, `step` (the request in the turn), `index` (the block in the response), `kind` (`text`/`thinking`), `text` | `turn.step` |
| `turn_end` | `turnId`, `agentId?`, `aborted`, `answer?`, `usage?`, `durationMs?` | `turn.complete` |
| `prompt` | `text`, `origin` | `prompt.submit` |
| `ask` | `toolId`, `questions` | `tool.call` on AskUserQuestion |
| `plan` | `toolId`, `plan`, `planFilePath?` | `tool.check` on ExitPlanMode resolving to `ask` |
| `permission` | `toolId`, `tool`, `input`, `reason?` | `tool.check` resolving to `ask` |
| `settled` | `toolId`, `by` (`terminal`/`web`/`gone`) | a dialog closed |
| `model` | `model`, `effort?` | `turn.step`, when it changes |
| `agents` | `agents` (as `$.agent.list()` returns them) | after every `turn_end` |
| `ack` | `id`, `ok`, `error?` | a command finished |
| `bye` | `reason` | `session.end` |

Answer: `204`, or `409` when the token is unknown (session-events restarted),
which sends the mod back to hello.

### `GET /mod/v1/poll?token=…`

Held for up to 25 s. Answer: `{"commands": [ … ]}`, possibly empty.

| op | fields | the mod does |
|---|---|---|
| `prompt` | `id`, `text` | `$.prompt.submit({text, asUser: true})` |
| `abort` | `id` | `$.turn.abort` on the running main-thread turn |
| `answer` | `id`, `toolId`, `answers` or `chat`, `annotations?` | resolves AskUserQuestion with `{result}`, or with `{deny: chat}` for "Chat about this" |
| `decide` | `id`, `toolId`, `decision` (`allow`/`deny`), `reason?` | resolves a held `tool.check` |
| `model` | `id`, `model`, `effort?` | `$.command.run({command: "model", args})`, then `effort` |
| `history` | `id` | sends a fresh `history` event |

Every command is answered with an `ack` event.

## Consequences
- `claude-tmux-state` and `claude-se-hook` leave Claude's managed hooks, except
  SessionEnd, which keeps `claude-tmux-state clear`: it records a deliberate
  exit for tl-session-watch, which nothing in the mod can write for another
  user. pi still calls `claude-tmux-state` from its extension, so the script
  stays installed.
- The permission-mode chip still walks Shift+Tab through the pane. The spike
  measured `$.config.set({key: "permissionMode"})` writing only the default for
  new sessions and leaving the live mode alone.
- The model chip still drives Claude's `/model` picker through the pane. The
  mod's `model` command works, but `/model` asks Claude's own "Switch model?"
  once a conversation is cached, which only the terminal can answer, so the
  route does not use it.
- Prompts sent from the web show in the pane as "Prompt from the terminal-lobby
  plugin" followed by the text, and a prompt sent mid-turn waits for the turn to
  end instead of being folded into it. Stop does not hand queued prompts back:
  no mod API takes them off Claude's queue.
- If session-events is down, the mod keeps retrying hello with backoff and
  Claude itself is unaffected; what happened meanwhile is delivered in order
  once it is back.
- Mods were served off by a rollout switch for some Claude processes on this
  box even on 2.1.287 (measured 2026-10-02 by the mod's live test), and loaded
  once `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` was in Claude's environment. The
  managed settings set it.
- A reload of the mod can take a module away with a command in hand. A newer
  hello supersedes the older token, whose polls are refused, and commands that
  were handed out but never acked go to the module that says hello next. The
  mod ignores a command id it has already run.
- Pressing Esc on the mod's own dialog lets Claude draw its native prompt, which
  the web cannot answer; the card goes away and the terminal answers it.
- agent-api still reads and answers dialogs through the pane, so sessionio keeps
  the pane parsers and key drivers for it. On a session with the mod it meets
  the mod's Allow / Deny or plan dialog, which is drawn as a question, and can
  answer it as one. Moving agent-api onto the mod is a separate change.

## What the live test settled

- `$.ui.ask` can be taken down. It runs as an AskUserQuestion tool call that
  passes through the mod's own `tool.call` hook, so the mod races its own
  dialog and returns the web's answer as the result. The dialog leaves the
  screen at once.

## Open questions

- How a mod built against 2.1.287's types behaves on the next Claude release;
  the API is marked as moving between releases.
- Whether subagent events render well in the Text view: the wire carries them
  and the unit tests cover them, but the live test did not run a subagent.
  the API is marked as moving between releases.
