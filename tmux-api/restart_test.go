package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"terminal-lobby/authuser"
	"terminal-lobby/sessionio"
)

// A restart is asked for by a person looking at the session, so the sweep's
// exclusions that protect somebody's work do not apply: the card has already
// asked "this cuts the current turn" before a busy session gets here. What
// still refuses is a session that is already suspended (the resume is the way
// back) and a turn a Caller is running over HTTP, which agent-api is waiting on
// and would never see finish.
func TestRestartPolicy(t *testing.T) {
	now := time.Unix(testNow, 0)
	for _, c := range []struct {
		why     string
		facts   paneFacts
		decline bool
	}{
		{"an idle session", paneFacts{state: stateDone}, false},
		{"a session somebody has on screen", paneFacts{state: stateDone, attached: 1}, false},
		{"a session mid-turn", paneFacts{state: stateRunning, attached: 1}, false},
		{"a session waiting on a question", paneFacts{state: stateAwaiting}, false},
		{"a Caller's idle conversation", paneFacts{state: stateDone, agentOwner: "muse", agentLastTurn: testNow}, false},
		{"a suspended session", paneFacts{state: stateDone, suspendedAt: testNow - 60}, true},
		{"a Caller's turn in flight", paneFacts{state: stateRunning, agentOwner: "muse"}, true},
	} {
		t.Run(c.why, func(t *testing.T) {
			why, got := restartPolicy.decline(c.facts, now)
			if got != c.decline {
				t.Fatalf("decline = %v (%q), want %v", got, why, c.decline)
			}
		})
	}
}

// The whole restart against a REAL tmux server: a session mid-turn with a
// client on it, which the sweep would never touch, is stopped and comes back
// running the same command on the same conversation, in the same tmux session.
func TestRestartAgainstRealTmux(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	tmux := withRealTmux(t)
	rec := withTelemetry(t)
	transcript := withFakeTranscript(t, testUUID)
	claude := fakeClaudeScript(t)

	const name = "r7m2q9x4tpz3"
	if out, err := tmux("new-session", "-d", "-s", name, "/bin/sh", "-c", claude+" --effort max; :"); err != nil {
		t.Fatalf("new-session: %v: %s", err, out)
	}
	for _, kv := range [][2]string{
		{sessionio.OptionTranscript, transcript},
		{sessionio.OptionState, stateRunning},
		{sessionio.OptionBackground, "a8574b6e73ce517a0"},
	} {
		if out, err := tmux("set-option", "-t", exactPane(name), kv[0], kv[1]); err != nil {
			t.Fatalf("stamping %s: %v: %s", kv[0], err, out)
		}
	}
	waitUntil(t, 3*time.Second, func() bool {
		return liveSessionNamed(t, osSelf, name).Tool == toolClaude
	}, "the fake claude never appeared under the pane")
	before, ok := liveSuspendOps.inspect(mustPanePID(t, osSelf, name))
	if !ok {
		t.Fatal("no claude under the pane before the restart")
	}

	w := httptest.NewRecorder()
	restartSession(w, osSelf, name)
	if w.Code != http.StatusOK {
		t.Fatalf("restart = %d, want 200: %s", w.Code, w.Body)
	}

	// The session is the same tmux session, with a NEW claude in it.
	if out, err := tmux("has-session", "-t", exactSession(name)); err != nil {
		t.Fatalf("the session did not survive the restart: %v: %s", err, out)
	}
	var after procFacts
	waitUntil(t, 5*time.Second, func() bool {
		f, ok := liveSuspendOps.inspect(mustPanePID(t, osSelf, name))
		after = f
		return ok && f.claudePID != before.claudePID
	}, "the restarted pane never got a new claude")
	if !procGone(procRoot, before.claudePID) {
		t.Fatalf("the old claude %d is still running", before.claudePID)
	}
	// Same command, same flags, on the same conversation.
	want := []string{"/bin/sh", "-c", claude + " --resume " + testUUID + " --effort max; :"}
	if strings.Join(after.argv, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("the restarted pane runs\n  %q\nwant\n  %q", after.argv, want)
	}

	// Nothing of the suspend it went through is left on the session. Read once
	// the LIST sees the claude, because clearDeadStates blanks the state of a
	// session it last saw with no claude under the pane.
	waitUntil(t, 5*time.Second, func() bool {
		return liveSessionNamed(t, osSelf, name).Tool == toolClaude
	}, "the list never saw the restarted claude")
	got := liveSessionNamed(t, osSelf, name)
	if got.SuspendedAt != 0 || got.State == stateSuspended {
		t.Fatalf("the restarted session still reads suspended: %+v", got)
	}
	// A restarted claude sits at its prompt, whatever the old one was doing.
	if got.State != stateDone {
		t.Fatalf("State = %q after the restart, want %q", got.State, stateDone)
	}
	if v, _ := tmux("show-options", "-w", "-t", exactPane(name), "remain-on-exit"); strings.Contains(v, "on") {
		t.Fatalf("remain-on-exit is still on after the restart: %q", v)
	}
	for _, opt := range []string{resumeCmdOption, suspendedOption} {
		if v, _ := tmux("display-message", "-p", "-t", exactPane(name), "#{"+opt+"}"); v != "" {
			t.Fatalf("%s = %q after the restart, want it cleared", opt, v)
		}
	}

	// Its own event, not session.suspended: the sweep's numbers argue the
	// idle threshold, and a person's restart is not an idle session.
	var restarted, suspended bool
	for _, l := range rec.lines {
		restarted = restarted || strings.Contains(l, `"session.restarted"`)
		suspended = suspended || strings.Contains(l, `"session.suspended"`)
	}
	if !restarted || suspended {
		t.Fatalf("events: restarted=%v suspended=%v, want only session.restarted: %v", restarted, suspended, rec.lines)
	}
}

