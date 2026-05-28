#!/bin/bash
echo ""
echo "  Welcome, Bob! 🚀"
echo ""
echo "  Starting Claude Code in /home/wizard/code..."
echo "  (Right-click for tmux menu, or Ctrl+B then | or - to split)"
echo ""
cd /home/wizard/code && exec npx @anthropic-ai/claude-code --dangerously-skip-permissions --model claude-opus-4-8
