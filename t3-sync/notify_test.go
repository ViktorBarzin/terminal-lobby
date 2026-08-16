package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func postNotice(t *testing.T, h http.Handler, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// The notice is the ONLY evidence of a deliberate lobby-side kill. A session
// that merely stopped existing is indistinguishable from an OOM or a reboot,
// and those cross nothing (decision 3) — so this endpoint is what separates
// "the user chose to end this" from "the box had a bad day".
func TestKillNoticeAccepted(t *testing.T) {
	k := NewKillNotices("wizard")

	rec := postNotice(t, k.Handler(), NotifyKilledPath, `{"osUser":"wizard","session":"feat-header"}`)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204: %s", rec.Code, rec.Body.String())
	}
	got := k.Drain()
	if len(got) != 1 || got[0] != "feat-header" {
		t.Fatalf("Drain() = %v, want [feat-header]", got)
	}
	if again := k.Drain(); len(again) != 0 {
		t.Errorf("second Drain() = %v, want empty — a notice is delivered once", again)
	}
}

// Another user's kill is not this syncer's business: each syncer speaks for one
// uid and reconciles only that user's sessions (decision 13).
func TestKillNoticeRejectsAnotherUser(t *testing.T) {
	k := NewKillNotices("wizard")

	rec := postNotice(t, k.Handler(), NotifyKilledPath, `{"osUser":"emo","session":"their-work"}`)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", rec.Code)
	}
	if got := k.Drain(); len(got) != 0 {
		t.Errorf("Drain() = %v, want empty", got)
	}
}

// An omitted osUser is the common case for a caller that only ever talks to one
// user's syncer, and it is safe: the socket is already per-user.
func TestKillNoticeAllowsOmittedUser(t *testing.T) {
	k := NewKillNotices("wizard")

	rec := postNotice(t, k.Handler(), NotifyKilledPath, `{"session":"feat-header"}`)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204: %s", rec.Code, rec.Body.String())
	}
	if got := k.Drain(); len(got) != 1 {
		t.Errorf("Drain() = %v, want one notice", got)
	}
}

func TestKillNoticeRejectsMalformed(t *testing.T) {
	k := NewKillNotices("wizard")

	cases := []struct {
		name, body string
		want       int
	}{
		{"not json", `{`, http.StatusBadRequest},
		{"no session", `{"osUser":"wizard"}`, http.StatusBadRequest},
		{"invalid session name", `{"session":"../../etc/passwd"}`, http.StatusBadRequest},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := postNotice(t, k.Handler(), NotifyKilledPath, c.body)
			if rec.Code != c.want {
				t.Errorf("status = %d, want %d", rec.Code, c.want)
			}
		})
	}
	if got := k.Drain(); len(got) != 0 {
		t.Errorf("a malformed notice was queued: %v", got)
	}
}

func TestKillNoticeRoutingAndMethod(t *testing.T) {
	k := NewKillNotices("wizard")

	rec := postNotice(t, k.Handler(), "/notify/something-else", `{"session":"x"}`)
	if rec.Code != http.StatusNotFound {
		t.Errorf("unknown path status = %d, want 404", rec.Code)
	}

	req := httptest.NewRequest(http.MethodGet, NotifyKilledPath, nil)
	rec = httptest.NewRecorder()
	k.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET status = %d, want 405", rec.Code)
	}
}

// Two notices for the same session are one fact. Collapsing them keeps the
// plan a set of intentions rather than a queue of retries.
func TestKillNoticeCollapsesDuplicates(t *testing.T) {
	k := NewKillNotices("wizard")
	for i := 0; i < 3; i++ {
		postNotice(t, k.Handler(), NotifyKilledPath, `{"session":"feat-header"}`)
	}
	postNotice(t, k.Handler(), NotifyKilledPath, `{"session":"other"}`)

	got := k.Drain()
	if len(got) != 2 {
		t.Fatalf("Drain() = %v, want two distinct sessions", got)
	}
}

