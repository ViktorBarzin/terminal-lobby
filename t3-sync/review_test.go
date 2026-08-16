package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"terminal-lobby/sessionio"
)

// Regression tests for the review pass on 2026-08-16.

// T3's HTTP route decodes ClientThreadTurnStartCommand, whose runtimeMode and
// interactionMode are plain required fields — the internal command gives both a
// decoding default, the client-facing one does not. A payload missing
// interactionMode comes back 400 with an empty body and nothing logged
// server-side, so every adopted thread stayed bound and permanently empty.
func TestWarmUpCarriesTheFieldsT3Requires(t *testing.T) {
	h := newHarness(t)
	repo := filepath.Join(t.TempDir(), "terminal-lobby")
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	h.startClaude("feat-header", repo, reconcileClaudeA)
	cands, err := h.adopter.Candidates()
	if err != nil {
		t.Fatalf("Candidates: %v", err)
	}
	if _, err := h.adopter.Adopt(context.Background(), cands[0]); err != nil {
		t.Fatalf("Adopt: %v", err)
	}

	warm := h.t3.dispatched(VerbTurnStart)
	if len(warm) != 1 {
		t.Fatalf("dispatched %d warm-up turns, want 1", len(warm))
	}
	for _, key := range []string{"runtimeMode", "interactionMode"} {
		raw, ok := warm[0][key]
		if !ok {
			t.Fatalf("thread.turn.start has no %s; T3 answers 400 with an empty body", key)
		}
		if v := jsonString(raw); v == "" {
			t.Errorf("%s is empty; the schema declares a literal union", key)
		}
	}
	if got := jsonString(warm[0]["interactionMode"]); got != "default" {
		t.Errorf("interactionMode = %q, want T3's own default", got)
	}
}

