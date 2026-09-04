package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"terminal-lobby/slug"
)

// The auto-title rule against a REAL tmux server.
//
// autotitle_test.go stubs tmux, which proves the rule calls what it means to
// but not that tmux agrees. The things a stub cannot check are the ones most
// likely to be wrong here: whether a pane title carrying a multi-byte glyph
// survives the round trip through `#{pane_title}` at all, whether the title the
// rule stamps comes back through `#{@title}` on the next list, and whether a
// summary the clean had to shorten still leaves an 11-field row parseable —
// @title is field 9 and pane_title, the only field allowed to hold a tab, is
// last, so anything the rule writes into field 9 has to be safe.
//
// Measured on tmux 3.4 while writing these, and worth knowing: `select-pane -T`
// SILENTLY REFUSES a title containing a control character (the pane keeps the
// title it had), while `set-option @title` stores a tab raw and hands it back
// raw. So a tab cannot reach the rule through pane_title at all — the clean is
// what makes sure the rule cannot put one into @title by any other route, and
// autotitle_test.go covers that hermetically.
//
// Skipped when tmux is missing, so this stays runnable anywhere.

// fakeClaude returns the path to a binary whose /proc comm is "claude", which
// is what the liveness backstop looks for (proc.go). Without one in the pane,
// clearDeadStates blanks @claude_state on the way through GET /sessions and the
// rule correctly declines to title a session whose Claude is not running.
//
// A copy of `sleep`, so it sits there being a process and nothing else.
func fakeClaude(t *testing.T) string {
	t.Helper()
	real, err := exec.LookPath("sleep")
	if err != nil {
		t.Skip("no sleep on this host")
	}
	body, err := os.ReadFile(real)
	if err != nil {
		t.Fatal(err)
	}
	// Not t.TempDir(): the path goes into a tmux pane's argv and the session
	// outlives the directory's cleanup ordering.
	dir, err := os.MkdirTemp("", "tlc")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	path := filepath.Join(dir, "claude")
	if err := os.WriteFile(path, body, 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

// liveClaudeSession creates a session on the private server, marks it as a live
// Claude and gives its pane the title Claude Code would have written.
//
// The pane runs the fake claude, not a shell, for two reasons: a shell draws a
// prompt and some write their own OSC 2 title doing it, which would race the
// title being seeded here; and the liveness backstop wants a claude under the
// pane before it will let @claude_state stand.
func liveClaudeSession(t *testing.T, tmux func(...string) (string, error), name, paneTitle string) {
	t.Helper()
	if out, err := tmux("new-session", "-d", "-s", name, fakeClaude(t), "300"); err != nil {
		t.Fatalf("new-session %s: %v: %s", name, err, out)
	}
	if out, err := tmux("set-option", "-t", exactPane(name), "@claude_state", stateRunning); err != nil {
		t.Fatalf("stamping @claude_state: %v: %s", err, out)
	}
	if out, err := tmux("select-pane", "-t", exactPane(name), "-T", paneTitle); err != nil {
		t.Fatalf("setting the pane title: %v: %s", err, out)
	}
}

func TestAutoTitleAgainstRealTmux(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	tmux := withRealTmux(t)
	withAutoTitleTracker(t)
	swapTitleStore(t)
	rec := withTelemetry(t)

	const name = "k7m2q9x4tpz3"
	liveClaudeSession(t, tmux, name, "✳ Tashkent trip planning")

	before := liveSessions(t, osSelf)
	if len(before) != 1 {
		t.Fatalf("seeded %d sessions, want 1: %+v", len(before), before)
	}
	if before[0].State != stateRunning {
		t.Fatalf("State = %q, want %q — the rule would skip this session", before[0].State, stateRunning)
	}
	if before[0].PaneTitle != "✳ Tashkent trip planning" {
		t.Fatalf("PaneTitle = %q; the glyph did not survive the round trip", before[0].PaneTitle)
	}
	if before[0].Title != "" {
		t.Fatalf("Title = %q, want empty on a session nobody has titled", before[0].Title)
	}

	autoTitleSessions(osSelf, before, time.Now())

	after := liveSessions(t, osSelf)
	if len(after) != 1 {
		t.Fatalf("%d sessions after the rule ran, want 1: %+v", len(after), after)
	}
	if after[0].Title != "Tashkent trip planning" {
		t.Errorf("@title on the live session = %q, want the summary without its glyph", after[0].Title)
	}
	// The rule reads the pane title; it must never write it.
	if after[0].PaneTitle != "✳ Tashkent trip planning" {
		t.Errorf("PaneTitle = %q, want it untouched", after[0].PaneTitle)
	}
	if got := titleStoreInstance.all(osSelf)[name]; got != "Tashkent trip planning" {
		t.Errorf("title memory = %q, want the summary", got)
	}
	if evs := autonamed(t, rec); len(evs) != 1 {
		t.Fatalf("emitted %d events, want 1: %v", len(evs), rec.lines)
	}

	// The stamp is its own marker: the next poll reads @title back and leaves
	// the session alone even though the summary has moved on.
	if out, err := tmux("select-pane", "-t", exactPane(name), "-T", "✳ Tashkent trip planning, day two"); err != nil {
		t.Fatalf("moving the pane title on: %v: %s", err, out)
	}
	autoTitleSessions(osSelf, liveSessions(t, osSelf), time.Now())
	if got := liveSessions(t, osSelf)[0].Title; got != "Tashkent trip planning" {
		t.Errorf("@title = %q; the title should freeze at the first summary", got)
	}
	if evs := autonamed(t, rec); len(evs) != 1 {
		t.Errorf("emitted %d events, want 1 for the life of the session", len(evs))
	}
}

// The rule has no clock of its own — it runs on the session-list poll. So the
// wiring is half the feature, and calling autoTitleSessions directly proves
// none of it. This drives GET /sessions against a real tmux server and reads
// the title out of the response body, which is the surface the lobby sees.
func TestAutoTitleReachesTheSessionsResponse(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	tmux := withRealTmux(t)
	withUserMap(t, "authself="+osSelf+"\n")
	withAutoTitleTracker(t)
	withTempLayoutStore(t)
	swapTitleStore(t)
	swapProjectStore(t)
	swapShareStore(t)
	swapAssignmentStore(t)
	swapImageStore(t)
	rec := withTelemetry(t)

	const name = "z9k3npq7v2wx"
	liveClaudeSession(t, tmux, name, "✳ Tashkent trip planning")
	// A plain shell alongside it, so the response also shows what the rule
	// leaves alone.
	if out, err := tmux("new-session", "-d", "-s", "shell", "sleep", "300"); err != nil {
		t.Fatalf("creating the shell: %v: %s", err, out)
	}
	sessionsCacheInstance.invalidate(osSelf)

	w := httptest.NewRecorder()
	handleSessions(w, sessionReq(http.MethodGet, "/sessions", "", "authself"))
	if w.Code != http.StatusOK {
		t.Fatalf("GET /sessions: %d (%s)", w.Code, w.Body)
	}
	var body []Session
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not a session list (%v): %s", err, w.Body)
	}

	got := findSession(t, body, name)
	// The poll that stamps is the one that serves it. A title arriving a cache
	// cycle late is the difference between a card that reads right and a card
	// that reads as twelve random characters for five seconds.
	if got.Title != "Tashkent trip planning" {
		t.Errorf("title in the /sessions body = %q, want the summary", got.Title)
	}
	if sh := findSession(t, body, "shell"); sh.Title != "" {
		t.Errorf("the plain shell was titled %q", sh.Title)
	}
	if evs := autonamed(t, rec); len(evs) != 1 {
		t.Fatalf("emitted %d events, want 1: %v", len(evs), rec.lines)
	}

	// And it is on the session, not just in the answer.
	if live := findSession(t, liveSessions(t, osSelf), name); live.Title != "Tashkent trip planning" {
		t.Errorf("@title on the live session = %q, want the summary", live.Title)
	}
}

// A Claude that died leaves its session untitled, and this is the only place
// that can be checked: @claude_state is a stale tmux option until the liveness
// backstop reads /proc and blanks it, which happens inside GET /sessions and
// nowhere a stub can reach. The pane here holds a summary and no claude.
func TestAutoTitleLeavesASessionWhoseClaudeIsGone(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	tmux := withRealTmux(t)
	withUserMap(t, "authself="+osSelf+"\n")
	withAutoTitleTracker(t)
	withTempLayoutStore(t)
	swapTitleStore(t)
	swapProjectStore(t)
	swapShareStore(t)
	swapAssignmentStore(t)
	swapImageStore(t)
	rec := withTelemetry(t)

	const name = "vw2r5t8xn4qm"
	if out, err := tmux("new-session", "-d", "-s", name, "sleep", "300"); err != nil {
		t.Fatalf("new-session: %v: %s", err, out)
	}
	// The option a live Claude would have left behind, and the summary it wrote
	// before it went. Nothing under the pane is a claude.
	if out, err := tmux("set-option", "-t", exactPane(name), "@claude_state", stateDone); err != nil {
		t.Fatalf("stamping @claude_state: %v: %s", err, out)
	}
	if out, err := tmux("select-pane", "-t", exactPane(name), "-T", "✳ Tashkent trip planning"); err != nil {
		t.Fatalf("setting the pane title: %v: %s", err, out)
	}
	sessionsCacheInstance.invalidate(osSelf)

	w := httptest.NewRecorder()
	handleSessions(w, sessionReq(http.MethodGet, "/sessions", "", "authself"))
	if w.Code != http.StatusOK {
		t.Fatalf("GET /sessions: %d (%s)", w.Code, w.Body)
	}
	var body []Session
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not a session list (%v): %s", err, w.Body)
	}
	if got := findSession(t, body, name); got.Title != "" {
		t.Errorf("titled a session whose Claude is gone: %q", got.Title)
	}
	if live := findSession(t, liveSessions(t, osSelf), name); live.Title != "" {
		t.Errorf("@title on the live session = %q, want it untouched", live.Title)
	}
	if evs := autonamed(t, rec); len(evs) != 0 {
		t.Errorf("emitted %d events: %v", len(evs), rec.lines)
	}
}