// A notice that could not be acted on has to come back, or a kill dispatched
// while t3-serve was down would silently never archive its thread.
func TestKillNoticeRequeue(t *testing.T) {
	k := NewKillNotices("wizard")
	postNotice(t, k.Handler(), NotifyKilledPath, `{"session":"feat-header"}`)

	pending := k.Drain()
	k.Requeue(pending)
	if got := k.Drain(); len(got) != 1 || got[0] != "feat-header" {
		t.Errorf("Drain() after Requeue = %v, want [feat-header]", got)
	}
}

func TestListenSpec(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "t3-sync.sock")

	ln, err := ListenSpec("unix:" + sock)
	if err != nil {
		t.Fatalf("ListenSpec unix: %v", err)
	}
	if _, err := net.Dial("unix", sock); err != nil {
		t.Errorf("dial the unix socket: %v", err)
	}
	ln.Close()

	// A stale socket from a previous run must not stop the next start: the
	// file outlives the process that made it.
	ln, err = ListenSpec("unix:" + sock)
	if err != nil {
		t.Fatalf("ListenSpec over a stale socket: %v", err)
	}
	ln.Close()

	ln, err = ListenSpec("tcp:127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenSpec tcp: %v", err)
	}
	ln.Close()

	if _, err := ListenSpec("smoke-signals:/dev/null"); err == nil {
		t.Error("ListenSpec accepted an unknown scheme")
	}
}

// The notice crosses a binary boundary, so the shape is pinned to the producer
// rather than to a copy of it: tmux-api posts this and nothing negotiates.
// A drift here is a kill that never archives its thread, silently.
func TestKillNoticeWireMatchesTmuxAPI(t *testing.T) {
	raw, err := os.ReadFile("../tmux-api/killnotify.go")
	if err != nil {
		t.Fatalf("read the producer: %v", err)
	}
	producer := string(raw)

	if want := "killNotifyPath = " + strconv.Quote(NotifyKilledPath); !strings.Contains(producer, want) {
		t.Errorf("tmux-api does not declare\n\t%s\nThe path is the whole contract; a mismatch is a 404 nobody reads.", want)
	}
	// Every key the consumer reads has to be a key the producer writes.
	for _, key := range []string{"osUser", "session", "killedAt", "source"} {
		if !strings.Contains(producer, `json:"`+key+`"`) {
			t.Errorf("tmux-api's killNotice has no %q field", key)
		}
	}

	// And the body it builds has to be one this handler accepts.
	body := `{"osUser":"wizard","session":"feat-header","killedAt":"2026-08-16T00:00:00Z","source":"tmux-api"}`
	k := NewKillNotices("wizard")
	if rec := postNotice(t, k.Handler(), NotifyKilledPath, body); rec.Code != http.StatusNoContent {
		t.Fatalf("the producer's own body was answered %d: %s", rec.Code, rec.Body.String())
	}
	if got := k.Drain(); len(got) != 1 || got[0] != "feat-header" {
		t.Errorf("Drain() = %v, want [feat-header]", got)
	}
}

// The unit passes a bare host:port, and systemd turns an unset port into an
// empty string rather than dropping the argument.
func TestListenSpecBareAddress(t *testing.T) {
	ln, err := ListenSpec("127.0.0.1:0")
	if err == nil {
		ln.Close()
		t.Fatal("ListenSpec accepted port 0: tmux-api could never find that listener")
	}

	ln, err = ListenSpec("127.0.0.1:" + freePort(t))
	if err != nil {
		t.Fatalf("ListenSpec on a bare address: %v", err)
	}
	defer ln.Close()
	if _, ok := ln.Addr().(*net.TCPAddr); !ok {
		t.Errorf("listener address is %T, want TCP", ln.Addr())
	}

	for _, spec := range []string{"127.0.0.1:", "127.0.0.1:nope", ":7695", "127.0.0.1:99999"} {
		if ln, err := ListenSpec(spec); err == nil {
			ln.Close()
			t.Errorf("ListenSpec(%q) started a listener nobody could find", spec)
		}
	}
}

// freePort asks the kernel for an unused port and hands it back as a string.
// Racy in principle, and the alternative — a hardcoded port — collides with the
// real syncers on this box, which is worse.
func freePort(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("find a free port: %v", err)
	}
	defer ln.Close()
	_, port, err := net.SplitHostPort(ln.Addr().String())
	if err != nil {
		t.Fatalf("split %q: %v", ln.Addr(), err)
	}
	return port
}
