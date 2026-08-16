package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sort"
	"time"

	"terminal-lobby/sessionio"
)

// One reconcile pass: compare the user's live tmux sessions against T3's thread
// list and close the gap.
//
// The direction of authority is decision 2 — the lobby is the writer of record
// for existence, naming, grouping and sharing, because T3 has no notion of
// owners, shares, layout or OS-user isolation. Whatever T3 knows, we told it.
//
// Destruction is the part that needs care, because the two surfaces mean
// different things by "done" (decision 3):
//
//	thread deleted in T3        → kill the tmux session
//	thread archived in T3       → nothing; archive is a T3-side gesture
//	session killed in the lobby → archive the thread; the conversation survives
//	earlyoom kills a Claude     → nothing crosses; the next prompt resurrects it
//	T3 reaps the bridge         → nothing crosses; the bridge is a client
//
// Archive is the routine "done" gesture here — 386 threads, mostly archived —
// so mapping it to a kill would be destructive by accident.

// Reconciler runs the passes.
type Reconciler struct {
	Cfg     Config
	Client  *Client
	Adopter *Adopter
	Tmux    tmuxSource
	// Lobby is tmux-api. Every mutation of a session goes through it rather
	// than through tmux directly, so the project assignment, the layout and the
	// rest of the lobby hear about it.
	Lobby    *TmuxAPI
	Bindings *sessionio.Index
	// Notices carries the deliberate-kill signal from tmux-api (CONTRACT.md §8).
	// Without it a lobby kill is indistinguishable from an OOM and crosses
	// nothing, which is the safe way to lose the signal.
	Notices *KillNotices

	// orphans remembers which "bound to a thread t3 does not have" pairings
	// have already been logged. Written only from the reconcile loop's own
	// goroutine.
	orphans map[string]bool
}

// Plan is what one pass intends to do, computed before anything is dispatched.
//
// Computing the whole plan first is what makes --dry-run meaningful and what
// makes a pass reviewable in a log: the first run against a user with live
// threads is a dry run, and a plan that is only a list of intentions is the
// thing to read.
type Plan struct {
	// Adopt are live sessions with no thread yet.
	Adopt []Candidate
	// Rename are threads whose title no longer matches their tmux session.
	// tmux wins (decision 7).
	Rename []Rename
	// ArchiveThread are threads whose tmux session was deliberately killed.
	ArchiveThread []string
	// KillSession are tmux sessions whose thread was deliberately deleted.
	KillSession []string
	// PruneBinding are index entries for conversations neither surface has.
	PruneBinding []string
	// WarmUp are threads that exist and were never warmed, so the bridge has
	// never been spawned for them and their history has never replayed.
	WarmUp []WarmUp

	// notices are the kill notices this plan consumed. Apply hands back the
	// ones it could not act on, so a kill dispatched while t3-serve was down is
	// retried rather than lost.
	notices []string
}

// Rename is one title correction.
type Rename struct {
	ThreadID string
	Title    string
}

// WarmUp is one retry of decision 11's sentinel turn.
type WarmUp struct {
	ThreadID string
	ClaudeID string
	TmuxName string
}

// Empty reports whether the plan would change nothing — the steady state, and
// what almost every pass should produce.
func (p Plan) Empty() bool {
	return len(p.Adopt) == 0 && len(p.Rename) == 0 && len(p.ArchiveThread) == 0 &&
		len(p.KillSession) == 0 && len(p.PruneBinding) == 0 && len(p.WarmUp) == 0
}

