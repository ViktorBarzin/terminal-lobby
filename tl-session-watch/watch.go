package main

import (
	"strings"
	"time"
)

// The comparison half of tl-session-watch, kept free of the box so it can be
// driven tick by tick in a test. Everything that touches tmux, cgroups or the
// manifest lives in collect.go; everything that decides what is news lives here.

// Session is one tmux session as one tick saw it.
type Session struct {
	Name string
	// ClaudeState is the session's @claude_state stamp, empty when unset.
	// SessionEnd clears it on an orderly exit and a SIGKILL cannot run that
	// hook, so a stamp with no claude behind it is evidence of a death.
	ClaudeState string
	ClaudeAlive bool
	// PaneBytes and PaneLimit come from the pane scope's cgroup:
	// memory.current and memory.max. PaneLimit is 0 when the pane is uncapped.
	//
	// PaneBytes is reported but never compared against a threshold. It rides up
	// to the cap in any pane doing file I/O, because the cap makes the kernel
	// reclaim cache rather than kill anything: measured 2026-09-01, one pane sat
	// at 6143 MB of a 6144 MB cap with memory.events showing max=45450 and
	// oom_kill=0.
	PaneBytes uint64
	PaneLimit uint64
	// PaneUnreclaimable is anon + shmem, which is the memory that actually forces
	// a kill. The user slice sets memory.swap.max=0 and cgroup limits are
	// hierarchical, so neither can be paged out. In the pane above this read 628
	// MB against the same 6144 MB cap; forty minutes earlier, with /tmp 95% full,
	// it read 4424 MB and the pane genuinely was at risk.
	PaneUnreclaimable uint64
	// TopIsClaude says whether the highest-RSS process in the pane is a claude,
	// which is the same ranking the kernel uses at the cap. It is the difference
	// between the cap taking a build and the cap taking a conversation.
	TopIsClaude bool
}

// Snapshot is one user's world at one tick.
type Snapshot struct {
	User   string
	BootID string
	// Taken is when this snapshot was read, which is what a tombstone's age is
	// measured against.
	Taken time.Time
	// Sessions is what tmux reports, keyed by name.
	Sessions map[string]Session
	// Tombstones maps a session name to the epoch of its most recent deliberate
	// kill, from /var/lib/tmux-persist/<user>.forgotten.tsv.
	//
	// This, not the manifest, is what records intent. tmux-persist-forget appends
	// a tombstone; it does NOT remove the manifest row, which only goes at the
	// next 5-minute save. An earlier version of this watcher tested for an
	// orphaned manifest row and therefore called every deliberate kill a death
	// for up to five minutes.
	Tombstones map[string]int64
}

type Kind string

const (
	// KindSessionDied: gone from tmux with its manifest row intact.
	KindSessionDied Kind = "session_died"
	// KindSessionKilled: gone from both, so the forget ran. Logged, never alerted.
	KindSessionKilled Kind = "session_killed"
	// KindClaudeDied: the session survived and the conversation in it did not.
	KindClaudeDied Kind = "claude_died"
	// KindPaneNearCap: the cap will take a conversation next, not a build.
	KindPaneNearCap Kind = "pane_near_cap"
	// KindRebooted: the box restarted, carrying how many sessions came back.
	KindRebooted Kind = "rebooted"
)

// Finding is one thing worth a journal line.
type Finding struct {
	Kind              Kind
	User              string
	Session           string
	State             string
	PaneBytes         uint64
	PaneUnreclaimable uint64
	PaneLimit         uint64
	Before            int
	After             int
}

type Config struct {
	// PaneWarnBytes is where the pane pre-warning sits, compared against
	// UNRECLAIMABLE memory rather than memory.current. Gated on the fattest
	// process being a claude, which is what lets it sit well below the cap.
	PaneWarnBytes uint64
	// ConfirmTicks is how many consecutive ticks a stamp-with-no-claude must
	// hold. Restarting claude to load a new skill set leaves a tick that looks
	// exactly like a death.
	ConfirmTicks int
	// SkipPrefixes names sessions that are not conversations, so losing one
	// costs nothing a person would miss.
	SkipPrefixes []string
	// TombstoneGrace is how recent a tombstone must be to explain the
	// disappearance we are looking at. The file is append-only and never pruned,
	// so a name killed weeks ago still has a row: without an age bound, a session
	// that reused that name and then genuinely died would be written off as a
	// deliberate kill.
	TombstoneGrace time.Duration
}

