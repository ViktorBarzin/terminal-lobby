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

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
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
	out, err := tmuxCmd(osUser, "display-message", "-p", "-t", exactPane(name),
		"#{session_name}"+listSep+"#{pane_id}"+listSep+
			"#{"+suspendedOption+"}"+listSep+
			"#{"+suspendStateOption+"}"+listSep+
			"#{pane_dead}"+listSep+
			"#{pane_pid}"+listSep+
			"#{"+sessionio.OptionTranscript+"}"+listSep+
			// Last, and addressed as last: the resume command is the one field
			// here that can hold anything, so it gets whatever separators are
			// left over rather than shifting the fields ahead of it.
			"#{"+resumeCmdOption+"}").Output()
	if err != nil {
		return suspendedFacts{}, false
	}
	parts := strings.SplitN(strings.TrimRight(string(out), "\n"), listSep, 8)
	if len(parts) != 8 || parts[0] != name {
		return suspendedFacts{}, false
	}
	at, _ := strconv.ParseInt(parts[2], 10, 64)
	pid, _ := strconv.Atoi(strings.TrimSpace(parts[5]))
	return suspendedFacts{
		paneID:      parts[1],
		suspendedAt: at,
		savedState:  parts[3],
		paneDead:    strings.TrimSpace(parts[4]) == "1",
		panePID:     pid,
		transcript:  parts[6],
		resumeCmd:   parts[7],
	}, true
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
	args := append([]string{"respawn-pane", "-k", "-t", paneID}, argv...)
	out, err := tmuxCmd(osUser, args...).CombinedOutput()
	return string(out), err
}

