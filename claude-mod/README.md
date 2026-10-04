# terminal-lobby Claude mod

A Claude Code mod (a plugin of function hooks, Claude Code 2.1.287 or newer)
that reports a Claude session to terminal-lobby's session-events and carries
the lobby's actions back into the session. The design and the wire protocol
are in [ADR-0036](../docs/adr/0036-claude-speaks-to-the-lobby-through-a-mod.md).

What it does, in short:

- Sends every stored conversation row, tool results, turn starts and ends,
  streamed text deltas (coalesced to about 50 ms), prompts and model changes
  to `POST /mod/v1/events`, one request in flight at a time.
- Sends a `level` snapshot (main turn running, compacting, the main thread's
  tool, the agents, the dialogs open, the last reply and notice) after every hello, on every turn edge,
  dialog settle, Agent call and compaction, and every 30 s, so session-events
  writes the tmux options from what the mod knows now rather than from edges
  it may have missed. The engine's agent list names subagents and teammates
  only; workflow runs are added from the Workflow tool's result until a task
  notification names them (`hooks/lib/level.ts`). The classic Stop and
  SubagentStop hooks never reach a mod on this box (measured 2026-10-04).
- Keeps the main turn, the open dialogs and the workflow runs in `$.state`
  (`hooks/state.d.ts`), which a hot reload keeps.
- Says hello only while the listener on session-events' port is root's
  (`hooks/lib/listener.ts`, the session-events.socket unit), unless
  `TL_MOD_URL` names another server.
- Long-polls `GET /mod/v1/poll` for commands: send a prompt, abort the turn,
  answer an AskUserQuestion, approve (with words for Claude) or reject a plan
  or a permission, message a subagent. A prompt that fails after its ack is
  reported as `command_failed`.
- Holds plan approvals and permission prompts in `tool.check` and draws its own
  Approve / Reject dialog, raced against the web answer. A web answer takes the
  terminal dialog off the screen.
- Asks haiku for a short title on the first prompt the lobby sends into a fresh
  conversation, and sends it as a `summary` event. Claude Code titles only
  prompts somebody typed.
- Stays inert in a non-interactive session (`claude -p`) and outside tmux.

## Layout

| path | what |
|---|---|
| `hooks/register.ts` | wires Claude Code events to the logic |
| `hooks/state.d.ts` | the types contract: what the mod keeps in `$.state` |
| `hooks/lib/wire.ts` | the wire's event types, mirroring Go's json tags; `MOD_VERSION` |
| `hooks/lib/link.ts` | hello, the events sender and the command poll, with injected I/O |
| `hooks/lib/queue.ts` | the outgoing queue: delta merging, one level, and the cap |
| `hooks/lib/level.ts` | the main turn, tool, compaction, open dialogs and workflow runs, as the `level` event sends them |
| `hooks/lib/dialogs.ts` | the terminal-versus-web races for questions, plans and permissions; one hold per tool call |
| `hooks/lib/commands.ts` | the poll's commands, their acks and `command_failed` |
| `hooks/lib/lifecycle.ts` | what `session.end` means for the link (`/clear` and resume keep it) |
| `hooks/lib/listener.ts` | whether root holds session-events' port |
| `hooks/lib/shape.ts` | event shaping, media stripping, dialog text, answer shapes, backoff |
| `hooks/lib/pending.ts` | dialogs waiting on a web answer |
| `hooks/lib/stamp.ts` | whether session-events has been told where the transcript is |
| `hooks/lib/summary.ts` | the title request for a lobby-started conversation, and reading the reply |
| `hooks/lib/command.ts` | whether a lobby prompt is a slash command to run rather than text to submit |
| `test/*.test.ts` | unit tests for `hooks/lib`; `test/wire.test.ts` checks the events against `testdata/mod-wire/` |

## Loading it for a dev session

```sh
claude --plugin-dir claude-mod
```

`TL_MOD_URL` overrides the server address (default `http://127.0.0.1:7685`).
Claude Code reloads the module when a file in the folder changes.

If the debug log says hooks modules are "turned off for installed plugins in
this process: the rollout switch served off", start Claude with
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in its environment.

## Tests and checks

```sh
cd claude-mod
npm test                          # unit tests (Node 24 runs .ts directly, no install)
claude plugin validate .          # manifest, types contract and hooks module, as the engine reads them
npm install && npm run typecheck  # tsc over hooks/ and test/
```

Type-checking needs Claude Code's plugin API declarations, which are Claude
Code's and are not kept in this repository. `npm run typecheck`
(`scripts/typecheck.ts`) takes the newest copy on the machine: the one Claude
Code lays in `.claude-plugin/types/` when it loads the mod from this folder,
or the plugin-authoring skill's under `/var/tmp/claude-<uid>/bundled-skills/`,
or the file `CLAUDE_CODE_TYPES` names. CI runs the unit tests only: Claude
Code writes the declarations only for a signed-in session, which CI has not.

Bump `MOD_VERSION` (`hooks/lib/wire.ts`) and the `version` in
`.claude-plugin/plugin.json` together whenever `hooks/` changes;
`test/version.test.ts` checks both against `origin/master`.
