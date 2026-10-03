package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"

	"terminal-lobby/telemetry"
)

// Steering: a message the person types to a subagent from the Text view while
// that agent is open in the drill-in. The mod hands it to the engine, which
// queues it in the agent's inbox: a running subagent takes it at its next tool
// boundary, an idle teammate when it next runs (measured on CLI 2.1.288,
// 2026-10-03). Finished agents are read-only; the mod refuses them.
//
// The route sits beside the drill-in's own, under /events/, because the
// ingress routes by that prefix (drill.go).

// maxSteerText bounds a message, as a prompt is bounded.
const maxSteerText = 64 << 10

// steerRefusals are the reasons the mod gives that are the agent's state, not
// a failure: the composer shows them and stops offering to send.
var steerRefusals = []string{"finished", "not-addressable"}

func (rg *registry) handleSteer() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		osUser, session, agent := osUserFrom(r.Context()), r.PathValue("session"), r.PathValue("agent")
		var body struct {
			Text string `json:"text"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxSteerText+1024)
		if json.NewDecoder(r.Body).Decode(&body) != nil || strings.TrimSpace(body.Text) == "" || len(body.Text) > maxSteerText {
			http.Error(w, "bad body (need text)", http.StatusBadRequest)
			return
		}
		c := rg.mods.conn(osUser, session)
		if c == nil {
			http.Error(w, "this session's Claude has not connected to the lobby", http.StatusServiceUnavailable)
			return
		}
		c.mu.Lock()
		can := slices.Contains(c.ops, "steer")
		c.mu.Unlock()
		if !can {
			http.Error(w, "this session's Claude started before agents could be messaged; restart it to message its agents", http.StatusNotImplemented)
			return
		}
		if _, _, _, err := rg.agentTranscript(osUser, session, agent); err != nil {
			drillError(w, err)
			return
		}
		ack, err := c.send(r.Context(), modCommand{Op: "steer", AgentID: agent, Text: body.Text})
		result := "sent"
		defer func() {
			events.Emit("agents.steer_sent", osUser, telemetry.Attrs{
				"tl.session": session, "tl.count": len(body.Text), "tl.result": result,
			})
		}()
		if err != nil {
			// A command in hand goes out again to the next hello, so it may yet
			// be delivered: the text is not handed back to send twice.
			result = "unconfirmed"
			if errors.Is(err, errModGone) {
				result = "gone"
			}
			http.Error(w, "the session's Claude did not confirm the message; it may still reach the agent", http.StatusGatewayTimeout)
			return
		}
		if !ack.OK {
			kind, reason, _ := strings.Cut(ack.Error, ": ")
			if slices.Contains(steerRefusals, kind) {
				result = kind
				http.Error(w, reason, http.StatusConflict)
				return
			}
			result = "refused"
			http.Error(w, "the session's Claude refused the message: "+ack.Error, http.StatusBadGateway)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
