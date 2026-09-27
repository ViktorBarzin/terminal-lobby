# Blocking prompts are answered by injecting keys, not by a hook broker

> **2026-09-27:** `AskUserQuestion` is no longer answered this way. ADR-0034
> answers it through a `PermissionRequest` hook that runs alongside the CLI's
> menu. Plan approvals and permission prompts still use key injection as
> described here.

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

## Amended 2026-09-23: a multi-select tap toggles, and a button leaves the question

Key injection and one request per reader action both stand. What changes is
which action leaves a multi-select question.

**What prompted the amendment.** Viktor reported on 2026-09-23 that "multi
answer questions now move on to the next step on the first selection and the
user can't select more than one answer." Since the one-tap design shipped on
2026-09-11 (`c319f82d`), a tap on a multi-select row sent the desired set, and
the server then walked to the CLI's commit row and pressed `Enter` (`planChoice`
in `sessionio/answerplan.go`). The first tap therefore committed the question,
and on a one-question call it landed on the review screen. A second pick could
still be added by walking back to the question, which the 2026-09-11
verification run did once, but every extra pick cost a walk back.

**The decision.** A tap on a multi-select row toggles that row and nothing else.
It is still one request carrying the set the question should hold, now with
`stay`, which applies the set and keeps the question on screen, and the card
draws the ticks from the reading that comes back. Leaving the question is a
request of its own, sent by a commit button that carries the pane's own label
for the commit row, `Next` or `Submit`. Free text on a multi-select is one more
pick, typed into the CLI's inline row with no `Enter`. Single-select is
unchanged: one tap answers, through the digit.

The button mirrors the terminal rather than adding a step to it. Measured on CLI
2.1.280, `Enter` on a numbered multi-select row toggles it and never leaves the
question. What leaves is an unnumbered row under the free-text row, `Next` on
every question but the last and `Submit` on the last, so a reader at the
terminal already ticks and then commits. The card now asks for the same two
gestures.

- *Was:* "A multi-select one sends the desired final set, because its rows are
  toggles the CLI is already holding … so a second pick adds rather than
  replacing the first." *Now:* it still sends the desired final set, and a
  second pick still adds, but a tap no longer leaves the question. The commit
  button sends the set the card shows without `stay`, and an empty set is
  refused with nothing typed. The CLI would accept an empty commit, and Claude
  would receive "The user did not answer the questions."
- *Was:* the tab bar's box fills "on the first `Space`, before the `Enter` that
  leaves the question." *Now:* the `Enter` that leaves is the one on the commit
  row, and measured on 2.1.280 the box empties again once every tick is removed,
  so the tally can fall as well as run ahead. The conclusion holds: the drawn
  question decides position.

**What it costs.** A one-pick answer now takes two requests, the tick and the
commit, where it took one. A tap made while a request is in flight waits rather
than being dropped, and goes out computed against the reading that request's
reply returned, so the card holds the reader's pending taps and still no model
of the dialog. Every request still records one `text.answer_sent` or
`text.answer_failed`, now with `tl.action`, and `claude.answered` skips toggles,
so one multi-select answer counts once, at its commit (ADR-0006). The 2.1.280
measurements and the wire additions are in
`docs/plans/2026-09-10-text-mode-answers-dialogs-design.md`.

## Amended 2026-09-24: the plan-approval dialog is answered the same way

Key injection and one request per reader action both stand. What changes is
that a third blocking prompt, the dialog Claude Code draws when an
`ExitPlanMode` call presents a plan, is now answered through them.

**What prompted the amendment.** On 2026-09-24 Viktor asked for text mode to
handle the plan review and the clear-context start, which it could not do. The
plan dialog lists the ways to approve the plan, usually including one that
clears context first, and a row for telling Claude what to change. `ParseDialog`
requires the question widget's "Enter to select … Esc to cancel" footer and a
free-text or chat row, and the plan dialog draws neither, so the pane watcher
published no reading, no card docked, `POST /answer` refused with `no-dialog`,
and the plan row in the timeline read "awaiting approval" for as long as the
dialog stood. Reviewing and starting a plan meant switching to the Terminal.

