package main

// Bringing a suspended session back.
//
// POST /sessions/{name}/resume is the whole of it, and it happens on a CLICK —
// there is no automatic resume. Cold `claude --resume <uuid>` reaches a loaded
// prompt in 1.7 s (empty transcript) to 3.1 s (24 MB), and the pre-warmed pool
// is deliberately not used for it: a slot buys about a second, reaches under
// half the sessions, and leaves the create path cold while it is held.
//
// The pane's frozen scrollback is left exactly as it was until respawn-pane
// replaces it. A suspended session shows the last thing it said, which is what
// a person scrolling the sidebar wants to see.
//
// The sequence itself, every check and its order, is sessionio.Resume, shared
// with agent-api, which resumes a Caller's conversation when the Caller sends
// it a message. What stays here is the HTTP answer, the cache, the event, and
// the seams this package's tests swap.

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	"terminal-lobby/sessionio"
	"terminal-lobby/telemetry"
)

// suspendedFacts is everything the resume needs, read in one tmux call: a
// second round trip could see a session that moved between them.
type suspendedFacts struct {
	paneID string
	// panePID is #{pane_pid}: read only to answer whether a claude is running
	// under a pane that is still ALIVE, and never consulted for a dead one —
	// tmux goes on printing a dead pane's old pid and the kernel reuses pids.
	panePID     int
	suspendedAt int64
	resumeCmd   string
	savedState  string
	// transcript is @claude_transcript, re-read here rather than trusted from
	// suspend time: a transcript can be deleted while a session sits
	// suspended, and respawning `claude --resume` against a file that is no
	// longer there ends with claude exiting, the pane exiting and the session
	// gone (suspend.go transcriptHasAConversation has the measurement).
	transcript string
	// paneDead is #{pane_dead}: 1 once the pane's command has exited and
	// remain-on-exit is holding its scrollback.
	//
	// It is NOT on its own the test for a stale mark. Most suspended sessions
	// are dead panes, but a session restored by tmux-persist runs
	// `…; claude …; echo …; exec bash -l`, so killing its claude leaves the
	// pane alive with a bash in it (measured on tmux 3.4, 2026-09-19) and the
	// mark is perfectly good. What would make the mark stale is a CLAUDE under
	// that live pane, which is the thing `respawn-pane -k` must not replace, so
	// that is what is asked — see resumeSession.
	paneDead bool
}

// readSuspended reads the three marks and the pane id. ok=false means the
// session could not be read at all, which is a 404; a session that reads fine
// with no timestamp is live, which is a 409.
var readSuspended = func(osUser, name string) (suspendedFacts, bool) {
	f, ok := apiInjector().ReadSuspended(osUser, name)
	if !ok {
		return suspendedFacts{}, false
	}
	return suspendedFacts{
		paneID:      f.PaneID,
		panePID:     f.PanePID,
		suspendedAt: f.SuspendedAt,
		resumeCmd:   f.ResumeCmd,
		savedState:  f.SavedState,
		transcript:  f.Transcript,
		paneDead:    f.PaneDead,
	}, true
}

// shared is the same facts in sessionio's spelling, for the shared sequence.
func (f suspendedFacts) shared() sessionio.SuspendedFacts {
	return sessionio.SuspendedFacts{
		PaneID:      f.paneID,
		PanePID:     f.panePID,
		SuspendedAt: f.suspendedAt,
		ResumeCmd:   f.resumeCmd,
		SavedState:  f.savedState,
		Transcript:  f.transcript,
		PaneDead:    f.paneDead,
	}
}

// claudeUnderPane answers whether a claude is running under a pane, from
// /proc. ok=false means the scan did not happen, which is neither answer.
//
// A var for the tests, and the same /proc walk the sweep makes: every user's
// processes are visible here (comm and stat are world-readable), which is what
// lets one service run as wizard and still see emo's claude.
var claudeUnderPane = func(pid int) (bool, bool) {
	if pid <= 0 {
		return false, false
	}
	tree, err := procTreeFrom(procRoot)
	if err != nil || len(tree.comm) == 0 {
		return false, false
	}
	return tree.hasClaudeUnder(pid), true
}

// respawnPane re-runs the pane with argv, replacing whatever is in it.
//
// argv reaches tmux as SEPARATE arguments, which is what makes this exact:
// tmux execvp's a multi-element command without parsing it, so no shell and no
// tmux quoting rule stands between the stored command and the process. A
// single string would be re-split by tmux's own parser, whose rules are not the
// shell's (suspend.go, fact 4).
var respawnPane = func(osUser, paneID string, argv []string) (string, error) {
	return apiInjector().RespawnPane(osUser, paneID, argv)
}

// clearSuspendMarks puts the session back the way it was. Best-effort on
// purpose: the respawn has already happened by the time this runs, so a failed
// unset leaves a live session wearing a stale mark — which the next sweep's own
// "already suspended" check skips and an operator can clear by hand. Failing
// the request here would tell the lobby the resume did not work when it did.
var clearSuspendMarks = func(osUser, name, savedState string) {
	// remain-on-exit goes back off first, then the marks, then the state the
	// session had when it was suspended (sessionio.ClearSuspendMarks has the
	// order and why). Worth being honest about what restoring the state buys:
	// a resumed pane has no claude under it until the boot finishes (1.7-3.1
	// s), and clearDeadStates blanks the state of a session in that
	// condition, so a poll landing inside the window still shows nothing.
	// Claude's own SessionStart hook re-stamps a few seconds later, which is
	// the answer that lasts.
	if err := apiInjector().ClearSuspendMarks(osUser, name, savedState); err != nil {
		log.Printf("resume: clearing the suspend marks on %s/%s: %v", osUser, name, err)
	}
}

