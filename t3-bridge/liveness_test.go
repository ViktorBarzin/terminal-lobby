package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"terminal-lobby/sessionio"
)

// attachEqualStrings is this area's slice comparison. It is deliberately not
// shared with the protocol tests: a helper reached across an ownership boundary
// is a merge conflict waiting to happen.
func attachEqualStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// The pin's whole contract with T3, in the shapes T3 actually reads. The chain
// is traced in liveness.go's header; these two frames are its input.
func TestPinFrameShapes(t *testing.T) {
	out := &attachSyncBuf{}
	p := newAttachPin(NewEncoder(out), attachTestID, "feat-header")

	if err := p.Sync(sessionio.StateRunning); err != nil {
		t.Fatalf("Sync running: %v", err)
	}
	if err := p.Sync(sessionio.StateDone); err != nil {
		t.Fatalf("Sync done: %v", err)
	}

	lines := strings.Split(strings.TrimSuffix(out.String(), "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("wrote %d lines, want an assert and a release:\n%s", len(lines), out.String())
	}

	var start map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &start); err != nil {
		t.Fatalf("assert frame: %v", err)
	}
	if start["type"] != "system" || start["subtype"] != "task_progress" {
		t.Fatalf("assert frame = %v, want system/task_progress", start)
	}
	for _, key := range []string{"task_id", "description", "uuid", "session_id"} {
		if v, ok := start[key].(string); !ok || v == "" {
			t.Fatalf("assert frame is missing %s: %v", key, start)
		}
	}
	if start["session_id"] != attachTestID {
		t.Fatalf("session_id = %v", start["session_id"])
	}
	// A zero token count would clobber the thread's usage display, so the
	// bridge reports no usage at all rather than a made-up one.
	if _, present := start["usage"]; present {
		t.Fatalf("assert frame carries usage: %v", start)
	}

	var stop map[string]any
	if err := json.Unmarshal([]byte(lines[1]), &stop); err != nil {
		t.Fatalf("release frame: %v", err)
	}
	if stop["type"] != "system" || stop["subtype"] != "task_updated" {
		t.Fatalf("release frame = %v, want system/task_updated", stop)
	}
	if stop["task_id"] != start["task_id"] {
		t.Fatalf("release names task %v, assert named %v", stop["task_id"], start["task_id"])
	}
	patch, ok := stop["patch"].(map[string]any)
	if !ok || patch["status"] != "completed" {
		t.Fatalf("release patch = %v, want status completed", stop["patch"])
	}
}

// One task id for the life of the bridge: T3 files the assert under a stable
// activity id keyed by task, so re-asserting updates one row instead of
// growing the thread a row per turn.
func TestPinReusesOneTaskID(t *testing.T) {
	out := &attachSyncBuf{}
	p := newAttachPin(NewEncoder(out), attachTestID, "feat-header")
	p.interval = 0 // assert on every Sync

	for i := 0; i < 3; i++ {
		if err := p.Sync(sessionio.StateRunning); err != nil {
			t.Fatalf("Sync: %v", err)
		}
	}
	ids := map[string]bool{}
	for _, line := range strings.Split(strings.TrimSuffix(out.String(), "\n"), "\n") {
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("frame: %v", err)
		}
		ids[m["task_id"].(string)] = true
	}
	if len(ids) != 1 {
		t.Fatalf("used %d task ids, want 1", len(ids))
	}
}

// The registry T3 keeps is in-memory and holds an entry until something
// terminal arrives, so re-asserting is only a refresh — and it is rate limited,
// because every assert costs T3 a projection write.
func TestPinRateLimitsItsAsserts(t *testing.T) {
	out := &attachSyncBuf{}
	p := newAttachPin(NewEncoder(out), attachTestID, "feat-header")
	p.interval = time.Minute
	now := time.Unix(0, 0)
	p.now = func() time.Time { return now }

	for i := 0; i < 5; i++ {
		if err := p.Sync(sessionio.StateRunning); err != nil {
			t.Fatalf("Sync: %v", err)
		}
	}
	if got := strings.Count(out.String(), "task_progress"); got != 1 {
		t.Fatalf("asserted %d times inside one interval, want 1", got)
	}

	now = now.Add(2 * time.Minute)
	if err := p.Sync(sessionio.StateRunning); err != nil {
		t.Fatalf("Sync: %v", err)
	}
	if got := strings.Count(out.String(), "task_progress"); got != 2 {
		t.Fatalf("asserted %d times over two intervals, want 2", got)
	}
}

