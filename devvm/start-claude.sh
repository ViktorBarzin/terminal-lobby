#!/bin/bash
# SAMPLE, not a shipped file. No manifest entry installs it, nothing in this
# repo executes it, and it is not what a session on this box starts under: that
# launcher is the roster's, lives in each user's home, and pins --session-id per
# launch (see the comment on claudeCommand in skills-api/restart.go). Copy this
# into a home and wire it up with `set -g default-command` if you want it, per
# docs/multi-user.md.
#
# It starts in the invoking user's own home on purpose. An earlier version
# hardcoded one box's admin tree, which would have pointed every user who copied
# it at somebody else's files.
start_dir="$(getent passwd "$(id -un)" | cut -d: -f6 || true)"
start_dir="${start_dir:-${HOME:-/}}"

echo ""
echo "  Welcome, $(id -un)! 🚀"
echo ""
echo "  Starting Claude Code in $start_dir..."
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

cd "$start_dir" || exit 1
# Branch on Claude's exit code. We deliberately do NOT `exec` claude so we can
# react to how it exited:
#   - clean exit (user quit) -> end the pane's command. With remain-on-exit off
#     the tmux window/session closes and ttyd closes the terminal — no shell.
#   - crash / failed launch (bad model, npx/network hiccup -> non-zero) -> fall
#     through to an interactive shell, so the freshly-created session isn't
#     destroyed-and-recreated in a ttyd auto-reconnect loop.
# No --model: inherit the org-wide default from /etc/claude-code/managed-settings.json.
npx @anthropic-ai/claude-code \
  --dangerously-skip-permissions "${name_args[@]}"
code=$?

if [ "$code" -eq 0 ]; then
  exit 0
fi

echo ""
echo "  claude exited abnormally (status $code). Dropping to a shell — your tmux session is preserved."
echo "  Re-launch any time with: ~/start-claude.sh"
echo ""
exec "${SHELL:-/bin/bash}" -l
