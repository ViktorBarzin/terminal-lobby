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
// Claude's own queue. This refuses exactly one screen, on which a prompt is not
// queued at all but typed into a menu. A question on the pane does not refuse
// a prompt, and neither does a running turn.

// planPane is what the guard reads: the pane, and the options the hooks stamp.
// An interface so the guard is tested without tmux; production passes the
// Injector.
type planPane interface {
	CapturePane(osUser, session string) (string, error)
	Option(osUser, session, name string) (string, bool)
}

// exitPlanTool is the tool whose dialog is the plan approval.
const exitPlanTool = "ExitPlanMode"

// planOpen reports whether the plan approval is up on the session's pane.
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
func planOpen(rg *registry, p planPane, osUser, session string) bool {
	if pane, err := p.CapturePane(osUser, session); err == nil && sessionio.ParsePlanDialog(pane) != nil {
		return true
	}
	ask, _ := p.Option(osUser, session, sessionio.OptionAsk)
	if ask == "" {
		return false
	}
	fs, ok := rg.source(osUser, session)
	return ok && pendingPlan(fs) == ask
}

// pendingPlan is the tool id of the newest ExitPlanMode whose result has not
// arrived, or "" when there is none. It reads as far back as pendingQuestions
// does, and for the same reason: a blocking call belongs to the turn that is
// still running.
func pendingPlan(fs *sessionio.FileSource) string {
	id := ""
	for _, e := range fs.ReplayWindow(0, answerKnownTurns) {
		switch {
		case e.Kind == sessionio.KindToolUse && e.Tool == exitPlanTool:
			id = e.ToolID
		case id != "" && e.Kind == sessionio.KindToolResult && e.ToolID == id:
			id = ""
		}
	}
	return id
}

// planOpenReason is the refusal's reason, as the client matches it.
const planOpenReason = "plan-open"

// writePlanOpen is the refusal: 409, in the shape the answer routes use.
//
// Not a 2xx: a client from before the plan card counts a 2xx as sent and clears
// its field, and on anything else it keeps the text and says the send failed
// (frontend-v2 store/session.ts send).
func writePlanOpen(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusConflict)
	if err := json.NewEncoder(w).Encode(struct {
		Applied bool   `json:"applied"`
		Reason  string `json:"reason"`
	}{false, planOpenReason}); err != nil {
		log.Printf("writePlanOpen: %v", err)
	}
}
