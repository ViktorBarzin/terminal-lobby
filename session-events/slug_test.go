package main

import "testing"

// The slug rule is Claude Code's, not ours, so these cases are anchored to
// directory names observed under ~/.claude/projects rather than to what the
// implementation happens to do. The worktree cases are the ones that matter:
// a dot in the cwd is the difference between tailing the transcript and
// tailing nothing at all.
func TestTranscriptPathMatchesClaudeCodesSlug(t *testing.T) {
	for _, tc := range []struct{ cwd, want string }{
		{"/home/wizard/code/terminal-lobby", "-home-wizard-code-terminal-lobby"},
		{"/home/wizard/code/infra/.worktrees/ingress-factory-nullguard",
			"-home-wizard-code-infra--worktrees-ingress-factory-nullguard"},
		{"/home/wizard/code/tripit/.worktrees/fullscreen-nav",
			"-home-wizard-code-tripit--worktrees-fullscreen-nav"},
		{"/home/wizard/my.dir/sub", "-home-wizard-my-dir-sub"},
	} {
		got := transcriptPath("/root", tc.cwd, "abc")
		want := "/root/" + tc.want + "/abc.jsonl"
		if got != want {
			t.Errorf("transcriptPath(%q)\n got %q\nwant %q", tc.cwd, got, want)
		}
	}
}
