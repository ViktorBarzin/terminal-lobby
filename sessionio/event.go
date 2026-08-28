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
	// The CLI reports a prompt LEAVING the queue three different ways, and all
	// three have to be carried or the queue only ever grows. Measured across
	// 141 transcripts: enqueue 1261, remove 841, dequeue 393, popAll 13.
	MetaUnqueued     Meta = "unqueued"      // Body = the prompt that left
	MetaDequeued     Meta = "dequeued"      // the head was taken; no body
	MetaQueueCleared Meta = "queue-cleared" // the whole queue was drained
	MetaSkill        Meta = "skill"         // Body = the skill that was loaded
	MetaCompact      Meta = "compact"       // the context was compacted here
	MetaHookError    Meta = "hook-error"    // Body = what the hook reported
	// MetaContext carries a `/context` reading in Event.Context (see
	// context.go). Like the mode, it is session STATE rather than something
	// said, so the reader shows it in a chip rather than as a row.
	MetaContext Meta = "context"
	// MetaAsking carries a blocking AskUserQuestion read off the PANE, as JSON
	// in Body — or an empty Body when the dialog is gone. Session state like
	// the mode: the newest one wins and it renders as the answer card, never as
	// a row. It exists because the transcript is not always written while the
	// dialog is up (see dialog.go); the transcript's own record still wins
	// whenever it has one.
	MetaAsking Meta = "asking"
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
	// Context is the `/context` reading on a MetaContext event. It carries the
	// headline and the category table only — the record it comes from also
	// holds per-tool, per-agent, per-memory and per-skill tables, which are
	// most of its 14.9 KB and are not what a meter shows.
	Context *ContextReading `json:"context,omitempty"`
}

// JSON returns the compact wire encoding of the event.
func (e Event) JSON() []byte { b, _ := json.Marshal(e); return b }
