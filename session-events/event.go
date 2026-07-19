package main

import "encoding/json"

// Kind is the discriminator for a normalized event. Values are the wire strings
// the web renderer switches on — keep them stable.
type Kind string

const (
	KindSession            Kind = "session"
	KindUser               Kind = "user"
	KindText               Kind = "text"
	KindToolUse            Kind = "tool_use"
	KindToolResult         Kind = "tool_result"
	KindResult             Kind = "result"
	KindState              Kind = "state"
	KindPermissionRequest  Kind = "permission_request"
	KindPermissionResolved Kind = "permission_resolved"
	KindError              Kind = "error"
	KindTurnEnd            Kind = "turn_end"
)

// Event is the renderer's contract. Field order is fixed by the struct so the
// wire shape is stable; omitempty keeps optional fields absent.
type Event struct {
	ID      int64  `json:"id"`
	Kind    Kind   `json:"kind"`
	Session string `json:"session"`
	TurnID  string `json:"turnId,omitempty"`
	Body    string `json:"body,omitempty"`
	Tool    string `json:"tool,omitempty"`
	ToolID  string `json:"toolId,omitempty"`
	IsError bool   `json:"isError,omitempty"`
	At      int64  `json:"at,omitempty"`
}

// JSON returns the compact wire encoding of the event.
func (e Event) JSON() []byte { b, _ := json.Marshal(e); return b }