// A warm-up that failed used to latch off: the thread was bound, so the session
// stopped being an adoption candidate and nothing ever spawned a bridge for it.
func TestPlanRetriesAWarmUpThatNeverLanded(t *testing.T) {
	h := newHarness(t)
	h.startClaude("feat-header", "/home/wizard/code/terminal-lobby", reconcileClaudeA)
	// The state a failed warm-up leaves behind: thread created, binding written,
	// WarmedAt never stamped.
	if err := h.index.Put(reconcileClaudeA, sessionio.Binding{
		TmuxName: "feat-header", CWD: "/home/wizard/code/terminal-lobby", ThreadID: "t-1",
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := h.tmux.SetOption("wizard", "feat-header", sessionio.OptionThread, "t-1"); err != nil {
		t.Fatalf("stamp: %v", err)
	}

	p := h.plan(t, Snapshot{Threads: []Thread{{ID: "t-1", Title: "feat-header"}}})
	if len(p.WarmUp) != 1 || p.WarmUp[0].ThreadID != "t-1" || p.WarmUp[0].ClaudeID != reconcileClaudeA {
		t.Fatalf("WarmUp = %+v, want a retry for the empty thread", p.WarmUp)
	}
	if len(p.Adopt) != 0 {
		t.Errorf("it also tried to adopt the session again: %+v", p.Adopt)
	}

	if err := h.reconciler.Apply(context.Background(), p); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if len(h.t3.dispatched(VerbTurnStart)) != 1 {
		t.Fatalf("dispatched %d warm-up turns", len(h.t3.dispatched(VerbTurnStart)))
	}
	// And once it lands it is not retried for ever.
	if p := h.plan(t, Snapshot{Threads: []Thread{{ID: "t-1", Title: "feat-header"}}}); len(p.WarmUp) != 0 {
		t.Fatalf("WarmUp = %+v after a successful warm-up", p.WarmUp)
	}
}

// The prune pass is what a resurrection is built from, so an ABSENCE must never
// be enough to drop one. `list-sessions` against a tmux server that is not
// there is an ordinary empty list, so after a reboot every binding on the box
// looks abandoned at once — and an empty thread id is the normal state for a
// session the bridge created.
func TestPruneKeepsBindingsWhenTmuxHasNothingToSay(t *testing.T) {
	h := newHarness(t)
	if err := h.index.Put(reconcileClaudeA, sessionio.Binding{
		TmuxName: "feat-header", CWD: "/home/wizard/code/terminal-lobby",
	}); err != nil {
		t.Fatalf("seed the unadopted binding: %v", err)
	}
	if err := h.index.Put(reconcileClaudeB, sessionio.Binding{
		TmuxName: "other", CWD: "/home/wizard/code/tl", ThreadID: "t-9",
	}); err != nil {
		t.Fatalf("seed the bound binding: %v", err)
	}

	// A reboot: no tmux server, and a snapshot that has not caught up either.
	p := h.plan(t, Snapshot{})
	if len(p.PruneBinding) != 0 {
		t.Fatalf("PruneBinding = %v; a reboot is not evidence that a conversation is gone", p.PruneBinding)
	}
}

// Positive evidence still prunes: a thread T3 says is DELETED, and an unadopted
// binding old enough that nothing is coming for it.
func TestPruneDropsWhatIsGenuinelyGone(t *testing.T) {
	h := newHarness(t)
	if err := h.index.Put(reconcileClaudeA, sessionio.Binding{
		TmuxName: "deleted-thread", ThreadID: "t-1",
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := h.index.Put(reconcileClaudeB, sessionio.Binding{
		TmuxName: "long-forgotten", UpdatedAt: time.Now().Add(-2 * bindingGrace),
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	p := h.plan(t, Snapshot{Threads: []Thread{{ID: "t-1", DeletedAt: "2026-08-16T00:00:00Z"}}})
	want := []string{reconcileClaudeA, reconcileClaudeB} // Plan sorts them
	if strings.Join(p.PruneBinding, ",") != strings.Join(want, ",") {
		t.Fatalf("PruneBinding = %v, want %v", p.PruneBinding, want)
	}
}

// tmux names are reusable and stale bindings are kept on purpose, so reversing
// the index by name is ambiguous. Picking whichever the map yielded archived a
// thread nobody had touched about half the time.
func TestThreadForSessionPrefersTheNewestBinding(t *testing.T) {
	older := time.Now().Add(-7 * 24 * time.Hour)
	bindings := map[string]sessionio.Binding{
		"conv-last-week": {TmuxName: "work", ThreadID: "t-old", UpdatedAt: older},
		"conv-today":     {TmuxName: "work", ThreadID: "t-new", UpdatedAt: time.Now()},
	}
	for i := 0; i < 20; i++ { // map order is randomised per range
		got, ok := threadForSession(bindings, "work")
		if !ok || got != "t-new" {
			t.Fatalf("threadForSession = (%q, %v), want the newest binding", got, ok)
		}
	}

	// A genuine tie is left alone: archiving the wrong thread is worse than
	// archiving none.
	same := time.Now().UTC()
	tie := map[string]sessionio.Binding{
		"a": {TmuxName: "work", ThreadID: "t-a", UpdatedAt: same},
		"b": {TmuxName: "work", ThreadID: "t-b", UpdatedAt: same},
	}
	if got, ok := threadForSession(tie, "work"); ok {
		t.Fatalf("threadForSession on a tie = %q, want nothing", got)
	}
}

// A session the bridge created for a T3-born thread must not be adopted: T3
// already has a thread for it and nothing can tell us which, so a second one is
// what adoption would make. Its title must not be overwritten either — the
// tmux name is a slug of the workspace root, and T3's is the descriptive one.
func TestAT3BornSessionIsNeitherReadoptedNorRetitled(t *testing.T) {
	h := newHarness(t)
	h.startClaude("terminal-lobby-2", "/home/wizard/code/terminal-lobby", reconcileClaudeA)
	if err := h.index.Put(reconcileClaudeA, sessionio.Binding{
		TmuxName: "terminal-lobby-2",
		CWD:      "/home/wizard/code/terminal-lobby",
		Origin:   sessionio.OriginT3,
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	p := h.plan(t, Snapshot{Threads: []Thread{{ID: "t-1", Title: "Fix the header spacing"}}})
	if len(p.Adopt) != 0 {
		t.Fatalf("Adopt = %+v, want nothing: T3 already has a thread for this session", p.Adopt)
	}
	if len(p.Rename) != 0 {
		t.Fatalf("Rename = %+v, want nothing: the tmux name here is a directory, not a title", p.Rename)
	}
}

// The model a thread is stamped with comes from the session's own transcript
// where it can. Stamping the flag on every thread made a Sonnet session read as
// an Opus one in T3's list, and route on that.
func TestAdoptStampsTheModelTheSessionIsActuallyRunning(t *testing.T) {
	h := newHarness(t)
	repo := filepath.Join(t.TempDir(), "terminal-lobby")
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	path := h.startClaude("feat-header", repo, reconcileClaudeA)
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatalf("open transcript: %v", err)
	}
	if _, err := f.WriteString(`{"type":"assistant","uuid":"a1","sessionId":"` + reconcileClaudeA +
		`","message":{"role":"assistant","model":"claude-sonnet-4","content":[]}}` + "\n"); err != nil {
		t.Fatalf("append: %v", err)
	}
	f.Close()

	cands, err := h.adopter.Candidates()
	if err != nil {
		t.Fatalf("Candidates: %v", err)
	}
	if _, err := h.adopter.Adopt(context.Background(), cands[0]); err != nil {
		t.Fatalf("Adopt: %v", err)
	}
	var selection ModelSelection
	if err := json.Unmarshal(h.t3.dispatched(VerbThreadCreate)[0]["modelSelection"], &selection); err != nil {
		t.Fatalf("modelSelection: %v", err)
	}
	if selection.Model != "claude-sonnet-4" {
		t.Errorf("model = %q, want the one the session is running", selection.Model)
	}
}

// The escape hatch can be written broken at exactly the moment it is needed:
// claude off the unit's PATH at start-up (a failed self-update, a reboot that
// has not populated ~/.local/bin) used to blank a good binaryPath, and Verify
// compared "" against "" and called it healthy.
func TestAnEmptyClaudePathLeavesTheEscapeHatchAlone(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	good := SettingsMerge{Path: path, BridgePath: "/usr/local/bin/tl-t3-bridge", ClaudePath: "/home/wizard/.local/bin/claude"}
	if _, err := good.Apply(); err != nil {
		t.Fatalf("first Apply: %v", err)
	}

	blind := SettingsMerge{Path: path, BridgePath: "/usr/local/bin/tl-t3-bridge"}
	if _, err := blind.Apply(); err != nil {
		t.Fatalf("Apply with no claude: %v", err)
	}
	if err := good.Verify(); err != nil {
		t.Fatalf("the escape hatch was overwritten: %v", err)
	}

	// And an instance that genuinely has no binary is a Verify FAILURE, not a
	// match against an empty want.
	fresh := SettingsMerge{Path: filepath.Join(t.TempDir(), "settings.json"), BridgePath: "/usr/local/bin/tl-t3-bridge"}
	if _, err := fresh.Apply(); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if err := fresh.Verify(); err == nil {
		t.Fatal("Verify called an instance with no binaryPath healthy")
	}
}

// Both instances are named, so an operator can tell the bridge from the stock
// binary in T3's picker — which is the whole premise of decision 5.
func TestBothProviderInstancesAreNamed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	m := SettingsMerge{Path: path, BridgePath: "/usr/local/bin/tl-t3-bridge", ClaudePath: "/usr/bin/claude"}
	if _, err := m.Apply(); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var doc struct {
		ProviderInstances map[string]struct {
			DisplayName string `json:"displayName"`
		} `json:"providerInstances"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got := doc.ProviderInstances[InstanceBridged].DisplayName; got != bridgedDisplayName {
		t.Errorf("%s displayName = %q, want %q", InstanceBridged, got, bridgedDisplayName)
	}
	if got := doc.ProviderInstances[InstanceStock].DisplayName; got != stockDisplayName {
		t.Errorf("%s displayName = %q, want %q", InstanceStock, got, stockDisplayName)
	}
}

// The notice endpoint carries no credential, so loopback is the whole boundary.
// The check used to pass anything with a host in it.
func TestNotifyAddrMustBeLoopback(t *testing.T) {
	for _, addr := range []string{"0.0.0.0:7695", "127.0.0.1:", "127.0.0.1:0", ":7695"} {
		if err := validNotifyAddr(addr); err == nil {
			t.Errorf("validNotifyAddr(%q) accepted it", addr)
		}
	}
	for _, addr := range []string{"127.0.0.1:7695", "localhost:7695", "[::1]:7695"} {
		if err := validNotifyAddr(addr); err != nil {
			t.Errorf("validNotifyAddr(%q) = %v, want nil", addr, err)
		}
	}
}

// The bridge parses the conversation marker back out of the sentinel, so the
// two spellings have to agree exactly — the same rule the prompt itself is
// already pinned by.
func TestSentinelConversationMarkerMatchesTheBridge(t *testing.T) {
	raw, err := os.ReadFile("../t3-bridge/attach.go")
	if err != nil {
		t.Fatalf("read the bridge's attach.go: %v", err)
	}
	want := "const sentinelConversationPrefix = " + strconv.Quote(sentinelConversationPrefix)
	if !strings.Contains(string(raw), want) {
		t.Errorf("t3-bridge/attach.go does not declare\n\t%s\nThe two constants must be byte-identical.", want)
	}
}