**The decision.** The plan dialog is answered by key injection, like a question.

- The pane watcher reads it with a parser of its own and publishes a plan
  reading on the same `asking` meta, told apart from a question reading by
  `"kind": "plan"`. The reading carries the approve options exactly as drawn,
  because their labels vary by session ("(6% used)", whether auto mode exists),
  plus the feedback row's number and the plan file's path.
- `POST /answer/{session}` gains a `plan` field. An approve names the option's
  number and its drawn label, and is refused with nothing typed when the label
  on the pane differs. Feedback is pasted into the feedback row and read back,
  then committed with `Enter`, which sends it back to planning, or `BTab`, which
  approves the plan with it.
- Each key is its own send-keys run, and each step is proved by a fresh reading
  before the next key. `Esc` is never sent, and `Enter` is never pressed on an
  empty feedback row, because both reject the plan.
- The plan's text comes from the transcript, as the input of the `ExitPlanMode`
  call, and never from the pane: the dialog clips a long plan, and on a 58x20
  pane it draws no plan lines at all.

**Where the dialog is read.** The parse is anchored at the bottom of the
capture. The dialog takes the input box's place, so its footer,
`ctrl+g to edit in <editor> · <path>`, is the last line on the pane, while a
copy of the dialog quoted in the conversation always has the input box and the
CLI's status line under it. The landmarks the parser requires are the question
("Would you like to proceed?"), the numbered rows, the hint under the feedback
row and that footer. The heading lines above the plan help find the dialog's
top when they are drawn and are not required, because PgDn and a narrow pane
both remove them.

**A prompt no longer lands in the menu.** `POST /prompt/{session}` refuses with
`plan-open` while the dialog is on the pane, and the client keeps the text. The
prompt path sends C-e, C-u, a paste and Enter into whatever has focus, and on
this menu a digit selects an option, so a prompt such as "1. do X" could clear
context and start executing. While the plan card is docked the composer routes
Send as feedback, so the refusal is there for a stale client and for the moment
before the reading arrives.

The same route refuses with `permission-open` while a tool permission prompt is
on the pane, and since 2026-09-27 with `question-open` while a question is. A
prompt's Enter on a question picks the highlighted option: measured on 0.78.0,
a prompt sent before the question card docked answered "Shape?" with an option
nobody chose, and the words were lost. The card docks about 1.4 s after the
dialog draws, so the refusal covers that window and a stalled event stream.

- *Was (2026-09-10):* a capture the parser cannot fully read is shown as the
  pane itself, with the lines that look like numbered rows made tappable.
  *Now:* that still holds for questions. For a plan the card points to the
  Terminal and offers no tappable rows, because a misread digit on this menu can
  clear context and start execution.
- *Was:* "the transcript confirms the outcome either way." *Now:* an approval
  that clears context writes the same rejection as `Esc` into the old
  transcript, and the CLI starts a new transcript about 1 s after the key whose
  first user record carries the plan. That record is the confirmation. The
  SessionStart hook restamps `@claude_transcript`, and the Text view moves to
  the new conversation within about 6 s, opening it with a "Context cleared ·
  carrying out the plan" marker.

**What it costs.** We are coupled to a second dialog's wording and keys,
measured on Claude Code 2.1.281 on 2026-09-24 and pinned by the captures in
`sessionio/testdata/plan-*.txt`. A capture that stops parsing leaves a session
as it was before this change: no card, and the Terminal still answers. The
composer's new mode list drives Shift+Tab from the server, and `BTab` on the
plan dialog's feedback row approves the plan, so the composer holds the mode
dial while any dialog is drawn. Each plan answer records one `text.answer_sent`
or `text.answer_failed` with `tl.action` = `plan-approve` or `plan-feedback`,
and one `claude.answered` when it lands (ADR-0006). The measurements, the wire
contracts and the key sequences are in
`docs/plans/2026-09-24-text-composer-redesign.md`.
