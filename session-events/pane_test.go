package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakePanes stands in for the injector's pane reads.
type fakePanes struct {
	pane string
	err  error
}

func (f fakePanes) CapturePane(osUser, session string) (string, error) { return f.pane, f.err }
func (f fakePanes) State(osUser, session string) string                { return "done" }

func servePane(t *testing.T, p paneStateReader, session string) *httptest.ResponseRecorder {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /pane/{session}", handlePane(p))
	r := httptest.NewRequest(http.MethodGet, "/pane/"+session, nil)
	r = r.WithContext(context.WithValue(r.Context(), osUserKey, "wizard"))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	return w
}

// A fresh Claude on its folder-trust dialog has written no transcript, so
// session-events has not registered it, and the pane read answered 404: the
// Text view could not see the dialog and showed an idle, empty session
// (deployed review round 5, 2026-09-29). The pane is the user's own session in
// their own tmux either way, so it is read whether or not a transcript is.
func TestPaneReadsASessionWithNoTranscriptYet(t *testing.T) {
	w := servePane(t, fakePanes{pane: " ❯ No, exit\n   Yes, I trust this folder\n"}, "fresh1")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "trust this folder") {
		t.Fatalf("GET /pane = %d %q, want 200 with the pane", w.Code, w.Body.String())
	}
}

// A session that is not there at all is still a 404.
func TestPaneAnswersNotFoundForASessionThatIsNotThere(t *testing.T) {
	w := servePane(t, fakePanes{err: errors.New("can't find session")}, "gone1")
	if w.Code != http.StatusNotFound {
		t.Fatalf("GET /pane = %d, want 404", w.Code)
	}
}
