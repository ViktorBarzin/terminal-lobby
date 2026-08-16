package sessionio

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func tempIndex(t *testing.T) *Index {
	t.Helper()
	return NewIndex(filepath.Join(t.TempDir(), "state", "index.json"))
}

// The one thing the index exists for: a Claude session uuid is all the bridge
// ever learns from argv, and the tmux session NAME dies with the session. Only
// a store outside tmux can answer "what was this session called" for a session
// that is no longer there — which is the whole of resurrection (decision 10).
func TestIndexRemembersABindingAcrossProcesses(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state", "index.json")
	const uuid = "6c420342-1111-2222-3333-444444444444"

	writer := NewIndex(path)
	if err := writer.Put(uuid, Binding{
		TmuxName: "feat-header", CWD: "/home/wizard/code/terminal-lobby", ThreadID: "th-1",
	}); err != nil {
		t.Fatalf("Put: %v", err)
	}

	// A different process — the syncer reading what the bridge wrote.
	reader := NewIndex(path)
	got, ok, err := reader.Get(uuid)
	if err != nil || !ok {
		t.Fatalf("Get = (%+v, %v, %v), want the binding back", got, ok, err)
	}
	if got.TmuxName != "feat-header" || got.CWD != "/home/wizard/code/terminal-lobby" || got.ThreadID != "th-1" {
		t.Fatalf("binding = %+v", got)
	}
	if got.UpdatedAt.IsZero() {
		t.Fatal("Put did not stamp UpdatedAt — a stale entry can never be aged out")
	}
}

func TestIndexMissingUUIDAndMissingFile(t *testing.T) {
	ix := tempIndex(t)
	// A file that was never written is an EMPTY index, not a failure: the first
	// bridge to run on a box has no state, and that must not look like an error.
	all, err := ix.All()
	if err != nil {
		t.Fatalf("All on a missing file: %v", err)
	}
	if len(all) != 0 {
		t.Fatalf("missing file yielded %+v", all)
	}
	if _, ok, err := ix.Get("nobody"); err != nil || ok {
		t.Fatalf("Get(unknown) = (%v, %v), want (false, nil)", ok, err)
	}
}

func TestIndexOverwritesAndDeletes(t *testing.T) {
	ix := tempIndex(t)
	const uuid = "u-1"

	stamped := time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC)
	if err := ix.Put(uuid, Binding{TmuxName: "old-name", UpdatedAt: stamped}); err != nil {
		t.Fatal(err)
	}
	// An explicit UpdatedAt is kept as given, which is what makes the stamping
	// testable without a clock seam.
	if got, _, _ := ix.Get(uuid); !got.UpdatedAt.Equal(stamped) {
		t.Fatalf("UpdatedAt = %v, want the explicit %v", got.UpdatedAt, stamped)
	}

	if err := ix.Put(uuid, Binding{TmuxName: "new-name", ThreadID: "th-2"}); err != nil {
		t.Fatal(err)
	}
	got, _, _ := ix.Get(uuid)
	if got.TmuxName != "new-name" || got.ThreadID != "th-2" {
		t.Fatalf("re-Put did not replace the binding: %+v", got)
	}

	if err := ix.Delete(uuid); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := ix.Get(uuid); ok {
		t.Fatal("the deleted binding is still there")
	}
	// Deleting what is not there is not an error — reconcilers prune blind.
	if err := ix.Delete(uuid); err != nil {
		t.Fatalf("Delete of an absent binding: %v", err)
	}
}

// The syncer looks the binding up the other way round: T3 hands it a thread id
// and it has to find the session.
func TestIndexFindsByThread(t *testing.T) {
	ix := tempIndex(t)
	if err := ix.Put("u-1", Binding{TmuxName: "one", ThreadID: "th-1"}); err != nil {
		t.Fatal(err)
	}
	if err := ix.Put("u-2", Binding{TmuxName: "two", ThreadID: "th-2"}); err != nil {
		t.Fatal(err)
	}

	uuid, b, ok, err := ix.FindByThread("th-2")
	if err != nil || !ok || uuid != "u-2" || b.TmuxName != "two" {
		t.Fatalf("FindByThread(th-2) = (%q, %+v, %v, %v)", uuid, b, ok, err)
	}
	if _, _, ok, _ := ix.FindByThread("th-nope"); ok {
		t.Fatal("FindByThread invented a binding")
	}
}

// Two binaries write this file — the bridge as T3 spawns it, the syncer on its
// poll — so a read-modify-write has to be serialised or one of them loses its
// entry. The failure would be silent and only visible later, as a session that
// cannot be resurrected.
func TestIndexConcurrentWritersDoNotLoseEntries(t *testing.T) {
	path := filepath.Join(t.TempDir(), "index.json")
	const writers, perWriter = 8, 12

	var wg sync.WaitGroup
	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			ix := NewIndex(path) // a separate handle, as a separate process would have
			for i := 0; i < perWriter; i++ {
				uuid := "u-" + string(rune('a'+w)) + "-" + string(rune('0'+i))
				if err := ix.Put(uuid, Binding{TmuxName: uuid}); err != nil {
					t.Errorf("Put(%s): %v", uuid, err)
					return
				}
			}
		}(w)
	}
	wg.Wait()

	all, err := NewIndex(path).All()
	if err != nil {
		t.Fatalf("All: %v", err)
	}
	if len(all) != writers*perWriter {
		t.Fatalf("index holds %d bindings, want %d — concurrent writers clobbered each other",
			len(all), writers*perWriter)
	}
}

