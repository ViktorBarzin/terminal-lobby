package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The one-time pass that gives every session already running an opaque id for a
// name (ADR-0019), keeping what the session was called as its @title so nothing
// a person reads is lost: `authentik` keeps reading `authentik`, now as a title.

// swapMigrationMarker points the "already done" marker at a temp file, and
// returns its path.
func swapMigrationMarker(t *testing.T) string {
	t.Helper()
	old := sessionIDMarkerPath
	sessionIDMarkerPath = filepath.Join(t.TempDir(), "session-ids-migrated")
	t.Cleanup(func() { sessionIDMarkerPath = old })
	return sessionIDMarkerPath
}

// migrationStores swaps every store the cascade touches for a temp one, so a
// migration test cannot write to /var/lib.
func migrationStores(t *testing.T) {
	t.Helper()
	actAs(t, "wizard") // these tests act as the owner of the sessions they migrate
	swapTitleStore(t)
	swapAssignmentStore(t)
	swapProjectStore(t)
	swapShareStore(t)
	swapImageStore(t)
	old := layoutStoreInstance
	layoutStoreInstance = newLayoutStore(t.TempDir())
	t.Cleanup(func() { layoutStoreInstance = old })
}

func TestMigrateRenamesToAnIDAndKeepsTheOldNameAsTheTitle(t *testing.T) {
	migrationStores(t)
	argv := withTmuxStub(t, "exit 0")

	renamed, failed := migrateUserSessionNames("wizard", []Session{
		{ID: "$1", Name: "authentik"},
	})
	if renamed != 1 || failed != 0 {
		t.Fatalf("renamed=%d failed=%d, want 1 and 0", renamed, failed)
	}

	got := recordedArgv(t, argv)
	// The title is stamped FIRST, under the OLD name. A crash between the two
	// then leaves a session that still answers to `authentik` and now also
	// carries it as a title, which the next run finishes; the other order
	// would lose the only readable thing about it.
	stampAt := strings.Index(got, "@title")
	renameAt := strings.Index(got, "rename-session")
	if stampAt < 0 || renameAt < 0 {
		t.Fatalf("argv missing a stamp or a rename:\n%s", got)
	}
	if stampAt > renameAt {
		t.Errorf("stamped the title after the rename; want it before:\n%s", got)
	}
	for _, want := range []string{"set-option", "-t", "=authentik:", "@title", "authentik", "rename-session"} {
		if !strings.Contains(got, want) {
			t.Errorf("argv missing %q:\n%s", want, got)
		}
	}
	newName := renamedTo(t, got)
	if !isMintedName(newName) {
		t.Errorf("renamed to %q, which is not a minted id", newName)
	}
	// The title has to be remembered under the NAME THE SESSION NOW HAS, or a
	// restore hands it back untitled.
	if got := titleStoreInstance.all("wizard")[newName]; got != "authentik" {
		t.Errorf("title memory for %s = %q, want %q", newName, got, "authentik")
	}
}

func TestMigrateKeepsATitleTheSessionAlreadyHas(t *testing.T) {
	migrationStores(t)
	if err := titleStoreInstance.set("wizard", "nokia-api", "Nokia api"); err != nil {
		t.Fatal(err)
	}
	argv := withTmuxStub(t, "exit 0")

	if renamed, failed := migrateUserSessionNames("wizard", []Session{
		{ID: "$1", Name: "nokia-api", Title: "Nokia api"},
	}); renamed != 1 || failed != 0 {
		t.Fatalf("renamed=%d failed=%d, want 1 and 0", renamed, failed)
	}

	got := recordedArgv(t, argv)
	// Only sessions with nothing to read get their name written as a title.
	if strings.Contains(got, "set-option") {
		t.Errorf("re-stamped a title the session already had:\n%s", got)
	}
	newName := renamedTo(t, got)
	if got := titleStoreInstance.all("wizard")[newName]; got != "Nokia api" {
		t.Errorf("title memory for %s = %q, want %q", newName, got, "Nokia api")
	}
	if _, still := titleStoreInstance.all("wizard")["nokia-api"]; still {
		t.Error("the title is remembered under the old name as well as the new one")
	}
}

