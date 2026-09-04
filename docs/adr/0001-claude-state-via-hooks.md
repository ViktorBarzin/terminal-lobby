# Claude session state comes from Claude Code hooks, not terminal output

The sidebar's per-session state indicator (running / awaiting input /
completed) is driven by org-wide Claude Code hooks: entries in the
devvm's `/etc/claude-code/managed-settings.json` (owned by
`infra/scripts/workstation/`) run a small script deployed by this repo
that stamps a tmux session option (`@claude_state`) on state
transitions — UserPromptSubmit/PreToolUse → running, Notification →
awaiting input, Stop/SessionStart → completed, SessionEnd → unset. The
script no-ops when `$TMUX` is unset, so t3-serve and headless Claude
instances are unaffected. `tmux-api` returns the option through the
`list-sessions -F` call it already makes — no extra forks.

The hooks are *almost* the only writer. An interrupt ends a turn without
firing `Stop`, so the one component that injects interrupts writes the
resulting state itself — see "Interrupts have no hook" below.

## Considered Options

- **Pane title (OSC) sniffing** — rejected on evidence, not taste: a
  live Claude session sitting idle at the `❯` prompt still titles its
  pane `✳ <conversation summary>`. The ✳ title is a static summary,
  not a state signal. This is the trap a future reader is most likely
  to walk into — the title *looks* like the obvious source.
- **Pane content sniffing** (`capture-pane` + regexes on "esc to
  interrupt", permission dialogs) — works with zero configuration but
  is brittle across Claude Code versions/themes and adds a fork per
  session per refresh. Kept in mind as a fallback, not built.
- **Launcher-only hooks** (`--settings` in start-claude.sh) — single
  repo, but only covers launcher-started sessions; a manually-run
  `claude` inside tmux would show no state.

## Consequences

- State changes reach the sidebar within ~10 s worst case (5 s
  tmux-api cache + 5 s lobby poll).
- The hook wiring lives in the infra repo (managed-settings.json);
  the hook script and its consumers live here. Both sides tolerate the
  other being absent (missing script → hook exits 0; unset option →
  no indicator).
- **Interrupts have no hook, so the interrupter owns the transition.**
  `Stop` is the only hook that writes `done`, and Ctrl-C does not fire
  it — nothing else in the system clears the stamp either. One click of
  the composer's Stop button therefore latched `@claude_state` at
  `running` for the life of the session, and session-events' turn gate
  (`POST /prompt` 409s while the stamp reads `running`) rejected every
  later send: measured 14 consecutive 409s over 337 s with the pane
  sitting idle at `❯`, and 30 s of polling after a bare
  `tmux send-keys C-c` with the stamp unmoved. The invariant is now
  **an interrupt ends the turn**: `Injector.Cancel`
  (`sessionio/tmux.go`) re-derives the stamp right after the C-c
  lands — a stamped session becomes `done`, an unstamped one stays
  unstamped so a plain shell never grows a state dot. The trade is
  deliberate. This writer can under-report for a moment when an
  interrupt does not actually end the turn, and the next
  PreToolUse/PostToolUse hook re-stamps `running` within seconds;
  over-reporting `running` had no corrector at all. In telemetry the
  transition is marked by `claude.cancelled`, emitted at the same
  instant for the same session; `claude.state_changed` stays the hook
  script's event, so the two streams are not two writers of one fact.
- Residual, deliberately not covered: a **Ctrl-C typed straight at the
  pty** (the Terminal view, or any real terminal) is nobody's write, so
  it still leaves the stamp at `running` until that pane's next
  `UserPromptSubmit`/`Stop` pair rewrites it. Typing a prompt into the
  pty clears it within ~3 s, which is what makes the Terminal view the
  in-app recovery path. The liveness backstop below does not help here:
  claude is alive, just idle.
- **`Stop` is not the end of a turn's work, and a subagent's tool calls
  reach these same hooks.** Measured on 2026-09-04 against claude 2.1.260,
  with every hook event logged and its payload kept: a prompt that
  backgrounded one Agent and one command fired `Stop` at 05:09:41, and the
  agent finished at 05:11:57. Two minutes sixteen of a session reading
  *Done* while it was working. The second half is why the wrong colour was
  intermittent rather than constant — the subagent's own `PreToolUse` and
  `PostToolUse` arrive in the MAIN session carrying `agent_id`, so the
  script re-stamped `running` between Stops and the value a poll saw
  depended on when it landed.

  Both are fixed inside the events already wired, with no change to
  `managed-settings.json`: `PostToolUse` records a launch that returns
  `status: async_launched` in a second option, `@claude_bg`; the completing
  task re-enters as a `UserPromptSubmit` carrying `<task-notification>`,
  which retires that id; `Stop` stamps `done` only when the set is empty;
  and any event carrying `agent_id` is ignored. There is deliberately no
  expiry on an id — a human prompt clears the set, which is what makes
  typing into a session re-derive it, as it already was for `@claude_state`.

  That drain alone was not enough, and `Stop` now PRUNES the set against
  the harness's own registry (2026-09-04). A `<task-notification>` reaches
  the session as a prompt only when the task finished BETWEEN turns; one
  that finishes mid-turn is absorbed into the running turn — the transcript
  records `queue-operation` enqueue then remove with reason
  `absorbed_mid_turn` — and no `UserPromptSubmit` fires, so the id stayed
  for good and the session read `running` with nothing running. Measured
  over 122 transcripts: background commands reached the session as a prompt
  258 times against 765 absorbed or silently removed, agents 57 against 35,
  workflows 36 against 18; and of 56 tasks stopped with `TaskStop`, 42
  never enqueued a notification at all. The `Stop` payload carries
  `background_tasks`, the live list, and it is authoritative — a finished
  task and a `TaskStop`ped one both leave it at once. It is the only event
  that carries the field, and the only one that has to decide.

  A workflow id is not pruned: the kinds seen in a real payload are
  `shell` and `subagent`, and whether a running Workflow is listed at all
  is unmeasured, so pruning one could report `done` mid-run. Workflows stay
  on the notification drain until that is measured.
  `SubagentStart` and `SubagentStop` do fire and are accurate, and are
  deliberately unused: wiring them means an infra change reaching every
  headless Claude on the box. `TaskCreated` and `TaskCompleted` exist as
  event names in the binary and fired for none of the three launch kinds.
  Design and the full trace:
  `docs/plans/2026-09-04-background-work-session-state-design.md`.
- A session whose Claude died without hooks firing (kill -9, OOM) is
  caught by a liveness backstop: a state only survives while a claude
  process is alive under the session's `pane_pid` (one /proc scan per
  refresh, no forks). The first version used
  `pane_current_command != claude`, which is WRONG for launcher-started
  sessions: it reports the pane tty's foreground process-group leader,
  and start-claude.sh (bash, runs npx without exec, no job control)
  keeps that leader as `bash` while claude runs underneath — blanking
  every launcher user's dots (found on bob's sessions, 2026-07-07,
  same day).
