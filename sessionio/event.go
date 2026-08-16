package sessionio

import "encoding/json"

// Kind is the discriminator for a normalized event. Values are the wire strings
// the web renderer switches on — keep them stable.
type Kind string

const (
	KindSession            Kind = "session"
	KindUser               Kind = "user"
	KindText               Kind = "text"
	KindThinking           Kind = "thinking"
	KindToolUse            Kind = "tool_use"
	KindToolResult         Kind = "tool_result"
	KindResult             Kind = "result"
	KindState              Kind = "state"
	KindMeta               Kind = "meta"
	KindPermissionRequest  Kind = "permission_request"
	KindPermissionResolved Kind = "permission_resolved"
	KindError              Kind = "error"
	KindTurnEnd            Kind = "turn_end"
)

// Meta is the subtype of a KindMeta event — the session's own lifecycle, as
// opposed to what was said in it. These come from transcript records that carry
// no conversation (see Normalizer.meta), so they are the one place the reader
// looks past Conversational().
type Meta string

const (
	MetaMode           Meta = "mode"            // Body = the mode now in force
	MetaPermissionMode Meta = "permission-mode" // Body = the permission mode
	MetaQueued         Meta = "queued"          // Body = the queued prompt text
	MetaCompact        Meta = "compact"         // the context was compacted here
	MetaHookError      Meta = "hook-error"      // Body = what the hook reported
)

// Event is the renderer's contract. Field order is fixed by the struct so the
// wire shape is stable; omitempty keeps optional fields absent.
//
// Additive only: every field present before the 2026-08-16 text-view work keeps
// its name, type and optionality, so a browser holding an older bundle renders
// exactly what it rendered before and simply ignores the rest.
type Event struct {
	ID      int64  `json:"id"`
	Kind    Kind   `json:"kind"`
	Session string `json:"session"`
	TurnID  string `json:"turnId,omitempty"`
	Body    string `json:"body,omitempty"`
	Tool    string `json:"tool,omitempty"`
	ToolID  string `json:"toolId,omitempty"`
	ReqID   string `json:"reqId,omitempty"` // permission_request/resolved correlation id
	IsError bool   `json:"isError,omitempty"`
	At      int64  `json:"at,omitempty"`

	// Result is the transcript's `toolUseResult` for a tool_result event: the
	// structured form of what the tool returned, which is where Bash's
	// stdout/stderr split and Edit's structuredPatch live. Body stays the
	// flattened text so an older client is unaffected.
	Result json.RawMessage `json:"result,omitempty"`
	// Usage is `message.usage` from the assistant message that closed a turn,
	// carried on the turn_end event.
	Usage json.RawMessage `json:"usage,omitempty"`
	// Meta is set only on KindMeta events.
	Meta Meta `json:"meta,omitempty"`
	// Sidechain marks work belonging to a subagent rather than the main thread.
	Sidechain bool `json:"sidechain,omitempty"`
	// Truncated says Body and/or Result were capped for the wire (see
	// MaxInlineResult). The full payload is fetched on demand by ToolID.
	Truncated bool `json:"truncated,omitempty"`
}

// JSON returns the compact wire encoding of the event.
func (e Event) JSON() []byte { b, _ := json.Marshal(e); return b }
