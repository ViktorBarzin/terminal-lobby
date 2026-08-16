package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"terminal-lobby/sessionio"
)

// The reconciler's whole job is deciding what the difference between two lists
// MEANS. These tests are mostly about the meanings that must not be inferred:
// a session that is gone is not a kill, an archived thread is not a delete, and
// a title that differs is not a reason to touch tmux.

const (
	reconcileClaudeA = "aaaaaaaa-1111-4111-8111-111111111111"
	reconcileClaudeB = "bbbbbbbb-2222-4222-8222-222222222222"
)

// bind records what an adoption would have left behind, so a test can start
// from "this session is already mirrored".
// bind is the state after a COMPLETED adoption: thread created, binding
// written, warm-up landed. A binding with no WarmedAt is a different state —
// the thread exists and is empty — and TestPlanRetriesAWarmUpThatNeverLanded
// is what covers it.
func (h *harness) bind(claudeID, tmuxName, cwd, threadID string) {
	h.t.Helper()
	if err := h.index.Put(claudeID, sessionio.Binding{
		TmuxName: tmuxName, CWD: cwd, ThreadID: threadID, WarmedAt: time.Now().UTC(),
	}); err != nil {
		h.t.Fatalf("seed the binding: %v", err)
	}
	if err := h.tmux.SetOption("wizard", tmuxName, sessionio.OptionThread, threadID); err != nil &&
		h.tmux.HasSession(tmuxName) {
		h.t.Fatalf("stamp the thread: %v", err)
	}
}

// HasSession lets a test say "this session is still live" without reaching into
// the fake's lock.
func (f *fakeTmux) HasSession(name string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.options[name]
	return ok
}

func (h *harness) plan(t *testing.T, snap Snapshot) Plan {
	t.Helper()
	p, err := h.reconciler.Plan(context.Background(), snap)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	return p
}

func TestPlanAdoptsASessionT3HasNeverHeardOf(t *testing.T) {
	h := newHarness(t)
	h.startClaude("feat-header", "/home/wizard/code/terminal-lobby", reconcileClaudeA)

	p := h.plan(t, Snapshot{})
	if len(p.Adopt) != 1 || p.Adopt[0].TmuxName != "feat-header" {
		t.Fatalf("Adopt = %+v, want the unmirrored session", p.Adopt)
	}
	if len(p.KillSession) != 0 || len(p.ArchiveThread) != 0 {
		t.Errorf("plan %+v touches something destructive on a first sighting", p)
	}
}

// The steady state is an empty plan. Almost every pass on a healthy box should
// produce exactly this.
func TestPlanIsEmptyWhenBothSidesAgree(t *testing.T) {
	h := newHarness(t)
	h.startClaude("feat-header", "/home/wizard/code/terminal-lobby", reconcileClaudeA)
	h.bind(reconcileClaudeA, "feat-header", "/home/wizard/code/terminal-lobby", "t-1")

	p := h.plan(t, Snapshot{Threads: []Thread{{ID: "t-1", Title: "feat-header"}}})
	if !p.Empty() {
		t.Fatalf("Plan = %+v, want nothing to do", p)
	}
}

// Decision 7: one name, and tmux is the one that wins.
func TestPlanRenamesTheThreadToFollowTmux(t *testing.T) {
	h := newHarness(t)
	h.startClaude("feat-header", "/home/wizard/code/terminal-lobby", reconcileClaudeA)
	h.bind(reconcileClaudeA, "feat-header", "/home/wizard/code/terminal-lobby", "t-1")

	p := h.plan(t, Snapshot{Threads: []Thread{{ID: "t-1", Title: "Investigating the header layout"}}})
	if len(p.Rename) != 1 || p.Rename[0] != (Rename{ThreadID: "t-1", Title: "feat-header"}) {
		t.Fatalf("Rename = %+v, want the thread retitled to the tmux name", p.Rename)
	}
	if len(p.Adopt) != 0 {
		t.Errorf("a renamed thread was also adopted: %+v", p.Adopt)
	}
}

// Archive is T3's routine "done" gesture — 386 threads here, mostly archived.
// It crosses nothing, and it is not a reason to re-adopt a live session either.
func TestPlanLeavesAnArchivedThreadAlone(t *testing.T) {
	h := newHarness(t)
	h.startClaude("feat-header", "/home/wizard/code/terminal-lobby", reconcileClaudeA)
	h.bind(reconcileClaudeA, "feat-header", "/home/wizard/code/terminal-lobby", "t-1")

	p := h.plan(t, Snapshot{Threads: []Thread{
		{ID: "t-1", Title: "something else entirely", ArchivedAt: "2026-08-15T10:00:00.000Z"},
	}})
	if !p.Empty() {
		t.Fatalf("Plan = %+v, want an archived thread to change nothing", p)
	}
}