// What a restart refuses, against a real server, with nothing touched.
func TestRestartRefusalsAgainstRealTmux(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	tmux := withRealTmux(t)
	withTelemetry(t)

	t.Run("no such session", func(t *testing.T) {
		w := httptest.NewRecorder()
		restartSession(w, osSelf, "nosuchsession")
		if w.Code != http.StatusNotFound {
			t.Fatalf("restart = %d, want 404: %s", w.Code, w.Body)
		}
	})

	t.Run("a plain shell", func(t *testing.T) {
		const name = "r7m2q9x4tpz4"
		if out, err := tmux("new-session", "-d", "-s", name, "/bin/sh", "-c", "exec sleep 600"); err != nil {
			t.Fatalf("new-session: %v: %s", err, out)
		}
		w := httptest.NewRecorder()
		restartSession(w, osSelf, name)
		if w.Code != http.StatusConflict {
			t.Fatalf("restart = %d, want 409: %s", w.Code, w.Body)
		}
	})

	t.Run("a claude with no conversation yet", func(t *testing.T) {
		// No transcript stamp: `claude --resume` would find nothing, exit, and
		// take the session with it.
		claude := fakeClaudeScript(t)
		const name = "r7m2q9x4tpz5"
		if out, err := tmux("new-session", "-d", "-s", name, "/bin/sh", "-c", claude+"; :"); err != nil {
			t.Fatalf("new-session: %v: %s", err, out)
		}
		waitUntil(t, 3*time.Second, func() bool {
			return liveSessionNamed(t, osSelf, name).Tool == toolClaude
		}, "the fake claude never appeared under the pane")
		pid := mustPanePID(t, osSelf, name)
		w := httptest.NewRecorder()
		restartSession(w, osSelf, name)
		if w.Code != http.StatusConflict {
			t.Fatalf("restart = %d, want 409: %s", w.Code, w.Body)
		}
		if _, ok := liveSuspendOps.inspect(pid); !ok {
			t.Fatal("the claude was stopped anyway")
		}
	})
}

func mustPanePID(t *testing.T, osUser, name string) int {
	t.Helper()
	f, ok := liveSuspendOps.pane(osUser, name)
	if !ok {
		t.Fatalf("%s has no readable pane", name)
	}
	return f.pid
}

// The route reaches the handler on POST and nothing else: a GET that
// restarted a session would let a prefetch or a crawler cut somebody's turn.
func TestRestartRouteIsPostOnly(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "authself="+osSelf+"\n")
	tmux := withRealTmux(t)
	withTelemetry(t)

	for _, method := range []string{http.MethodGet, http.MethodDelete, http.MethodPut} {
		req := httptest.NewRequest(method, "/sessions/r7m2q9x4tpz6/restart", nil)
		req.Header.Set(authuser.DefaultAuthHeader, "authself")
		rec := httptest.NewRecorder()
		handleSessionByName(rec, req)
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s /sessions/{name}/restart = %d, want 405", method, rec.Code)
		}
	}

	// POST reaches restartSession, which answers 409 for a plain shell.
	if out, err := tmux("new-session", "-d", "-s", "r7m2q9x4tpz6", "/bin/sh", "-c", "exec sleep 600"); err != nil {
		t.Fatalf("new-session: %v: %s", err, out)
	}
	req := httptest.NewRequest(http.MethodPost, "/sessions/r7m2q9x4tpz6/restart", nil)
	req.Header.Set(authuser.DefaultAuthHeader, "authself")
	rec := httptest.NewRecorder()
	handleSessionByName(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("POST /sessions/{name}/restart on a shell = %d, want 409: %s", rec.Code, rec.Body)
	}
}
