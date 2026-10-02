package main

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"terminal-lobby/sessionio"
)

// privateDir is a directory only this test's account can write, the shape
// systemd's StateDirectory= gives the service.
func privateDir(t *testing.T) string {
	t.Helper()
	d := filepath.Join(t.TempDir(), "state")
	if err := os.Mkdir(d, 0o700); err != nil {
		t.Fatal(err)
	}
	return d
}

func TestAgentRulesAreWrittenIntoAPrivateDirectory(t *testing.T) {
	dir := privateDir(t)
	p, err := writeAgentRules(dir)
	if err != nil {
		t.Fatalf("writeAgentRules: %v", err)
	}
	if p != filepath.Join(dir, agentRulesFile) {
		t.Fatalf("path %q", p)
	}
	b, err := os.ReadFile(p)
	if err != nil || string(b) != agentSystemPrompt {
		t.Fatalf("file holds %d bytes (%v), want the rules", len(b), err)
	}
	fi, err := os.Lstat(p)
	if err != nil || !fi.Mode().IsRegular() || fi.Mode().Perm()&0o022 != 0 {
		t.Fatalf("file mode %v (%v)", fi.Mode(), err)
	}
	// Written again, it replaces itself.
	if _, err := writeAgentRules(dir); err != nil {
		t.Fatalf("second write: %v", err)
	}
}

// The live finding (2026-10-02): the rules lived in /tmp/agent-api, made
// with MkdirAll and written with WriteFile. /tmp is shared, so another
// account could create that directory first and either redirect the write
// through a symlink or swap in rules of its own.
func TestAgentRulesRefuseADirectorySomeoneElseCouldWrite(t *testing.T) {
	open := filepath.Join(t.TempDir(), "open")
	if err := os.Mkdir(open, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(open, 0o777); err != nil {
		t.Fatal(err)
	}
	if _, err := writeAgentRules(open); err == nil {
		t.Fatal("wrote the rules into a world-writable directory")
	}
	if _, err := os.Lstat(filepath.Join(open, agentRulesFile)); !os.IsNotExist(err) {
		t.Fatalf("a file was left behind: %v", err)
	}
}

func TestAgentRulesRefuseASymlinkedDirectory(t *testing.T) {
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(privateDir(t), link); err != nil {
		t.Fatal(err)
	}
	if _, err := writeAgentRules(link); err == nil {
		t.Fatal("wrote the rules through a symlinked directory")
	}
}

func TestAgentRulesRefuseADirectoryAnotherAccountOwns(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root owns /")
	}
	if _, err := writeAgentRules("/"); err == nil || !strings.Contains(err.Error(), "owned by") {
		t.Fatalf("err = %v, want a refusal naming the owner", err)
	}
}

// A symlink planted where the file goes is replaced, never written through.
func TestAgentRulesReplaceAPlantedSymlinkRatherThanFollowIt(t *testing.T) {
	dir := privateDir(t)
	victim := filepath.Join(t.TempDir(), "victim")
	if err := os.WriteFile(victim, []byte("victim-original"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(victim, filepath.Join(dir, agentRulesFile)); err != nil {
		t.Fatal(err)
	}
	p, err := writeAgentRules(dir)
	if err != nil {
		t.Fatalf("writeAgentRules: %v", err)
	}
	if b, _ := os.ReadFile(victim); string(b) != "victim-original" {
		t.Fatalf("the symlink's target was overwritten: %q", b)
	}
	if fi, err := os.Lstat(p); err != nil || !fi.Mode().IsRegular() {
		t.Fatalf("the rules file is %v (%v), want a regular file", fi.Mode(), err)
	}
}

// createCommand creates one conversation and returns the command it runs.
func createCommand(t *testing.T, h *harness) string {
	t.Helper()
	cwd := filepath.Join(h.homeBase, testOSUser, "code")
	h.decodeJSON(h.call("POST", "/v1/conversations", `{"cwd":`+jsonString(cwd)+`}`), http.StatusCreated, nil)
	created := h.sessions.createCalls()
	if len(created) == 0 || len(created[len(created)-1].Command) != 1 {
		t.Fatalf("created %+v", created)
	}
	return created[len(created)-1].Command[0]
}

func TestAConversationReadsTheRulesFromThePrivateDirectory(t *testing.T) {
	h := newHarness(t)
	h.srv.RulesDir, h.srv.RulesUser = privateDir(t), testOSUser
	args := shellWords(t, createCommand(t, h))
	p, ok := flagValue(args, "--append-system-prompt-file")
	if !ok || p != filepath.Join(h.srv.RulesDir, agentRulesFile) {
		t.Fatalf("--append-system-prompt-file = %q (%v) in %q", p, ok, args)
	}
	if b, err := os.ReadFile(p); err != nil || string(b) != agentSystemPrompt {
		t.Fatalf("the file the flag names does not hold the rules (%v)", err)
	}
}

// Every way the file cannot be used falls back to the rules inline, never to
// a session with no rules.
func TestAConversationFallsBackToInlineRules(t *testing.T) {
	open := filepath.Join(t.TempDir(), "open")
	if err := os.Mkdir(open, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(open, 0o777); err != nil {
		t.Fatal(err)
	}
	cases := []struct{ name, dir, user string }{
		{"no directory configured", "", testOSUser},
		{"a directory others can write", open, testOSUser},
		// The directory is 0700 and the service's own: a conversation run as
		// another account could not read a file in it.
		{"a conversation run as another account", privateDir(t), "someone-else"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t)
			h.srv.RulesDir, h.srv.RulesUser = c.dir, c.user
			args := shellWords(t, createCommand(t, h))
			if _, ok := flagValue(args, "--append-system-prompt-file"); ok {
				t.Fatalf("used the file flag: %q", args)
			}
			if v, ok := flagValue(args, "--append-system-prompt"); !ok || v != agentSystemPrompt {
				t.Fatalf("no inline rules in %q", args)
			}
		})
	}
}

// A resume of a conversation started before the move points it at
// sessionio.AgentRulesPath, which has to be where this service writes by
// default.
func TestTheDefaultRulesPathIsTheOneResumesMoveTo(t *testing.T) {
	if got := filepath.Join(stateDir(func(string) string { return "" }), agentRulesFile); got != sessionio.AgentRulesPath {
		t.Fatalf("agent-api writes %s by default, resumes point at %s", got, sessionio.AgentRulesPath)
	}
}
