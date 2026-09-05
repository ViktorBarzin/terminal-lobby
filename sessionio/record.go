package sessionio

import (
	"encoding/json"
	"strings"
)

// RecordType is the `type` discriminator on a transcript line.
//
// Claude Code writes far more than a conversation into the transcript. Measured
// on this box 2026-08-15 across the 40 most recent transcripts (33,000 records),
// the types present were: assistant, user, attachment, last-prompt, mode,
// permission-mode, ai-title, custom-title, agent-name, system, queue-operation,
// file-history-delta, file-history-snapshot, relocated, worktree-state,
// frame-link. Only the first two carry conversation. Constants are declared for
// the ones a reader is likely to meet in a debugger; the triage that matters is
// Conversational, which whitelists rather than enumerates.
type RecordType string

const (
	RecordAssistant      RecordType = "assistant"
	RecordUser           RecordType = "user"
	RecordSystem         RecordType = "system"
	RecordAttachment     RecordType = "attachment"
	RecordLastPrompt     RecordType = "last-prompt"
	RecordQueueOperation RecordType = "queue-operation"
	RecordMode           RecordType = "mode"
	RecordPermissionMode RecordType = "permission-mode"
)

// Message is the Anthropic message object carried by an assistant or user
// record. It is ALREADY the shape the Agent SDK puts on the wire, which is what
// makes the bridge a key mapping rather than a translation — so Raw keeps the
// original bytes and the named fields are only for the decisions this package
// makes (turn boundaries, block triage).
type Message struct {
	ID         string          `json:"id"`
	Role       string          `json:"role"`
	Model      string          `json:"model"`
	StopReason string          `json:"stop_reason"`
	Content    json.RawMessage `json:"content"`
	Usage      json.RawMessage `json:"usage"`
	// Raw is the message object exactly as it appeared in the transcript.
	Raw json.RawMessage `json:"-"`
}

// UnmarshalJSON decodes the named fields AND keeps the original bytes, in one
// pass. Re-encoding a decoded message would silently drop every key this struct
// does not name — usage, stop_details, service_tier, and whatever the next
// Claude version adds — and those keys are part of what T3 stores.
func (m *Message) UnmarshalJSON(b []byte) error {
	type plain Message // shed the custom unmarshaller, keep the tags
	var p plain
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	*m = Message(p)
	m.Raw = append(json.RawMessage(nil), b...)
	return nil
}

// Record is one decoded transcript line.
type Record struct {
	Type        RecordType `json:"type"`
	IsMeta      bool       `json:"isMeta"`
	IsSidechain bool       `json:"isSidechain"`
	Timestamp   string     `json:"timestamp"` // RFC3339, absent on some types
	UUID        string     `json:"uuid"`
	ParentUUID  string     `json:"parentUuid"`
	CWD         string     `json:"cwd"`
	Message     Message    `json:"message"`

	// SessionID is the "sessionId" spelling, present on every record that
	// carries one. SessionIDAlt is the "session_id" spelling newer Claude Code
	// versions ALSO write. Measured 2026-08-15 over 19,938 assistant/user
	// records: camelCase on all of them, snake_case on 17,759, identical
	// wherever both appeared. Read them through ClaudeID.
	SessionID    string `json:"sessionId"`
	SessionIDAlt string `json:"session_id"`

	// ToolUseResult is the structured result the harness recorded for a tool
	// call, alongside the tool_result block's flattened text. Shapes differ per
	// tool family — Bash {stdout,stderr,interrupted,…}, Edit
	// {filePath,structuredPatch,…}, WebSearch {query,results,…} — so it stays
	// raw here and is classified by the renderer.
	ToolUseResult json.RawMessage `json:"toolUseResult"`

	// The lifecycle fields, each carried by exactly one record type. See
	// Normalizer.meta for what becomes an Event.
	Mode             string          `json:"mode"`             // type "mode"
	PermissionMode   string          `json:"permissionMode"`   // type "permission-mode"
	Operation        string          `json:"operation"`        // type "queue-operation"
	Content          string          `json:"content"`          // the queued prompt's text
	Subtype          string          `json:"subtype"`          // type "system"
	HookErrors       json.RawMessage `json:"hookErrors"`       // type "system"
	IsCompactSummary bool            `json:"isCompactSummary"` // a compaction boundary
	// Effort is the level the turn reasoned at, written on every assistant
	// record alongside message.model. The two together are what a session is
	// running as (see MetaModel).
	Effort string `json:"effort"`

	// Line is the source line, byte for byte. Callers that forward a record
	// onward use this rather than re-encoding.
	Line []byte `json:"-"`
}

