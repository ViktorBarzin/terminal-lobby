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
)

// The title path against a REAL tmux server.
//
// Everything else in this suite stubs tmux, which proves the handlers do what
// they mean to but not that tmux agrees. The things most likely to be wrong
// here are exactly the things a stub cannot check: whether `set-option -t
// "=name:"` is accepted at all (`=name` is not), whether the option comes back
// through list-sessions, whether \x1f survives as a field separator, and
// whether arbitrary text round-trips through both.
//
// Skipped when tmux is missing, so this stays runnable anywhere.

// withRealTmux points tmuxBinary at a wrapper that pins every call to a private
// tmux server, and returns a helper that runs tmux against the same one.
func withRealTmux(t *testing.T) func(args ...string) (string, error) {
	t.Helper()
	real, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("no tmux on this host")
	}
	// A short socket dir: tmux socket paths are bounded by sockaddr_un, and a
	// go test TempDir carrying the test's name overflows it.
	dir, err := os.MkdirTemp("", "tlt")
	if err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join(dir, "s")

	wrapper := filepath.Join(dir, "tmux")
	body := "#!/bin/sh\nexec " + real + " -S '" + socket + "' \"$@\"\n"
	if err := os.WriteFile(wrapper, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	old := tmuxBinary
	tmuxBinary = wrapper
	t.Cleanup(func() {
		exec.Command(wrapper, "kill-server").Run()
		tmuxBinary = old
		os.RemoveAll(dir)
	})
	return func(args ...string) (string, error) {
		out, err := exec.Command(wrapper, args...).CombinedOutput()
		return strings.TrimRight(string(out), "\n"), err
	}
}

// liveSessions drives the real GET /sessions decode path over a real server.
func liveSessions(t *testing.T, osUser string) []Session {
	t.Helper()
	out, err := tmuxCmd(osUser, "list-sessions", "-F", tmuxListFmt).Output()
	if err != nil {
		t.Fatalf("list-sessions: %v", err)
	}
	return parseSessions(out)
}

func TestTitleRoundTripsThroughRealTmux(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	tmux := withRealTmux(t)
	withUserMap(t, "authself="+osSelf+"\n")
	withTempLayoutStore(t)
	swapTitleStore(t)
	swapProjectStore(t)
	swapShareStore(t)
	swapAssignmentStore(t)
	swapImageStore(t)

	if out, err := tmux("new-session", "-d", "-s", "deploy-the-thing"); err != nil {
		t.Fatalf("creating the session: %v: %s", err, out)
	}
	// A sibling whose name is a PREFIX of the first. This is the pair that
	// deriving names from titles makes ordinary, and the reason the target
	// form has to be "=name:" — a bare `-t deploy` resolves by prefix match
	// and exits 0 having stamped the wrong session.
	if out, err := tmux("new-session", "-d", "-s", "deploy"); err != nil {
		t.Fatalf("creating the sibling: %v: %s", err, out)
	}

	// A title with everything the separator change was made for: a pipe, a
	// non-Latin script, and an emoji.
	const title = "Deploy | тест 🚀"
	rec := httptest.NewRecorder()
	handleSessionByName(rec, sessionReq(http.MethodPost, "/sessions/deploy-the-thing/title",
		`{"title":`+mustJSON(t, title)+`}`, "authself"))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("POST title: %d (%s)", rec.Code, rec.Body)
	}

	sessions := liveSessions(t, osSelf)
	got := findSession(t, sessions, "deploy-the-thing")
	if got.Title != title {
		t.Errorf("title round-tripped as %q, want %q", got.Title, title)
	}
	if got.ID == "" || !strings.HasPrefix(got.ID, "$") {
		t.Errorf("session id = %q, want a $N", got.ID)
	}
	// The sibling must be untouched — the prefix-match hazard, checked rather
	// than reasoned about.
	if sib := findSession(t, sessions, "deploy"); sib.Title != "" {
		t.Errorf("the prefix sibling was stamped too: %q", sib.Title)
	}

	// Retitle: rename and stamp together, against a live server.
	rec = httptest.NewRecorder()
	handleSessionByName(rec, sessionReq(http.MethodPatch, "/sessions/deploy-the-thing",
		`{"name":"fix-the-parser","title":`+mustJSON(t, "Fix the parser")+`}`, "authself"))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("PATCH: %d (%s)", rec.Code, rec.Body)
	}
	sessions = liveSessions(t, osSelf)
	moved := findSession(t, sessions, "fix-the-parser")
	if moved.Title != "Fix the parser" {
		t.Errorf("after the retitle, title = %q", moved.Title)
	}
	// The session id proves it is the SAME session, renamed — not a new one.
	if moved.ID != got.ID {
		t.Errorf("session id changed across the rename: %q → %q", got.ID, moved.ID)
	}

	// Clearing puts it back to showing its name.
	rec = httptest.NewRecorder()
	handleSessionByName(rec, sessionReq(http.MethodPost, "/sessions/fix-the-parser/title",
		`{"title":""}`, "authself"))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("clearing: %d (%s)", rec.Code, rec.Body)
	}
	if cleared := findSession(t, liveSessions(t, osSelf), "fix-the-parser"); cleared.Title != "" {
		t.Errorf("a cleared title reads back %q", cleared.Title)
	}
}

