package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// devvm/clipboard-store-clean is the other half of this service's store
// lifecycle — it is what enforces the 30-day grace and the 7-day sweep the
// upload paths promise — so its tests live with the service rather than in
// release/, which only checks that the file ships.
//
// The script takes its paths from the environment purely so this can run
// hermetically. The unit sets no Environment=, so production always gets the
// defaults compiled into the script.
func runStoreClean(t *testing.T, store string) {
	t.Helper()
	tmp := t.TempDir()
	mapFile := filepath.Join(tmp, "ttyd-user-map")
	if err := os.WriteFile(mapFile, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("sh", filepath.Join("..", "devvm", "clipboard-store-clean"))
	cmd.Env = []string{
		"PATH=" + os.Getenv("PATH"),
		"STORE=" + store,
		// Empty map and absent layout dir: no session resolves to an
		// Authentik login, so nothing is ever reported alive and the
		// sweep takes its dead-session branch. The URL points at a
		// closed port so a live tmux-api on the box cannot answer.
		"MAP=" + mapFile,
		"LAYOUT_DIR=" + filepath.Join(tmp, "layout"),
		"SESSIONS_URL=http://127.0.0.1:1/sessions",
		"EPHEMERAL_DIRS=" + filepath.Join(tmp, "ephemeral"),
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("clipboard-store-clean failed: %v\n%s", err, out)
	}
}

// TL-24 and TL-6. [ -d ], [ ! -f ] and the > redirection all follow symlinks,
// so a symlinked session directory made the marker write land inside whatever
// it pointed at, and 30 days later rm -rf emptied that target instead. The
// sweep ran as root then, which is what made it worth an audit finding; it runs
// as the store's owner now, and it still must not walk out of the store.
func TestSweepSkipsASymlinkedSessionDir(t *testing.T) {
	root := t.TempDir()
	store := filepath.Join(root, "store")
	victim := filepath.Join(root, "victim")
	if err := os.MkdirAll(filepath.Join(store, "qauser"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(victim, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(store, "qauser", "hijack")
	if err := os.Symlink(victim, link); err != nil {
		t.Fatal(err)
	}

	runStoreClean(t, store)

	if _, err := os.Lstat(filepath.Join(victim, ".deleted-at")); err == nil {
		t.Error("the sweep armed its 30-day deletion clock inside the symlink's target")
	}
	if _, err := os.Lstat(link); err != nil {
		t.Errorf("the symlink itself should be left alone, got %v", err)
	}
}

// The same hole one level up: a symlinked USER directory hands the inner loop
// somebody else's tree.
func TestSweepSkipsASymlinkedUserDir(t *testing.T) {
	root := t.TempDir()
	store := filepath.Join(root, "store")
	victim := filepath.Join(root, "victim")
	if err := os.MkdirAll(store, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(victim, "sess"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(victim, filepath.Join(store, "evil")); err != nil {
		t.Fatal(err)
	}

	runStoreClean(t, store)

	if _, err := os.Lstat(filepath.Join(victim, "sess", ".deleted-at")); err == nil {
		t.Error("the sweep walked through a symlinked user directory")
	}
}

// A marker that is itself a symlink sends the epoch write wherever it points.
// sh has no O_NOFOLLOW, so the script unlinks first.
func TestSweepDoesNotWriteAMarkerThroughASymlink(t *testing.T) {
	root := t.TempDir()
	store := filepath.Join(root, "store")
	sess := filepath.Join(store, "qauser", "dead")
	if err := os.MkdirAll(sess, 0o755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "elsewhere")
	if err := os.Symlink(target, filepath.Join(sess, ".deleted-at")); err != nil {
		t.Fatal(err)
	}

	runStoreClean(t, store)

	if _, err := os.Lstat(target); err == nil {
		t.Error("the epoch landed at the symlink's target")
	}
}

// The guard must not disable the sweep: a plain dead session still starts its
// grace clock, or nothing is ever pruned.
func TestSweepStillMarksADeadSession(t *testing.T) {
	root := t.TempDir()
	store := filepath.Join(root, "store")
	sess := filepath.Join(store, "qauser", "dead")
	if err := os.MkdirAll(sess, 0o755); err != nil {
		t.Fatal(err)
	}

	runStoreClean(t, store)

	if _, err := os.Stat(filepath.Join(sess, ".deleted-at")); err != nil {
		t.Errorf("a dead session got no .deleted-at marker: %v", err)
	}
}
