package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// The replay cursor: how much of a session's transcript a thread has already
// been told about.
//
// It exists because the bridge is a DETACHED CLIENT of a conversation that
// outlives it. T3 reaps an idle provider session at 30 minutes and spawns a new
// bridge on the next touch, and the tmux session goes on writing the same
// transcript throughout. Without a durable mark, every re-attach would replay
// the whole file into a thread that already holds it — the same messages twice,
// then three times, growing with the conversation.
//
// It is a SEPARATE store from the binding index (sessionio.Index) because the
// two answer different questions and change at different rates: the binding is
// one small fact per session written at attach, the cursor moves with every
// batch of transcript records. Keeping the moving part out of the file two
// processes contend on keeps the index's flock uncontended.

// Cursor is how far into one session's transcript the thread has been told.
type Cursor struct {
	// LastUUID is the record uuid of the last frame actually EMITTED. It is the
	// anchor used when the byte offset cannot be trusted — a transcript shorter
	// than the offset is not the file the offset was taken from, and a uuid can
	// still find our place in it.
	LastUUID string `json:"lastUuid"`
	// Offset is the byte position just past the last record read, the cursor
	// sessionio.Tail resumes from. It is the fast path; LastUUID is the check.
	Offset int64 `json:"offset"`
	// UpdatedAt is when the cursor was last written, UTC. Save stamps it.
	UpdatedAt time.Time `json:"updatedAt"`
}

// CursorStore is the per-user cursor directory: one small JSON file per Claude
// session uuid.
//
// One file per session rather than one shared document: the writers are one
// bridge process per thread, all running as the same OS user, and a shared
// document would make them contend on a lock for writes that never overlap.
type CursorStore struct {
	dir string
}

// NewCursorStore binds to an explicit directory, created on first write.
func NewCursorStore(dir string) *CursorStore { return &CursorStore{dir: dir} }

// DefaultCursorDir is ~/.local/state/terminal-lobby/t3-bridge/cursor. It is
// derived from the index path rather than rebuilt so the two halves of the
// bridge's state cannot drift into different roots.
func DefaultCursorDir() (string, error) {
	root, err := attachStateDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "cursor"), nil
}

// Dir is the directory this store reads and writes.
func (s *CursorStore) Dir() string { return s.dir }

// Load returns the cursor for a Claude session uuid.
//
// A file that is not there yet is the ZERO cursor and no error — the first
// attach of a thread has nothing to resume from and must replay everything. A
// file that exists but cannot be parsed IS an error: answering "nothing has
// been sent" would replay a whole conversation into a thread that already holds
// it, which is precisely what this store exists to prevent. (sessionio.Index
// makes the same call for the same reason.)
func (s *CursorStore) Load(claudeID string) (Cursor, error) {
	path, err := s.path(claudeID)
	if err != nil {
		return Cursor{}, err
	}
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return Cursor{}, nil
	}
	if err != nil {
		return Cursor{}, fmt.Errorf("read cursor %s: %w", path, err)
	}
	if len(raw) == 0 {
		return Cursor{}, nil
	}
	var c Cursor
	if err := json.Unmarshal(raw, &c); err != nil {
		return Cursor{}, fmt.Errorf("parse cursor %s: %w", path, err)
	}
	return c, nil
}

// Save writes the cursor, stamping UpdatedAt when the caller left it zero.
//
// tmp + rename in the same directory, so a bridge killed mid-write leaves
// either the previous cursor or the next one. A half-written cursor read back
// as a smaller offset is a duplicate replay; read back as a larger one, it is a
// silently skipped message.
func (s *CursorStore) Save(claudeID string, c Cursor) error {
	path, err := s.path(claudeID)
	if err != nil {
		return err
	}
	if c.UpdatedAt.IsZero() {
		c.UpdatedAt = time.Now().UTC()
	}
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return fmt.Errorf("cursor dir: %w", err)
	}
	raw, err := json.Marshal(c)
	if err != nil {
		return fmt.Errorf("encode cursor: %w", err)
	}
	raw = append(raw, '\n')

	tmp, err := os.CreateTemp(s.dir, ".cursor-*.tmp")
	if err != nil {
		return fmt.Errorf("cursor temp: %w", err)
	}
	defer os.Remove(tmp.Name()) // a no-op once the rename succeeds
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return fmt.Errorf("cursor temp mode: %w", err)
	}
	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		return fmt.Errorf("write cursor: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("sync cursor: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close cursor: %w", err)
	}
	return os.Rename(tmp.Name(), path)
}

// path is the cursor file for a session uuid, refusing anything that is not one.
//
// The id arrives on T3's argv, so it is input rather than a fact: a value with
// a separator in it would put this store's writes wherever the caller liked.
// Checking the SHAPE (a uuid's alphabet and length) is cheaper than sanitising
// and leaves no encoding to get wrong.
func (s *CursorStore) path(claudeID string) (string, error) {
	if !attachIsUUID(claudeID) {
		return "", fmt.Errorf("cursor: %q is not a session uuid", claudeID)
	}
	return filepath.Join(s.dir, claudeID+".json"), nil
}

// attachIsUUID reports whether v has a uuid's shape: 36 characters of hex and
// dashes. It deliberately does not check the dash POSITIONS — a session id is
// an opaque token to the bridge, and the check is here to keep a path
// separator, a space or a shell metacharacter out of a filename, not to
// validate somebody else's identifier scheme.
func attachIsUUID(v string) bool {
	if len(v) != 36 {
		return false
	}
	for i := 0; i < len(v); i++ {
		c := v[i]
		switch {
		case c >= '0' && c <= '9', c >= 'a' && c <= 'f', c >= 'A' && c <= 'F', c == '-':
		default:
			return false
		}
	}
	return true
}