// clearSuspendMarks puts the session back the way it was. Best-effort on
// purpose: the respawn has already happened by the time this runs, so a failed
// unset leaves a live session wearing a stale mark — which the next sweep's own
// "already suspended" check skips and an operator can clear by hand. Failing
// the request here would tell the lobby the resume did not work when it did.
var clearSuspendMarks = func(osUser, name, savedState string) {
	unset := func(option string) {
		if out, err := tmuxCmd(osUser, "set-option", "-u", "-t", exactPane(name), option).CombinedOutput(); err != nil {
			log.Printf("resume: unsetting %s on %s/%s: %v: %s", option, osUser, name, err, strings.TrimSpace(string(out)))
		}
	}
	// remain-on-exit goes back off first. It was set for one kill; leaving it
	// on would keep the pane as a corpse the next time claude exits normally,
	// and the session would never close again.
	if out, err := tmuxCmd(osUser, "set-option", "-u", "-t", exactPane(name), "remain-on-exit").CombinedOutput(); err != nil {
		log.Printf("resume: unsetting remain-on-exit on %s/%s: %v: %s", osUser, name, err, strings.TrimSpace(string(out)))
	}
	unset(suspendedOption)
	unset(resumeCmdOption)
	// The state the session had when it was suspended, back where it was, so
	// the sidebar dot does not blink through empty on the way back.
	//
	// Worth being honest about what this buys: a resumed pane has no claude
	// under it until the boot finishes (1.7-3.1 s), and clearDeadStates blanks
	// the state of a session in that condition, so a poll landing inside the
	// window still shows nothing. Claude's own SessionStart hook re-stamps a
	// few seconds later, which is the answer that lasts. This covers the gap
	// before the first poll and no more.
	if savedState != "" && knownStates[savedState] && savedState != stateSuspended {
		if err := apiInjector().SetOption(osUser, name, sessionStateOption, savedState); err != nil {
			log.Printf("resume: restoring %s on %s/%s: %v", sessionStateOption, osUser, name, err)
		}
	}
	unset(suspendStateOption)
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
	facts, ok := readSuspended(osUser, name)
	if !ok {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}
	if facts.suspendedAt <= 0 {
		notSuspended(w)
		return
	}
	if !facts.paneDead {
		// A live pane under a suspended mark is one of two different things,
		// and respawning the wrong one destroys a conversation.
		//
		// A session restored by tmux-persist runs `…; claude …; exec bash -l`,
		// so the suspend's kill leaves the pane ALIVE holding a bash — measured
		// on tmux 3.4, 2026-09-19, and two of this box's sessions have that
		// shape today. That mark is good, that bash holds nothing, and
		// `respawn-pane -k` is exactly what should replace it.
		//
		// A CLAUDE under that live pane is the other thing: a mark that no
		// longer describes the session, and respawning over it would kill the
		// conversation somebody is in the middle of. So the claude is what is
		// asked about, not the pane.
		busy, ok := claudeUnderPane(facts.panePID)
		if !ok {
			// Nothing is cleared and nothing is respawned: an unreadable /proc
			// is not evidence either way, and clearing the marks would take the
			// resume command with them and leave the session unresumable.
			log.Printf("resume: %s/%s has a live pane and /proc would not say whether a claude is under it", osUser, name)
			http.Error(w, "cannot tell whether the pane is busy", http.StatusServiceUnavailable)
			return
		}
		if busy {
			log.Printf("resume: %s/%s is marked suspended but a claude is running under its pane — clearing the mark instead of respawning", osUser, name)
			clearSuspendMarks(osUser, name, facts.savedState)
			sessionsCacheInstance.invalidate(osUser)
			notSuspended(w)
			return
		}
	}
	argv, ok := shellSplitArgv(facts.resumeCmd)
	if !ok || len(argv) == 0 {
		// Only this service writes the option, and it writes it through
		// shellQuoteArgv — so reaching here means the mark was edited by hand
		// or truncated. Respawning a half-read command would run something
		// nobody wrote, so the session stays suspended.
		log.Printf("resume: %s/%s carries a %s this cannot read: %q", osUser, name, resumeCmdOption, facts.resumeCmd)
		http.Error(w, "resume command unreadable", http.StatusInternalServerError)
		return
	}
	if facts.paneID == "" {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}
	// The conversation still has to be on disk. `respawn-pane -k` replaces the
	// frozen pane with the resume command and there is no way back from it: if
	// claude then finds nothing to resume it exits, the shell's -c list ends,
	// the pane exits, and the session goes with it, because the marks are
	// cleared — remain-on-exit with them — as soon as the respawn is issued.
	// Refusing here keeps the session suspended and clickable instead.
	if !transcriptHasAConversation(osUser, facts.transcript) {
		log.Printf("resume: %s/%s has no transcript to resume (%q) — leaving it suspended rather than respawning into a session that would exit",
			osUser, name, facts.transcript)
		http.Error(w, "no transcript to resume", http.StatusInternalServerError)
		return
	}

	started := time.Now()
	if out, err := respawnPane(osUser, facts.paneID, argv); err != nil {
		msg := strings.TrimSpace(out)
		if tmuxTargetMissing(msg) {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}
		log.Printf("resume: respawn-pane %s for %s/%s: %v: %s", facts.paneID, osUser, name, err, msg)
		http.Error(w, "respawn-pane failed", http.StatusInternalServerError)
		return
	}
	resumeMs := time.Since(started).Milliseconds()

	// Only after the respawn landed. A failed resume leaves every mark where
	// it was, so the session still reads as suspended and the click can be
	// tried again.
	clearSuspendMarks(osUser, name, facts.savedState)
	// An explicit resume IS a drive, and without saying so the reaper undoes it
	// within five minutes: @last_drive still holds the stamp that made the
	// session a candidate, and stampDrives (lastdrive.go) only moves it for a
	// session with a read-write client attached. The lobby's own click happens
	// to attach one a moment later, so this covers the gap before that lands
	// and every caller that never attaches at all — which makes this the
	// second writer of the option, after stampDrives.
	//
	// Through apiInjector rather than setDriveOption for the reason apiInjector
	// exists (suspend.go): the package-level gridInjector was built at init and
	// ignores the binary seams, so a write through it never reaches a test's
	// tmux.
	if err := apiInjector().SetOption(osUser, name, lastDriveOption, strconv.FormatInt(time.Now().Unix(), 10)); err != nil {
		log.Printf("resume: stamping %s on %s/%s: %v", lastDriveOption, osUser, name, err)
	}
	sessionsCacheInstance.invalidate(osUser)

	events.Emit("session.resumed", osUser, telemetry.Attrs{
		"tl.session":          name,
		"tl.suspendedSeconds": time.Now().Unix() - facts.suspendedAt,
		// How long the respawn call itself took, which is the part this
		// service owns. Claude's own boot happens after the pane exists and is
		// measured by the client, not here.
		"tl.resumeMs": resumeMs,
		"tl.client":   "api",
	})
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resumeResponse{Resumed: true})
}
