package main

import (
	"context"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"terminal-lobby/sessionio"
	"terminal-lobby/sessionio/siotest"
)

func TestRegistrySourceRequiresSessionStart(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	opts := siotest.NewFakeOptions("wizard/demo")
	rg := newRegistry(ctx, time.Millisecond, "/root", opts, "wizard")

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
	if fs.Path() != "/root/wizard/.claude/projects/-home-wizard-x/s1.jsonl" {
		t.Fatalf("transcript path = %q", fs.Path())
	}
}

// A SessionStart that cannot be recorded must not answer 204: the hook would
// then have every reason to believe the session is watchable when it is not.
func TestRegistrySessionStartFailsWhenItCannotRecord(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rg := newRegistry(ctx, time.Millisecond, "/root", siotest.NewFakeOptions(), "wizard") // no live sessions

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
	path := sessionio.TranscriptPath(root, cwd, claudeID)
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
func waitForMarker(t *testing.T, fs *sessionio.FileSource, want string) {
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
	t.Fatalf("source tailing %s never produced %q; got %+v", fs.Path(), want, fs.Replay(0))
}

func bodies(fs *sessionio.FileSource) []string {
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
	opts := siotest.NewFakeOptions(osUser + "/" + tmux)

	ctxA, cancelA := context.WithCancel(context.Background())
	before := newRegistry(ctxA, time.Millisecond, homeBase, opts, osUser)
	register(t, before, osUser, "aaaa-1111", cwd, tmux)
	if _, ok := before.source(osUser, tmux); !ok {
		t.Fatal("session should resolve in the process that received the hook")
	}
	cancelA() // the service exits — deploy, crash, restart, all the same

	after := newRegistry(context.Background(), time.Millisecond, homeBase, opts, osUser)
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
	opts := siotest.NewFakeOptions(osUser + "/" + tmux)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rg := newRegistry(ctx, time.Millisecond, homeBase, opts, osUser)
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

	opts.Kill(osUser, tmux)  // tmux kill-session
	opts.Start(osUser, tmux) // same name, a plain shell this time

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
	opts := siotest.NewFakeOptions(osUser + "/" + tmux)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rg := newRegistry(ctx, time.Millisecond, homeBase, opts, osUser)

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
	if second.Path() != pathB {
		t.Fatalf("source still tails %q; want the re-registered transcript %q", second.Path(), pathB)
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
	opts := siotest.NewFakeOptions("wizard/qa-stable")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rg := newRegistry(ctx, time.Millisecond, homeBase, opts, "wizard")

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
	rg := newRegistry(ctx, time.Millisecond, "/root", siotest.NewFakeOptions(), "wizard")
	w := httptest.NewRecorder()
	rg.handleSessionStart()(w, httptest.NewRequest("POST", "/x", strings.NewReader(`{"user":"wizard"}`)))
	if w.Code != 400 {
		t.Fatalf("missing fields: want 400, got %d", w.Code)
	}
}

// A source must be readable the moment it is handed out. Left to the tail
// goroutine, a client that opened the stream first replayed an empty log and
// then received the whole transcript live, bypassing the replay window.
func TestSourceIsHydratedBeforeItIsReturned(t *testing.T) {
	dir := t.TempDir()
	home := filepath.Join(dir, "home")
	user := "someone"
	root := filepath.Join(home, user, ".claude", "projects", "-x")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	transcript := filepath.Join(root, "sess.jsonl")
	lines := []string{
		`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}`,
		`{"type":"assistant","message":{"role":"assistant","id":"m1","stop_reason":"end_turn","content":[{"type":"text","text":"hi"}]}}`,
	}
	if err := os.WriteFile(transcript, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rg := newRegistry(ctx, time.Hour, home, siotest.NewFakeOptions(user+"/s"), user)
	if err := rg.user(user).sm.Put(sessionio.SessionInfo{
		TmuxSession: "s", CWD: "/x", ClaudeID: "sess",
	}); err != nil {
		t.Fatal(err)
	}

	fs, ok := rg.source(user, "s")
	if !ok {
		t.Fatal("source not registered")
	}
	// No sleep, no poll: the transcript must already be readable.
	if got := len(fs.Replay(0)); got == 0 {
		t.Fatal("the source was handed out before its transcript was read")
	}
}

// The regression this whole path exists for. session-events runs as one user
// and serves several; a home is 0750, so reading another user's transcript with
// this process's own file access fails — and it failed SILENTLY, as an empty
// stream the text view drew as an empty conversation. Every user who was not
// the service's own saw a blank session.
func TestRegistryReadsAForeignUserThroughAChildAndItsOwnUserDirectly(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rg := newRegistry(ctx, time.Millisecond, t.TempDir(), siotest.NewFakeOptions(), "wizard")

	own := rg.user("wizard")
	if own.priv != nil {
		t.Fatal("the service's own user must be read directly, not through sudo")
	}
	if _, ok := own.reader.(sessionio.LocalReader); !ok {
		t.Fatalf("own user reader is %T, want sessionio.LocalReader", own.reader)
	}

	foreign := rg.user("bob")
	if foreign.priv == nil {
		t.Fatal("another user must be read through a child running as them")
	}
	if foreign.reader != sessionio.Reader(foreign.priv) {
		t.Fatal("the foreign user's source must read through that same child")
	}
}

// The hook reports BOTH where the session is working and which file the harness
// is writing. Only the second one locates the transcript: Claude Code files a
// session under the directory it was STARTED in, so a session that cds — into a
// worktree, into a sub-project — and re-registers used to be stamped with a path
// that does not exist, and its Text view tailed an empty file for good.
func TestRegistryUsesTheTranscriptPathTheHookReports(t *testing.T) {
	const (
		osUser  = "wizard"
		started = "/home/wizard/code" // where claude was launched
		working = "/home/wizard/code/.worktrees/topic"
		tmux    = "qa-cd-away"
	)
	homeBase := t.TempDir()
	path := writeTranscript(t, homeBase, osUser, started, "aaaa-1111", "MARKER-WHERE-IT-STARTED")
	opts := siotest.NewFakeOptions(osUser + "/" + tmux)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rg := newRegistry(ctx, time.Millisecond, homeBase, opts, osUser)

	w := httptest.NewRecorder()
	rg.handleSessionStart()(w, httptest.NewRequest("POST", "/hooks/session-start",
		strings.NewReader(`{"user":"`+osUser+`","session_id":"aaaa-1111","cwd":"`+working+
			`","tmux_session":"`+tmux+`","transcript_path":"`+path+`"}`)))
	if w.Code != 204 {
		t.Fatalf("session-start: want 204, got %d (%s)", w.Code, w.Body.String())
	}

	fs, ok := rg.source(osUser, tmux)
	if !ok {
		t.Fatal("session does not resolve after SessionStart")
	}
	if fs.Path() != path {
		t.Fatalf("tailing %q, but the harness is writing %q", fs.Path(), path)
	}
	waitForMarker(t, fs, "MARKER-WHERE-IT-STARTED")
}

// A path the hook supplies is untrusted input like any other — the endpoint is
// loopback, but everything on the box can reach loopback.
func TestRegistryRefusesATranscriptPathOutsideTheUsersProjects(t *testing.T) {
	const (
		osUser = "wizard"
		tmux   = "qa-escape"
	)
	homeBase := t.TempDir()
	opts := siotest.NewFakeOptions(osUser + "/" + tmux)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rg := newRegistry(ctx, time.Millisecond, homeBase, opts, osUser)

	w := httptest.NewRecorder()
	rg.handleSessionStart()(w, httptest.NewRequest("POST", "/hooks/session-start",
		strings.NewReader(`{"user":"`+osUser+`","session_id":"aaaa-1111","cwd":"/home/wizard/x",`+
			`"tmux_session":"`+tmux+`","transcript_path":"/etc/shadow.jsonl"}`)))
	if w.Code != 500 {
		t.Fatalf("a transcript outside the projects root was accepted: %d (%s)", w.Code, w.Body.String())
	}
}

// A source is retired when the tmux name it is keyed by starts pointing
// somewhere else, and until 2026-08-28 that only ever happened because some
// OTHER request asked for the session. A browser sitting on an open stream
// makes no such request: it kept its subscription to the retired source and
// received nothing more, so the transcript froze at the moment of the swap.
// With a question dialog on screen at that moment, the answer card stayed
// docked over a dialog that had been answered in the terminal minutes earlier.
func TestRegistrySweepEndsStreamsOnASourceThatMoved(t *testing.T) {
	const (
		osUser = "wizard"
		cwd    = "/home/wizard/qa"
		tmux   = "qa-sweep"
	)
	homeBase := t.TempDir()
	writeTranscript(t, homeBase, osUser, cwd, "aaaa-1111", "MARKER-A")
	pathB := writeTranscript(t, homeBase, osUser, cwd, "bbbb-2222", "MARKER-B")
	opts := siotest.NewFakeOptions(osUser + "/" + tmux)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rg := newRegistry(ctx, time.Millisecond, homeBase, opts, osUser)
	register(t, rg, osUser, "aaaa-1111", cwd, tmux)

	fs, ok := rg.source(osUser, tmux)
	if !ok {
		t.Fatal("session does not resolve after SessionStart")
	}
	ch, release := fs.Subscribe() // a browser watching the Text view
	defer release()
	waitForMarker(t, fs, "MARKER-A")

	// A new Claude claims the same tmux window. Nothing asks the registry for
	// this session — the only reader is the stream already open.
	if err := opts.SetOption(osUser, tmux, sessionio.OptionTranscript, pathB); err != nil {
		t.Fatal(err)
	}
	rg.sweep()

	select {
	case _, open := <-ch:
		if open {
			t.Fatal("the retired source is still delivering its own events")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the stream stayed open on a source that moved — the reader freezes for good")
	}

	next, ok := rg.source(osUser, tmux)
	if !ok || next.Path() != pathB {
		t.Fatalf("after the sweep the session resolves to %v/%q, want %q", ok, next.Path(), pathB)
	}
}

// The sweep is a background job on a shared box, so it only looks at sources
// somebody is actually reading. One with no subscribers can wait for the next
// request to notice it moved, and checking it costs a tmux round trip per
// session per tick for nobody's benefit.
func TestRegistrySweepLeavesUnwatchedSourcesAlone(t *testing.T) {
	const (
		osUser = "wizard"
		cwd    = "/home/wizard/qa"
		tmux   = "qa-sweep-idle"
	)
	homeBase := t.TempDir()
	writeTranscript(t, homeBase, osUser, cwd, "aaaa-1111", "MARKER-A")
	pathB := writeTranscript(t, homeBase, osUser, cwd, "bbbb-2222", "MARKER-B")
	opts := siotest.NewFakeOptions(osUser + "/" + tmux)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rg := newRegistry(ctx, time.Millisecond, homeBase, opts, osUser)
	register(t, rg, osUser, "aaaa-1111", cwd, tmux)
	if _, ok := rg.source(osUser, tmux); !ok {
		t.Fatal("session does not resolve after SessionStart")
	}
	if err := opts.SetOption(osUser, tmux, sessionio.OptionTranscript, pathB); err != nil {
		t.Fatal(err)
	}

	before := opts.Reads()
	rg.sweep()
	if got := opts.Reads() - before; got != 0 {
		t.Fatalf("the sweep read the session map %d times for a source nobody is watching", got)
	}
}

// fakePane stands in for the tmux pane read.
type fakePane struct {
	mu    sync.Mutex
	text  string
	reads int
}

func (f *fakePane) CapturePane(osUser, session string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reads++
	return f.text, nil
}
func (f *fakePane) set(text string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.text = text
}
func (f *fakePane) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reads
}

const paneWithQuestion = `
 ☐ Colour
Which colour should the badge be?
❯ 1. Red
     Make it red.
  2. Blue
     Make it blue.
  3. Type something.
  4. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel
`

// Claude Code does not always write the AskUserQuestion record while its dialog
// is up — measured 2026-08-28, two of five consecutive calls in one session were
// written only when the question was ANSWERED, 112 seconds later in one case.
// For that window the transcript says "working" and the Text view has nothing to
// show, while the terminal sits on a dialog. The pane is the only other place
// the question exists, so it is read while a watched session is mid-turn.
func TestRegistryWatchesThePaneOfAWatchedSessionMidTurn(t *testing.T) {
	const (
		osUser = "wizard"
		cwd    = "/home/wizard/qa"
		tmux   = "qa-asking"
	)
	homeBase := t.TempDir()
	writeTranscript(t, homeBase, osUser, cwd, "aaaa-1111", "MARKER-ASKING")
	opts := siotest.NewFakeOptions(osUser + "/" + tmux)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rg := newRegistry(ctx, time.Millisecond, homeBase, opts, osUser)
	pane := &fakePane{}
	rg.panes = pane
	register(t, rg, osUser, "aaaa-1111", cwd, tmux)

	fs, ok := rg.source(osUser, tmux)
	if !ok {
		t.Fatal("session does not resolve")
	}
	waitForMarker(t, fs, "MARKER-ASKING")

	// Nobody is reading it yet: no pane round trip.
	rg.watchPanes()
	if pane.count() != 0 {
		t.Fatalf("the pane of an unwatched session was read %d times", pane.count())
	}

	ch, release := fs.Subscribe()
	defer release()
	go func() {
		for range ch {
		}
	}()
	pane.set(paneWithQuestion)
	rg.watchPanes()

	var asking *sessionio.Event
	for _, e := range fs.Replay(0) {
		if e.Kind == sessionio.KindMeta && e.Meta == sessionio.MetaAsking {
			ev := e
			asking = &ev
		}
	}
	if asking == nil {
		t.Fatalf("the dialog on the pane was not reported; events = %+v", fs.Replay(0))
	}
	if !strings.Contains(asking.Body, "Which colour should the badge be?") {
		t.Fatalf("asking event = %q", asking.Body)
	}

	// The dialog goes away — answered in the terminal — and that is reported too,
	// or the card would stay docked over nothing.
	pane.set("❯ \n")
	rg.watchPanes()
	last := ""
	for _, e := range fs.Replay(0) {
		if e.Kind == sessionio.KindMeta && e.Meta == sessionio.MetaAsking {
			last = e.Body
		}
	}
	if last != "" {
		t.Fatalf("the dialog going away left %q behind", last)
	}
}
