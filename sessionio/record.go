package sessionio

import (
	"bytes"
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
	// wherever both appeared. They can differ, though: the conversation the
	// plan approval's clear context starts writes sessionId as the NEW
	// conversation and session_id as the one it came from (CLI 2.1.281,
	// measured 2026-09-24). sessionId is the file's own conversation, which is
	// why ClaudeID reads it first. Read them through ClaudeID.
	SessionID    string `json:"sessionId"`
	SessionIDAlt string `json:"session_id"`

	// PlanContent and Origin mark the first user record of a conversation the
	// plan approval started by clearing the context: the approved plan, and
	// {kind: "auto-continuation"} (CLI 2.1.281, measured 2026-09-24). A typed
	// prompt carries {kind: "human"} and a background task's notice
	// {kind: "task-notification"}. Origin stays raw so a shape the CLI has not
	// used yet cannot make the whole line undecodable; read it through
	// OriginKind.
	PlanContent string          `json:"planContent"`
	Origin      json.RawMessage `json:"origin"`

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
	// ImagePasteIDs are the numbers of the pictures pasted into the terminal
	// for this prompt, one per image block, the N its text calls "[Image #N]".
	// Both terminal pastes in the 2026-09-24 census carried [1] beside one block.
	ImagePasteIDs pasteIDs `json:"imagePasteIds"`
	// IsAPIErrorMessage marks the assistant record Claude Code writes in place
	// of a reply when the API call failed: model "<synthetic>", stop_reason
	// "stop_sequence", and the error as its text. It is not always the end: the
	// harness can retry past it and the conversation goes on.
	IsAPIErrorMessage bool `json:"isApiErrorMessage"`
	// ToolEndsTurn marks a tool result that ends the turn by itself. A workflow
	// member returning its answer through StructuredOutput finishes on this
	// record and never writes an end_turn one.
	ToolEndsTurn bool `json:"toolEndsTurn"`
	// AgentID names the subagent a sidechain record belongs to. Every record
	// in an agent-<id>.jsonl carries it, so two agents' interleaved work can
	// be told apart.
	AgentID string `json:"agentId"`

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
	// Source is an image block's picture, nil on every other block.
	Source *ImageSource `json:"source"`
}

// ImageSource is the `source` of an image block: what the picture declares
// itself to be and how big it is, without the picture.
//
// The bytes stay in the transcript. A block runs to 645k base64 characters
// (p50 140k over the 134 Reads of an image in the 2026-09-24 census) and a
// Read line carries a second copy in toolUseResult, so decoding the data into a
// string would put megabytes on the tail for every session with a picture in
// it, for a field nothing on the wire carries. The image-block routes read the
// bytes back by position when a browser asks (see ScanImageBlock).
type ImageSource struct {
	Type      string  `json:"type"` // "base64" in every census block
	MediaType string  `json:"media_type"`
	Size      b64Size `json:"data"`
}

// UnmarshalJSON decodes an image source and accepts any other shape as an empty
// one. Block types other than image use the same key differently (the API's
// search_result names its URL as a string), and encoding/json reports one
// mistyped field as an error for the WHOLE content array, which Blocks() then
// answers with nothing: one odd block would erase every block of its record.
func (s *ImageSource) UnmarshalJSON(b []byte) error {
	type plain ImageSource // shed this method, keep the tags
	var p plain
	if json.Unmarshal(b, &p) != nil {
		*s = ImageSource{}
		return nil
	}
	*s = ImageSource(p)
	return nil
}

// pasteIDs is a record's imagePasteIds, read leniently. DecodeRecord drops a
// line whose fields do not match their types, so a list in some future shape
// (strings, objects) must cost the paste numbers and not the prompt they sit
// beside: anything but an array of integers reads as no list at all.
type pasteIDs []int

// UnmarshalJSON implements the leniency described on the type.
func (p *pasteIDs) UnmarshalJSON(b []byte) error {
	var ids []int
	if json.Unmarshal(b, &ids) != nil {
		ids = nil
	}
	*p = ids
	return nil
}

// b64Size is the decoded size of a base64 string, read off the JSON token
// without holding the string.
type b64Size int64

// UnmarshalJSON sizes the token in place. With n the characters between the
// quotes and pad the trailing '=' (at most two), the decoded size is
// (n-pad)*3/4. A token carrying a backslash is unescaped first, because JSON
// may spell '/' as '\/' and the count is of decoded characters; the encoder
// Claude Code uses does not escape any base64 character, so that path is for
// correctness rather than speed. Anything that is not a string sizes to 0
// rather than failing the record: a picture of unknown size still renders.
func (s *b64Size) UnmarshalJSON(b []byte) error {
	*s = 0
	if len(b) < 2 || b[0] != '"' || b[len(b)-1] != '"' {
		return nil
	}
	body := b[1 : len(b)-1]
	if bytes.IndexByte(body, '\\') >= 0 {
		var str string
		if json.Unmarshal(b, &str) != nil {
			return nil
		}
		body = []byte(str)
	}
	n := len(body)
	pad := 0
	for pad < 2 && n-pad > 0 && body[n-1-pad] == '=' {
		pad++
	}
	*s = b64Size((n - pad) * 3 / 4)
	return nil
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

// OriginKind is the record's origin.kind, or "" when it has none or carries
// it in another shape.
func (r Record) OriginKind() string {
	var o struct {
		Kind string `json:"kind"`
	}
	if len(r.Origin) == 0 || json.Unmarshal(r.Origin, &o) != nil {
		return ""
	}
	return o.Kind
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
