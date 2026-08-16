package sessionio

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// IndexVersion is the on-disk format version of index.json. It is written on
// every save so a later format change can be recognised rather than guessed at.
const IndexVersion = 1

// Binding is one durable Claude-session → tmux-session mapping.
type Binding struct {
	// TmuxName is the tmux session the conversation runs in. This is the field
	// the whole index exists for: it is the one fact that dies with the session
	// and cannot be recovered from anywhere else.
	TmuxName string `json:"tmuxName"`
	// CWD is the directory the session was started in — where a resurrection
	// has to put the new one, and how the syncer files a thread under a T3
	// workspace root.
	CWD string `json:"cwd"`
	// ThreadID is the T3 thread mirroring this session, "" for a session no
	// thread has adopted yet. It is also stamped on the live tmux session as
	// @t3_thread; this copy is the one that survives the session's death.
	ThreadID string `json:"threadId"`
	// Origin says who named the tmux session, which is what decides who wins a
	// naming disagreement and whether the syncer may adopt it. Empty means
	// "written before this field existed", and is read as OriginLobby.
	Origin string `json:"origin,omitempty"`
	// AliasOf redirects this uuid to the conversation it really names.
	//
	// It exists for one case, and it is the one T3 leaves no other way to
	// express: a thread created by the syncer for a session that is ALREADY
	// running gets a provider session id T3 invents for itself, because no
	// dispatchable command seeds one and the snapshot does not project it. The
	// bridge learns the true conversation from the warm-up turn and files that
	// id here, so every later spawn under T3's invented id resolves to the same
	// tmux session instead of starting a second Claude.
	AliasOf string `json:"aliasOf,omitempty"`
	// WarmedAt is when a warm-up turn last succeeded for this binding. Zero on
	// an adopted thread means the sentinel never landed, which is a state the
	// syncer retries rather than latches (decision 11).
	WarmedAt time.Time `json:"warmedAt,omitempty"`
	// UpdatedAt is when the binding was last written, in UTC. Put stamps it
	// when it is zero, so callers normally leave it alone.
	UpdatedAt time.Time `json:"updatedAt"`
}

// Who chose a session's tmux name. The lobby is the writer of record for
// existence and naming (decision 2), so OriginLobby is the default and the
// interesting value is the other one: a session the BRIDGE created for a thread
// born in T3, whose name is a slug of the workspace root and carries no
// information T3 does not already have.
const (
	OriginLobby = "lobby"
	OriginT3    = "t3"
)

// FromT3 reports whether the bridge created this session for a T3-born thread.
func (b Binding) FromT3() bool { return b.Origin == OriginT3 }

// Index is the durable uuid → Binding store shared by tl-t3-bridge and
// tl-t3-sync, at ~/.local/state/terminal-lobby/t3-bridge/index.json.
//
// Why it exists, and why here. The bridge only ever learns a Claude session
// UUID — T3 passes it as --session-id or --resume and nothing else. To
// resurrect a session that is gone it also needs the tmux NAME and the cwd, and
// those live on the tmux session, which is exactly what is missing. The lobby's
// other bindings (@claude_transcript, @claude_state, @t3_thread) are deliberately
// tmux-session-lifetime so a reused name never serves a dead conversation
// (see SessionMap). This one is deliberately the opposite: it is the half of
// the binding that has to outlive the session. It sits in sessionio rather than
// in either binary because both read and write it, and a package main cannot be
// imported.
//
// Concurrency: two processes write it. Every read-modify-write happens under an
// exclusive flock on a sidecar .lock file, and the save itself is tmp+rename in
// the same directory, so a reader either sees the previous file or the next one
// and never a partial write.
//
// An Index value is cheap; construct one per use rather than sharing it.
type Index struct {
	path string
}

// NewIndex binds to an explicit index file. The file and its directories are
// created on first write.
func NewIndex(path string) *Index { return &Index{path: path} }

// DefaultIndexPath is the per-user location: $XDG_STATE_HOME (or ~/.local/state)
// + terminal-lobby/t3-bridge/index.json. It is filed under t3-bridge/ because
// the bridge is what makes the binding load-bearing; the syncer is the second
// reader of the bridge's state, not a co-owner of a neutral store.
func DefaultIndexPath() (string, error) {
	base := os.Getenv("XDG_STATE_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("index path: %w", err)
		}
		base = filepath.Join(home, ".local", "state")
	}
	return filepath.Join(base, "terminal-lobby", "t3-bridge", "index.json"), nil
}

// Path is the file this index reads and writes.
func (ix *Index) Path() string { return ix.path }

// indexFile is the on-disk document. Bindings is a map so a uuid lookup needs
// no scan and two writers merging the same file cannot reorder each other.
type indexFile struct {
	Version  int                `json:"version"`
	Bindings map[string]Binding `json:"bindings"`
}

// All returns every binding, keyed by Claude session uuid. A file that does not
// exist yet is an empty index, not an error — the first run on a box has no
// state. A file that exists but cannot be parsed IS an error: answering "no
// bindings" there would send the bridge resurrecting sessions that are alive.
func (ix *Index) All() (map[string]Binding, error) {
	doc, err := ix.load()
	if err != nil {
		return nil, err
	}
	return doc.Bindings, nil
}

// Get returns one binding. ok=false when the uuid is not in the index.
func (ix *Index) Get(claudeID string) (Binding, bool, error) {
	all, err := ix.All()
	if err != nil {
		return Binding{}, false, err
	}
	b, ok := all[claudeID]
	return b, ok, nil
}

