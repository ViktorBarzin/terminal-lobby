package main

import (
	"os"
	"path/filepath"
	"testing"
)

// Everything keyed by a session's NAME has to move when the name does.
//
// The layout always did. The rest did not, which mattered little while
// renaming was a rare deliberate act — deriving names from titles makes it
// routine, so a retitle that dropped a session out of a shared project or
// orphaned its shares would be an everyday occurrence rather than an edge case.

func swapAssignmentStore(t *testing.T) *assignmentStore {
	t.Helper()
	old := assignmentStoreInstance
	assignmentStoreInstance = newAssignmentStore(t.TempDir())
	t.Cleanup(func() { assignmentStoreInstance = old })
	return assignmentStoreInstance
}

func swapImageStore(t *testing.T) string {
	t.Helper()
	old := sessionImageRoot
	sessionImageRoot = t.TempDir()
	t.Cleanup(func() { sessionImageRoot = old })
	return sessionImageRoot
}

// A shared project lists its members as (owner, name). Leave the old name
// there and the session vanishes from every other member's sidebar, while
// still running perfectly well for its owner.
func TestRenameCarriesIntoTheProjectStore(t *testing.T) {
	swapProjectStore(t)
	ps := projectStoreInstance
	if err := ps.update(func(set *ProjectSet) error {
		set.Projects = []GlobalProject{{
			ID: "p1", Name: "tripit", Members: []Member{{OSUser: "wizard"}, {OSUser: "bob"}},
			Sessions: []SessionRef{
				{Owner: "wizard", Name: "deploy-the-thing"},
				{Owner: "bob", Name: "deploy-the-thing"}, // same name, different owner
				{Owner: "wizard", Name: "untouched"},
			},
		}}
		return nil
	}); err != nil {
		t.Fatalf("seeding the project store: %v", err)
	}

	carryRenameAcrossStores("wizard", "deploy-the-thing", "fix-the-parser")

	got, err := ps.load()
	if err != nil {
		t.Fatal(err)
	}
	want := []SessionRef{
		{Owner: "wizard", Name: "fix-the-parser"},
		{Owner: "bob", Name: "deploy-the-thing"}, // another user's session is not ours to rename
		{Owner: "wizard", Name: "untouched"},
	}
	refs := got.Projects[0].Sessions
	if len(refs) != len(want) {
		t.Fatalf("refs = %+v, want %+v", refs, want)
	}
	for i := range want {
		if refs[i] != want[i] {
			t.Errorf("ref %d = %+v, want %+v", i, refs[i], want[i])
		}
	}
}

// A share grants a named guest access to (owner, name). Leave the old name and
// the guest loses access with no signal to either side.
func TestRenameCarriesIntoTheShareStore(t *testing.T) {
	swapShareStore(t)
	ss := shareStoreInstance
	if err := ss.update(func(set *ShareSet) error {
		set.Shares = []Share{
			{Owner: "wizard", Name: "deploy-the-thing", Guest: "bob", Mode: "ro"},
			{Owner: "wizard", Name: "deploy-the-thing", Guest: "carol", Mode: "rw"},
			{Owner: "bob", Name: "deploy-the-thing", Guest: "wizard", Mode: "ro"},
			{Owner: "wizard", Name: "untouched", Guest: "bob", Mode: "ro"},
		}
		return nil
	}); err != nil {
		t.Fatalf("seeding the share store: %v", err)
	}

	carryRenameAcrossStores("wizard", "deploy-the-thing", "fix-the-parser")

	got, err := ss.load()
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []Share{
		{Owner: "wizard", Name: "fix-the-parser", Guest: "bob", Mode: "ro"},
		{Owner: "wizard", Name: "fix-the-parser", Guest: "carol", Mode: "rw"},
		{Owner: "bob", Name: "deploy-the-thing", Guest: "wizard", Mode: "ro"},
		{Owner: "wizard", Name: "untouched", Guest: "bob", Mode: "ro"},
	} {
		found := false
		for _, s := range got.Shares {
			if s == want {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("share %+v missing after the rename; have %+v", want, got.Shares)
		}
	}
	if len(got.Shares) != 4 {
		t.Errorf("share count = %d, want 4 (%+v)", len(got.Shares), got.Shares)
	}
}

// Session images live in a directory named after the session. tmux-api and
// clipboard-upload both run as the same service user and the store is theirs,
// so this is a plain rename rather than a call to another service.
func TestRenameCarriesTheImageDirectory(t *testing.T) {
	root := swapImageStore(t)
	old := filepath.Join(root, "wizard", "deploy-the-thing")
	if err := os.MkdirAll(old, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(old, "shot.png"), []byte("png"), 0o644); err != nil {
		t.Fatal(err)
	}

	carryRenameAcrossStores("wizard", "deploy-the-thing", "fix-the-parser")

	moved := filepath.Join(root, "wizard", "fix-the-parser", "shot.png")
	if _, err := os.Stat(moved); err != nil {
		t.Fatalf("the image did not follow the rename: %v", err)
	}
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Errorf("the old image directory is still there: %v", err)
	}
}