// Plan computes the pass without changing anything.
//
// The distinction that matters most is deliberate destruction versus a process
// merely exiting. A tmux session that is GONE is not evidence of a kill — OOM
// and reboots look identical — so the only evidence of a lobby-side kill is a
// notice from tmux-api, and even that is checked against tmux before it is
// believed. Everything ambiguous resolves to doing nothing.
func (r *Reconciler) Plan(ctx context.Context, snap Snapshot) (Plan, error) {
	candidates, err := r.Adopter.Candidates()
	if err != nil {
		return Plan{}, err
	}
	byClaude := make(map[string]Candidate, len(candidates)) // uuid → candidate
	for _, c := range candidates {
		byClaude[c.ClaudeID] = c
	}
	// Every session, not just the candidates: a kill notice is checked against
	// what tmux actually has, and a session that is running without a Claude in
	// it — or under an ignored name — is still running (CONTRACT.md §8.2).
	sessions, err := r.Tmux.ListSessions(r.Cfg.OSUser)
	if err != nil {
		return Plan{}, fmt.Errorf("list sessions: %w", err)
	}
	live := make(map[string]bool, len(sessions))
	for _, s := range sessions {
		live[s.Name] = true
	}
	bindings, err := r.Bindings.All()
	if err != nil {
		return Plan{}, fmt.Errorf("read the binding index: %w", err)
	}

	var p Plan
	for _, c := range candidates {
		binding := bindings[c.ClaudeID]
		threadID := c.ThreadID
		if threadID == "" {
			threadID = binding.ThreadID
		}
		if threadID == "" {
			if binding.FromT3() {
				// The bridge created this session for a thread T3 already has.
				// Which thread is the one fact nobody can tell us — T3 does not
				// pass it to the bridge, and the snapshot does not project the
				// session id that would identify it — so adopting would make a
				// SECOND thread for a conversation that already has one. Leaving
				// it alone costs the tmux→T3 rename and the kill→archive for
				// these sessions; making a duplicate cost the delete→kill as
				// well, and broke it silently.
				continue
			}
			p.Adopt = append(p.Adopt, c)
			continue
		}
		// A thread that exists but never got its warm-up turn is empty for good
		// unless it is retried: the thread is bound, so it is not a candidate
		// again, and nothing else ever spawns a bridge for it. The dispatch is
		// what fails here (a 400 on a payload T3's client-facing schema
		// rejected), not the adoption around it, so the retry is just the turn.
		if binding.ThreadID == threadID && binding.WarmedAt.IsZero() {
			if thread, ok := snap.Thread(threadID); ok && !thread.Archived() && !thread.Deleted() {
				p.WarmUp = append(p.WarmUp, WarmUp{ThreadID: threadID, ClaudeID: c.ClaudeID, TmuxName: c.TmuxName})
			}
		}
		thread, ok := snap.Thread(threadID)
		if !ok {
			// The binding names a thread this snapshot does not carry. That is
			// ambiguous — T3's read model is a projection and can lag a thread
			// this syncer created seconds ago, and a base dir pointed at a
			// different server looks the same — so nothing happens. Re-adopting
			// on the strength of an absence would create a fresh thread every
			// five seconds for as long as the ambiguity lasted; leaving it alone
			// costs one session that is not mirrored until someone says so.
			r.warnOrphan(c.TmuxName, threadID)
			continue
		}
		switch {
		case thread.Deleted():
			// Deliberate destruction, and it crosses (decision 3).
			p.KillSession = append(p.KillSession, c.TmuxName)
		case thread.Archived():
			// The routine "done" gesture. It crosses nothing — and the session
			// is not renamed to match a title nobody is looking at either.
		case binding.FromT3():
			// The bridge named this session after the workspace root, because
			// T3 sends it the directory and never the thread's title. Pushing
			// that back over T3's own title would replace "Fix the header
			// spacing" with "terminal-lobby-2" — decision 7's "tmux wins" is
			// about names a HUMAN chose in the lobby.
			//
			// Session titles do not change this. A T3-born session still has no
			// title of its own, so ThreadTitle() falls back to that same
			// workspace slug and there is still nothing worth pushing.
		case thread.Title != c.ThreadTitle():
			p.Rename = append(p.Rename, Rename{ThreadID: threadID, Title: c.ThreadTitle()})
		}
	}

	// A kill notice is the only evidence that a session's disappearance was
	// deliberate. tmux is still the authority on whether it is gone: a notice
	// for a session that is running is stale or spoofed, and archiving on it
	// would take away the thread of a session somebody is working in.
	p.notices = r.Notices.Drain()
	for _, name := range p.notices {
		if live[name] {
			log.Printf("kill notice for %s ignored: the session is still running", name)
			continue
		}
		threadID, ok := threadForSession(bindings, name)
		if !ok {
			continue // never mirrored; nothing to archive
		}
		thread, ok := snap.Thread(threadID)
		if !ok || thread.Archived() || thread.Deleted() {
			continue // already in the state the notice is asking for
		}
		p.ArchiveThread = append(p.ArchiveThread, threadID)
	}

	// A binding is what a resurrection is built from, so dropping one needs
	// POSITIVE evidence that nothing will ever want it — not merely an absence.
	//
	// Absence is exactly what a reboot produces: `list-sessions` against a tmux
	// server that is not there is an ordinary empty list, so every binding on
	// the box looks abandoned at once. The rule that used to apply here dropped
	// every entry with no thread id on the first pass after a restart, and an
	// empty thread id is the NORMAL state for a session the bridge created.
	// Both facts a resurrection needs — the tmux name and the cwd — live only
	// here, so that was the one copy.
	//
	// So: prune a bound binding only when its thread is known DELETED (a
	// snapshot that merely lags is not evidence), and an unbound one only once
	// it is old enough that nothing is coming for it.
	prunable := time.Now().Add(-bindingGrace)
	for claudeID, b := range bindings {
		if _, ok := byClaude[claudeID]; ok {
			continue
		}
		if b.ThreadID != "" {
			thread, ok := snap.Thread(b.ThreadID)
			if !ok || !thread.Deleted() {
				continue
			}
		} else if b.UpdatedAt.After(prunable) {
			continue
		}
		p.PruneBinding = append(p.PruneBinding, claudeID)
	}
	// Map iteration is random, and a plan that reads differently every pass is
	// a plan nobody can diff in a journal.
	sort.Strings(p.PruneBinding)

	return p, nil
}

