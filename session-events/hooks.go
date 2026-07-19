package main

import (
	"encoding/json"
	"net/http"
)

type permReqBody struct {
	User      string          `json:"user"`
	Session   string          `json:"session"`
	ToolName  string          `json:"tool_name"`
	ToolInput json.RawMessage `json:"tool_input"`
}

// permResolver resolves a (user, session) to the live source's subscriber state
// and event sink. ok=false means no such session is registered (→ fall through
// to the terminal prompt).
type permResolver func(user, session string) (hasSub bool, emit func(Event), ok bool)

// writeHookDecision emits the exact PreToolUse hook output Claude Code reads to
// allow/deny/ask a tool call (verified against the hooks reference).
func writeHookDecision(w http.ResponseWriter, decision string) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"hookSpecificOutput": map[string]string{
			"hookEventName":      "PreToolUse",
			"permissionDecision": decision,
		},
	})
}

// permissionRequestHandler is the localhost endpoint the PreToolUse hook POSTs to.
// It blocks (inside the broker) until a web decision, the deadline, or fall-through,
// then returns the hook decision JSON.
func permissionRequestHandler(b *PermissionBroker, resolve permResolver) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body permReqBody
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		hasSub, emit, ok := resolve(body.User, body.Session)
		if !ok {
			// Unknown session → let the terminal prompt handle it.
			writeHookDecision(w, DecisionAsk)
			return
		}
		d := b.Request(r.Context(), body.Session, body.ToolName, string(body.ToolInput), hasSub, emit)
		writeHookDecision(w, d)
	}
}

type permResolveBody struct {
	Decision string `json:"decision"`
}

// permissionResolveHandler serves POST /permission/{id} from the web client.
func permissionResolveHandler(b *PermissionBroker) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body permResolveBody
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		if body.Decision != DecisionAllow && body.Decision != DecisionDeny {
			http.Error(w, "decision must be allow|deny", http.StatusBadRequest)
			return
		}
		if !b.Resolve(r.PathValue("id"), body.Decision) {
			http.Error(w, "no pending permission", http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