// Block is one content block of a message.
type Block struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	Thinking  string          `json:"thinking"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
	IsError   bool            `json:"is_error"`
}

// DecodeRecord parses one transcript line. ok=false means the line was not a
// JSON object at all (a partial write, or something that is not a transcript) —
// the caller drops it. An unknown `type` is NOT a decode failure: it decodes
// fine and Conversational then declines it.
func DecodeRecord(line []byte) (Record, bool) {
	var r Record
	if err := json.Unmarshal(line, &r); err != nil {
		return Record{}, false
	}
	r.Line = line
	return r, true
}

// Conversational reports whether this record carries conversation content that
// belongs in a mirrored thread.
//
// It is a WHITELIST — assistant and user, nothing else — because the drop list
// is open-ended and grows with every Claude Code release. The alternative,
// naming the types to drop, means each newly-invented record type leaks into a
// T3 thread as a malformed message until somebody notices. Note that "user"
// includes the harness feeding Claude back its own tool output: those records
// carry a tool_result block rather than the human's words, and T3 wants them.
func (r Record) Conversational() bool {
	return r.Type == RecordAssistant || r.Type == RecordUser
}

// ClaudeID is the Claude session uuid this record belongs to — the shared
// identity between a lobby Session, its transcript and a T3 Thread.
func (r Record) ClaudeID() string {
	if r.SessionID != "" {
		return r.SessionID
	}
	return r.SessionIDAlt
}

// Role is the message role, falling back to the record type for the older
// lines that omit message.role.
func (r Record) Role() string {
	if r.Message.Role != "" {
		return r.Message.Role
	}
	return string(r.Type)
}

// Blocks decodes the message content, accepting either a plain string (wrapped
// into a single text block) or an array of blocks. It decodes on each call;
// callers in a tail loop should hold the result.
func (r Record) Blocks() []Block {
	var s string
	if json.Unmarshal(r.Message.Content, &s) == nil {
		return []Block{{Type: "text", Text: s}}
	}
	var blocks []Block
	if json.Unmarshal(r.Message.Content, &blocks) == nil {
		return blocks
	}
	return nil
}

// Text is the record's first text block, "" when it has none. It answers "what
// did this message actually say" for the two places that need to match on
// wording: the interrupt notice, and the bridge recognising its own sentinel.
func (r Record) Text() string {
	for _, b := range r.Blocks() {
		if b.Type == "text" {
			return b.Text
		}
	}
	return ""
}

// HasBlock reports whether the content carries a block of any of these types.
func (r Record) HasBlock(types ...string) bool {
	return hasBlock(r.Blocks(), types...)
}

func hasBlock(blocks []Block, types ...string) bool {
	for _, b := range blocks {
		for _, t := range types {
			if b.Type == t {
				return true
			}
		}
	}
	return false
}

// EndsTurn reports whether a message stop_reason means Claude is finished.
// A turn continues only while it is calling a tool or has paused mid-turn;
// anything else (end_turn, stop_sequence, max_tokens, refusal, …) ends it.
// Whitelisting the continuations rather than the terminals keeps an
// unrecognized future stop_reason from wedging a consumer on "still working".
func EndsTurn(stopReason string) bool {
	switch stopReason {
	case "", "tool_use", "pause_turn":
		return false
	}
	return true
}

// interruptMarker opens the notice Claude appends when the operator presses ESC
// or the composer's Stop: "[Request interrupted by user]" and
// "[Request interrupted by user for tool use]".
const interruptMarker = "[Request interrupted by user"

// InterruptNotice reports the interrupt notice carried by a record, and its text.
//
// Claude writes it as a user-ROLE text line with no isMeta key, so the ordinary
// "the human spoke" test claims it: the notice renders as the operator's own
// words, and it opens a turn that never closes — the response it interrupted
// stopped at stop_reason "tool_use", which EndsTurn treats as a continuation,
// so nothing settles either turn and the reader shows "working" forever.
func InterruptNotice(r Record) (string, bool) {
	return interruptNotice(r.Role(), r.IsMeta, r.Blocks())
}

func interruptNotice(role string, isMeta bool, blocks []Block) (string, bool) {
	if role != "user" || isMeta {
		return "", false
	}
	for _, b := range blocks {
		if b.Type != "text" {
			continue
		}
		if text := strings.TrimSpace(b.Text); strings.HasPrefix(text, interruptMarker) {
			return text, true
		}
	}
	return "", false
}