// A pane title carrying the field separator must not shift the columns — it is
// the last field for that reason, and applications set it freely via OSC 2.
func TestPaneTitleWithOddCharactersDoesNotBreakTheRow(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	tmux := withRealTmux(t)
	withUserMap(t, "authself="+osSelf+"\n")
	swapTitleStore(t)

	if out, err := tmux("new-session", "-d", "-s", "work"); err != nil {
		t.Fatalf("creating the session: %v: %s", err, out)
	}
	if out, err := tmux("set-option", "-t", "=work:", "allow-rename", "off"); err != nil {
		t.Fatalf("pinning the pane title: %v: %s", err, out)
	}
	if out, err := tmux("select-pane", "-t", "=work:", "-T", "make | tee build.log"); err != nil {
		t.Fatalf("setting the pane title: %v: %s", err, out)
	}

	rec := httptest.NewRecorder()
	handleSessionByName(rec, sessionReq(http.MethodPost, "/sessions/work/title",
		`{"title":`+mustJSON(t, "Build | watch")+`}`, "authself"))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("POST title: %d (%s)", rec.Code, rec.Body)
	}

	got := findSession(t, liveSessions(t, osSelf), "work")
	if got.Title != "Build | watch" {
		t.Errorf("display title = %q", got.Title)
	}
	if got.PaneTitle != "make | tee build.log" {
		t.Errorf("pane title = %q", got.PaneTitle)
	}
	// The columns either side of the two title fields must still be intact.
	if got.Name != "work" || got.ID == "" {
		t.Errorf("row shifted: %+v", got)
	}
}

// Why the separator is a TAB and not a unit separator.
//
// tmux escapes non-printable bytes on output — in the format literal and
// inside expanded values alike — so a \x1f separator arrives as the four
// characters \037, and a \x1f inside a value arrives as the same four
// characters. The two are then indistinguishable, and every row parses as one
// field. This is measured rather than reasoned about because it is invisible
// until a session list comes back empty.
func TestTmuxEscapesControlCharactersButNotTab(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	tmux := withRealTmux(t)
	if out, err := tmux("new-session", "-d", "-s", "probe"); err != nil {
		t.Fatalf("new-session: %v: %s", err, out)
	}

	// A unit separator in the FORMAT comes back escaped, not raw.
	out, err := tmuxCmd(osSelf, "list-sessions", "-F", "#{session_name}\x1fx").Output()
	if err != nil {
		t.Fatalf("list-sessions: %v", err)
	}
	if strings.Contains(string(out), "\x1f") {
		t.Error("tmux passed \\x1f through raw — the tab separator could be reconsidered")
	}
	if !strings.Contains(string(out), `\037`) {
		t.Errorf("expected \\x1f to arrive escaped, got %q", out)
	}

	// A tab does pass through raw, on both sides — which is what the parser
	// depends on.
	out, err = tmuxCmd(osSelf, "list-sessions", "-F", "#{session_name}\tx").Output()
	if err != nil {
		t.Fatalf("list-sessions: %v", err)
	}
	if !strings.Contains(string(out), "probe\tx") {
		t.Errorf("tab did not survive the format string: %q", out)
	}

	// And the separator this service actually uses is that tab.
	if listSep != "\t" {
		t.Errorf("listSep = %q; a non-printable separator does not survive tmux", listSep)
	}
}

func findSession(t *testing.T, sessions []Session, name string) Session {
	t.Helper()
	for _, s := range sessions {
		if s.Name == name {
			return s
		}
	}
	t.Fatalf("session %q not in %+v", name, sessions)
	return Session{}
}

func mustJSON(t *testing.T, s string) string {
	t.Helper()
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
