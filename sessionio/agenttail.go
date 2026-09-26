package sessionio

import (
	"bytes"
	"encoding/json"
	"strings"
)

// agentResultMax is how much of an ended agent's final answer or error the
// panel carries, in runes.
const agentResultMax = 200

// syntheticModel is what Claude Code writes as the model of a record it made up
// itself, such as an API error. It names no model.
const syntheticModel = "<synthetic>"

// AgentTail follows one agent transcript, agent-<id>.jsonl, and keeps what it
// says about the agent right now: the live half of an AgentInfo, beside the
// identity its sidecar gives (see AgentMeta).
//
// Reads go through a Reader and resume by byte offset, so another user's
// agents are read the way their session transcript is. A line still being
// written is left for the next Poll, because ReadFrom only ever returns
// complete ones.
//
// Nothing here judges liveness. An agent is running until its own transcript
// says it ended, however long it has been quiet; the panel shows the quiet
// instead of guessing at it.
//
// An AgentTail is NOT safe for concurrent use.
type AgentTail struct {
	path   string
	reader Reader
	off    int64

	state     AgentState
	model     string
	startedAt int64
	lastAt    int64
	endedAt   int64
	tool      string
	detail    string
	toolCalls int
	result    string
	spawned   []string // the Agent tool_use ids this agent emitted, in order

	// Output tokens, summed over messages. A message is written one record per
	// content block, and its non-final records carry a placeholder count
	// (measured 8, 8, then 805 for one message), so only the last record of
	// each message counts.
	tokens    int64
	msgTokens map[string]int64

	// The text blocks of the assistant message being written, for the final
	// answer. A tool result can land between two blocks of one message, so
	// this is keyed on the message id rather than on adjacency.
	textMsg string
	text    []string
}

// NewAgentTail follows the agent transcript at path through r, from its start.
func NewAgentTail(path string, r Reader) *AgentTail {
	if r == nil {
		r = LocalReader{}
	}
	return &AgentTail{path: path, reader: r, state: AgentRunning, msgTokens: map[string]int64{}}
}

// Path is the transcript being followed.
func (t *AgentTail) Path() string { return t.path }

// Offset is the byte position just past the last complete line read.
func (t *AgentTail) Offset() int64 { return t.off }

// Poll reads whatever was appended since the last call and folds it in.
// changed reports whether any complete line arrived. An error means the file
// could not be read, most often because it does not exist yet: the sidecar is
// written about two seconds before the first record.
func (t *AgentTail) Poll() (changed bool, err error) {
	lines, next, err := t.reader.ReadFrom(t.path, t.off)
	if err != nil {
		return false, err
	}
	changed, t.off = next != t.off, next
	for _, ln := range lines {
		if rec, ok := DecodeRecord([]byte(ln)); ok {
			t.record(rec)
		}
	}
	return changed, nil
}

// Spawned is the ids of the Agent tool_use blocks this agent emitted, in the
// order it emitted them. A nested agent's sidecar names one of them as its
// ToolUseID, which is how its parent is found when the sidecar does not name
// the parent outright.
func (t *AgentTail) Spawned() []string { return append([]string(nil), t.spawned...) }

// Info is the agent as the panel shows it: identity from meta, live state from
// the transcript read so far. The workflow a member belongs to is read off its
// path; its label and phase come from the run file, which this does not read.
func (t *AgentTail) Info(meta AgentMeta) AgentInfo {
	id, _ := AgentFileID(t.path)
	info := AgentInfo{
		ID:          id,
		Description: meta.Description,
		Name:        meta.Name,
		AgentType:   meta.AgentType,
		Model:       firstOf(meta.Model, t.model),
		Color:       meta.Color,
		Depth:       meta.SpawnDepth,
		ParentID:    meta.ParentAgentID,
		ToolUseID:   meta.ToolUseID,
		WorkflowID:  workflowOf(t.path),
		State:       t.state,

		StartedAt:      t.startedAt,
		LastActivityAt: t.lastAt,
		EndedAt:        t.endedAt,

		Tool:         t.tool,
		ToolDetail:   t.detail,
		ToolCalls:    t.toolCalls,
		OutputTokens: t.tokens,
		Result:       t.result,
	}
	// Before the first record the sidecar is all there is: the agent was
	// spawned when it was written, and has done nothing since.
	if info.StartedAt == 0 {
		info.StartedAt = meta.WrittenAt
	}
	if info.LastActivityAt == 0 {
		info.LastActivityAt = info.StartedAt
	}
	// A stop is written into the sidecar, not the transcript, so an agent
	// stopped mid-tool-call would otherwise read as running for good.
	if meta.StoppedByUser && info.State == AgentRunning {
		info.State, info.Result = AgentFailed, "Stopped by user"
		info.EndedAt = max(meta.WrittenAt, info.LastActivityAt)
	}
	return info
}

