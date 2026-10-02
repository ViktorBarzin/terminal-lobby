# terminal-lobby Claude mod

A Claude Code mod (a plugin of function hooks, Claude Code 2.1.287 or newer)
that reports a Claude session to terminal-lobby's session-events and carries
the lobby's actions back into the session. The design and the wire protocol
are in [ADR-0036](../docs/adr/0036-claude-speaks-to-the-lobby-through-a-mod.md).

What it does, in short:

- Sends every stored conversation row, tool results, turn starts and ends,
  streamed text deltas (coalesced to about 50 ms), prompts, model changes and
  the agent list to `POST /mod/v1/events`, one request in flight at a time.
- Long-polls `GET /mod/v1/poll` for commands: send a prompt, abort the turn,
  answer an AskUserQuestion, approve or reject a plan or a permission, switch
  the model, resend history.
- Holds plan approvals and permission prompts in `tool.check` and draws its own
  Approve / Reject dialog, raced against the web answer. A web answer takes the
  terminal dialog off the screen.
- Stays inert in a non-interactive session (`claude -p`) and outside tmux.

## Layout

| path | what |
|---|---|
| `hooks/register.ts` | wires Claude Code events to the logic |
| `hooks/lib/link.ts` | hello, the events sender and the command poll, with injected I/O |
| `hooks/lib/queue.ts` | the outgoing queue: delta merging and the cap |
| `hooks/lib/shape.ts` | event shaping, media stripping, dialog text, answer shapes, backoff |
| `hooks/lib/pending.ts` | dialogs waiting on a web answer |
| `test/*.test.ts` | unit tests for `hooks/lib` |

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
node --test test/*.test.ts        # unit tests (Node 24 runs .ts directly)
claude plugin validate .          # manifest and hooks module, as the engine reads them
```

Type-checking needs the engine's declarations, which Claude Code writes to
`.claude-plugin/types/` the first time it loads the mod (that folder is
git-ignored). After one load, `tsc -p tsconfig.json` with TypeScript 5.4 or
newer checks `hooks/`.