func TestRenameWithNoImagesIsHarmless(t *testing.T) {
	root := swapImageStore(t)
	swapProjectStore(t)
	swapShareStore(t)

	carryRenameAcrossStores("wizard", "never-had-images", "still-none")

	if _, err := os.Stat(filepath.Join(root, "wizard", "still-none")); !os.IsNotExist(err) {
		t.Errorf("an empty directory was conjured for a session with no images: %v", err)
	}
}

// A rename must never overwrite a directory that already belongs to a
// different session — the destination name having images means something else
// used that name, and merging the two would mix two conversations' pictures.
func TestRenameLeavesAnOccupiedImageDirectoryAlone(t *testing.T) {
	root := swapImageStore(t)
	from := filepath.Join(root, "wizard", "deploy-the-thing")
	to := filepath.Join(root, "wizard", "fix-the-parser")
	for _, d := range []string{from, to} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(to, "theirs.png"), []byte("theirs"), 0o644); err != nil {
		t.Fatal(err)
	}

	carryRenameAcrossStores("wizard", "deploy-the-thing", "fix-the-parser")

	if _, err := os.Stat(filepath.Join(to, "theirs.png")); err != nil {
		t.Fatalf("an occupied destination was clobbered: %v", err)
	}
	if _, err := os.Stat(from); os.IsNotExist(err) {
		t.Error("the source directory was removed even though the move did not happen")
	}
}

// The killed-assignment memory is what puts a restored session back in its
// project. Keyed by name, so it moves too.
func TestRenameCarriesTheKilledAssignmentMemory(t *testing.T) {
	as := swapAssignmentStore(t)
	if err := as.remember("wizard", "deploy-the-thing", "tripit"); err != nil {
		t.Fatal(err)
	}

	carryRenameAcrossStores("wizard", "deploy-the-thing", "fix-the-parser")

	set, err := as.load("wizard")
	if err != nil {
		t.Fatal(err)
	}
	if project, ok := assignmentProjectOf(set, "fix-the-parser"); !ok || project != "tripit" {
		t.Errorf("assignment under the new name = (%q, %v), want (tripit, true)", project, ok)
	}
	if _, ok := assignmentProjectOf(set, "deploy-the-thing"); ok {
		t.Error("the old name kept its assignment")
	}
}

// One store failing must not stop the others: the tmux rename has already
// landed, so a partial carry is strictly better than an early return that
// leaves the remaining stores stale as well.
func TestRenameCarriesOnWhenOneStoreFails(t *testing.T) {
	swapImageStore(t)
	swapShareStore(t)
	ss := shareStoreInstance
	if err := ss.update(func(set *ShareSet) error {
		set.Shares = []Share{{Owner: "wizard", Name: "deploy-the-thing", Guest: "bob", Mode: "ro"}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	// An unwritable project store: the carry has to survive it.
	old := projectStoreInstance
	projectStoreInstance = newProjectStore("/proc/nonexistent-dir/projects.json")
	t.Cleanup(func() { projectStoreInstance = old })

	carryRenameAcrossStores("wizard", "deploy-the-thing", "fix-the-parser")

	got, err := ss.load()
	if err != nil {
		t.Fatal(err)
	}
	if got.Shares[0].Name != "fix-the-parser" {
		t.Errorf("the share did not move after an unrelated store failed: %+v", got.Shares)
	}
}
