package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func titlesFixture(t *testing.T) *titleStore {
	t.Helper()
	return newTitleStore(t.TempDir())
}

func TestTitleStoreRoundTrip(t *testing.T) {
	s := titlesFixture(t)
	if got := s.get("wizard", "work"); got != "" {
		t.Fatalf("an unwritten title reads back %q, want empty", got)
	}
	if err := s.set("wizard", "work", "Deploy the thing 🚀"); err != nil {
		t.Fatalf("set: %v", err)
	}
	if got := s.get("wizard", "work"); got != "Deploy the thing 🚀" {
		t.Fatalf("get = %q", got)
	}
	// One user's titles are their own; the store is per-user like the layout.
	if got := s.get("bob", "work"); got != "" {
		t.Fatalf("bob sees wizard's title: %q", got)
	}
}

func TestTitleStoreSetReplacesAndClears(t *testing.T) {
	s := titlesFixture(t)
	mustSet(t, s, "wizard", "work", "First")
	mustSet(t, s, "wizard", "work", "Second")
	if got := s.get("wizard", "work"); got != "Second" {
		t.Fatalf("a re-set title reads back %q, want the latest", got)
	}
	// Clearing a title is how a session goes back to showing its name, so an
	// empty set must REMOVE the entry rather than store an empty string that a
	// restore would then re-stamp.
	mustSet(t, s, "wizard", "work", "")
	if got := s.get("wizard", "work"); got != "" {
		t.Fatalf("a cleared title reads back %q", got)
	}
	raw, err := os.ReadFile(filepath.Join(s.dir, "wizard.json"))
	if err != nil {
		t.Fatalf("reading the store: %v", err)
	}
	if strings.Contains(string(raw), "work") {
		t.Fatalf("a cleared title left its entry behind: %s", raw)
	}
}

// A rename has to carry the title with it, or the session comes back from a
// restore under its new name with the old name's title missing.
func TestTitleStoreRenameCarriesTheTitle(t *testing.T) {
	s := titlesFixture(t)
	mustSet(t, s, "wizard", "deploy-the-thing", "Deploy the thing")
	if err := s.rename("wizard", "deploy-the-thing", "fix-the-parser"); err != nil {
		t.Fatalf("rename: %v", err)
	}
	if got := s.get("wizard", "fix-the-parser"); got != "Deploy the thing" {
		t.Fatalf("the title did not follow the rename: %q", got)
	}
	if got := s.get("wizard", "deploy-the-thing"); got != "" {
		t.Fatalf("the old name kept a title: %q", got)
	}
}

func TestTitleStoreRenameOfAnUntitledSessionIsHarmless(t *testing.T) {
	s := titlesFixture(t)
	if err := s.rename("wizard", "absent", "also-absent"); err != nil {
		t.Fatalf("renaming an untitled session: %v", err)
	}
	if got := s.get("wizard", "also-absent"); got != "" {
		t.Fatalf("a title appeared from nowhere: %q", got)
	}
}

func TestTitleStoreForget(t *testing.T) {
	s := titlesFixture(t)
	mustSet(t, s, "wizard", "work", "Work")
	mustSet(t, s, "wizard", "other", "Other")
	if err := s.forget("wizard", "work"); err != nil {
		t.Fatalf("forget: %v", err)
	}
	if got := s.get("wizard", "work"); got != "" {
		t.Fatalf("a forgotten title survives: %q", got)
	}
	if got := s.get("wizard", "other"); got != "Other" {
		t.Fatalf("forget took an unrelated title too: %q", got)
	}
}

// The store outlives the sessions it describes on purpose — that is what makes
// a title survive a reboot — so something has to stop it growing forever. An
// entry goes when its session is deliberately killed; what accumulates is
// titles of sessions that died without one and were never restored.
func TestTitleStoreStaysWithinItsBudget(t *testing.T) {
	s := titlesFixture(t)
	for i := 0; i < titlesKeep+50; i++ {
		mustSet(t, s, "wizard", fmt.Sprintf("session-%d", i), fmt.Sprintf("Title %d", i))
	}
	set, err := s.loadForTest("wizard")
	if err != nil {
		t.Fatal(err)
	}
	if len(set.Titles) != titlesKeep {
		t.Fatalf("store holds %d entries, want the %d budget", len(set.Titles), titlesKeep)
	}
	// The OLDEST go first: the newest writes are the sessions most likely to
	// still be restorable.
	if got := s.get("wizard", "session-0"); got != "" {
		t.Errorf("the oldest entry survived the prune: %q", got)
	}
	if got := s.get("wizard", fmt.Sprintf("session-%d", titlesKeep+49)); got == "" {
		t.Error("the newest entry was pruned")
	}
}

// A session that is merely NOT RUNNING must keep its title — that is exactly
// the session a restore is about to bring back, and it is why the bound is a
// generous count rather than "is this name live right now".
func TestTitleStoreKeepsTitlesOfSessionsThatAreNotRunning(t *testing.T) {
	s := titlesFixture(t)
	mustSet(t, s, "wizard", "long-dead-but-restorable", "Still wanted")
	for i := 0; i < 50; i++ {
		mustSet(t, s, "wizard", fmt.Sprintf("other-%d", i), "Other")
	}
	if got := s.get("wizard", "long-dead-but-restorable"); got != "Still wanted" {
		t.Errorf("a dormant session lost its title: %q", got)
	}
}

// A corrupt file degrades to "no titles" rather than failing the request that
// touched it: a title is a convenience on top of the name, and losing one must
// not break a rename or a restore.
func TestTitleStoreCorruptFileReadsEmpty(t *testing.T) {
	s := titlesFixture(t)
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.dir, "wizard.json"), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := s.get("wizard", "work"); got != "" {
		t.Fatalf("corrupt store returned %q", got)
	}
	// …and a write over it recovers rather than compounding the damage.
	mustSet(t, s, "wizard", "work", "Recovered")
	if got := s.get("wizard", "work"); got != "Recovered" {
		t.Fatalf("could not write over a corrupt store: %q", got)
	}
}

func TestTitleStoreWritesPrivateFiles(t *testing.T) {
	s := titlesFixture(t)
	mustSet(t, s, "wizard", "work", "Work")
	info, err := os.Stat(filepath.Join(s.dir, "wizard.json"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("title store mode = %o, want 600", perm)
	}
}

func mustSet(t *testing.T, s *titleStore, osUser, name, title string) {
	t.Helper()
	if err := s.set(osUser, name, title); err != nil {
		t.Fatalf("set(%s, %s, %q): %v", osUser, name, title, err)
	}
}
