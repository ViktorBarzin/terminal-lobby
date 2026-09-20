package main

// A person setting a session's state by hand.
//
// The state dot is stamped by hooks (docs/adr/0001-claude-state-via-hooks.md),
// and the ADR's own history is a list of ways it has read wrong: an interrupt
// typed straight at the pty, a dialog the harness took down without saying so,
// a background id nobody retired. Each one was fixed where it broke, and each
// fix arrived after somebody had spent a while looking at a dot they could not
// correct. This is the correction: three rows in the card's ⋯ menu that write
// the same option the hooks write.
//
// It is the SAME option, deliberately, rather than an override field beside
// it. Every consumer already reads @claude_state — the sidebar, the model
// picker's turn gate, agent-api's turn tracking, the push sender, the T3
// bridge's pin — and an override would have to be threaded through all of
// them or they would disagree about one fact. Writing the option itself also
// gives the lifetime for free: the next hook event stamps over it, so a
// correction lasts exactly until the system has something new to say, which
// is what was asked for.
//
// Two marks travel with the write, because a state alone does not survive
// contact with them:
//
//   - @claude_ask holds a session at awaiting for as long as it says a dialog
//     is drawn, whatever event fires next. A correction away from awaiting
//     that left it standing would be undone by the next PreToolUse. Cancel
//     clears it for the same reason (sessionio/tmux.go).
//   - @claude_bg is what keeps a session at running past its Stop. Marking a
//     session done while it still owes work leaves the card reading
//     "Done · 2 agents", and for an idle session nothing retires those ids
//     until its next turn ends. Done clears them. If the work is real, the
//     next SubagentStart or task-notification puts the session back to
//     running within seconds, and the next Stop rebuilds the set from the
//     harness's own list.

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"

	"terminal-lobby/sessionio"
	"terminal-lobby/telemetry"
)

// askOption is @claude_ask, the drawn-dialog mark, named through sessionio so
// this service and the hook script that writes it cannot drift apart — the
// arrangement sessionStateOption and sessionTitleOption already have.
const askOption = sessionio.OptionAsk

// stateMarks are what this handler has to know about a session before it
// writes: whether it is suspended, and what state it is in now.
type stateMarks struct {
	suspendedAt int64
	state       string
}

// readStateMarks reads both in one call, and answers the "is it even there"
// question at the same time. ok=false means the read did not land on the
// session that was asked for, which is a 404.
//
// The name is echoed back and has to match, because tmux does NOT fail an
// unknown target: `display-message -p -t no-such-session` exits 0 (measured on
// tmux 3.4), so without the check a session that is gone would read as one
// with no marks at all.
func readStateMarks(osUser, name string) (stateMarks, bool) {
	out, err := tmuxCmd(osUser, "display-message", "-p", "-t", exactPane(name),
		"#{session_name}"+listSep+"#{"+suspendedOption+"}"+listSep+
			// Last, and addressed as last: SplitN hands the final field every
			// separator left over. The state is one of three words, so there
			// are none, but the ordering rule is the list format's and this
			// keeps to it.
			"#{"+sessionStateOption+"}").Output()
	if err != nil {
		return stateMarks{}, false
	}
	parts := strings.SplitN(strings.TrimRight(string(out), "\n"), listSep, 3)
	if len(parts) != 3 || parts[0] != name {
		return stateMarks{}, false
	}
	at, _ := strconv.ParseInt(strings.TrimSpace(parts[1]), 10, 64)
	return stateMarks{suspendedAt: at, state: strings.TrimSpace(parts[2])}, true
}

// setStateOption writes @claude_state onto a live session, returning tmux's
// own message alongside the error so the caller can ask tmuxTargetMissing
// about it.
//
// exactPane, not exactSession: set-option's -t takes a pane target, and the
// leading '=' is what stops a bare name resolving by prefix onto a sibling —
// the hazard stampTitle documents, and the same one here.
func setStateOption(osUser, name, state string) (string, error) {
	out, err := tmuxCmd(osUser, "set-option", "-t", exactPane(name), sessionStateOption, state).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

// unsetSessionOption clears one option off a session. Measured on tmux 3.4:
// unsetting an option that was never set exits 0 silently, so no caller here
// needs a "was it set" check first.
func unsetSessionOption(osUser, name, option string) error {
	out, err := tmuxCmd(osUser, "set-option", "-u", "-t", exactPane(name), option).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// setSessionState serves POST /sessions/{name}/state {"state": "..."}.
//
//	204  stamped
//	400  a value outside running/awaiting/done
//	404  no such session
//	409  the session is suspended, or no Claude has ever run in it
func setSessionState(w http.ResponseWriter, r *http.Request, osUser, name string) {
	var body struct {
		State string `json:"state"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	state := strings.TrimSpace(body.State)
	if !hookStates[state] {
		http.Error(w, "invalid state", http.StatusBadRequest)
		return
	}
	marks, ok := readStateMarks(osUser, name)
	if !ok {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}
	if marks.suspendedAt > 0 {
		// parseSessions forces a suspended session's state whatever the option
		// says, because the hook's state describes a claude that was killed on
		// purpose. A stamp here would be invisible, which reads as the button
		// doing nothing.
		http.Error(w, "the session is suspended — resume it first", http.StatusConflict)
		return
	}
	if marks.state == "" {
		// No Claude has run in this session, and a stamp would grow a state
		// dot on a plain shell. Cancel declines the same write for the same
		// reason, and the liveness backstop (proc.go) would blank it within a
		// poll anyway.
		http.Error(w, "the session has no Claude state to set", http.StatusConflict)
		return
	}
	if state != stateAwaiting {
		// Before the state, never after: a reader that saw the new state with
		// the marker still standing would resolve it straight back to
		// awaiting. Best-effort — the write below is the one that decides the
		// request, and a marker that would not clear is worth a log, not a
		// failure.
		if err := unsetSessionOption(osUser, name, askOption); err != nil {
			log.Printf("set state: clearing %s on %s as %s failed: %v", askOption, name, osUser, err)
		}
	}
	if msg, err := setStateOption(osUser, name, state); err != nil {
		if tmuxTargetMissing(msg) {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}
		log.Printf("set %s on %s as %s failed: %v: %s", sessionStateOption, name, osUser, err, msg)
		http.Error(w, "set-option failed", http.StatusInternalServerError)
		return
	}
	if state == stateDone {
		// After the state landed, not before: a write that failed would
		// otherwise have taken a live count with it and changed nothing else.
		if err := unsetSessionOption(osUser, name, sessionBackgroundOption); err != nil {
			log.Printf("set state: clearing %s on %s as %s failed: %v", sessionBackgroundOption, name, osUser, err)
		}
	}
	// The body the cache is holding was built before the stamp, and serving it
	// for the rest of the window would show the old dot to the person who just
	// corrected it.
	sessionsCacheInstance.invalidate(osUser)
	holdManualPush(osUser, name, state)
	// Its own event name. claude.state_changed belongs to the hook script
	// (ADR-0001), and the two streams are not two writers of one fact: this
	// one says a PERSON decided, which is the thing worth being able to count
	// separately when the dots are wrong often enough for anybody to use it.
	events.Emit("claude.state_set", osUser, telemetry.Attrs{
		"tl.session": name, "tl.to": state, "tl.from": marks.state, "tl.client": "api",
	})
	w.WriteHeader(http.StatusNoContent)
}
