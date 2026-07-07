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
- A session whose Claude died without hooks firing (kill -9, OOM) is
  caught by the `pane_current_command != claude` backstop and shows no
  indicator.
