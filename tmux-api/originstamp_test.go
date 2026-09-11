package main

import (
	"strings"
	"testing"
)

// The one-shot pass that stamps @tl_origin=user onto the sessions that were
// already running when origins shipped. Everything here is hermetic: tmux is a
// stub recording its argv, so the assertions are about which sessions the pass
// decides to touch, which is the whole of its behaviour.

func TestGrandfatherStampsAnUnattributedSession(t *testing.T) {
	actAs(t, "wizard")
	argv := withTmuxStub(t, "exit 0")

	stamped, failed := grandfatherUserOrigins("wizard", []Session{
		{ID: "$1", Name: "k7m2q9x4tp0v", Title: "Deploy the thing"},
	})
	if stamped != 1 || failed != 0 {
		t.Fatalf("stamped=%d failed=%d, want 1 and 0", stamped, failed)
	}

	got := recordedArgv(t, argv)
	// The pane target form, not the session one: set-option's -t takes a pane,
	// and the '=' stops a bare name resolving by prefix onto a sibling.
	for _, want := range []string{"set-option", "-t", "=k7m2q9x4tp0v:", originOption, originUser} {
		if !strings.Contains(got, want+"\n") {
			t.Errorf("argv missing %q:\n%s", want, got)
		}
	}
}

// Never overwrite. `test` is what a harness wrote about its own session, and a
// pass that stamped over it would undo the marking on every service restart —
// which is exactly when a QA fleet's sessions are most likely to be alive.
func TestGrandfatherLeavesAStampedSessionAlone(t *testing.T) {
	actAs(t, "wizard")
	argv := withTmuxStub(t, "exit 0")

	stamped, failed := grandfatherUserOrigins("wizard", []Session{
		{ID: "$1", Name: "k7m2q9x4tp0v", Origin: originUser},
		{ID: "$2", Name: "b3n8h1x5r2wq", Origin: originTest},
	})
	if stamped != 0 || failed != 0 {
		t.Fatalf("stamped=%d failed=%d, want 0 and 0", stamped, failed)
	}
	if got := recordedArgv(t, argv); got != "" {
		t.Errorf("touched tmux for sessions that already carry an origin:\n%s", got)
	}
}

// A reserved name is forced system by isSystemSession whatever the option says
// (origin.go), so stamping one `user` would write a value nothing reads — and
// would read, to anyone looking at the option later, as the lobby claiming it
// made a harness session.
func TestGrandfatherLeavesAReservedNameUnstamped(t *testing.T) {
	actAs(t, "wizard")
	argv := withTmuxStub(t, "exit 0")

	stamped, failed := grandfatherUserOrigins("wizard", []Session{
		{ID: "$1", Name: "qa-slug"},
		{ID: "$2", Name: "t3e2e-42"},
		{ID: "$3", Name: "tlp-t7"},
		{ID: "$4", Name: poolSlotPrefix + "home_wizard"},
	})
	if stamped != 0 || failed != 0 {
		t.Fatalf("stamped=%d failed=%d, want 0 and 0", stamped, failed)
	}
	if got := recordedArgv(t, argv); got != "" {
		t.Errorf("touched tmux for reserved names:\n%s", got)
	}
}

// A session tmux will not stamp (it died between the list and the set-option)
// must not stop the rest, the way one unrenamable session does not stop the id
// migration.
func TestGrandfatherKeepsGoingPastASessionItCannotStamp(t *testing.T) {
	actAs(t, "wizard")
	// Fails the FIRST call only, so the second session still gets its stamp.
	argv := withTmuxStub(t, `if [ ! -f "$0.seen" ]; then : > "$0.seen"; echo "no such session: =gone:" >&2; exit 1; fi; exit 0`)

	out := captureLog(t, func() {
		stamped, failed := grandfatherUserOrigins("wizard", []Session{
			{ID: "$1", Name: "gone"},
			{ID: "$2", Name: "alive"},
		})
		if stamped != 1 || failed != 1 {
			t.Fatalf("stamped=%d failed=%d, want 1 and 1", stamped, failed)
		}
	})
	if !strings.Contains(out, "gone") {
		t.Errorf("the session that would not stamp was not logged:\n%s", out)
	}
	if got := recordedArgv(t, argv); !strings.Contains(got, "=alive:\n") {
		t.Errorf("gave up after the first failure:\n%s", got)
	}
}

