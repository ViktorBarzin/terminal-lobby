package main

import (
	"os/user"
	"testing"
)

// The session browser's host stamps @tl_browser from inside the session, with
// `tmux set-option -t $TMUX_PANE`, a PANE target with no -p
// (tl-browser/host/lib/tmux.mjs). This checks against a real tmux server that
// such a stamp lands where list-sessions reads it, and that unsetting it with
// -u clears it, which a stub cannot say. Skipped when tmux is missing.
func TestBrowserStampFromThePaneReachesTheList(t *testing.T) {
	tmux := withRealTmux(t)
	me, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	if out, err := tmux("new-session", "-d", "-s", "k7m2q9x4tpz3"); err != nil {
		t.Fatalf("creating the session: %v: %s", err, out)
	}
	pane, err := tmux("display-message", "-p", "-t", "=k7m2q9x4tpz3:", "#{pane_id}")
	if err != nil {
		t.Fatalf("pane id: %v", err)
	}
	browserOf := func() string {
		for _, s := range liveSessions(t, me.Username) {
			if s.Name == "k7m2q9x4tpz3" {
				return s.Browser
			}
		}
		t.Fatal("the session is not listed")
		return ""
	}
	if got := browserOf(); got != "" {
		t.Fatalf("before any stamp: %q", got)
	}
	for _, state := range []string{"live", "frozen"} {
		if out, err := tmux("set-option", "-t", pane, browserOption, state); err != nil {
			t.Fatalf("stamping %s: %v: %s", state, err, out)
		}
		if got := browserOf(); got != state {
			t.Fatalf("after stamping %s from the pane: %q", state, got)
		}
	}
	if out, err := tmux("set-option", "-u", "-t", pane, browserOption); err != nil {
		t.Fatalf("unsetting: %v: %s", err, out)
	}
	if got := browserOf(); got != "" {
		t.Fatalf("after unsetting: %q", got)
	}
}
