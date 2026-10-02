package main

import "net/http"

// paneReader reads what a session's pane is showing. An interface so a route
// is tested without tmux; production passes the Injector.
type paneReader interface {
	CapturePane(osUser, session string) (string, error)
}

// paneStateReader is what GET /pane needs from the injector: the pane, and
// the session's hook state.
type paneStateReader interface {
	paneReader
	State(osUser, session string) string
}

// handlePane answers what the session's pane shows now, and its hook state.
// The Text view reads it to mirror a blocking prompt, which the transcript
// does not report while it is pending (ADR-0010), and the mode and the model
// a fresh session has not written anywhere yet.
//
// A session with no transcript is read too. A fresh Claude on its folder-trust
// dialog has written none, so session-events has not registered it, and a 404
// here left the Text view showing an idle, empty session (deployed review
// round 5, 2026-09-29). The read is of the caller's own tmux session as their
// own OS user, as the terminal view is, so a transcript adds no permission; a
// session that is not there fails the capture and is a 404.
func handlePane(p paneStateReader) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		osUser, session := osUserFrom(r.Context()), r.PathValue("session")
		text, err := p.CapturePane(osUser, session)
		if err != nil {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}
		writeJSON(w, struct {
			Pane  string `json:"pane"`
			State string `json:"state"`
		}{text, p.State(osUser, session)})
	}
}