// Idempotence, which is what stands in for a marker file here: the pass is
// self-limiting, because the second run sees the origins the first one wrote.
func TestGrandfatherSecondRunChangesNothing(t *testing.T) {
	actAs(t, "wizard")
	argv := withTmuxStub(t, "exit 0")

	// The list a second start reads: the stamps of the first run are on the
	// sessions, exactly as tmux would report them.
	runs := 0
	list := func(osUser string) []Session {
		runs++
		if runs == 1 {
			return []Session{{ID: "$1", Name: "k7m2q9x4tp0v"}}
		}
		return []Session{{ID: "$1", Name: "k7m2q9x4tp0v", Origin: originUser}}
	}

	if got := grandfatherSessionOrigins([]string{"wizard"}, list); got != 1 {
		t.Fatalf("first run stamped %d, want 1", got)
	}
	first := recordedArgv(t, argv)
	if got := grandfatherSessionOrigins([]string{"wizard"}, list); got != 0 {
		t.Fatalf("second run stamped %d, want 0", got)
	}
	if got := recordedArgv(t, argv); got != first {
		t.Errorf("the second run touched tmux:\nbefore:\n%s\nafter:\n%s", first, got)
	}
}

// Every user the service serves, not just the one whose sessions happen to be
// first — the same enumeration migrateSessionNamesToIDs runs on.
//
// The second user's stamp goes through `sudo -n -u`, because tmuxCmd only runs
// tmux directly for the process's own user. That is the path production takes
// for everyone, so the sudo stub is where its argv lands.
func TestGrandfatherCoversEveryUser(t *testing.T) {
	actAs(t, "wizard")
	tmuxArgv := withTmuxStub(t, "exit 0")
	sudoArgv := withSudoStub(t, "exit 0")

	total := grandfatherSessionOrigins([]string{"wizard", "emo"}, func(osUser string) []Session {
		return []Session{{ID: "$1", Name: osUser + "-session"}}
	})
	if total != 2 {
		t.Fatalf("stamped %d across two users, want 2", total)
	}
	if got := recordedArgv(t, tmuxArgv); !strings.Contains(got, "=wizard-session:\n") {
		t.Errorf("the process's own user was not stamped directly:\n%s", got)
	}
	got := recordedArgv(t, sudoArgv)
	for _, want := range []string{"-u", "emo", "=emo-session:", originOption, originUser} {
		if !strings.Contains(got, want+"\n") {
			t.Errorf("sudo argv missing %q:\n%s", want, got)
		}
	}
}

// The pass against a REAL tmux server. The stubs above prove it picks the right
// sessions; only tmux can say whether the option it writes is the one
// list-sessions reads back — which is the whole of what the grandfathering has
// to achieve, since a stamp nothing reads leaves the session in System.
//
// Skipped when tmux is missing, the way title_live_test.go is.
func TestGrandfatherStampsLiveSessionsThroughRealTmux(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	tmux := withRealTmux(t)

	for _, name := range []string{"ordinary", "already", "qa-fleet"} {
		if out, err := tmux("new-session", "-d", "-s", name); err != nil {
			t.Fatalf("creating %s: %v: %s", name, err, out)
		}
	}
	if out, err := tmux("set-option", "-t", "=already:", originOption, originTest); err != nil {
		t.Fatalf("stamping the harness session: %v: %s", err, out)
	}

	// liveSessions rather than userSessions as the list: the same parse over
	// the same tmux output, without the title and proc machinery, which this
	// pass does not read and which would write to /var/lib.
	live := func(string) []Session { return liveSessions(t, osSelf) }

	if got := grandfatherSessionOrigins([]string{osSelf}, live); got != 1 {
		t.Fatalf("stamped %d sessions, want 1 — the unattributed one", got)
	}
	sessions := liveSessions(t, osSelf)
	if got := findSession(t, sessions, "ordinary").Origin; got != originUser {
		t.Errorf("the unattributed session came back with origin %q, want %q", got, originUser)
	}
	if got := findSession(t, sessions, "already").Origin; got != originTest {
		t.Errorf("the harness session's own stamp was overwritten: origin %q, want %q", got, originTest)
	}
	if got := findSession(t, sessions, "qa-fleet").Origin; got != "" {
		t.Errorf("a reserved name was stamped %q, want left alone", got)
	}
	if isSystemSession(findSession(t, sessions, "ordinary")) {
		t.Error("a grandfathered session still reads as a system session")
	}

	// The second start, against the box the first one left behind.
	if got := grandfatherSessionOrigins([]string{osSelf}, live); got != 0 {
		t.Errorf("a second run stamped %d sessions, want 0", got)
	}
}
