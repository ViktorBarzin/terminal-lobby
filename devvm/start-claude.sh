#!/bin/bash
echo ""
echo "  Welcome, Emo! 🚀"
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
# Do NOT `exec`: if claude exits or fails to launch (bad model, npx/network
# hiccup), the tmux window's command ends and — with remain-on-exit off — the
# whole session is destroyed, after which ttyd's auto-reconnect recreates and
# re-kills it in a loop. Falling through to an interactive shell keeps the
# freshly-created session alive instead.
npx @anthropic-ai/claude-code \
  --dangerously-skip-permissions --model claude-opus-4-8 "${name_args[@]}"
code=$?
echo ""
echo "  claude exited (status $code). Dropping to a shell — your tmux session is preserved."
echo "  Re-launch any time with: ~/start-claude.sh"
echo ""
exec "${SHELL:-/bin/bash}" -l