// warnOrphan reports a binding that points at a thread T3 does not have, once
// per pairing rather than once per pass: this runs on a five-second ticker, and
// a line every tick would bury the journal it is meant to be found in.
func (r *Reconciler) warnOrphan(tmuxName, threadID string) {
	key := tmuxName + "\x00" + threadID
	if r.orphans[key] {
		return
	}
	if r.orphans == nil {
		r.orphans = map[string]bool{}
	}
	r.orphans[key] = true
	log.Printf("session %s is bound to thread %s, which t3 does not have; leaving it alone "+
		"(t3 may still be catching up — if it persists, clear %s on the session)",
		tmuxName, threadID, sessionio.OptionThread)
}

// bindingGrace is how long an unadopted binding is kept once its session is no
// longer live. It is long because the cost of keeping one is a few hundred
// bytes and the cost of dropping one is a conversation that can never be
// resurrected under its own name and directory again.
const bindingGrace = 30 * 24 * time.Hour

// threadForSession finds the thread bound to a tmux session name.
//
// The index is keyed by conversation, not by name, because a name is reusable
// and a conversation is not. Reversing it is therefore AMBIGUOUS: bindings for
// dead conversations are kept on purpose, so two entries can name `work` — last
// week's, retained for resurrection, and today's. Picking whichever the map
// happened to yield archived a thread nobody had touched about half the time,
// and left the one that had just lost its session open.
//
// The newest write wins, and a genuine tie is left alone: there is no way to
// tell those apart, and archiving the wrong thread is worse than archiving
// none.
func threadForSession(bindings map[string]sessionio.Binding, name string) (string, bool) {
	best, tied := sessionio.Binding{}, false
	for _, b := range bindings {
		if b.TmuxName != name || b.ThreadID == "" {
			continue
		}
		switch {
		case best.ThreadID == "" || b.UpdatedAt.After(best.UpdatedAt):
			best, tied = b, false
		case b.UpdatedAt.Equal(best.UpdatedAt) && b.ThreadID != best.ThreadID:
			tied = true
		}
	}
	if best.ThreadID == "" {
		return "", false
	}
	if tied {
		log.Printf("kill notice for %s: two bindings name it and neither is newer; archiving nothing", name)
		return "", false
	}
	return best.ThreadID, true
}

