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

## Amended 2026-09-10 — the browser no longer drives the walk

The decision above stands: key injection, not a hook broker. That is still the
expensive part to reverse and nothing here touches it. Two of the consequences
written alongside it have changed, and this section is what replaces them.

**What prompted the amendment.** The client-side walk planned every step ahead:
each step's expectation was the *next* question's text, and the last step's was
the review screen's title. Ten days of field telemetry
(`{job="devvm-journal", unit="tmux-api.service"}`, `TLEVENT`) recorded 15
answers: four-question calls landed 1 and failed 4, one-question calls landed 8
and failed 2. All six failures are `desync` — the plan predicted a screen and did
not find it — with none refused and none unreadable, so the keys always went in
and the pane was always readable. The full working is in
`docs/plans/2026-09-10-text-mode-answers-dialogs-design.md`.

**One tap, one request.** `POST /answer/{session}` carries one reader action
addressed by its question *header*. `session-events` answers the question the
pane is drawing and returns a fresh reading. The browser renders what comes
back. Nothing predicts a screen, and there is no ordered list of answers for an
index to slip in.

A single-select question sends the label chosen. A multi-select one sends the
desired final set, because its rows are toggles the CLI is already holding: the
reader's tap is applied against what the pane shows ticked, so a second pick
adds rather than replacing the first.

- *Was:* the text view mirrors the prompt and sends the answer as keystrokes.
  *Now:* the text view sends the reader's choice, and `session-events` does the
  mirroring and the keystrokes. The channel into the pty is unchanged.
- *Was:* "treat a failure to parse as an unknown prompt: show the honest
  fallback to the terminal." *Now:* show the captured pane itself, with the
  lines that look like numbered rows made tappable. Detecting those rows is a
  guess, and a CLI restyle can make it wrong; that was weighed against offering
  a plain arrow-key row and chosen deliberately, because a reader on a phone
  reaching a screen we cannot parse should still be able to answer it.

**What position means.** The question the pane is *drawing* decides which
question is on screen. The tab bar supplies the count and the headers, and its
`☒` tally is a progress signal rather than an index: measured 2026-09-10, a
multi-select question's box fills on the first `Space`, before the `Enter` that
leaves the question, so the tally runs one ahead there.

**Whoever answers first still wins.** A request for a question the pane is not
drawing is refused rather than typed, and the refusal carries the current
reading, so the card re-renders against what is actually on screen. Stopping is
now cheap, which is what lets the card drop the latch that used to disable
`Send` after a failed walk.

**Keeping up with the CLI.** A capture the parser cannot fully read is recorded
as a set of present and absent landmarks — structure only, never screen text,
per ADR-0008. Claude Code updates roughly daily and our fixtures are static
captures; one marker was already stale when this was written, the free-text
option having become `Type something` while the frontend still called it
`Other`. A synthetic nightly check was considered and declined, because making
the CLI draw an `AskUserQuestion` needs a real model call and that is recurring
spend. The fingerprint rides on dialogs that happen anyway.
