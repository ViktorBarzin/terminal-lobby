package main

import (
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"

	"terminal-lobby/sessionio"
)

var errFake = errors.New("capture-pane: no such session")

// fakePane records what the refresher did to a pane, and lets a test say what
// the pane looked like when it asked.
type fakePane struct {
	mu       sync.Mutex
	state    string
	pane     string
	captErr  error
	prompted []string
}

func (f *fakePane) State(osUser, session string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.state
}

func (f *fakePane) CapturePane(osUser, session string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.pane, f.captErr
}

func (f *fakePane) Prompt(osUser, session, text string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.prompted = append(f.prompted, text)
	return nil
}

func (f *fakePane) sent() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.prompted)
}

const idlePane = "────────\n❯ \n────────\n  ⏵⏵ bypass permissions on\n"
const draftPane = "────────\n❯ half a thought I have not sent\n────────\n"

// The refresh is the one thing in this service that WRITES to a pane on its own
// schedule rather than because somebody clicked. Every condition below is a
// reason not to.
func TestRefreshOnlyRunsWhenEveryConditionHolds(t *testing.T) {
	for _, tc := range []struct {
		name  string
		state string
		pane  string
		want  bool
	}{
		{"idle session with an empty composer", sessionio.StateDone, idlePane, true},
		{
			// Claude is mid-turn. Typed input would be QUEUED and run after,
			// which is not a refresh, it is a prompt nobody wrote.
			"a running turn", sessionio.StateRunning, idlePane, false,
		},
		{
			// Awaiting means something is blocking on a human — a dialog is up.
			// Typing here would answer it.
			"a session awaiting input", sessionio.StateAwaiting, idlePane, false,
		},
		{
			// An unstamped session never ran Claude at all; it is a plain shell.
			"an unstamped session", "", idlePane, false,
		},
		{"an unsent draft in the composer", sessionio.StateDone, draftPane, false},
		{"a pane we cannot recognise", sessionio.StateDone, "who knows\n", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fp := &fakePane{state: tc.state, pane: tc.pane}
			r := newRefresher(fp)
			r.refresh("wizard", "demo")

			sent := fp.sent()
			if tc.want && len(sent) != 1 {
				t.Fatalf("expected one refresh, got %v", sent)
			}
			if !tc.want && len(sent) != 0 {
				t.Fatalf("expected no refresh, got %v", sent)
			}
			if tc.want && !strings.Contains(sent[0], "/context") {
				t.Errorf("refreshed with %q, want /context", sent[0])
			}
		})
	}
}

// A capture that errors must not be read as "the composer is empty".
func TestRefreshSkipsWhenThePaneCannotBeRead(t *testing.T) {
	fp := &fakePane{state: sessionio.StateDone, pane: idlePane, captErr: errFake}
	r := newRefresher(fp)
	r.refresh("wizard", "demo")
	if got := fp.sent(); len(got) != 0 {
		t.Fatalf("refreshed despite an unreadable pane: %v", got)
	}
}

// The refresh is owned by the SERVER, one per session — three devices watching
// the same session must not mean three commands in its pane.
func TestRefreshIsOncePerSessionNotOncePerViewer(t *testing.T) {
	fp := &fakePane{state: sessionio.StateDone, pane: idlePane}
	r := newRefresher(fp)

	for range 3 {
		r.attach("wizard", "demo")
	}
	r.wait()
	if got := fp.sent(); len(got) != 1 {
		t.Fatalf("three viewers produced %d refreshes: %v", len(got), got)
	}

	// The last viewer leaving stops the watch; a viewer arriving afterwards
	// starts a fresh one, which is a new open and gets its own reading.
	for range 3 {
		r.detach("wizard", "demo")
	}
	r.attach("wizard", "demo")
	r.wait()
	if got := fp.sent(); len(got) != 2 {
		t.Fatalf("re-opening produced %d refreshes total: %v", len(got), got)
	}
}

// Nothing may touch a session nobody is watching. This is the reach lesson of
// 575d4f5, where a mechanism acting on unwatched sessions cost every user on the
// box; the shape it took there was a hook, but the rule is about reach.
func TestRefreshNeverTouchesAnUnwatchedSession(t *testing.T) {
	fp := &fakePane{state: sessionio.StateDone, pane: idlePane}
	r := newRefresher(fp)

	r.attach("wizard", "demo")
	r.wait()
	r.detach("wizard", "demo")

	// A turn settling in a session with no viewer must produce nothing.
	r.turnSettled("wizard", "demo", 10)
	r.wait()
	if got := fp.sent(); len(got) != 1 {
		t.Fatalf("an unwatched session was refreshed: %v", got)
	}
}

// While a viewer IS watching, each settled turn gets a reading — that is what
// makes the meter current at the moment a reader looks at a finished turn.
func TestRefreshRunsWhenATurnSettles(t *testing.T) {
	fp := &fakePane{state: sessionio.StateDone, pane: idlePane}
	r := newRefresher(fp)

	r.attach("wizard", "demo")
	r.wait()
	r.turnSettled("wizard", "demo", 10)
	r.wait()
	r.turnSettled("wizard", "demo", 20)
	r.wait()

	if got := fp.sent(); len(got) != 3 {
		t.Fatalf("open + two settled turns produced %d refreshes: %v", len(got), got)
	}
}

// Every attached viewer sees the same turn_end on its own stream and reports it.
// One finished turn is one reading, however many devices are watching.
func TestRefreshRunsOncePerTurnNotOncePerStream(t *testing.T) {
	fp := &fakePane{state: sessionio.StateDone, pane: idlePane}
	r := newRefresher(fp)

	r.attach("wizard", "demo")
	r.attach("wizard", "demo")
	r.attach("wizard", "demo")
	r.wait()

	// Three streams, one turn.
	for range 3 {
		r.turnSettled("wizard", "demo", 42)
	}
	r.wait()

	if got := fp.sent(); len(got) != 2 { // one on open, one for the turn
		t.Fatalf("one turn across three streams produced %d refreshes: %v", len(got), got)
	}
}
