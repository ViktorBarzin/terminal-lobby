package main

import (
	"encoding/json"
	"log"
	"net/http"

	"terminal-lobby/sessionio"
)

// What stops a typed prompt.
//
// Claude takes its prompts through its mod (ADR-0036), so nothing is typed into
// a Claude pane and none of Claude's dialogs can catch the Enter. Typing is
// left for codex and pi. Codex raises menus whose highlighted row a prompt's
// Enter would pick, so a codex pane showing one refuses the prompt with a
// reason, and the sender keeps its text. Pi has its own trust check
// (turn_routes.go).

// planPane is what the guard reads: the pane.
type planPane interface {
	CapturePane(osUser, session string) (string, error)
	Option(osUser, session, name string) (string, bool)
}

// promptRefusal is why a prompt must not be typed into the session now, or ""
// when it may be.
func promptRefusal(p planPane, osUser, session string) string {
	reason, _ := paneRefusal(p, osUser, session)
	return reason
}

// paneRefusal is promptRefusal plus whether the pane shows Claude's input box,
// which the paste uses to pick how it clears the line.
func paneRefusal(p planPane, osUser, session string) (string, bool) {
	pane, err := p.CapturePane(osUser, session)
	if err != nil {
		return "", false
	}
	if sessionio.CodexMenuOpen(pane) {
		return menuOpenReason, false
	}
	return "", sessionio.ClaudeInputReady(pane)
}

// Refusal reasons, on the wire as {"applied": false, "reason": ...} with a 409.
const (
	// menuOpenReason: codex has a menu up.
	menuOpenReason = "menu-open"
	// trustOpenReason: Claude is asking whether to trust its folder, and loads
	// no mod until someone answers it in the terminal.
	trustOpenReason = "trust-open"
	// dialogOpenReason: something replaced the input line mid-send that the
	// guard does not know.
	dialogOpenReason = "dialog-open"
)

// writePromptRefusal answers 409 with the reason, so the client can keep the
// text and say where to answer.
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
