package main

import (
	"strings"
	"testing"
	"time"
)

// emo's crash on 2026-11-01, as the watcher saw it: thirteen sessions in one
// tick, none the next, every one a session_died.
func emoCrash(t *testing.T) (*Watcher, []Finding, []Snapshot) {
	t.Helper()
	w := NewWatcher(Config{ConfirmTicks: 2, SkipPrefixes: []string{"__terminal_lobby_"}})
	var before []Session
	for _, n := range []string{"3d_printer", "marinov", "nova-kamera", "revolut-card-renewal"} {
		before = append(before, live(n))
	}
	w.Tick([]Snapshot{snap("emo", "boot-1", before...)})
	after := []Snapshot{snap("emo", "boot-1")}
	return w, w.Tick(after), after
}

func TestAServerThatDiesWithItsSessionsIsRestored(t *testing.T) {
	_, findings, after := emoCrash(t)
	r := NewServerRestorer(time.Hour)

	users, notes := r.Decide(findings, after, t0)
	if len(users) != 1 || users[0] != "emo" {
		t.Fatalf("want a restore of emo's server, got %v", users)
	}
	if len(notes) != 1 || notes[0].Kind != KindServerDied || notes[0].User != "emo" || notes[0].Before != 4 {
		t.Fatalf("want one server_died for emo with before=4, got %+v", notes)
	}
}

// One session ending while it is the user's only one also leaves them with no
// sessions, and tmux exits with it. That is someone typing /exit, not a crash,
// and bringing it back would undo what they did.
func TestTheLastSessionEndingAloneIsNotACrash(t *testing.T) {
	w := NewWatcher(Config{ConfirmTicks: 2})
	w.Tick([]Snapshot{snap("emo", "boot-1", live("only"))})
	after := []Snapshot{snap("emo", "boot-1")}
	findings := w.Tick(after)

	if users, notes := NewServerRestorer(time.Hour).Decide(findings, after, t0); len(users) != 0 || len(notes) != 0 {
		t.Fatalf("want nothing, got users=%v notes=%+v", users, notes)
	}
}

// Sessions killed on purpose through the lobby leave tombstones and read as
// session_killed. Killing everything is a choice, not a crash.
func TestKillingEverySessionOnPurposeIsNotACrash(t *testing.T) {
	w := NewWatcher(Config{ConfirmTicks: 2})
	w.Tick([]Snapshot{snap("emo", "boot-1", live("a"), live("b"), live("c"))})
	after := []Snapshot{forgot(forgot(forgot(snap("emo", "boot-1"), "a", 5), "b", 5), "c", 5)}
	findings := w.Tick(after)

	if users, _ := NewServerRestorer(time.Hour).Decide(findings, after, t0); len(users) != 0 {
		t.Fatalf("want no restore after deliberate kills, got %v", users)
	}
}

// Several sessions dying while others live on is a different failure, a box
// OOM say, and the server is still up to show it.
func TestDeathsWithSessionsStillLiveAreNotAServerCrash(t *testing.T) {
	w := NewWatcher(Config{ConfirmTicks: 2})
	w.Tick([]Snapshot{snap("emo", "boot-1", live("a"), live("b"), live("c"))})
	after := []Snapshot{snap("emo", "boot-1", live("c"))}
	findings := w.Tick(after)

	if users, _ := NewServerRestorer(time.Hour).Decide(findings, after, t0); len(users) != 0 {
		t.Fatalf("want no restore while the server is up, got %v", users)
	}
}

// A server that crashes again within the hour is left down: something about it
// is crashing it, and a restore loop would only hide that.
func TestASecondCrashWithinTheHourIsNotRestoredAgain(t *testing.T) {
	_, findings, after := emoCrash(t)
	r := NewServerRestorer(time.Hour)
	if users, _ := r.Decide(findings, after, t0); len(users) != 1 {
		t.Fatalf("first crash: want a restore, got %v", users)
	}

	users, notes := r.Decide(findings, after, t0.Add(20*time.Minute))
	if len(users) != 0 {
		t.Fatalf("second crash inside the hour: want no restore, got %v", users)
	}
	var skipped bool
	for _, n := range notes {
		if n.Kind == KindResumeSkipped && n.User == "emo" && n.Session == "" {
			skipped = true
		}
	}
	if !skipped {
		t.Fatalf("want a resume_skipped for emo's server, got %+v", notes)
	}

	if users, _ := r.Decide(findings, after, t0.Add(61*time.Minute)); len(users) != 1 {
		t.Fatalf("after the hour: want a restore again, got %v", users)
	}
}

// The restore runs as a transient system unit, not as a child of the watcher.
// A tmux server started from inside the watcher's sandbox would see a
// read-only home and sit in its 128M cgroup.
func TestServerRestoreRunsOutsideTheWatcher(t *testing.T) {
	argv := serverRestoreArgv("/usr/local/bin/tmux-persist", "emo", t0)
	got := strings.Join(argv, " ")
	if argv[0] != systemdRunBinary {
		t.Fatalf("want systemd-run, got %q", got)
	}
	if !strings.HasSuffix(got, " /usr/local/bin/tmux-persist restore emo") {
		t.Fatalf("want it to end in `tmux-persist restore emo`, got %q", got)
	}
	if !strings.Contains(got, "--unit=tl-server-restore-emo-") || !strings.Contains(got, "--collect") {
		t.Fatalf("want a named, collected transient unit, got %q", got)
	}
}

func TestServerDiedLineCarriesTheCount(t *testing.T) {
	got := Line(Finding{Kind: KindServerDied, User: "emo", Before: 13})
	if got != "event=server_died user=emo before=13" {
		t.Fatalf("got %q", got)
	}
}