type Watcher struct {
	cfg  Config
	prev map[string]Snapshot
	// streak counts consecutive ticks of "stamp set, no claude" per session.
	streak map[string]int
	// open marks a level condition already reported, so an hour above the line
	// is one line rather than 120. The vanish comparison needs no such
	// bookkeeping: it is edge-triggered by construction, since prev advances
	// every tick.
	open map[string]bool
}

func NewWatcher(cfg Config) *Watcher {
	if cfg.ConfirmTicks < 1 {
		cfg.ConfirmTicks = 1
	}
	if cfg.TombstoneGrace <= 0 {
		cfg.TombstoneGrace = 90 * time.Second
	}
	return &Watcher{
		cfg:    cfg,
		prev:   map[string]Snapshot{},
		streak: map[string]int{},
		open:   map[string]bool{},
	}
}

// Tick folds one round of snapshots in and returns what changed worth saying.
func (w *Watcher) Tick(snaps []Snapshot) []Finding {
	var out []Finding
	for _, cur := range snaps {
		prev, seen := w.prev[cur.User]
		w.prev[cur.User] = cur

		// A boot id change means every session left tmux for a reason that is
		// not a memory kill, and tmux-persist is meant to bring them back. The
		// restore gap is the story, so the per-session findings stand down.
		rebooted := seen && cur.BootID != "" && prev.BootID != "" && prev.BootID != cur.BootID
		if rebooted {
			out = append(out, Finding{
				Kind:   KindRebooted,
				User:   cur.User,
				Before: w.countable(prev.Sessions),
				After:  w.countable(cur.Sessions),
			})
		}

		if seen && !rebooted {
			out = append(out, w.vanished(prev, cur)...)
		}
		out = append(out, w.standing(cur)...)
	}
	return out
}

// vanished reports sessions present last tick and absent now, split by whether a
// recent tombstone explains the disappearance.
func (w *Watcher) vanished(prev, cur Snapshot) []Finding {
	cutoff := cur.Taken.Add(-w.cfg.TombstoneGrace).Unix()
	var out []Finding
	for name, was := range prev.Sessions {
		if w.skip(name) {
			continue
		}
		if _, still := cur.Sessions[name]; still {
			continue
		}
		kind := KindSessionDied
		if ts, ok := cur.Tombstones[name]; ok && ts >= cutoff {
			kind = KindSessionKilled
		}
		out = append(out, Finding{
			Kind:    kind,
			User:    cur.User,
			Session: name,
			State:   was.ClaudeState,
		})
	}
	return out
}

// standing reports the two conditions read off a session that is still there.
func (w *Watcher) standing(cur Snapshot) []Finding {
	var out []Finding
	for name, s := range cur.Sessions {
		if w.skip(name) {
			continue
		}
		key := cur.User + "/" + name

		if s.ClaudeState != "" && !s.ClaudeAlive {
			w.streak[key]++
			if w.streak[key] >= w.cfg.ConfirmTicks && w.raise(KindClaudeDied, key) {
				out = append(out, Finding{
					Kind:    KindClaudeDied,
					User:    cur.User,
					Session: name,
					State:   s.ClaudeState,
				})
			}
		} else {
			delete(w.streak, key)
			w.clear(KindClaudeDied, key)
		}

		// Compared against unreclaimable memory, not memory.current: the cap
		// makes the kernel reclaim cache before it kills anything, so current
		// sitting at the ceiling is normal rather than dangerous. An uncapped
		// pane has nothing about to kill it either, so a warning there would
		// name a risk that is not present.
		if s.PaneLimit > 0 && s.PaneUnreclaimable >= w.cfg.PaneWarnBytes && s.TopIsClaude {
			if w.raise(KindPaneNearCap, key) {
				out = append(out, Finding{
					Kind:              KindPaneNearCap,
					User:              cur.User,
					Session:           name,
					PaneBytes:         s.PaneBytes,
					PaneUnreclaimable: s.PaneUnreclaimable,
					PaneLimit:         s.PaneLimit,
				})
			}
		} else {
			w.clear(KindPaneNearCap, key)
		}
	}
	return out
}

// raise opens an episode, reporting whether this call is the one that opened it.
func (w *Watcher) raise(k Kind, key string) bool {
	id := string(k) + "/" + key
	if w.open[id] {
		return false
	}
	w.open[id] = true
	return true
}

func (w *Watcher) clear(k Kind, key string) { delete(w.open, string(k)+"/"+key) }

func (w *Watcher) skip(name string) bool {
	for _, p := range w.cfg.SkipPrefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

func (w *Watcher) countable(sessions map[string]Session) int {
	n := 0
	for name := range sessions {
		if !w.skip(name) {
			n++
		}
	}
	return n
}
