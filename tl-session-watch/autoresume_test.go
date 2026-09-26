package main

import (
	"strings"
	"testing"
	"time"
)

var t0 = time.Date(2026, 9, 26, 21, 0, 0, 0, time.UTC)

func withClaude(name string, pids ...int) Session {
	s := live(name)
	s.ClaudePIDs = pids
	return s
}

func died(user, session string) Finding {
	return Finding{Kind: KindSessionDied, User: user, Session: session, State: "running"}
}

func TestASessionWhoseClaudeTheCapKilledIsResumed(t *testing.T) {
	r := NewResumer(time.Hour)
	r.Observe([]Snapshot{snap("wizard", "boot-1", withClaude("pi", 3908023))})
	r.Killed(3908023, t0)

	acts, notes := r.Decide([]Finding{died("wizard", "pi")}, t0)
	if len(acts) != 1 || acts[0].User != "wizard" || acts[0].Session != "pi" {
		t.Fatalf("want one resume of wizard/pi, got %+v", acts)
	}
	if len(notes) != 0 {
		t.Fatalf("want no notes, got %+v", notes)
	}
}

// A death with no cap kill behind it is someone's exit, earlyoom, or a crash.
// Only the pane cap is in scope.
func TestADeathWithoutACapKillIsNotResumed(t *testing.T) {
	r := NewResumer(time.Hour)
	r.Observe([]Snapshot{snap("wizard", "boot-1", withClaude("pi", 100))})
	r.Killed(999, t0) // some other claude

	if acts, _ := r.Decide([]Finding{died("wizard", "pi")}, t0); len(acts) != 0 {
		t.Fatalf("want no resume, got %+v", acts)
	}
}

// A session a restore made survives its claude as a bare shell, so the second
// kill reads as claude_died, reported only after the confirm ticks, by which
// time the pane no longer shows a claude. The pid seen while it lived is what
// ties the death to the kill.
func TestAClaudeDiedAfterTheConfirmTicksIsStillMatched(t *testing.T) {
	r := NewResumer(time.Hour)
	r.Observe([]Snapshot{snap("wizard", "boot-1", withClaude("infra", 55))})
	r.Killed(55, t0)
	shell := live("infra")
	shell.ClaudeAlive = false
	r.Observe([]Snapshot{snap("wizard", "boot-1", shell)})
	r.Observe([]Snapshot{snap("wizard", "boot-1", shell)})

	f := Finding{Kind: KindClaudeDied, User: "wizard", Session: "infra"}
	if acts, _ := r.Decide([]Finding{f}, t0.Add(time.Minute)); len(acts) != 1 {
		t.Fatalf("want a resume, got %+v", acts)
	}
}

func TestASecondCapKillWithinTheHourIsLeftDead(t *testing.T) {
	r := NewResumer(time.Hour)
	r.Observe([]Snapshot{snap("wizard", "boot-1", withClaude("pi", 1))})
	r.Killed(1, t0)
	r.Decide([]Finding{died("wizard", "pi")}, t0)

	r.Observe([]Snapshot{snap("wizard", "boot-1", withClaude("pi", 2))})
	r.Killed(2, t0.Add(20*time.Minute))
	acts, notes := r.Decide([]Finding{died("wizard", "pi")}, t0.Add(20*time.Minute))
	if len(acts) != 0 {
		t.Fatalf("want no second resume inside the hour, got %+v", acts)
	}
	if len(notes) != 1 || notes[0].Kind != KindResumeSkipped || notes[0].Session != "pi" {
		t.Fatalf("want one resume_skipped note, got %+v", notes)
	}

	r.Observe([]Snapshot{snap("wizard", "boot-1", withClaude("pi", 3))})
	r.Killed(3, t0.Add(61*time.Minute))
	if acts, _ := r.Decide([]Finding{died("wizard", "pi")}, t0.Add(61*time.Minute)); len(acts) != 1 {
		t.Fatalf("want a resume once the hour has passed, got %+v", acts)
	}
}

func TestTheHourIsPerSession(t *testing.T) {
	r := NewResumer(time.Hour)
	r.Observe([]Snapshot{
		snap("wizard", "boot-1", withClaude("a", 1), withClaude("b", 2)),
		snap("emo", "boot-1", withClaude("a", 3)),
	})
	r.Killed(1, t0)
	r.Killed(2, t0)
	r.Killed(3, t0)
	acts, _ := r.Decide([]Finding{died("wizard", "a"), died("wizard", "b"), died("emo", "a")}, t0)
	if len(acts) != 3 {
		t.Fatalf("want three independent resumes, got %+v", acts)
	}
}

// Kill records are only useful for the tick or two after the kill. Holding them
// forever would let a pid the kernel later reuses for a new claude match a kill
// from last week.
func TestOldKillsAreForgotten(t *testing.T) {
	r := NewResumer(time.Hour)
	r.Killed(9, t0)
	r.Observe([]Snapshot{snap("wizard", "boot-1", withClaude("x", 9))})
	if acts, _ := r.Decide([]Finding{died("wizard", "x")}, t0.Add(20*time.Minute)); len(acts) != 0 {
		t.Fatalf("want a stale kill ignored, got %+v", acts)
	}
}

// Other findings pass through untouched.
func TestOnlyDeathsAreConsidered(t *testing.T) {
	r := NewResumer(time.Hour)
	r.Observe([]Snapshot{snap("wizard", "boot-1", withClaude("x", 9))})
	r.Killed(9, t0)
	f := Finding{Kind: KindSessionKilled, User: "wizard", Session: "x"}
	if acts, _ := r.Decide([]Finding{f}, t0); len(acts) != 0 {
		t.Fatalf("a deliberate kill is not resumed, got %+v", acts)
	}
}

func TestTheResumeMessageSaysWhatHappened(t *testing.T) {
	for _, want := range []string{"memory", "resumed automatically", "background agents", "leftovers", "within the hour"} {
		if !strings.Contains(resumeMessage, want) {
			t.Errorf("want %q in the message", want)
		}
	}
}

func TestResumeLinesAreLogfmt(t *testing.T) {
	got := Line(Finding{Kind: KindSessionResumed, User: "wizard", Session: "pi"})
	if got != "event=session_resumed user=wizard session=pi" {
		t.Fatalf("got %q", got)
	}
}