// A summary the clean had to change still has to leave a parseable row. The
// longest thing a pane can carry is the case that would show a cap applied to
// bytes rather than runes, or applied after the write rather than before it.
func TestAutoTitleWritesAParseableRowForAnOversizedSummary(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	tmux := withRealTmux(t)
	withAutoTitleTracker(t)
	swapTitleStore(t)
	withTelemetry(t)

	const name = "q4m8vwx2rt5n"
	// Multi-byte throughout, so a cap counting bytes would cut a character in
	// half and the round trip would come back mangled rather than merely short.
	summary := strings.Repeat("Ташкент ", 40)
	liveClaudeSession(t, tmux, name, "✻ "+summary)

	before := liveSessions(t, osSelf)
	if len(before) != 1 {
		t.Fatalf("seeded %d sessions, want 1: %+v", len(before), before)
	}
	autoTitleSessions(osSelf, before, time.Now())

	after := liveSessions(t, osSelf)
	if len(after) != 1 {
		t.Fatalf("%d sessions after the rule ran, want 1 — the row shifted: %+v", len(after), after)
	}
	if after[0].Name != name {
		t.Errorf("Name = %q, want %q — the row shifted", after[0].Name, name)
	}
	if after[0].State != stateRunning {
		t.Errorf("State = %q, want %q — the row shifted", after[0].State, stateRunning)
	}
	// At most the cap, and not far under it — the clean drops a trailing space
	// after cutting, so a title landing exactly on a word boundary comes back
	// one rune short.
	if n := utf8.RuneCountInString(after[0].Title); n > slug.MaxTitleRunes || n < slug.MaxTitleRunes-8 {
		t.Errorf("@title is %d runes, want it capped near %d", n, slug.MaxTitleRunes)
	}
	if !utf8.ValidString(after[0].Title) {
		t.Errorf("@title is not valid UTF-8 (%q); the cap cut a character in half", after[0].Title)
	}
	if !strings.HasPrefix(summary, after[0].Title) {
		t.Errorf("@title = %q, want a prefix of the summary", after[0].Title)
	}
}
