# Blocking prompts are answered by injecting keys, not by a hook broker

A Claude session blocks on two things a text-view reader cannot answer: a
permission prompt, and an `AskUserQuestion` menu. Both are drawn by the CLI in
its own pane, and neither is an event the transcript reports while it is
pending.

We answer them by **mirroring the prompt into the text view and sending the
answer back as keystrokes into the same pty** — the same channel the composer
already uses for prompts and interrupts (`sessionio.Injector`). A pending
`AskUserQuestion` is derivable from the transcript, which carries the full
question, its options, their descriptions and previews, as a `tool_use` with no
matching `tool_result` yet. A pending permission is signalled by the existing
Notification-hook state stamp (`@claude_state` = awaiting input, ADR-0001) and
read from the pane with `capture-pane`.

## Considered options

- **A PreToolUse hook broker** — the shape we had, and removed in `575d4f5`. The
  hook routed every tool call through `session-events`, which returned `"ask"`
  for any session nothing was watching. A PreToolUse `"ask"` *overrides* the
  allowlist and the permission mode rather than deferring to normal flow, so
  with the text view paused it forced a permission prompt on every tool call in
  every session on a shared devvm. A corrected version could fall through by
  exiting 0 with no decision, which fixes that specific failure — but it still
  puts a hook on the hot path of every tool call for every user on the box, to
  serve a reader who is usually not watching.
- **Auto-fallback to the terminal** — banner or switch to the pty when a prompt
  appears. Costs nothing and never lies, but it hands a phone user a TUI dialog
  in a 40-column terminal, which is most of what the text view exists to avoid.
- **Key injection** (chosen) — no new hook, no per-tool-call cost to anyone
  else, both surfaces stay live, and the transcript confirms the outcome either
  way.

## Consequences

- **Whoever answers first wins**, and that is the correct semantics: the pane
  and the text view are two windows onto one process. The view reconciles from
  the transcript once the answer lands, so an answer typed in the terminal
  settles the card in the browser.
- **We are coupled to the TUI's key handling and dialog wording.** The
  `AskUserQuestion` half is low-risk — the options come from the transcript, so
  only the *selection* keys are inferred. The permission half reads the dialog
  off the screen, and a Claude Code release that restyles it will need us to
  follow. Treat a failure to parse as "unknown prompt": show the honest fallback
  to the terminal rather than guessing a keystroke.
- `capture-pane` is used deliberately here, having been rejected for *state* in
  ADR-0001 — that rejection was about polling every session on every refresh to
  infer something a hook reports reliably. This reads one pane, only while a
  session is both watched in text mode and known to be awaiting input.
- The `permission_request` / `permission_resolved` event kinds kept in
  `event.go` after `575d4f5` have a producer again.
