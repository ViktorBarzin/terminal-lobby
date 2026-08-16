package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A cursor that has never been written is the zero cursor, not an error: the
// first attach of a thread has nothing to resume from.
func TestCursorLoadMissingIsZero(t *testing.T) {
	s := NewCursorStore(t.TempDir())
	got, err := s.Load("6c420342-1111-2222-3333-444444444444")
	if err != nil {
		t.Fatalf("Load on a fresh store: %v", err)
	}
	if got.LastUUID != "" || got.Offset != 0 {
		t.Fatalf("fresh store answered %+v, want the zero cursor", got)
	}
}

func TestCursorRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s := NewCursorStore(dir)
	id := "6c420342-1111-2222-3333-444444444444"
	want := Cursor{LastUUID: "rec-9", Offset: 4096}

	if err := s.Save(id, want); err != nil {
		t.Fatalf("Save: %v", err)
	}
	got, err := NewCursorStore(dir).Load(id) // a SEPARATE store: this is the reap
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got.LastUUID != want.LastUUID || got.Offset != want.Offset {
		t.Fatalf("round trip gave %+v, want LastUUID=%q Offset=%d", got, want.LastUUID, want.Offset)
	}
	if got.UpdatedAt.IsZero() {
		t.Fatal("Save did not stamp UpdatedAt")
	}
}

// The cursor holds state whose loss re-sends a whole conversation into a live
// thread, so it is the user's alone to read.
func TestCursorFileIsPrivate(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state", "cursor")
	s := NewCursorStore(dir)
	if err := s.Save("6c420342-1111-2222-3333-444444444444", Cursor{Offset: 1}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	fi, err := os.Stat(filepath.Join(dir, "6c420342-1111-2222-3333-444444444444.json"))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := fi.Mode().Perm(); perm != 0o600 {
		t.Fatalf("cursor file mode %v, want 0600", perm)
	}
	di, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("stat dir: %v", err)
	}
	if perm := di.Mode().Perm(); perm != 0o700 {
		t.Fatalf("cursor dir mode %v, want 0700", perm)
	}
}

// A cursor that cannot be parsed is an ERROR, never a zero cursor. Answering
// "nothing was sent yet" would replay the whole transcript into a thread that
// already has it — the one outcome the cursor exists to prevent. Same call as
// sessionio.Index makes for the binding index.
func TestCursorCorruptIsAnError(t *testing.T) {
	dir := t.TempDir()
	id := "6c420342-1111-2222-3333-444444444444"
	if err := os.WriteFile(filepath.Join(dir, id+".json"), []byte("{not json"), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := NewCursorStore(dir).Load(id); err == nil {
		t.Fatal("Load accepted a corrupt cursor; want an error")
	}
}

// The uuid comes from T3's argv, which is not ours to trust with a path.
func TestCursorRejectsUnsafeIDs(t *testing.T) {
	s := NewCursorStore(t.TempDir())
	for _, id := range []string{"", "../escape", "a/b", "with space", "semi;colon", strings.Repeat("a", 200)} {
		t.Run(id, func(t *testing.T) {
			if _, err := s.Load(id); err == nil {
				t.Errorf("Load(%q) was accepted", id)
			}
			if err := s.Save(id, Cursor{Offset: 1}); err == nil {
				t.Errorf("Save(%q) was accepted", id)
			}
		})
	}
}

// Save replaces rather than appends, so a cursor that goes backwards (a fresh
// attach of a transcript that was rotated) is representable.
func TestCursorSaveOverwrites(t *testing.T) {
	dir := t.TempDir()
	s := NewCursorStore(dir)
	id := "6c420342-1111-2222-3333-444444444444"
	if err := s.Save(id, Cursor{LastUUID: "a", Offset: 900, UpdatedAt: time.Now().UTC()}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := s.Save(id, Cursor{LastUUID: "b", Offset: 12}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	got, err := s.Load(id)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got.LastUUID != "b" || got.Offset != 12 {
		t.Fatalf("got %+v, want the second save", got)
	}
}
