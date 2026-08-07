package main

import (
	"context"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRegistrySourceRequiresSessionStart(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	opts := newFakeTmuxOptions("wizard/demo")
	rg := newRegistry(ctx, time.Millisecond, "/root", opts)

	if _, ok := rg.source("wizard", "demo"); ok {
		t.Fatal("unregistered session must not resolve")
	}

	w := httptest.NewRecorder()
	rg.handleSessionStart()(w, httptest.NewRequest("POST", "/hooks/session-start",
		strings.NewReader(`{"user":"wizard","session_id":"s1","cwd":"/home/wizard/x","tmux_session":"demo"}`)))
	if w.Code != 204 {
		t.Fatalf("session-start: want 204, got %d (%s)", w.Code, w.Body.String())
	}

	fs, ok := rg.source("wizard", "demo")
	if !ok || fs == nil {
		t.Fatal("session should resolve after SessionStart")
	}
	if fs.path != "/root/wizard/.claude/projects/-home-wizard-x/s1.jsonl" {
		t.Fatalf("transcript path = %q", fs.path)
	}
}

// A SessionStart that cannot be recorded must not answer 204: the hook would
// then have every reason to believe the session is watchable when it is not.
func TestRegistrySessionStartFailsWhenItCannotRecord(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rg := newRegistry(ctx, time.Millisecond, "/root", newFakeTmuxOptions()) // no live sessions

	w := httptest.NewRecorder()
	rg.handleSessionStart()(w, httptest.NewRequest("POST", "/hooks/session-start",
		strings.NewReader(`{"user":"wizard","session_id":"s1","cwd":"/home/wizard/x","tmux_session":"ghost"}`)))
	if w.Code != 500 {
		t.Fatalf("unrecordable session-start: want 500, got %d (%s)", w.Code, w.Body.String())
	}
}

// writeTranscript lays down a one-line transcript whose single user message
// carries `marker`, at the path sessionMap will derive for (cwd, claudeID).
func writeTranscript(t *testing.T, homeBase, osUser, cwd, claudeID, marker string) string {
	t.Helper()
	root := filepath.Join(homeBase, osUser, ".claude", "projects")
	path := transcriptPath(root, cwd, claudeID)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	line := `{"type":"user","message":{"role":"user","content":"` + marker + `"}}` + "\n"
	if err := os.WriteFile(path, []byte(line), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// waitForMarker polls the source's replay log until an event body carries want.
func waitForMarker(t *testing.T, fs *fileSource, want string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		for _, e := range fs.Replay(0) {
			if e.Body == want {
				return
			}
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("source tailing %s never produced %q; got %+v", fs.path, want, fs.Replay(0))
}

func bodies(fs *fileSource) []string {
	var out []string
	for _, e := range fs.Replay(0) {
		out = append(out, e.Body)
	}
	return out
}

// register drives the SessionStart hook endpoint the way claude-se-hook does.
func register(t *testing.T, rg *registry, osUser, claudeID, cwd, tmuxSession string) {
	t.Helper()
	w := httptest.NewRecorder()
	rg.handleSessionStart()(w, httptest.NewRequest("POST", "/hooks/session-start",
		strings.NewReader(`{"user":"`+osUser+`","session_id":"`+claudeID+
			`","cwd":"`+cwd+`","tmux_session":"`+tmuxSession+`"}`)))
	if w.Code != 204 {
		t.Fatalf("session-start %s: want 204, got %d (%s)", claudeID, w.Code, w.Body.String())
	}
}

// THE restart defect: every deploy restarts this service, and a registry that
// lives only in the process's memory turns each restart into
// "404 session not registered" for every Claude session already running —
// measured 2026-08-06 as 9 of 9 live sessions rendering an empty Text view.
// The mapping has to be recovered by a process that never saw the hook fire.
func TestRegistryResolvesSessionsRegisteredBeforeARestart(t *testing.T) {
	const (
		osUser = "wizard"
		cwd    = "/home/wizard/qa"
		tmux   = "qa-restart"
	)
	homeBase := t.TempDir()
	writeTranscript(t, homeBase, osUser, cwd, "aaaa-1111", "MARKER-SURVIVES-RESTART")
	opts := newFakeTmuxOptions(osUser + "/" + tmux)

	ctxA, cancelA := context.WithCancel(context.Background())
	before := newRegistry(ctxA, time.Millisecond, homeBase, opts)
	register(t, before, osUser, "aaaa-1111", cwd, tmux)
	if _, ok := before.source(osUser, tmux); !ok {
		t.Fatal("session should resolve in the process that received the hook")
	}
	cancelA() // the service exits — deploy, crash, restart, all the same

	after := newRegistry(context.Background(), time.Millisecond, homeBase, opts)
	fs, ok := after.source(osUser, tmux)
	if !ok {
		t.Fatal("session does not resolve after a restart — the Text view renders NO TRANSCRIPT")
	}
	waitForMarker(t, fs, "MARKER-SURVIVES-RESTART")
}

// The other half: a mapping must not outlive the tmux session it describes.
// Kill a registered Claude session, start a plain shell under the same name,
// and the pane must stop serving the dead conversation — and the tail that was
// reading it has to stop with it.
func TestRegistryStopsServingAfterTheTmuxSessionIsReplaced(t *testing.T) {
	const (
		osUser = "wizard"
		cwd    = "/home/wizard/qa"
		tmux   = "qa-vstale"
	)
	homeBase := t.TempDir()
	writeTranscript(t, homeBase, osUser, cwd, "aaaa-1111", "MARKER-DEAD-SESSION")
	opts := newFakeTmuxOptions(osUser + "/" + tmux)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rg := newRegistry(ctx, time.Millisecond, homeBase, opts)
	register(t, rg, osUser, "aaaa-1111", cwd, tmux)
	fs, ok := rg.source(osUser, tmux)
	if !ok {
		t.Fatal("session should resolve after SessionStart")
	}
	waitForMarker(t, fs, "MARKER-DEAD-SESSION")

	us := rg.user(osUser)
	us.mu.Lock()
	live := us.srcs[tmux]
	us.mu.Unlock()

	opts.kill(osUser, tmux)  // tmux kill-session
	opts.start(osUser, tmux) // same name, a plain shell this time

	if _, ok := rg.source(osUser, tmux); ok {
		t.Fatal("the reused tmux name still serves the dead Claude session's transcript")
	}
	select {
	case <-live.done:
	case <-time.After(2 * time.Second):
		t.Fatal("the dead session's tail goroutine is still running — leaked")
	}
}

// Reusing a tmux session name — kill a Claude session, start a new one in the
// same tmux window — must re-resolve the transcript. fileSource.path is fixed at
// construction, so a source cached under the tmux name keeps serving the DEAD
// session's transcript for the rest of the process lifetime unless source()
// re-checks it against the registry.
func TestRegistrySourceRebuildsWhenTmuxNameIsReused(t *testing.T) {
	const (
		osUser = "wizard"
		cwd    = "/home/wizard/qa"
		tmux   = "qa-verify-reuse"
	)
	homeBase := t.TempDir()
	writeTranscript(t, homeBase, osUser, cwd, "aaaa-1111", "MARKER-TRANSCRIPT-A")
	pathB := writeTranscript(t, homeBase, osUser, cwd, "bbbb-2222", "MARKER-TRANSCRIPT-B")
	opts := newFakeTmuxOptions(osUser + "/" + tmux)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rg := newRegistry(ctx, time.Millisecond, homeBase, opts)

	register(t, rg, osUser, "aaaa-1111", cwd, tmux)
	first, ok := rg.source(osUser, tmux)
	if !ok {
		t.Fatal("session should resolve after SessionStart")
	}
	waitForMarker(t, first, "MARKER-TRANSCRIPT-A")

	// Grab the live entry so the eviction can be checked for a leaked tail.
	us := rg.user(osUser)
	us.mu.Lock()
	stale := us.srcs[tmux]
	us.mu.Unlock()
	if stale == nil {
		t.Fatal("no live source cached under the tmux name")
	}

	register(t, rg, osUser, "bbbb-2222", cwd, tmux) // same tmux name, a brand-new Claude session

	second, ok := rg.source(osUser, tmux)
	if !ok {
		t.Fatal("session should still resolve after re-registration")
	}
	if second.path != pathB {
		t.Fatalf("source still tails %q; want the re-registered transcript %q", second.path, pathB)
	}
	waitForMarker(t, second, "MARKER-TRANSCRIPT-B")
	for _, b := range bodies(second) {
		if b == "MARKER-TRANSCRIPT-A" {
			t.Fatalf("the dead session's transcript is still being served: %v", bodies(second))
		}
	}

	select {
	case <-stale.done:
	case <-time.After(2 * time.Second):
		t.Fatal("the evicted source's tail goroutine is still running — leaked")
	}
}

// The common case must not churn: re-registering the SAME transcript (a hook
// firing twice for one session) keeps the running source, so live SSE
// subscribers are not silently orphaned and the log is not replayed from zero.
func TestRegistrySourceKeptWhenTranscriptUnchanged(t *testing.T) {
	homeBase := t.TempDir()
	writeTranscript(t, homeBase, "wizard", "/home/wizard/qa", "aaaa-1111", "MARKER-TRANSCRIPT-A")
	opts := newFakeTmuxOptions("wizard/qa-stable")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rg := newRegistry(ctx, time.Millisecond, homeBase, opts)

	for i := 0; i < 2; i++ {
		register(t, rg, "wizard", "aaaa-1111", "/home/wizard/qa", "qa-stable")
	}

	first, _ := rg.source("wizard", "qa-stable")
	second, _ := rg.source("wizard", "qa-stable")
	if first != second {
		t.Fatal("source() rebuilt an unchanged session; live subscribers would be orphaned")
	}
}

func TestRegistryMissingSessionStartFields(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rg := newRegistry(ctx, time.Millisecond, "/root", newFakeTmuxOptions())
	w := httptest.NewRecorder()
	rg.handleSessionStart()(w, httptest.NewRequest("POST", "/x", strings.NewReader(`{"user":"wizard"}`)))
	if w.Code != 400 {
		t.Fatalf("missing fields: want 400, got %d", w.Code)
	}
}