// Delete is the deliberate one, and it crosses: the session goes with it.
func TestPlanKillsTheSessionOfADeletedThread(t *testing.T) {
	h := newHarness(t)
	h.startClaude("feat-header", "/home/wizard/code/terminal-lobby", reconcileClaudeA)
	h.bind(reconcileClaudeA, "feat-header", "/home/wizard/code/terminal-lobby", "t-1")

	p := h.plan(t, Snapshot{Threads: []Thread{
		{ID: "t-1", Title: "feat-header", DeletedAt: "2026-08-15T10:00:00.000Z"},
	}})
	if len(p.KillSession) != 1 || p.KillSession[0] != "feat-header" {
		t.Fatalf("KillSession = %v, want [feat-header]", p.KillSession)
	}
	if len(p.Adopt) != 0 {
		t.Errorf("the session of a deleted thread was re-adopted: %+v", p.Adopt)
	}
}

// A binding whose name has been taken over by an unrelated session must not be
// enough to kill that session: the conversation is what was deleted, and the
// name is only how we find it.
func TestPlanWillNotKillAReusedName(t *testing.T) {
	h := newHarness(t)
	// The binding says feat-header ran conversation A. It does not any more:
	// something else is running under that name now.
	h.startClaude("feat-header", "/home/wizard/code/terminal-lobby", reconcileClaudeB)
	if err := h.index.Put(reconcileClaudeA, sessionio.Binding{
		TmuxName: "feat-header", CWD: "/home/wizard/code/terminal-lobby", ThreadID: "t-1",
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	p := h.plan(t, Snapshot{Threads: []Thread{
		{ID: "t-1", Title: "feat-header", DeletedAt: "2026-08-15T10:00:00.000Z"},
	}})
	if len(p.KillSession) != 0 {
		t.Fatalf("KillSession = %v, want nothing: that session is a different conversation", p.KillSession)
	}
}

// A lobby kill is the one disappearance that crosses, and the notice is the
// only evidence of it.
func TestPlanArchivesOnAKillNotice(t *testing.T) {
	h := newHarness(t)
	h.startClaude("feat-header", "/home/wizard/code/terminal-lobby", reconcileClaudeA)
	h.bind(reconcileClaudeA, "feat-header", "/home/wizard/code/terminal-lobby", "t-1")
	h.tmux.vanish("feat-header")
	h.notices.Requeue([]string{"feat-header"})

	p := h.plan(t, Snapshot{Threads: []Thread{{ID: "t-1", Title: "feat-header"}}})
	if len(p.ArchiveThread) != 1 || p.ArchiveThread[0] != "t-1" {
		t.Fatalf("ArchiveThread = %v, want [t-1]", p.ArchiveThread)
	}
	// The conversation survives the session, so the binding stays: the next
	// prompt in T3 resurrects it.
	if len(p.PruneBinding) != 0 {
		t.Errorf("PruneBinding = %v, want the binding kept for a resurrection", p.PruneBinding)
	}
}

// earlyoom fired, or the box rebooted. Nothing crosses (decision 3) — and this
// is the test that stops a bad night from archiving fourteen threads.
func TestPlanIgnoresASessionThatMerelyVanished(t *testing.T) {
	h := newHarness(t)
	h.startClaude("feat-header", "/home/wizard/code/terminal-lobby", reconcileClaudeA)
	h.bind(reconcileClaudeA, "feat-header", "/home/wizard/code/terminal-lobby", "t-1")
	h.tmux.vanish("feat-header")

	p := h.plan(t, Snapshot{Threads: []Thread{{ID: "t-1", Title: "feat-header"}}})
	if !p.Empty() {
		t.Fatalf("Plan = %+v, want nothing: a session that stopped existing was not killed", p)
	}
}

// tmux is the authority, not the notice. A notice for a session that is still
// there is a stray — a spoof, a retry after a restart — and acting on it would
// archive the thread of a session somebody is working in.
func TestPlanIgnoresANoticeForALiveSession(t *testing.T) {
	h := newHarness(t)
	h.startClaude("feat-header", "/home/wizard/code/terminal-lobby", reconcileClaudeA)
	h.bind(reconcileClaudeA, "feat-header", "/home/wizard/code/terminal-lobby", "t-1")
	h.notices.Requeue([]string{"feat-header"})

	p := h.plan(t, Snapshot{Threads: []Thread{{ID: "t-1", Title: "feat-header"}}})
	if len(p.ArchiveThread) != 0 {
		t.Fatalf("ArchiveThread = %v, want nothing: the session is still running", p.ArchiveThread)
	}
}

// A thread that is already archived, or already deleted, needs no archiving.
func TestPlanDoesNotReArchive(t *testing.T) {
	for _, tc := range []struct{ name, archived, deleted string }{
		{"already archived", "2026-08-15T10:00:00.000Z", ""},
		{"already deleted", "", "2026-08-15T10:00:00.000Z"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			h.bind(reconcileClaudeA, "feat-header", "/home/wizard/code/terminal-lobby", "t-1")
			h.notices.Requeue([]string{"feat-header"})

			p := h.plan(t, Snapshot{Threads: []Thread{
				{ID: "t-1", Title: "feat-header", ArchivedAt: tc.archived, DeletedAt: tc.deleted},
			}})
			if len(p.ArchiveThread) != 0 {
				t.Errorf("ArchiveThread = %v, want nothing", p.ArchiveThread)
			}
		})
	}
}

// A binding neither surface has any use for is swept up. The condition is
// deliberately narrow — no live session AND no live thread — because a binding
// is exactly what a resurrection needs and dropping one early makes a thread
// permanently unresurrectable.
func TestPlanPrunesOnlyDoublyDeadBindings(t *testing.T) {
	h := newHarness(t)
	h.bind(reconcileClaudeA, "gone-for-good", "/home/wizard/code/x", "t-dead")
	h.bind(reconcileClaudeB, "also-gone", "/home/wizard/code/y", "t-live")

	p := h.plan(t, Snapshot{Threads: []Thread{
		{ID: "t-dead", DeletedAt: "2026-08-15T10:00:00.000Z"},
		{ID: "t-live", Title: "also-gone"},
	}})
	if len(p.PruneBinding) != 1 || p.PruneBinding[0] != reconcileClaudeA {
		t.Fatalf("PruneBinding = %v, want only the conversation neither side has", p.PruneBinding)
	}
}

// An ignored session is invisible to every rule, including the destructive
// ones: the QA harness makes and kills sessions constantly.
func TestPlanIgnoresMachineMadeSessions(t *testing.T) {
	h := newHarness(t)
	h.startClaude("qa-headless-1", "/home/wizard/code/qa", reconcileClaudeA)

	p := h.plan(t, Snapshot{})
	if !p.Empty() {
		t.Fatalf("Plan = %+v, want the QA session left alone", p)
	}
}

func TestApplyDispatchesThePlan(t *testing.T) {
	h := newHarness(t)
	h.startClaude("feat-header", "/home/wizard/code/terminal-lobby", reconcileClaudeA)
	h.bind(reconcileClaudeA, "feat-header", "/home/wizard/code/terminal-lobby", "t-1")

	if err := h.reconciler.Apply(context.Background(), Plan{
		Rename:        []Rename{{ThreadID: "t-1", Title: "feat-header"}},
		ArchiveThread: []string{"t-2"},
		KillSession:   []string{"feat-header"},
		PruneBinding:  []string{reconcileClaudeA},
	}); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	renamed := h.t3.dispatched(VerbThreadMetaUpdate)
	if len(renamed) != 1 || jsonString(renamed[0]["title"]) != "feat-header" {
		t.Errorf("thread.meta.update = %v, want one retitle to feat-header", renamed)
	}
	archived := h.t3.dispatched(VerbThreadArchive)
	if len(archived) != 1 || jsonString(archived[0]["threadId"]) != "t-2" {
		t.Errorf("thread.archive = %v, want one for t-2", archived)
	}
	// The kill goes through tmux-api, never through tmux: the lobby owns every
	// mutation of a session, and it is what tells the rest of the lobby.
	killed := false
	for _, call := range h.lobby.seenCalls() {
		if strings.HasPrefix(call, "DELETE /sessions/feat-header ") {
			killed = true
		}
	}
	if !killed {
		t.Errorf("tmux-api saw %v, want a DELETE for feat-header", h.lobby.seenCalls())
	}
	if _, ok, _ := h.index.Get(reconcileClaudeA); ok {
		t.Error("the pruned binding is still in the index")
	}
}

// The first run against a user with live threads is a dry run, and it has to be
// worth reading and worth nothing else.
func TestApplyDryRunDispatchesNothing(t *testing.T) {
	h := newHarness(t)
	h.cfg.DryRun = true
	h.reconciler.Cfg = h.cfg
	h.startClaude("feat-header", "/home/wizard/code/terminal-lobby", reconcileClaudeA)
	h.bind(reconcileClaudeA, "feat-header", "/home/wizard/code/terminal-lobby", "t-1")

	if err := h.reconciler.Apply(context.Background(), Plan{
		Adopt:         []Candidate{{TmuxName: "feat-header", ClaudeID: reconcileClaudeA}},
		Rename:        []Rename{{ThreadID: "t-1", Title: "feat-header"}},
		ArchiveThread: []string{"t-2"},
		KillSession:   []string{"feat-header"},
		PruneBinding:  []string{reconcileClaudeA},
	}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if seen := h.t3.seen(); len(seen) != 0 {
		t.Errorf("a dry run dispatched %v", seen)
	}
	if calls := h.lobby.seenCalls(); len(calls) != 0 {
		t.Errorf("a dry run called tmux-api: %v", calls)
	}
	if _, ok, _ := h.index.Get(reconcileClaudeA); !ok {
		t.Error("a dry run deleted a binding")
	}
}

// One unreachable thing must not stop every other session from reconciling —
// and a notice acted on unsuccessfully has to come back, or the kill is lost.
func TestApplyKeepsGoingAndRequeuesAFailedArchive(t *testing.T) {
	h := newHarness(t)
	h.t3.setDispatch(func(w http.ResponseWriter, body map[string]json.RawMessage, calls int) {
		if jsonString(body["type"]) == VerbThreadArchive {
			writeJSON(w, http.StatusInternalServerError, dispatchRejectedJSON)
			return
		}
		writeJSON(w, http.StatusOK, `{"sequence":1}`)
	})
	h.bind(reconcileClaudeA, "feat-header", "/home/wizard/code/x", "t-1")

	err := h.reconciler.Apply(context.Background(), Plan{
		ArchiveThread: []string{"t-1"},
		Rename:        []Rename{{ThreadID: "t-2", Title: "still-done"}},
	})
	if err == nil {
		t.Fatal("Apply returned nil after a dispatch failed")
	}
	if len(h.t3.dispatched(VerbThreadMetaUpdate)) != 1 {
		t.Error("the rename after the failed archive was skipped")
	}
	if got := h.notices.Drain(); len(got) != 1 || got[0] != "feat-header" {
		t.Errorf("Drain() = %v, want the session requeued for the next pass", got)
	}
}

func TestParseIgnore(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []string
	}{
		{"empty means the default list", "", DefaultIgnorePrefixes},
		{"whitespace is empty", "   ", DefaultIgnorePrefixes},
		{"the literal none means nothing is ignored", "none", nil},
		{"a list", "qa-,tlp-t", []string{"qa-", "tlp-t"}},
		{"padding and empties are dropped", " qa- , ,tlp-t ", []string{"qa-", "tlp-t"}},
		{"only separators falls back", ",,,", DefaultIgnorePrefixes},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := ParseIgnore(c.in)
			if strings.Join(got, ",") != strings.Join(c.want, ",") {
				t.Errorf("ParseIgnore(%q) = %v, want %v", c.in, got, c.want)
			}
		})
	}
}

