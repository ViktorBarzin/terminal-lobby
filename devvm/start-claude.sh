#!/bin/bash
echo ""
echo "  Welcome, Bob! 🚀"
echo ""
echo "  Starting Claude Code in /home/wizard/code..."
echo "  (Right-click for tmux menu, or Ctrl+B then | or - to split)"
echo ""
# Name the Claude session after the tmux session it runs in, so Claude's
# /resume picker, prompt box, and terminal title line up with the tmux
# session name (e.g. "Hunter", "Yale", "HA_status").
name_args=()
if [ -n "${TMUX:-}" ]; then
  sess="$(tmux display-message -p '#{session_name}' 2>/dev/null)"
  [ -n "$sess" ] && name_args=(--name "$sess")
fi

cd /home/wizard/code
# Branch on Claude's exit code. We deliberately do NOT `exec` claude so we can
# react to how it exited:
#   - clean exit (user quit) -> end the pane's command. With remain-on-exit off
#     the tmux window/session closes and ttyd closes the terminal — no shell.
#   - crash / failed launch (bad model, npx/network hiccup -> non-zero) -> fall
#     through to an interactive shell, so the freshly-created session isn't
#     destroyed-and-recreated in a ttyd auto-reconnect loop.
npx @anthropic-ai/claude-code \
  --dangerously-skip-permissions --model claude-opus-4-8 "${name_args[@]}"
code=$?

if [ "$code" -eq 0 ]; then
  exit 0
fi

echo ""
echo "  claude exited abnormally (status $code). Dropping to a shell — your tmux session is preserved."
echo "  Re-launch any time with: ~/start-claude.sh"
echo ""
exec "${SHELL:-/bin/bash}" -l
