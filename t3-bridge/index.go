package main

import (
	"fmt"

	"terminal-lobby/sessionio"
)

// The bridge's view of the durable binding index.
//
// The storage lives in sessionio.Index — atomic writes, flock, the on-disk
// shape — because the syncer reads and writes the same file and a package main
// cannot be imported. What lives HERE is the bridge's policy: which facts it
// records, and when.
//
// Why the index exists at all: T3 hands the bridge a Claude session uuid and
// nothing else. Every other binding in this system is deliberately
// tmux-session-lifetime — @claude_transcript, @claude_state, @t3_thread all die
// with the session, so a reused name never serves a dead conversation. That is
// right for reading a LIVE session and useless for bringing back a dead one,
// which needs the tmux name and cwd precisely when tmux no longer has them.

// Bindings is the bridge's handle on the index.
type Bindings struct {
	ix *sessionio.Index
}

// OpenBindings binds to the per-user index at
// ~/.local/state/terminal-lobby/t3-bridge/index.json.
func OpenBindings() (*Bindings, error) {
	path, err := sessionio.DefaultIndexPath()
	if err != nil {
		return nil, fmt.Errorf("bindings: %w", err)
	}
	return &Bindings{ix: sessionio.NewIndex(path)}, nil
}

// OpenBindingsAt binds to an explicit path. Tests use it; so does anything that
// wants to look at another location without an environment variable.
func OpenBindingsAt(path string) *Bindings {
	return &Bindings{ix: sessionio.NewIndex(path)}
}

// Index exposes the underlying store for the batch operations Bindings does not
// wrap (Update, All).
func (b *Bindings) Index() *sessionio.Index { return b.ix }

// Lookup returns what is known about a Claude session uuid.
func (b *Bindings) Lookup(claudeID string) (sessionio.Binding, bool, error) {
	return b.ix.Get(claudeID)
}

// Record writes the binding for a target the bridge has just resolved or
// created. It is called on EVERY successful attach, not only on creation: a
// session renamed in the lobby has to be findable under its new name the next
// time it dies, and the attach is the only moment the bridge knows both halves.
//
// It MERGES rather than replaces, and that distinction is load-bearing. The
// bridge attaches knowing the tmux name and the cwd; it is never told which
// thread it is serving, and nothing in this binary stamps @t3_thread, so the
// thread id it reads back off a session it created is "". Writing that over the
// pairing the syncer recorded is what made a bridge-born session look unadopted
// on the next reconcile — a second thread for one session, and a kill that then
// read whichever of the two the index happened to name.
//
// The same rule covers the cwd: a target resolved without one leaves the stored
// value alone rather than blanking the directory a resurrection has to start
// in.
func (b *Bindings) Record(t Target) error {
	if t.ClaudeID == "" || t.TmuxName == "" {
		return fmt.Errorf("bindings: refusing to record an incomplete target %+v", t)
	}
	return b.ix.Merge(t.ClaudeID, func(stored sessionio.Binding) sessionio.Binding {
		stored.TmuxName = t.TmuxName
		if t.CWD != "" {
			stored.CWD = t.CWD
		}
		if t.ThreadID != "" {
			stored.ThreadID = t.ThreadID
		}
		if t.Origin != "" {
			stored.Origin = t.Origin
		}
		if t.AliasOf != "" {
			stored.AliasOf = t.AliasOf
		}
		return stored
	})
}

// Forget drops a binding. The bridge calls it for a DELIBERATE destruction
// only: a session that merely exited — OOM, a reboot, a reaped bridge — keeps
// its binding, because that binding is exactly what the next prompt will
// resurrect from (decision 3, and the "Kill" entry in CONTEXT.md).
func (b *Bindings) Forget(claudeID string) error { return b.ix.Delete(claudeID) }