// stampResumeDrive moves both last-used clocks to now. An explicit resume IS a
// drive, and without saying so the reaper undoes it within five minutes:
// @last_drive still holds the stamp that made the session a candidate, and
// stampDrives (lastdrive.go) only moves it for a session with a read-write
// client attached. The lobby's own click happens to attach one a moment later,
// so this covers the gap before that lands and every caller that never
// attaches at all. A session that reports its own activity is timed by
// sessionio.OptionLastActivity instead, and a resumed claude reports none
// until its first prompt, so the resume writes that stamp too.
//
// Through apiInjector rather than setDriveOption for the reason apiInjector
// exists (suspend.go): the package-level gridInjector was built at init and
// ignores the binary seams, so a write through it never reaches a test's tmux.
var stampResumeDrive = func(osUser, name string, at int64) {
	if err := apiInjector().StampDriven(osUser, name, at); err != nil {
		log.Printf("resume: stamping the drive clocks on %s/%s: %v", osUser, name, err)
	}
}

// notSuspended is the 409 body, written from the two places that decide a
// session is live: no mark at all, and a mark over a pane that is still
// running.
func notSuspended(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusConflict)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": "not suspended"})
}

// sessionStateOption is @claude_state, named through sessionio so this service
// and the hook script that writes it cannot drift apart — the same arrangement
// sessionTitleOption has (main.go).
const sessionStateOption = sessionio.OptionState

// liveResumeOps is sessionio.ResumeOps over this package's seams. Built per
// call, so a test that swaps one is the one the request runs against. The
// resume and the restart (restart.go) both use it.
func liveResumeOps() sessionio.ResumeOps {
	return sessionio.ResumeOps{
		Read: func(u, n string) (sessionio.SuspendedFacts, bool) {
			f, ok := readSuspended(u, n)
			return f.shared(), ok
		},
		ClaudeUnderPane: func(pid int) (bool, bool) { return claudeUnderPane(pid) },
		HasConversation: func(u, path string) bool { return transcriptHasAConversation(u, path) },
		Respawn:         func(u, pane string, argv []string) (string, error) { return respawnPane(u, pane, argv) },
		ClearMarks:      func(u, n, saved string) { clearSuspendMarks(u, n, saved) },
		StampDriven:     func(u, n string, at int64) { stampResumeDrive(u, n, at) },
	}
}

// resumeResponse is the body of a successful POST /sessions/{name}/resume.
type resumeResponse struct {
	Resumed bool `json:"resumed"`
}

// resumeSession serves POST /sessions/{name}/resume.
//
//	200 {"resumed":true}         the respawn was issued
//	404                          no such session
//	409 {"error":"not suspended"} it is live
func resumeSession(w http.ResponseWriter, osUser, name string) {
	res, err := sessionio.Resume(liveResumeOps(), osUser, name)
	switch {
	case err == nil:
	case errors.Is(err, sessionio.ErrSessionGone):
		http.Error(w, "session not found", http.StatusNotFound)
		return
	case errors.Is(err, sessionio.ErrNotSuspended):
		if res.StaleMarkCleared {
			log.Printf("resume: %s/%s is marked suspended but a claude is running under its pane — cleared the mark instead of respawning", osUser, name)
			sessionsCacheInstance.invalidate(osUser)
		}
		notSuspended(w)
		return
	case errors.Is(err, sessionio.ErrPaneUnknown):
		log.Printf("resume: %s/%s has a live pane and /proc would not say whether a claude is under it", osUser, name)
		http.Error(w, "cannot tell whether the pane is busy", http.StatusServiceUnavailable)
		return
	case errors.Is(err, sessionio.ErrResumeCmdUnreadable):
		// Only this service writes the option, and it writes it through
		// shellQuoteArgv — so reaching here means the mark was edited by hand
		// or truncated. The session stays suspended.
		log.Printf("resume: %s/%s carries a %s this cannot read", osUser, name, resumeCmdOption)
		http.Error(w, "resume command unreadable", http.StatusInternalServerError)
		return
	case errors.Is(err, sessionio.ErrNothingToResume):
		log.Printf("resume: %s/%s has no transcript to resume — leaving it suspended rather than respawning into a session that would exit",
			osUser, name)
		http.Error(w, "no transcript to resume", http.StatusInternalServerError)
		return
	default:
		log.Printf("resume: %s/%s: %v", osUser, name, err)
		http.Error(w, "respawn-pane failed", http.StatusInternalServerError)
		return
	}
	sessionsCacheInstance.invalidate(osUser)

	events.Emit("session.resumed", osUser, telemetry.Attrs{
		"tl.session":          name,
		"tl.suspendedSeconds": time.Now().Unix() - res.SuspendedAt,
		// How long the respawn call itself took, which is the part this
		// service owns. Claude's own boot happens after the pane exists and is
		// measured by the client, not here.
		"tl.resumeMs": res.RespawnMs,
		"tl.client":   "api",
	})
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resumeResponse{Resumed: true})
}