func (t *AgentTail) record(rec Record) {
	at := parseAt(rec.Timestamp)
	if at > 0 {
		if t.startedAt == 0 {
			t.startedAt = at
		}
		t.lastAt = max(t.lastAt, at)
	} else {
		at = t.lastAt
	}
	switch rec.Type {
	case RecordAssistant:
		t.assistant(rec, at)
	case RecordUser:
		t.user(rec, at)
	case RecordAttachment:
		t.attachment(rec, at)
	}
}

func (t *AgentTail) assistant(rec Record, at int64) {
	msg := rec.Message
	if msg.Model != "" && msg.Model != syntheticModel {
		t.model = msg.Model
	}
	out := outputTokens(msg.Usage)
	if msg.ID == "" {
		t.tokens += out
	} else {
		t.tokens += out - t.msgTokens[msg.ID]
		t.msgTokens[msg.ID] = out
	}
	if msg.ID != t.textMsg {
		t.textMsg, t.text = msg.ID, nil
	}
	for _, b := range rec.Blocks() {
		switch b.Type {
		case "tool_use":
			t.toolCalls++
			t.tool, t.detail = b.Name, toolDetail(b.Name, b.Input)
			if b.Name == "Agent" || b.Name == "Task" {
				t.spawned = append(t.spawned, b.ID)
			}
		case "text":
			t.text = append(t.text, b.Text)
		}
	}
	switch {
	case rec.IsAPIErrorMessage:
		t.end(AgentFailed, at, strings.Join(t.text, " "))
	case EndsTurn(msg.StopReason):
		t.end(AgentDone, at, strings.Join(t.text, " "))
	default:
		t.reopen()
	}
}

func (t *AgentTail) user(rec Record, at int64) {
	blocks := rec.Blocks()
	if notice, ok := interruptNotice(rec.Role(), rec.IsMeta, blocks); ok {
		t.end(AgentFailed, at, notice)
		return
	}
	if rec.ToolEndsTurn {
		if !t.ended() {
			t.end(AgentDone, at, firstToolResult(blocks))
		}
		return
	}
	// A tool result is the harness answering a call, and one lands after
	// StructuredOutput has already ended the agent. Anything else is new
	// work: a teammate given another message runs again.
	for _, b := range blocks {
		if b.Type != "tool_result" {
			t.reopen()
			return
		}
	}
}

// attachment picks out the one attachment that ends an agent: the answer a
// workflow member returns through StructuredOutput. Measured on this box,
// those members write no end_turn record at all. Every other attachment,
// including the hook records that trail an agent's last answer, is bookkeeping.
func (t *AgentTail) attachment(rec Record, at int64) {
	if !bytes.Contains(rec.Line, []byte(`"structured_output"`)) {
		return // most attachments; skip the second decode
	}
	var a struct {
		Attachment struct {
			Type string          `json:"type"`
			Data json.RawMessage `json:"data"`
		} `json:"attachment"`
	}
	if json.Unmarshal(rec.Line, &a) != nil || a.Attachment.Type != "structured_output" {
		return
	}
	var compact bytes.Buffer
	if json.Compact(&compact, a.Attachment.Data) != nil {
		compact.Reset()
		compact.Write(a.Attachment.Data)
	}
	t.end(AgentDone, at, compact.String())
}

func (t *AgentTail) end(s AgentState, at int64, text string) {
	t.state, t.endedAt, t.result = s, at, clipRight(oneLine(text), agentResultMax)
}

func (t *AgentTail) reopen() { t.state, t.endedAt, t.result = AgentRunning, 0, "" }

func (t *AgentTail) ended() bool { return t.state == AgentDone || t.state == AgentFailed }

func outputTokens(usage json.RawMessage) int64 {
	var u struct {
		OutputTokens int64 `json:"output_tokens"`
	}
	_ = json.Unmarshal(usage, &u)
	return u.OutputTokens
}

func firstToolResult(blocks []Block) string {
	for _, b := range blocks {
		if b.Type == "tool_result" {
			return decodeToolResult(b.Content)
		}
	}
	return ""
}
