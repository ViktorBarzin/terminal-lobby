package main

import "testing"

// What a mirrored T3 thread is called.
//
// Decision 7 is "one name, so both lists read as the same sessions". Until
// session titles there was only one name to use — the tmux name — and T3's
// descriptive titles were squeezed into 32 characters of [A-Za-z0-9_-] to
// match it. Now the lobby has a title, and that is the better name to agree on.

func TestThreadTitlePrefersTheSessionTitle(t *testing.T) {
	c := Candidate{TmuxName: "deploy-the-thing", Title: "Deploy the thing 🚀"}
	if got := c.ThreadTitle(); got != "Deploy the thing 🚀" {
		t.Errorf("ThreadTitle() = %q, want the session's title", got)
	}
}

func TestThreadTitleFallsBackToTheTmuxName(t *testing.T) {
	// Most sessions have never been titled, and a T3-born one never is: the
	// bridge names it after the workspace root. Both land here.
	for _, c := range []Candidate{
		{TmuxName: "work"},
		{TmuxName: "work", Title: ""},
	} {
		if got := c.ThreadTitle(); got != "work" {
			t.Errorf("ThreadTitle(%+v) = %q, want the tmux name", c, got)
		}
	}
}

// The reconciler compares a thread's title against ThreadTitle() to decide
// whether to correct it. A session whose title matches must produce no rename,
// or the syncer would push the same string every five seconds.
func TestPlanDoesNotRenameAThreadAlreadyTitledCorrectly(t *testing.T) {
	c := Candidate{TmuxName: "deploy-the-thing", Title: "Deploy the thing"}
	if c.ThreadTitle() != "Deploy the thing" {
		t.Fatalf("fixture: ThreadTitle() = %q", c.ThreadTitle())
	}
	// Titling a session changes what the thread should be called, so a thread
	// still carrying the tmux name IS a correction worth making.
	if c.ThreadTitle() == c.TmuxName {
		t.Error("a titled session should not agree with its tmux name here")
	}
}
