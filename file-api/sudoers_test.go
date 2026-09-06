package main

import (
	"os"
	"strings"
	"testing"
)

// The sudoers grant is what makes the privileged re-exec possible at all: sudo
// matches the TARGET BINARY's path against the grant, so a binary no NOPASSWD
// line names cannot run its own child as another user, and the failure surfaces
// as an opaque permission error rather than as a missing grant. The template is
// the reference copy of a hand-maintained file, so this pins the two together.
//
// It is a reference, not the installed file. A drift here does not break the
// box on its own, and the template's own header says the names in it are
// placeholders. What this catches is the binary going unmentioned entirely,
// which is the case an operator copying the template would deploy broken.
// sudoersGrantTarget is the path exeSelf falls back to, which is where the
// package installs this binary and what the grant is keyed on.
const sudoersGrantTarget = installPath

func TestSudoersTemplateGrantsThisBinary(t *testing.T) {
	raw, err := os.ReadFile("../devvm/sudoers.d-ttyd-users.template")
	if err != nil {
		t.Fatalf("read the sudoers template: %v", err)
	}
	if !grantsBinary(string(raw), sudoersGrantTarget) {
		t.Errorf("no NOPASSWD line in devvm/sudoers.d-ttyd-users.template grants %s, "+
			"so the privileged re-exec has nothing to run under", sudoersGrantTarget)
	}
}

// grantsBinary reports whether any NOPASSWD line permits the binary. Comment
// lines are skipped: the template explains every grant in prose above it, so a
// plain substring search would pass on the documentation alone.
func grantsBinary(sudoers, binary string) bool {
	for _, line := range strings.Split(sudoers, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		_, cmds, ok := strings.Cut(line, "NOPASSWD:")
		if !ok {
			continue
		}
		for _, c := range strings.Split(cmds, ",") {
			if strings.TrimSpace(c) == binary {
				return true
			}
		}
	}
	return false
}

// The helper has to reject the prose, or the check above is worthless.
func TestGrantsBinaryIgnoresComments(t *testing.T) {
	if grantsBinary("#   /usr/local/bin/file-api   re-execs ITSELF as the mapped user\n", "/usr/local/bin/file-api") {
		t.Error("a comment mentioning the binary must not count as a grant")
	}
	if !grantsBinary("wizard ALL=(bob) NOPASSWD: /usr/bin/tmux, /usr/local/bin/file-api\n", "/usr/local/bin/file-api") {
		t.Error("a real NOPASSWD line must count as a grant")
	}
	if grantsBinary("wizard ALL=(bob) NOPASSWD: /usr/bin/tmux\n", "/usr/local/bin/file-api") {
		t.Error("a grant for another binary must not count")
	}
}
