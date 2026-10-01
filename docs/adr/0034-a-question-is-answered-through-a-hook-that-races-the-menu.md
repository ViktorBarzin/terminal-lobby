# A question is answered through a hook that races the menu

Viktor, 2026-09-27: *"let's see how t3 code handles it and mirror the
behaviour. right now it's quite unstable."*

An `AskUserQuestion` is now answered as data rather than as keystrokes. A
Claude Code `PermissionRequest` hook, matched only on `AskUserQuestion`, hands
the question to `session-events` and waits. The question card sends the reader's
answers there, and the hook returns them to the CLI as
`{behavior: "allow", updatedInput: {questions, answers}}`. This is the same
payload T3 Code returns through the Agent SDK's `canUseTool` callback. The CLI
keeps drawing its own menu while the hook waits, so the pane and the card both
stay answerable and the first answer wins, as it did under ADR-0010.

This replaces ADR-0010's key injection for `AskUserQuestion` only. Plan
approvals and permission prompts keep key injection.

## Why now

Key injection means reading the pane to learn where the dialog is. Since the
2026-09-10 rework, 27 of 237 answers failed (11%): 10 `not-drawn`, 9
`no-dialog`, 8 `unverified`. The parser and the card took 22 commits in 17
days, roughly half of them for multi-select. The failure that prompted this was
a multi-select dialog taller than an 80x23 pane. The CLI cuts such a dialog off
at the top, so the question text never reaches `capture-pane`, and the card fell
back to showing the raw pane.

A hook receives the question as data, so none of that reading is needed.

## Why this hook and not the one ADR-0010 removed

ADR-0010 rejected a PreToolUse broker because it sat on every tool call for
every user, and its `"ask"` overrode the allowlist. The hook here differs in the
two ways that matter:

- A `matcher` of `AskUserQuestion` means the hook never runs for any other tool.
- `PermissionRequest` runs alongside the menu, not before it. A PreToolUse hook
  holds the menu back until it returns, which would take the terminal out of the
  race. Measured on Claude Code 2.1.283:

| Behaviour | PreToolUse | PermissionRequest |
|---|---|---|
| Menu drawn while the hook waits | no, a spinner instead | yes |
| Answers delivered by `allow` + `updatedInput` | yes | yes, and the menu closes |
| Fires in bypass mode | yes | yes |
| Terminal answers first | not possible | the terminal's answer wins, and the hook keeps running with its output ignored |
| Hook times out | the menu draws | the menu stays up |

## Consequences

- The hook is not killed when the terminal wins, so it has to notice by itself.
  `session-events` watches the transcript for the call's `tool_result` and
  releases the hook. The hook's stdin carries no `tool_use_id`, so the match is
  made on the session and the question text.
- `updatedInput` replaces the tool input rather than merging into it, so
  `questions` is echoed back unchanged. Answer keys must equal the question text
  exactly, since a mismatch reaches Claude as "The user did not answer the
  questions." Multi-select answers go as one `"A, B"` string, because an array
  reaches the model as `A,B` and the TUI draws no answer row for it.
- Claude accepts a partial answer map and treats the rest as skipped, so the
  card sends nothing until every question has an answer.
- "Chat about this" is a `deny` whose message is the reader's text.
- A question with no hold behind it (a session started before the hook was
  installed, or a hook that has timed out) cannot be answered from the card. The
  card says so and offers the terminal. The pane-reading answer path for
  `AskUserQuestion` is removed rather than kept as a fallback. `ParseDialog`
  stays for detection only, because the prompt guard and the mode dial ask it
  whether a question is on screen before they type anything.
- The hook ships in the managed settings (`infra/scripts/workstation/managed-settings.json`),
  so it reaches every user on the box at once.

## Amendment, 2026-10-01: several calls held at once

Viktor, 2026-10-01: *"there's still cases there text mode redirects to the
terminal - why? let's see how t3 code handles all cases and close the gap."*

From 27 September to 1 October, 202 `AskUserQuestion` calls were asked across
every user on the box. All of them outside the QA rigs under `/var/tmp` reached
a hook. The Terminal fallback came from a different place: Claude often asks two
or three calls in one assistant message when it grills, and Claude Code runs the
hook for each of them together while the terminal shows their menus one after
another. `session-events` kept one hold per session and let a newer call replace
the older, so the card answered the last call and the others could only be
answered in the terminal. On 1 October that happened in five rounds across two
sessions (`question.hold` outcome `replaced`, followed by `terminal` for the
call that was left).

T3 Code keeps every pending question by request id and shows the oldest first
(`derivePendingRequests`, `pendingUserInputs[0]` in `ChatView.tsx`). The lobby
now does the same:

- `session-events` holds every call a session asks, in the order the hooks
  arrived. The `held` event carries them all under `calls`, oldest first, and
  the oldest again under `questions` for a page loaded before this change.
- The card answers the oldest call and shows how many more are waiting. Once it
  is answered, or answered in the terminal, the next call takes its place.
- An answer names its call by its question texts (`call` in the answer request).
  A request without `call` goes to the call its answer keys belong to, and
  "Chat about this" without one declines the oldest.
- A call asked again with the same questions replaces the earlier hold. That is
  Claude Code re-asking after something else claimed the turn, and the earlier
  call never gets a result.
- `question.hold` records `tl.calls`, the number of calls the session held once
  this one was added.

A session started before the hook was installed does get its questions held:
Claude Code picks up the managed-settings hook without a restart. The `health`
session, whose Claude started on 22 September, asked 3 questions after
27 September and all 3 were held. The card's Terminal fallback stays for the
cases that remain: `session-events` unreachable for longer than the hook's
10-minute retry window, or a hold withdrawn while its menu is still up.

## Considered options

- **Fix the parser for clipped multi-select.** The narrowest change for the
  failure that prompted this. It keeps the coupling to the TUI's drawing, and
  that coupling has been where the failures come from.
- **A PreToolUse hook.** Supported by Claude Code for exactly this, but the menu
  is not drawn while it waits, so the terminal cannot answer.
- **Keep key injection as a fallback behind the hook.** More sessions stay
  answerable from the card, but both paths would need maintaining, including the
  one that fails.