// FindByThread resolves the reverse direction: T3 hands the syncer a thread id
// and it has to find the session. Returns the uuid alongside the binding.
func (ix *Index) FindByThread(threadID string) (string, Binding, bool, error) {
	if threadID == "" {
		return "", Binding{}, false, nil
	}
	all, err := ix.All()
	if err != nil {
		return "", Binding{}, false, err
	}
	for uuid, b := range all {
		if b.ThreadID == threadID {
			return uuid, b, true, nil
		}
	}
	return "", Binding{}, false, nil
}

// Put writes one binding, replacing any previous one for the same uuid. It
// stamps UpdatedAt with the current UTC time unless the caller set it.
func (ix *Index) Put(claudeID string, b Binding) error {
	if claudeID == "" {
		return fmt.Errorf("index put: empty claude session id")
	}
	if b.UpdatedAt.IsZero() {
		b.UpdatedAt = time.Now().UTC()
	}
	return ix.Update(func(m map[string]Binding) error {
		m[claudeID] = b
		return nil
	})
}

// Merge writes one binding through a callback that receives whatever is
// already stored, so a writer that knows three of the five facts cannot erase
// the other two.
//
// Put REPLACES, which is right for a caller that knows the whole entry and
// wrong for the bridge: it attaches with a tmux name and a cwd in hand and no
// idea which thread the session belongs to, and a plain Put wrote "" over a
// threadId the syncer had recorded. The reconciler then saw an unadopted
// session, created a second thread for it, and the kill path read whichever of
// the two the index happened to name.
//
// The callback runs under the same exclusive lock as every other write, and
// UpdatedAt is stamped afterwards unless the callback set it.
func (ix *Index) Merge(claudeID string, apply func(Binding) Binding) error {
	if claudeID == "" {
		return fmt.Errorf("index merge: empty claude session id")
	}
	return ix.Update(func(m map[string]Binding) error {
		before := m[claudeID]
		next := apply(before)
		if next.UpdatedAt.Equal(before.UpdatedAt) {
			next.UpdatedAt = time.Now().UTC()
		}
		m[claudeID] = next
		return nil
	})
}

// Delete removes a binding. Removing one that is not there is not an error:
// reconcilers prune without looking first.
func (ix *Index) Delete(claudeID string) error {
	return ix.Update(func(m map[string]Binding) error {
		delete(m, claudeID)
		return nil
	})
}

// Update runs fn over the whole index under the exclusive lock and saves the
// result. It is the primitive Put and Delete are built from, and the one a
// batch reconcile should use so its several changes land as one write.
//
// The mutation is applied to a COPY: an fn that fails leaves the file exactly
// as it was, rather than half-applied.
func (ix *Index) Update(fn func(map[string]Binding) error) error {
	unlock, err := ix.lock()
	if err != nil {
		return err
	}
	defer unlock()

	doc, err := ix.load()
	if err != nil {
		return err
	}
	next := make(map[string]Binding, len(doc.Bindings)+1)
	for k, v := range doc.Bindings {
		next[k] = v
	}
	if err := fn(next); err != nil {
		return err
	}
	return ix.save(indexFile{Version: IndexVersion, Bindings: next})
}

func (ix *Index) load() (indexFile, error) {
	doc := indexFile{Version: IndexVersion, Bindings: map[string]Binding{}}
	raw, err := os.ReadFile(ix.path)
	if os.IsNotExist(err) {
		return doc, nil
	}
	if err != nil {
		return doc, fmt.Errorf("read %s: %w", ix.path, err)
	}
	if len(raw) == 0 {
		return doc, nil
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return doc, fmt.Errorf("parse %s: %w", ix.path, err)
	}
	if doc.Bindings == nil {
		doc.Bindings = map[string]Binding{}
	}
	return doc, nil
}

// save writes the document atomically: a temp file in the SAME directory (so
// the rename cannot cross filesystems), fsynced before the rename so a crash
// cannot leave a renamed-but-empty file.
func (ix *Index) save(doc indexFile) error {
	if err := os.MkdirAll(filepath.Dir(ix.path), 0o700); err != nil {
		return fmt.Errorf("index dir: %w", err)
	}
	raw, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return fmt.Errorf("encode index: %w", err)
	}
	raw = append(raw, '\n')

	tmp, err := os.CreateTemp(filepath.Dir(ix.path), ".index-*.tmp")
	if err != nil {
		return fmt.Errorf("index temp: %w", err)
	}
	defer os.Remove(tmp.Name()) // no-op once the rename succeeds
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return fmt.Errorf("index temp mode: %w", err)
	}
	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		return fmt.Errorf("write index: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("sync index: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close index: %w", err)
	}
	return os.Rename(tmp.Name(), ix.path)
}

// lock takes an exclusive flock on a sidecar file and returns the release.
//
// The lock is a SEPARATE file from index.json on purpose: the index itself is
// replaced by rename on every write, so a lock held on its inode would stop
// guarding it the moment somebody saved.
func (ix *Index) lock() (func(), error) {
	if err := os.MkdirAll(filepath.Dir(ix.path), 0o700); err != nil {
		return nil, fmt.Errorf("index dir: %w", err)
	}
	f, err := os.OpenFile(ix.path+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("index lock: %w", err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		f.Close()
		return nil, fmt.Errorf("index flock: %w", err)
	}
	return func() {
		syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		f.Close()
	}, nil
}