// T3's snapshot is a projection and can lag a thread this syncer just created.
// Treating that absence as "the thread is gone" would create a new thread every
// tick, so the ambiguous case does nothing at all.
func TestPlanDoesNotReAdoptWhenT3HasNotCaughtUp(t *testing.T) {
	h := newHarness(t)
	h.startClaude("feat-header", "/home/wizard/code/terminal-lobby", reconcileClaudeA)
	h.bind(reconcileClaudeA, "feat-header", "/home/wizard/code/terminal-lobby", "t-nowhere")

	for i := 0; i < 3; i++ {
		p := h.plan(t, Snapshot{Threads: []Thread{{ID: "t-other", Title: "someone else"}}})
		if !p.Empty() {
			t.Fatalf("pass %d planned %+v, want nothing for a thread t3 has not projected yet", i, p)
		}
	}
}

// tmux is the authority on "gone", and the whole session list is what is asked
// — not the candidate list. A session whose Claude has exited still exists, and
// archiving its thread would take the conversation out of T3 while somebody is
// still sitting in the pane.
func TestPlanIgnoresANoticeForASessionWithoutAClaude(t *testing.T) {
	h := newHarness(t)
	h.bind(reconcileClaudeA, "plain-shell", "/home/wizard", "t-1")
	h.tmux.start("plain-shell", "/home/wizard") // live, but nothing stamped
	h.notices.Requeue([]string{"plain-shell"})

	p := h.plan(t, Snapshot{Threads: []Thread{{ID: "t-1", Title: "plain-shell"}}})
	if len(p.ArchiveThread) != 0 {
		t.Fatalf("ArchiveThread = %v, want nothing: the session is still there", p.ArchiveThread)
	}
}
