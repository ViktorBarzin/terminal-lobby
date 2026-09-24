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
	// MetaModel carries the model the session is answering on, and the effort
	// it is answering at, in Event.Model. Emitted only when the pair CHANGES,
	// because every assistant record names it and a marker per turn would say
	// nothing.
	//
	// It reads off the transcript rather than off the pane, unlike the
	// permission mode next door, because a stock Claude pane does not report
	// its model anywhere: the line under the input is whatever statusLine
	// command the account configured, and on this box that is a plugin. The
	// transcript names the model on every assistant record and has since long
	// before this existed.
	MetaModel Meta = "model"
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
	// Bytes is how much text a MetaSkill event stands in for: the length of the
	// SKILL.md body that was collapsed to this one line. On the wire so the card
	// can say what it is hiding — median 3.1 kB across 340 loads, up to 23.3 kB.
	Bytes int64 `json:"bytes,omitempty"`
	// Context is the `/context` reading on a MetaContext event. It carries the
	// headline and the category table only — the record it comes from also
	// holds per-tool, per-agent, per-memory and per-skill tables, which are
	// most of its 14.9 KB and are not what a meter shows.
	Context *ContextReading `json:"context,omitempty"`
	// Model is the model and effort on a MetaModel event (see above).
	Model *ModelState `json:"model,omitempty"`
	// Images names the pictures a prompt or a tool result carried, by
	// position. The bytes are never on the wire: a client asks the image-block
	// routes for the one it scrolls to (see ImageRef).
	Images []ImageRef `json:"images,omitempty"`
	// RecordID is the transcript uuid of the user record a prompt's Images
	// belong to, which is how the route finds them again. Set only beside
	// Images.
	RecordID string `json:"record,omitempty"`
	// Files are the absolute paths of the pictures a screenshot tool wrote,
	// resolved on this side because the link the tool prints is relative to a
	// directory the browser never learns (see shotFiles).
	Files []string `json:"files,omitempty"`
}

// ImageRef is one picture block a user prompt or a tool result carried. The
// bytes stay in the transcript and are read back by N through the image-block
// routes, so a phone opening a session never downloads a picture it does not
// scroll to, and the 8 KiB wire cap never cuts one.
type ImageRef struct {
	// N is the block's index among the record's (or the result's) image
	// blocks, counting from 0 and counting every image block.
	N int `json:"n"`
	// MediaType is what the block declared. Advisory: the route sniffs.
	MediaType string `json:"mediaType,omitempty"`
	// Bytes is the decoded size, read off the base64 length.
	Bytes int64 `json:"bytes,omitempty"`
	// Paste is the terminal paste id the prompt's text calls "[Image #N]".
	Paste int `json:"paste,omitempty"`
}

// JSON returns the compact wire encoding of the event.
func (e Event) JSON() []byte { b, _ := json.Marshal(e); return b }