// Apply executes a plan. With Cfg.DryRun it logs every intended dispatch and
// sends none.
//
// A failure on one item does not abort the pass: the next tick retries, and one
// unreachable session must not stop every other session from being reconciled.
// The error it returns is a count for the caller's log line, not a reason to
// stop the loop.
func (r *Reconciler) Apply(ctx context.Context, p Plan) error {
	if r.Cfg.DryRun {
		r.logPlan(p)
		// Nothing was acted on, so the notices go back: a dry run must leave the
		// world — including our own inbox — exactly as it found it.
		r.Notices.Requeue(p.notices)
		return nil
	}

	var failures []error

	for _, c := range p.Adopt {
		threadID, err := r.Adopter.Adopt(ctx, c)
		if err != nil {
			failures = append(failures, err)
			continue
		}
		log.Printf("adopted %s as thread %s", c.TmuxName, threadID)
	}

	for _, w := range p.WarmUp {
		if err := r.Adopter.WarmUp(ctx, w.ThreadID, w.ClaudeID); err != nil {
			failures = append(failures, fmt.Errorf("warm up thread %s (%s): %w", w.ThreadID, w.TmuxName, err))
			continue
		}
		log.Printf("thread %s warmed up: %s will now replay into it", w.ThreadID, w.TmuxName)
	}

	for _, rn := range p.Rename {
		payload, err := json.Marshal(struct {
			ThreadID string `json:"threadId"`
			Title    string `json:"title"`
		}{rn.ThreadID, rn.Title})
		if err != nil {
			failures = append(failures, err)
			continue
		}
		if _, err := r.Client.Dispatch(ctx, VerbThreadMetaUpdate, payload); err != nil {
			failures = append(failures, fmt.Errorf("rename thread %s: %w", rn.ThreadID, err))
			continue
		}
		log.Printf("thread %s retitled to %s", rn.ThreadID, rn.Title)
	}

	// An archive that failed puts its notice back in the inbox. Everything else
	// in this pass is re-derived from scratch next tick; the kill notice is the
	// one fact that exists nowhere else, so losing it loses the archive for good.
	var unarchived []string
	for _, threadID := range p.ArchiveThread {
		payload, err := json.Marshal(struct {
			ThreadID string `json:"threadId"`
		}{threadID})
		if err != nil {
			failures = append(failures, err)
			unarchived = append(unarchived, threadID)
			continue
		}
		if _, err := r.Client.Dispatch(ctx, VerbThreadArchive, payload); err != nil {
			failures = append(failures, fmt.Errorf("archive thread %s: %w", threadID, err))
			unarchived = append(unarchived, threadID)
			continue
		}
		log.Printf("thread %s archived: its session was killed in the lobby", threadID)
	}

	for _, name := range p.KillSession {
		if err := r.Lobby.Kill(ctx, name); err != nil {
			failures = append(failures, fmt.Errorf("kill session %s: %w", name, err))
			continue
		}
		log.Printf("session %s killed: its thread was deleted in t3", name)
	}

	if len(p.PruneBinding) > 0 {
		if err := r.Bindings.Update(func(all map[string]sessionio.Binding) error {
			for _, claudeID := range p.PruneBinding {
				delete(all, claudeID)
			}
			return nil
		}); err != nil {
			failures = append(failures, fmt.Errorf("prune %d bindings: %w", len(p.PruneBinding), err))
		}
	}

	r.Notices.Requeue(r.sessionsForThreads(unarchived))
	if len(failures) > 0 {
		return fmt.Errorf("%d of the pass's actions failed, first: %w", len(failures), failures[0])
	}
	return nil
}

// sessionsForThreads reverses the binding index: the tmux session names behind
// a set of threads.
//
// It is how a failed archive becomes a notice again. Deriving the name here
// rather than carrying it through the plan means the requeue works for any
// ArchiveThread entry, however the plan was built — and every entry there came
// from a notice in the first place, since nothing else produces one.
func (r *Reconciler) sessionsForThreads(threadIDs []string) []string {
	if len(threadIDs) == 0 {
		return nil
	}
	bindings, err := r.Bindings.All()
	if err != nil {
		log.Printf("cannot requeue %d kill notices: %v", len(threadIDs), err)
		return nil
	}
	wanted := make(map[string]bool, len(threadIDs))
	for _, id := range threadIDs {
		wanted[id] = true
	}
	var out []string
	for _, b := range bindings {
		if b.TmuxName != "" && wanted[b.ThreadID] {
			out = append(out, b.TmuxName)
		}
	}
	sort.Strings(out)
	return out
}

// logPlan writes a dry run's intentions, one line each — the thing an operator
// reads before enabling a syncer against a user with live threads.
func (r *Reconciler) logPlan(p Plan) {
	for _, c := range p.Adopt {
		log.Printf("dry run: would adopt %s (%s) in %s", c.TmuxName, c.ClaudeID, c.CWD)
	}
	for _, rn := range p.Rename {
		log.Printf("dry run: would retitle thread %s to %s", rn.ThreadID, rn.Title)
	}
	for _, id := range p.ArchiveThread {
		log.Printf("dry run: would archive thread %s", id)
	}
	for _, name := range p.KillSession {
		log.Printf("dry run: would kill session %s", name)
	}
	for _, id := range p.PruneBinding {
		log.Printf("dry run: would forget the binding for %s", id)
	}
	for _, w := range p.WarmUp {
		log.Printf("dry run: would warm up thread %s for %s", w.ThreadID, w.TmuxName)
	}
}

// Ignored reports whether a session name is machine-made and not worth a thread
// — the QA harness's sessions, agent worktrees, this project's own e2e
// sessions (decision 4).
func Ignored(name string, prefixes []string) bool {
	for _, p := range prefixes {
		if len(name) >= len(p) && name[:len(p)] == p {
			return true
		}
	}
	return false
}
