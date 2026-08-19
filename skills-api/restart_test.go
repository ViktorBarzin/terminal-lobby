package main

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// withTmuxStub swaps the tmux binary for a script that records its argv and
// answers display-message with a fixture line, so the full HTTP → tmux argv path
// runs without a live tmux server. Mirrors tmux-api's own stub approach.
//
// cwd and state are passed as separate printf arguments with the tab in the
// FORMAT: a tab written into an argument would stay a literal backslash-t, and
// the handler splits on a real tab, so the fixture would silently never look
// mid-turn.
func withTmuxStub(t *testing.T, cwd, state string) (argvLog string) {
	t.Helper()
	dir := t.TempDir()
	argvLog = filepath.Join(dir, "argv")
	stub := filepath.Join(dir, "tmux")
	script := fmt.Sprintf(`#!/bin/sh
printf '%%s\n' "$*" >> %q
case "$1" in
  display-message) printf '%%s\t%%s\n' %q %q ;;
esac
exit 0
`, argvLog, cwd, state)
	if err := os.WriteFile(stub, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	old := tmuxBinary
	tmuxBinary = stub
	t.Cleanup(func() { tmuxBinary = old })
	return argvLog
}

func readLog(t *testing.T, path string) string {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(body)
}

func TestRestartRespawnsThePaneInPlaceWithContinue(t *testing.T) {
	withHomeBase(t)
	me, _ := twoLocalUsers(t)
	withUserMap(t, "wiz="+me+"\n")
	log := withTmuxStub(t, "/home/wizard/code", "done")

	w := post(t, "/skills/restart", "wiz", `{"session":"notes"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("restart: %d %s", w.Code, w.Body.String())
	}
	argv := readLog(t, log)
	if !strings.Contains(argv, "respawn-pane -k") {
		t.Errorf("want a respawn rather than a quit: %s", argv)
	}
	if !strings.Contains(argv, "respawn-pane -k -t notes -c /home/wizard/code ") {
		t.Errorf("want the pane's own directory, since --continue resolves the thread by cwd: %s", argv)
	}
	if !strings.Contains(argv, "--continue") || !strings.Contains(argv, "--name notes") {
		t.Errorf("want --continue and the session name: %s", argv)
	}
	if !strings.Contains(argv, "/.local/bin/claude") {
		t.Errorf("want the user's own binary by absolute path: %s", argv)
	}
}

func TestRestartRefusesASessionMidTurn(t *testing.T) {
	withHomeBase(t)
	me, _ := twoLocalUsers(t)
	withUserMap(t, "wiz="+me+"\n")
	log := withTmuxStub(t, "/home/wizard", "running")

	w := post(t, "/skills/restart", "wiz", `{"session":"infra-work"}`)
	if w.Code != http.StatusConflict {
		t.Fatalf("a session mid-turn must be refused: %d", w.Code)
	}
	if strings.Contains(readLog(t, log), "respawn-pane") {
		t.Error("nothing should have been respawned")
	}
}

func TestRestartAllowsASessionWithNoRecordedState(t *testing.T) {
	// A session that predates the state hooks, or one Claude never ran in, has no
	// @claude_state. That is not "running", so it is restartable.
	withHomeBase(t)
	me, _ := twoLocalUsers(t)
	withUserMap(t, "wiz="+me+"\n")
	log := withTmuxStub(t, "/home/wizard", "")

	if w := post(t, "/skills/restart", "wiz", `{"session":"plain"}`); w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(readLog(t, log), "respawn-pane") {
		t.Error("want the respawn to have run")
	}
}

func TestRestartRejectsASessionNameTmuxApiWouldNotHaveMade(t *testing.T) {
	withHomeBase(t)
	me, _ := twoLocalUsers(t)
	withUserMap(t, "wiz="+me+"\n")
	log := withTmuxStub(t, "/home/wizard", "done")

	for _, name := range []string{"", "has space", "semi;colon", "$(whoami)", strings.Repeat("a", 33), "../x"} {
		body := fmt.Sprintf(`{"session":%q}`, name)
		if w := post(t, "/skills/restart", "wiz", body); w.Code != http.StatusBadRequest {
			t.Errorf("session=%q: %d, want 400", name, w.Code)
		}
	}
	if readLog(t, log) != "" {
		t.Errorf("no tmux call should have been made: %s", readLog(t, log))
	}
}

func TestRestartOfAnUnknownSessionIs404(t *testing.T) {
	withHomeBase(t)
	me, _ := twoLocalUsers(t)
	withUserMap(t, "wiz="+me+"\n")
	// A stub that fails, the way tmux does for a session that is not there.
	dir := t.TempDir()
	stub := filepath.Join(dir, "tmux")
	if err := os.WriteFile(stub, []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	old := tmuxBinary
	tmuxBinary = stub
	t.Cleanup(func() { tmuxBinary = old })

	if w := post(t, "/skills/restart", "wiz", `{"session":"ghost"}`); w.Code != http.StatusNotFound {
		t.Fatalf("status %d, want 404", w.Code)
	}
}

func TestTmuxCmdSudoesOnlyForAnotherUser(t *testing.T) {
	oldSelf, oldSudo, oldTmux := selfUser, sudoBinary, tmuxBinary
	t.Cleanup(func() { selfUser, sudoBinary, tmuxBinary = oldSelf, oldSudo, oldTmux })
	selfUser, sudoBinary, tmuxBinary = "wizard", "/usr/bin/sudo", "/usr/bin/tmux"

	own := tmuxCmd("wizard", "list-sessions")
	if own.Path != "/usr/bin/tmux" {
		t.Errorf("own user should not go through sudo: %v", own.Args)
	}
	other := tmuxCmd("emo", "list-sessions")
	if other.Path != "/usr/bin/sudo" {
		t.Fatalf("another user must go through sudo: %v", other.Args)
	}
	want := []string{"/usr/bin/sudo", "-n", "-H", "-u", "emo", "/usr/bin/tmux", "list-sessions"}
	if strings.Join(other.Args, " ") != strings.Join(want, " ") {
		t.Errorf("argv = %v, want %v", other.Args, want)
	}
}

func TestSplitPaneInfoHandlesTheTmuxAnswerShapes(t *testing.T) {
	for _, c := range []struct{ in, cwd, state string }{
		{"/home/wizard/code\tdone\n", "/home/wizard/code", "done"},
		{"/home/wizard\t\n", "/home/wizard", ""},
		{"/home/wizard", "/home/wizard", ""},
		{"", "", ""},
	} {
		cwd, state := splitPaneInfo(c.in)
		if cwd != c.cwd || state != c.state {
			t.Errorf("splitPaneInfo(%q) = (%q,%q), want (%q,%q)", c.in, cwd, state, c.cwd, c.state)
		}
	}
}
