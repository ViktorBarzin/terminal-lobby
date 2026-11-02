package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A lobby kill detaches the session's terminals before destroying it. tmux 3.4
// segfaults when a focus event arrives from a client whose session was just
// destroyed (sessionio.Injector.KillSession has the details), and on 2026-11-01
// that took all 13 of emo's sessions with it.
func TestKillSessionDetachesClientsBeforeKilling(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osSelf+"\n")
	withTempLayoutStore(t)
	argv := withTmuxStub(t, "exit 0")
	withSudoStub(t, "exit 0")

	rec := httptest.NewRecorder()
	handleSessionByName(rec, sessionReq(http.MethodDelete, "/sessions/qa-detach", "", "alice"))
	if rec.Code != http.StatusOK {
		t.Fatalf("DELETE /sessions/qa-detach: got %d, want %d", rec.Code, http.StatusOK)
	}

	got := recordedArgv(t, argv)
	detach := strings.Index(got, "detach-client\n-s\n=qa-detach\n")
	kill := strings.Index(got, "kill-session\n-t\n=qa-detach\n")
	if detach < 0 || kill < 0 || detach > kill {
		t.Fatalf("want detach-client -s =qa-detach before kill-session -t =qa-detach, tmux saw:\n%s", got)
	}
}

// Every kill in this service goes through killTmuxSession, so none of them can
// skip the detach. A literal "kill-session" anywhere else is a new path that
// would.
func TestNoDirectKillSessionCalls(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(src), `"kill-session"`) {
			t.Errorf("%s runs tmux kill-session directly; use killTmuxSession", f)
		}
	}
}