func TestMigrateSkipsASessionThatAlreadyHasAnID(t *testing.T) {
	migrationStores(t)
	argv := withTmuxStub(t, "exit 0")

	// Idempotence: a second run must be a no-op, which is also what makes a
	// partial run safe to finish.
	if renamed, failed := migrateUserSessionNames("wizard", []Session{
		{ID: "$1", Name: "k7m2q9x4tpz3", Title: "Tashkent trip planning"},
	}); renamed != 0 || failed != 0 {
		t.Fatalf("renamed=%d failed=%d, want 0 and 0", renamed, failed)
	}
	if got := recordedArgv(t, argv); got != "" {
		t.Errorf("touched tmux for a session that already has an id:\n%s", got)
	}
}

func TestMigrateRetriesWhenTmuxSaysTheNameIsTaken(t *testing.T) {
	migrationStores(t)
	counter := filepath.Join(t.TempDir(), "n")
	argv := withTmuxStub(t, `
case "$1" in
rename-session)
  n=$(cat '`+counter+`' 2>/dev/null || echo 0)
  echo $((n+1)) > '`+counter+`'
  if [ "$n" = "0" ]; then
    echo "duplicate session: $3" >&2
    exit 1
  fi
  ;;
esac
exit 0`)

	if renamed, failed := migrateUserSessionNames("wizard", []Session{
		{ID: "$1", Name: "authentik"},
	}); renamed != 1 || failed != 0 {
		t.Fatalf("renamed=%d failed=%d, want 1 and 0", renamed, failed)
	}
	if n := strings.Count(recordedArgv(t, argv), "rename-session"); n != 2 {
		t.Errorf("rename-session ran %d times, want 2 (the first one collided)", n)
	}
}

func TestMigrateLeavesTheStoresAloneWhenTheRenameFails(t *testing.T) {
	migrationStores(t)
	if err := layoutStoreInstance.save("wizard", Layout{Version: 1, Ungrouped: []string{"authentik"}}); err != nil {
		t.Fatal(err)
	}
	withTmuxStub(t, `
case "$1" in
rename-session) echo "can't find session: $3" >&2; exit 1;;
esac
exit 0`)

	if renamed, failed := migrateUserSessionNames("wizard", []Session{
		{ID: "$1", Name: "authentik"},
	}); renamed != 0 || failed != 1 {
		t.Fatalf("renamed=%d failed=%d, want 0 and 1", renamed, failed)
	}
	l, err := layoutStoreInstance.load("wizard")
	if err != nil {
		t.Fatal(err)
	}
	// A half-applied migration is the one outcome worth guarding: the session
	// still answers to `authentik`, so the layout has to as well.
	if len(l.Ungrouped) != 1 || l.Ungrouped[0] != "authentik" {
		t.Errorf("layout = %+v, want the name left alone after a failed rename", l.Ungrouped)
	}
}

