package main

// Restarting a session's Claude on the same conversation.
//
// A Claude reads its binary, its settings and its plugins when it starts, so a
// session that predates a change keeps running without it. The session menu's
// Restart is how a person brings one up to date without losing the thread or
// the tmux session.
//
// It is a suspend followed straight away by a resume, and reuses both whole.
// The suspend's stop (stopClaude) is the careful half: it SIGTERMs claude so
// the transcript is flushed, holds the pane with remain-on-exit so the
// one-pane session does not die with it, and works for every pane shape on
// the box, the tmux-persist one included. sessionio.Resume then respawns the
// pane with `claude --resume <uuid>` and the flags the session started with,
// and clears every mark. `respawn-pane -k` straight over a live claude would
// be shorter, and is what this avoids: it can leave the old claude reparented
// to init rather than dead, and it does not wait for the transcript.
//
// The policy is a person's, not the sweep's. They are looking at the session
// and the card has already asked before cutting a turn, so being attached,
// running or awaiting does not refuse. Two things still do: a session that is
// already suspended (opening it resumes it, which loads the new binary just
// the same), and a turn a Caller is running over HTTP, which agent-api is
// waiting on and would never see finish.

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	"terminal-lobby/sessionio"
	"terminal-lobby/telemetry"
)

// restartPolicy is stopClaude's policy for a restart a person asked for.
var restartPolicy = stopPolicy{
	verb: "restart",
	decline: func(f paneFacts, _ time.Time) (string, bool) {
		switch {
		case f.suspendedAt > 0:
			return "is suspended", true
		case f.agentOwner != "" && f.state == stateRunning:
			return "is running a turn for " + f.agentOwner, true
		}
		return "", false
	},
}

// sessionNamed finds one session in the caller's list, with the tool and state
// the list resolves.
func sessionNamed(osUser, name string) (Session, bool) {
	for _, s := range userSessions(osUser) {
		if s.Name == name {
			return s, true
		}
	}
	return Session{}, false
}

// restartResponse is the body of a successful POST /sessions/{name}/restart.
type restartResponse struct {
	Restarted bool `json:"restarted"`
}

// restartSession serves POST /sessions/{name}/restart.
//
//	200 {"restarted":true}  claude was stopped and respawned on its conversation
//	404                     no such session
//	409                     not a Claude session, suspended, no conversation
//	                        yet, or a Caller's turn in flight
//	500                     claude would not stop, or stopped and did not come
//	                        back (the session is then left suspended, and
//	                        opening it resumes it)
func restartSession(w http.ResponseWriter, osUser, name string) {
	started := time.Now()
	s, ok := sessionNamed(osUser, name)
	if !ok {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}
	if s.SuspendedAt > 0 {
		http.Error(w, "the session is suspended — open it to resume", http.StatusConflict)
		return
	}
	if s.Tool != toolClaude {
		http.Error(w, "only a Claude session can be restarted", http.StatusConflict)
		return
	}
	from := s.State
	// The state the resume puts back. A restarted claude sits at its prompt
	// whatever the old one was doing, and its SessionStart hook stamps done
	// a moment later anyway.
	s.State = stateDone

	_, err := stopClaude(liveSuspendOps, restartPolicy, osUser, s, started)
	switch {
	case err == nil:
	case errors.Is(err, errNoPane):
		http.Error(w, "session not found", http.StatusNotFound)
		return
	case errors.Is(err, errNoConversation):
		http.Error(w, "the session has no conversation to restart yet", http.StatusConflict)
		return
	case errors.Is(err, errDeclined), errors.Is(err, errNoClaude), errors.Is(err, errNotResumable):
		http.Error(w, "the session "+err.Error(), http.StatusConflict)
		return
	default:
		// Past the point where the session may carry remain-on-exit and a
		// resume command. If claude exits later, the sweep's repair pass marks
		// it suspended and a click brings it back.
		sessionsCacheInstance.invalidate(osUser)
		http.Error(w, "Claude did not stop", http.StatusInternalServerError)
		return
	}

	_, err = sessionio.Resume(liveResumeOps(), osUser, name)
	sessionsCacheInstance.invalidate(osUser)
	if err != nil {
		log.Printf("restart: %s/%s stopped but did not resume: %v", osUser, name, err)
		http.Error(w, "Claude stopped but did not come back — open the session to resume it", http.StatusInternalServerError)
		return
	}

	ms := time.Since(started).Milliseconds()
	events.Emit("session.restarted", osUser, telemetry.Attrs{
		"tl.session":   name,
		"tl.from":      from,
		"tl.restartMs": ms,
		"tl.client":    "api",
	})
	log.Printf("restart: %s/%s restarted from %s in %dms", osUser, name, from, ms)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(restartResponse{Restarted: true})
}
