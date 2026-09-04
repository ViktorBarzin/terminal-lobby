package main

import (
	"testing"
)

// The migration against a REAL tmux server.
//
// migrate_ids_test.go stubs tmux, which proves the pass calls what it means to
// but not that tmux agrees. The things a stub cannot check are the ones most
// likely to be wrong here: whether `rename-session -t "=name"` actually moves a
// live session, whether the @title stamped under the OLD name is still on the
// session after it is renamed (it is the SESSION's option, not the name's), and
// whether a second pass over the result finds anything left to do.
//
// Skipped when tmux is missing, so this stays runnable anywhere.

func TestMigrationRenamesRealSessions(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	tmux := withRealTmux(t)
	migrationStores(t)
	swapMigrationMarker(t)

	// The box on 2026-09-04: a session with no title, one that has one, and
	// one already carrying an id.
	for _, name := range []string{"authentik", "nokia-api", "k7m2q9x4tpz3"} {
		if out, err := tmux("new-session", "-d", "-s", name); err != nil {
			t.Fatalf("new-session %s: %v: %s", name, err, out)
		}
	}
	if out, err := tmux("set-option", "-t", "=nokia-api:", sessionTitleOption, "Nokia api"); err != nil {
		t.Fatalf("seeding a title: %v: %s", err, out)
	}
	if out, err := tmux("set-option", "-t", "=k7m2q9x4tpz3:", sessionTitleOption, "Tashkent trip planning"); err != nil {
		t.Fatalf("seeding a title: %v: %s", err, out)
	}

	before := liveSessions(t, osSelf)
	if len(before) != 3 {
		t.Fatalf("seeded %d sessions, want 3: %+v", len(before), before)
	}
	if n := migrateSessionNamesToIDs([]string{osSelf}, func(string) []Session { return before }); n != 2 {
		t.Fatalf("renamed %d, want 2 (the third already had an id)", n)
	}

	after := liveSessions(t, osSelf)
	if len(after) != 3 {
		t.Fatalf("%d sessions after the migration, want 3: %+v", len(after), after)
	}
	byTitle := make(map[string]string, len(after))
	for _, s := range after {
		byTitle[s.Title] = s.Name
	}
	// Nothing a person reads is lost: `authentik` keeps reading `authentik`,
	// now as a title, and a session that already had one keeps that.
	for _, title := range []string{"authentik", "Nokia api"} {
		name, ok := byTitle[title]
		if !ok {
			t.Errorf("no session titled %q survived the migration: %+v", title, after)
			continue
		}
		if !isMintedName(name) {
			t.Errorf("session titled %q is still called %q, which is not an id", title, name)
		}
		// The title has to be remembered under the name the session NOW has,
		// or the next restore hands it back untitled.
		if got := titleStoreInstance.all(osSelf)[name]; got != title {
			t.Errorf("title memory for %s = %q, want %q", name, got, title)
		}
	}
	// The one that already had an id is untouched, name and title alike.
	if byTitle["Tashkent trip planning"] != "k7m2q9x4tpz3" {
		t.Errorf("renamed a session that already had an id: %+v", after)
	}

	// Idempotent: a second pass over what the first one produced does nothing.
	if n := migrateSessionNamesToIDs([]string{osSelf}, func(string) []Session { return after }); n != 0 {
		t.Errorf("a second pass renamed %d sessions, want 0", n)
	}
}