func TestMigrateCarriesTheRenameThroughTheStores(t *testing.T) {
	migrationStores(t)
	if err := layoutStoreInstance.save("wizard", Layout{Version: 1, Ungrouped: []string{"authentik"}}); err != nil {
		t.Fatal(err)
	}
	if err := shareStoreInstance.update(func(ss *ShareSet) error {
		ss.Shares = []Share{{Owner: "wizard", Name: "authentik", Guest: "emo", Mode: "ro"}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	argv := withTmuxStub(t, "exit 0")

	if renamed, _ := migrateUserSessionNames("wizard", []Session{{ID: "$1", Name: "authentik"}}); renamed != 1 {
		t.Fatalf("renamed=%d, want 1", renamed)
	}
	newName := renamedTo(t, recordedArgv(t, argv))

	l, err := layoutStoreInstance.load("wizard")
	if err != nil {
		t.Fatal(err)
	}
	if len(l.Ungrouped) != 1 || l.Ungrouped[0] != newName {
		t.Errorf("layout = %+v, want [%s]", l.Ungrouped, newName)
	}
	ss, err := shareStoreInstance.load()
	if err != nil {
		t.Fatal(err)
	}
	// Leave the old name in a grant and the guest silently loses access.
	if len(ss.Shares) != 1 || ss.Shares[0].Name != newName {
		t.Errorf("shares = %+v, want the grant to follow to %s", ss.Shares, newName)
	}
}

func TestMigrateKeepsGoingPastOneFailure(t *testing.T) {
	migrationStores(t)
	argv := withTmuxStub(t, `
case "$1 $3" in
"rename-session =broken") echo "can't find session: broken" >&2; exit 1;;
esac
exit 0`)

	renamed, failed := migrateUserSessionNames("wizard", []Session{
		{ID: "$1", Name: "broken"},
		{ID: "$2", Name: "authentik"},
		{ID: "$3", Name: "k7m2q9x4tpz3"},
	})
	if renamed != 1 || failed != 1 {
		t.Fatalf("renamed=%d failed=%d, want 1 and 1", renamed, failed)
	}
	if !strings.Contains(recordedArgv(t, argv), "=authentik") {
		t.Errorf("stopped at the first failure instead of carrying on:\n%s", recordedArgv(t, argv))
	}
}

func TestMigrateRunsOnceAndOnlyAfterACleanPass(t *testing.T) {
	migrationStores(t)
	marker := swapMigrationMarker(t)
	argv := withTmuxStub(t, `
case "$1 $3" in
"rename-session =broken") echo "can't find session: broken" >&2; exit 1;;
esac
exit 0`)
	sessions := map[string][]Session{"wizard": {{ID: "$1", Name: "broken"}, {ID: "$2", Name: "authentik"}}}
	list := func(u string) []Session { return sessions[u] }

	// A pass that could not finish leaves no marker, so the next start
	// retries — and the session it DID migrate is skipped by its shape.
	if renamed := migrateSessionNamesToIDs([]string{"wizard"}, list); renamed != 1 {
		t.Fatalf("first pass renamed %d, want 1", renamed)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("marker written after a pass that failed a session: %v", err)
	}

	// Now everything renames.
	sessions["wizard"] = []Session{{ID: "$2", Name: "authentik"}}
	if renamed := migrateSessionNamesToIDs([]string{"wizard"}, list); renamed != 1 {
		t.Fatalf("second pass renamed %d, want 1", renamed)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("no marker after a clean pass: %v", err)
	}

	// Marker present: no tmux call at all, however many named sessions appear.
	before := recordedArgv(t, argv)
	sessions["wizard"] = []Session{{ID: "$9", Name: "appeared-later"}}
	if renamed := migrateSessionNamesToIDs([]string{"wizard"}, list); renamed != 0 {
		t.Fatalf("third pass renamed %d, want 0 — the marker says it is done", renamed)
	}
	if recordedArgv(t, argv) != before {
		t.Error("ran tmux again despite the marker")
	}
}

// renamedTo pulls the new name out of the recorded argv: the token after the
// `rename-session -t =<old>` triple, for the LAST rename in the file.
func renamedTo(t *testing.T, argv string) string {
	t.Helper()
	lines := strings.Split(strings.TrimRight(argv, "\n"), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if lines[i] == "rename-session" && i+3 < len(lines) {
			return lines[i+3]
		}
	}
	t.Fatalf("no rename-session in argv:\n%s", argv)
	return ""
}

// A machine-made session is excluded from T3 mirroring by its NAME
// (t3-sync/main.go DefaultIgnorePrefixes). Renaming one to an id would have the
// syncer adopt it: a real T3 thread created and warmed for a session that
// exists to be thrown away.
func TestMigrateLeavesReservedNamesAlone(t *testing.T) {
	migrationStores(t)
	argv := withTmuxStub(t, "exit 0")

	reserved := []Session{
		{ID: "$1", Name: "qa-lobby-smoke"},
		{ID: "$2", Name: "t3e2e-thread-42"},
		{ID: "$3", Name: "tlp-t7"},
		{ID: "$4", Name: poolSlotPrefix + "_home_wizard_code"},
	}
	renamed, failed := migrateUserSessionNames("wizard", reserved)
	if renamed != 0 || failed != 0 {
		t.Fatalf("renamed=%d failed=%d, want 0 and 0", renamed, failed)
	}
	if got := recordedArgv(t, argv); got != "" {
		t.Errorf("touched tmux for a reserved name:\n%s", got)
	}

	// And a name that merely CONTAINS one of the prefixes is a person's, so it
	// still migrates.
	renamed, failed = migrateUserSessionNames("wizard", []Session{{ID: "$5", Name: "my-qa-notes"}})
	if renamed != 1 || failed != 0 {
		t.Fatalf("renamed=%d failed=%d for a human name, want 1 and 0", renamed, failed)
	}
}
