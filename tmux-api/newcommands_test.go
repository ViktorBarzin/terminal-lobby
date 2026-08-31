package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The probe runs in a login+interactive shell, and an rc file is free to print
// a banner into it. Anything that is not a `key<TAB>0|1` line is somebody
// else's output and must not become an answer about a command.
func TestParseProbeIgnoresEverythingButAnswers(t *testing.T) {
	out := strings.Join([]string{
		"Welcome to your shell!",         // a banner
		"claude\t1",                      // an answer
		"codex\t0",                       // an answer
		"shell\t1",                       // an answer
		"some-key\twhat",                 // a key with a non-answer
		"UPPERCASE\t1",                   // outside the key charset
		"aaaaaaaaaaaaaaaaaaaaaaaa\t1",    // longer than a key may be
		"claude 1",                       // space, not a tab
		"",                               // blank
		"[oh-my-zsh] plugins loaded",     // more banner
	}, "\n")

	got := parseProbe([]byte(out))
	want := map[string]bool{"claude": true, "codex": false, "shell": true}
	if len(got) != len(want) {
		t.Fatalf("parseProbe returned %v, want exactly %v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("parseProbe[%q] = %v, want %v", k, got[k], v)
		}
	}
}

// Fail OPEN. A probe that cannot run says nothing about any command, and the
// lobby greys out only what it has been told is missing — so a broken probe
// leaves every option enabled, exactly as before the feature existed. Greying
// out a command that in fact works would be the worse failure: it takes away a
// tool the box has.
func TestNewCommandsFailsOpenWhenTheProbeFails(t *testing.T) {
	_, other := actAsFixture(t)
	t.Cleanup(stubProbe(func(string) ([]byte, error) { return nil, errors.New("boom") }))

	rec := httptest.NewRecorder()
	handleNewCommands(rec, projectsReq(http.MethodGet, "/new-commands", "", "otherauth"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want 200 — a failed probe is not a failed request", rec.Code)
	}
	var got map[string]bool
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body.String())
	}
	if len(got) != 0 {
		t.Fatalf("got %v, want {} so the UI disables nothing", got)
	}
	_ = other
}

func TestNewCommandsReportsWhatTheProbeSaid(t *testing.T) {
	_, other := actAsFixture(t)
	t.Cleanup(stubProbe(func(u string) ([]byte, error) {
		if u != other {
			t.Errorf("probe ran as %q, want the resolved OS user %q", u, other)
		}
		return []byte("claude\t1\ncodex\t0\nshell\t1\n"), nil
	}))

	rec := httptest.NewRecorder()
	handleNewCommands(rec, projectsReq(http.MethodGet, "/new-commands", "", "otherauth"))
	var got map[string]bool
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body.String())
	}
	if got["claude"] != true || got["shell"] != true {
		t.Errorf("got %v, want claude and shell available", got)
	}
	if got["codex"] != false {
		t.Errorf("got %v, want codex reported unavailable", got)
	}
}

// A login shell is expensive enough that the 5s lobby poll must not spawn one.
func TestNewCommandsCachesPerUser(t *testing.T) {
	_, _ = actAsFixture(t)
	calls := 0
	t.Cleanup(stubProbe(func(string) ([]byte, error) {
		calls++
		return []byte("claude\t1\n"), nil
	}))

	for i := 0; i < 3; i++ {
		rec := httptest.NewRecorder()
		handleNewCommands(rec, projectsReq(http.MethodGet, "/new-commands", "", "otherauth"))
		if rec.Code != http.StatusOK {
			t.Fatalf("call %d: status %d", i, rec.Code)
		}
	}
	if calls != 1 {
		t.Fatalf("probe ran %d times for 3 requests; it must be cached", calls)
	}
}

// The probe runs somebody's login shell, and a login shell runs whatever their
// rc file says. One that blocks — on a network mount, a prompt, an update check
// — must not take an HTTP handler with it. A request that gives up is a request
// that greys nothing out, which is the harmless direction.
func TestProbeGivesUpOnAShellThatHangs(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "hangs")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nsleep 30\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	prevScript, prevTimeout := attachScript, probeTimeout
	attachScript, probeTimeout = script, 200*time.Millisecond
	t.Cleanup(func() { attachScript, probeTimeout = prevScript, prevTimeout })

	start := time.Now()
	if _, err := runProbe(selfUser); err == nil {
		t.Fatal("a probe that never returns must be an error, not a wait")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("probe took %s to give up; the timeout is not being applied", elapsed)
	}
}

// The shell owns the rules. If a key is added to or removed from the script's
// built-in map, this service and the lobby's dropdown are the things that go
// stale, and nothing fails loudly when they do — the option simply never
// appears, or appears and never runs.
func TestBuiltinCommandKeysMatchTheScript(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "devvm", "tmux-user-attach"))
	if err != nil {
		t.Skipf("tmux-user-attach not readable: %v", err)
	}
	src := string(b)
	if !strings.Contains(src, "BUILTIN_KEYS=(claude codex shell)") {
		t.Fatalf("tmux-user-attach no longer declares BUILTIN_KEYS=(claude codex shell).\n" +
			"Update builtinCommandKeys here and NEW_COMMANDS in the frontend to match.")
	}
	for _, k := range builtinCommandKeys {
		if !strings.Contains(src, k+")") {
			t.Errorf("key %q has no branch in the script's resolve_cmd", k)
		}
	}
}