// The file carries per-user state on a shared box, and its directory is created
// by whichever binary runs first.
func TestIndexIsPrivateToItsOwner(t *testing.T) {
	base := t.TempDir()
	path := filepath.Join(base, "terminal-lobby", "t3-bridge", "index.json")
	if err := NewIndex(path).Put("u-1", Binding{TmuxName: "one"}); err != nil {
		t.Fatal(err)
	}

	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := fi.Mode().Perm(); perm != 0o600 {
		t.Errorf("index.json mode = %o, want 600", perm)
	}
	di, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if perm := di.Mode().Perm(); perm != 0o700 {
		t.Errorf("state dir mode = %o, want 700", perm)
	}
}

// A reader must never see a half-written file, and a crashed write must never
// destroy the previous contents — hence tmp+rename. The observable part is that
// no partial file is left lying around next to the real one.
func TestIndexWritesAtomicallyAndLeavesNoTempFiles(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "index.json")
	ix := NewIndex(path)
	for i := 0; i < 3; i++ {
		if err := ix.Put("u-"+string(rune('1'+i)), Binding{TmuxName: "n"}); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		switch e.Name() {
		case "index.json", "index.json.lock":
		default:
			t.Errorf("stray file left behind: %s", e.Name())
		}
	}
}

// The on-disk shape is a contract between two binaries and a human reading it
// during an incident, so it is pinned here rather than left to whatever the
// struct happens to marshal to.
func TestIndexOnDiskShape(t *testing.T) {
	path := filepath.Join(t.TempDir(), "index.json")
	err := NewIndex(path).Put("6c420342-aaaa", Binding{
		TmuxName: "feat-header", CWD: "/home/wizard/code", ThreadID: "th-1",
		UpdatedAt: time.Date(2026, 8, 15, 22, 30, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Version  int `json:"version"`
		Bindings map[string]struct {
			TmuxName  string `json:"tmuxName"`
			CWD       string `json:"cwd"`
			ThreadID  string `json:"threadId"`
			UpdatedAt string `json:"updatedAt"`
		} `json:"bindings"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("index.json is not the documented shape: %v\n%s", err, raw)
	}
	if got.Version != IndexVersion {
		t.Errorf("version = %d, want %d", got.Version, IndexVersion)
	}
	b, ok := got.Bindings["6c420342-aaaa"]
	if !ok {
		t.Fatalf("bindings keyed wrong: %s", raw)
	}
	if b.TmuxName != "feat-header" || b.CWD != "/home/wizard/code" ||
		b.ThreadID != "th-1" || b.UpdatedAt != "2026-08-15T22:30:00Z" {
		t.Errorf("binding on disk = %+v", b)
	}
}

// A corrupt index must be loud, not silently empty: reporting "no bindings"
// would send the bridge into resurrecting sessions that already exist.
func TestIndexReportsCorruption(t *testing.T) {
	path := filepath.Join(t.TempDir(), "index.json")
	if err := os.WriteFile(path, []byte("{ this is not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewIndex(path).All(); err == nil {
		t.Fatal("a corrupt index read back as an empty one")
	}
}

// Update is the batch primitive the syncer prunes with: one read-modify-write
// under the same lock a Put takes.
func TestIndexUpdateAppliesUnderTheLock(t *testing.T) {
	ix := tempIndex(t)
	for _, u := range []string{"keep", "drop-1", "drop-2"} {
		if err := ix.Put(u, Binding{TmuxName: u}); err != nil {
			t.Fatal(err)
		}
	}
	err := ix.Update(func(m map[string]Binding) error {
		for k := range m {
			if k != "keep" {
				delete(m, k)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	all, _ := ix.All()
	if len(all) != 1 || all["keep"].TmuxName != "keep" {
		t.Fatalf("after prune: %+v", all)
	}
}

// An Update that fails leaves the file exactly as it was — a reconcile that
// bails halfway must not half-apply.
func TestIndexUpdateRollsBackOnError(t *testing.T) {
	ix := tempIndex(t)
	if err := ix.Put("u-1", Binding{TmuxName: "before"}); err != nil {
		t.Fatal(err)
	}
	boom := errBoom{}
	if err := ix.Update(func(m map[string]Binding) error {
		m["u-1"] = Binding{TmuxName: "after"}
		m["u-2"] = Binding{TmuxName: "extra"}
		return boom
	}); err != boom {
		t.Fatalf("Update returned %v, want the callback's error", err)
	}
	all, _ := ix.All()
	if len(all) != 1 || all["u-1"].TmuxName != "before" {
		t.Fatalf("a failed Update was partially applied: %+v", all)
	}
}

type errBoom struct{}

func (errBoom) Error() string { return "boom" }

func TestDefaultIndexPathIsUnderTheUsersStateDir(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", "/tmp/xdg-state")
	got, err := DefaultIndexPath()
	if err != nil {
		t.Fatal(err)
	}
	if want := "/tmp/xdg-state/terminal-lobby/t3-bridge/index.json"; got != want {
		t.Fatalf("DefaultIndexPath = %q, want %q", got, want)
	}

	t.Setenv("XDG_STATE_HOME", "")
	t.Setenv("HOME", "/home/someone")
	got, err = DefaultIndexPath()
	if err != nil {
		t.Fatal(err)
	}
	if want := "/home/someone/.local/state/terminal-lobby/t3-bridge/index.json"; got != want {
		t.Fatalf("DefaultIndexPath without XDG_STATE_HOME = %q, want %q", got, want)
	}
}