// Only "running" holds the pin. Anything else — done, awaiting, or a session
// that never ran a Claude — releases it, so an idle thread neither shows
// Working nor keeps a bridge alive that has nothing to mirror.
func TestPinHeldOnlyWhileRunning(t *testing.T) {
	for _, tc := range []struct {
		name  string
		state string
		want  bool
	}{
		{"running holds", sessionio.StateRunning, true},
		{"awaiting releases", sessionio.StateAwaiting, false},
		{"done releases", sessionio.StateDone, false},
		{"unstamped releases", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out := &attachSyncBuf{}
			p := newAttachPin(NewEncoder(out), attachTestID, "feat-header")
			if err := p.Sync(tc.state); err != nil {
				t.Fatalf("Sync: %v", err)
			}
			if p.Held() != tc.want {
				t.Fatalf("state %q left held=%v, want %v", tc.state, p.Held(), tc.want)
			}
		})
	}
}

// Releasing a pin nobody is holding must write nothing: T3 would file a stray
// "Task completed" row against a task it never saw start.
func TestPinReleaseIsIdempotent(t *testing.T) {
	out := &attachSyncBuf{}
	p := newAttachPin(NewEncoder(out), attachTestID, "feat-header")
	for i := 0; i < 3; i++ {
		if err := p.Release(); err != nil {
			t.Fatalf("Release: %v", err)
		}
	}
	if out.String() != "" {
		t.Fatalf("released an unheld pin: %s", out.String())
	}

	if err := p.Sync(sessionio.StateRunning); err != nil {
		t.Fatalf("Sync: %v", err)
	}
	out.Reset()
	for i := 0; i < 3; i++ {
		if err := p.Release(); err != nil {
			t.Fatalf("Release: %v", err)
		}
	}
	if got := strings.Count(out.String(), "task_updated"); got != 1 {
		t.Fatalf("wrote %d releases, want 1", got)
	}
}

// A bridge that exits mid-turn must drop the pin on the way out, or the thread
// shows Working for a session nothing is watching.
func TestFollowReleasesThePinOnExit(t *testing.T) {
	r := newAttachRig(t)
	if err := r.tmux.SetOption("wizard", "feat-header", sessionio.OptionState, sessionio.StateRunning); err != nil {
		t.Fatalf("seed state: %v", err)
	}
	a := r.attacher()
	attachFollow(t, a, func() bool { return strings.Contains(r.out.String(), "task_progress") })
	if !strings.Contains(r.out.String(), "task_updated") {
		t.Fatalf("no release on exit:\n%s", r.out.String())
	}
}

// The pin follows the session's own state stamp, which is what makes it honest:
// it is held exactly while a turn is in flight in the pane, whoever started it.
func TestFollowPinsWhileTheSessionWorks(t *testing.T) {
	r := newAttachRig(t)
	a := r.attacher()
	setState := func(v string) {
		t.Helper()
		if err := r.tmux.SetOption("wizard", "feat-header", sessionio.OptionState, v); err != nil {
			t.Fatalf("set @claude_state=%s: %v", v, err)
		}
	}
	setState(sessionio.StateRunning)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- a.Follow(ctx) }()

	attachWaitFor(t, "the pin to be taken", func() bool {
		return strings.Contains(r.out.String(), "task_progress")
	})
	setState(sessionio.StateDone) // the turn finishes in the pane
	attachWaitFor(t, "the pin to be released", func() bool {
		return strings.Contains(r.out.String(), "task_updated")
	})

	cancel()
	if err := <-done; err != nil {
		t.Fatalf("Follow: %v", err)
	}
}
