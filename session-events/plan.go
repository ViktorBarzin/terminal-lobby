package main

import (
	"encoding/json"
	"log"
	"net/http"

	"terminal-lobby/sessionio"
)

// POST /prompt refuses while Claude Code's plan approval is on the pane.
//
// WHY A PROMPT CANNOT GO IN. Injector.Prompt sends C-e C-u, a paste and Enter
// into whatever has focus. On the plan approval (sessionio/plandialog.go) the
// focus is its menu, and Enter selects the highlighted row, which is the first
// one when the dialog opens: on wizard's sessions "Yes, clear context and use
// auto mode". A prompt from a stale client would approve the plan, throw the
// conversation away and start executing, with nobody having chosen any of it.
//
// The Text view's own composer never sends one there: while the plan card is
// docked, its Send goes to POST /answer as feedback. What this stops is every
// other sender, a browser still holding a bundle from before the card, a
// second tab, a script, and the refusal hands the text back (409, applied
// false, reason plan-open), so the field it came from can restore it.
//
// THIS IS NOT THE TURN GATE gate_test.go keeps out of the route. That gate
// refused prompts while Claude worked, and a mid-turn prompt belongs in
// Claude's own queue. This refuses the screens on which a prompt is not queued
// at all but typed into a menu: the plan approval, and since 2026-09-27 the
// tool permission prompt (reason permission-open) and a question (reason
// question-open). A running turn does not refuse a prompt.
//
// A QUESTION WAS LET THROUGH until 2026-09-27, on the belief that a prompt
// dismissed it. It answers it: the Enter at the end of Injector.Prompt picks
// the highlighted row. Measured on 0.78.0, a prompt sent the moment the
// dialog drew answered "Shape?" with Circle, which nobody chose, and the words
// were lost. The Text view routes Send to POST /answer once its card docks,
// about 1.4 s after the dialog draws, so a Send inside that window, or with
// the event stream stalled, reached this route.

// planPane is what the guard reads: the pane, and the options the hooks stamp.
// An interface so the guard is tested without tmux; production passes the
// Injector.
type planPane interface {
	CapturePane(osUser, session string) (string, error)
	Option(osUser, session, name string) (string, bool)
}

// exitPlanTool is the tool whose dialog is the plan approval.
const exitPlanTool = "ExitPlanMode"

// promptRefusal reports whether the plan approval, a tool permission prompt,
// or a question is up on the session's pane.
//
// TWO READINGS, EITHER ENOUGH. The first is the pane parsed, which is what
// the contract names and what every measured layout satisfies: both
// renderers, 58 columns, a scrolled plan, typed feedback. The second is the
// net under it for a dialog a CLI update has restyled past the parser: the
// hooks stamp OptionAsk with the tool_use_id of the ExitPlanMode that drew
// the dialog, and clear it when the dialog goes (devvm/claude-tmux-state), so
// a marker naming the ExitPlanMode the transcript still holds open is the
// dialog on screen. The marker alone is not enough, because it names an
// AskUserQuestion's id the same way, and neither is the transcript alone,
// which keeps an unresolved call after a crash for good. The net cannot catch
// a restyled dialog whose record Claude Code has not written yet; for a
// question that window was measured at up to 112 s (registry.go watchPanes).
//
// A pane that cannot be read falls through to the net and then lets the
// prompt go. Prompt itself fails on a session that is gone, and refusing
// every prompt whenever tmux hiccups would be a worse trade than the net.
//
// The same capture answers for the tool permission prompt, the other screen a
// prompt must not reach (sessionio/permdialog.go): a paste lands on its menu, a
// digit in the text picks a row, and the Enter picks the highlighted one, which
// is "Yes". It has no net under it. Its dialog draws no marker the hooks stamp,
// and a restyled one leaves a prompt going through, as every prompt did before
// 2026-09-27.
//
// A question is read the same way, parse first and the net under it: the
// marker names the AskUserQuestion that drew the dialog, and a question whose
// top the pane has cut off does not parse, so only the net catches it.
//
// It names the screen, as the reason the refusal carries, or "".
func promptRefusal(rg *registry, p planPane, osUser, session string) string {
	if pane, err := p.CapturePane(osUser, session); err == nil {
		if sessionio.ParsePlanDialog(pane) != nil {
			return planOpenReason
		}
		if sessionio.ParsePermissionDialog(pane) != nil {
			return permissionOpenReason
		}
		if sessionio.ParseDialog(pane) != nil {
			return questionOpenReason
		}
	}
	ask, _ := p.Option(osUser, session, sessionio.OptionAsk)
	if ask == "" {
		return ""
	}
	fs, ok := rg.source(osUser, session)
	if !ok {
		return ""
	}
	switch ask {
	case pendingCall(fs, exitPlanTool):
		return planOpenReason
	case pendingCall(fs, askQuestionTool):
		return questionOpenReason
	}
	return ""
}

// pendingCall is the tool id of the newest call of `tool` whose result has not
// arrived, or "" when there is none. It reads as far back as pendingQuestions
// does, and for the same reason: a blocking call belongs to the turn that is
// still running.
func pendingCall(fs *sessionio.FileSource, tool string) string {
	id := ""
	for _, e := range fs.ReplayWindow(0, answerKnownTurns) {
		switch {
		case e.Kind == sessionio.KindToolUse && e.Tool == tool:
			id = e.ToolID
		case id != "" && e.Kind == sessionio.KindToolResult && e.ToolID == id:
			id = ""
		}
	}
	return id
}

// The refusal's reasons, as the client matches them.
const (
	planOpenReason       = "plan-open"
	permissionOpenReason = "permission-open"
	questionOpenReason   = "question-open"
)

// writePromptRefusal is the refusal: 409, in the shape the answer routes use.
//
// Not a 2xx: a client from before the plan card counts a 2xx as sent and clears
// its field, and on anything else it keeps the text and says the send failed
// (frontend-v2 store/session.ts send).
func writePromptRefusal(w http.ResponseWriter, reason string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusConflict)
	if err := json.NewEncoder(w).Encode(struct {
		Applied bool   `json:"applied"`
		Reason  string `json:"reason"`
	}{false, reason}); err != nil {
		log.Printf("writePromptRefusal: %v", err)
	}
}
