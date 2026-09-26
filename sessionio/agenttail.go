package sessionio

import (
	"bytes"
	"encoding/json"
	"regexp"
	"slices"
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

	// The agent's own background work (see foldTasks). calls holds each tool
	// call until its result lands, so a result that starts a task can name the
	// call that started it; tasks is what is still outstanding, oldest first;
	// finished holds ids whose notice was read before the result that started
	// them. waiting is set when a turn ended with work outstanding, and
	// cleared by the next assistant record.
	calls    map[string]agentCall
	tasks    []agentTask
	finished map[string]bool
	waiting  bool
}

// agentCall is a tool call as the panel names it: the tool and its detail.
type agentCall struct{ tool, detail string }

// agentTask is one piece of background work the agent started, by the id its
// notification will carry.
type agentTask struct {
	id   string
	call agentCall
}

// NewAgentTail follows the agent transcript at path through r, from its start.
func NewAgentTail(path string, r Reader) *AgentTail {
	if r == nil {
		r = LocalReader{}
	}
	return &AgentTail{
		path: path, reader: r, state: AgentRunning, msgTokens: map[string]int64{},
		calls: map[string]agentCall{}, finished: map[string]bool{},
	}
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
	t.waiting = false
	for _, b := range rec.Blocks() {
		switch b.Type {
		case "tool_use":
			t.toolCalls++
			t.tool, t.detail = b.Name, toolDetail(b.Name, b.Input)
			if b.ID != "" {
				t.calls[b.ID] = agentCall{t.tool, t.detail}
			}
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
		t.stop(at, strings.Join(t.text, " "))
	default:
		t.reopen()
	}
}

// stop is the agent ending its turn. That is the end of the agent only when
// nothing it started in the background is outstanding. An agent whose Bash
// went to the background, that armed a Monitor, or that launched an Agent with
// run_in_background ends its turn to wait, and the task's notification wakes
// it; Claude Code's own bar calls it finished at each of those pauses. While
// it waits it stays running, with no end or result, and its current tool is
// the newest call it is waiting on.
func (t *AgentTail) stop(at int64, text string) {
	if len(t.tasks) == 0 {
		t.end(AgentDone, at, text)
		return
	}
	t.reopen()
	t.waiting = true
	t.showWaitingOn()
}

// showWaitingOn makes a waiting agent's current tool the newest call it is
// waiting on, rather than whatever it ran in the foreground last.
func (t *AgentTail) showWaitingOn() {
	if !t.waiting || len(t.tasks) == 0 {
		return
	}
	c := t.tasks[len(t.tasks)-1].call
	t.tool, t.detail = c.tool, c.detail
}

func (t *AgentTail) user(rec Record, at int64) {
	blocks := rec.Blocks()
	t.foldTasks(blocks)
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
	if !bytes.Contains(rec.Line, []byte(`"structured_output"`)) && !bytes.Contains(rec.Line, []byte(`"queued_command"`)) {
		return // most attachments; skip the second decode
	}
	var a struct {
		Attachment struct {
			Type string          `json:"type"`
			Data json.RawMessage `json:"data"`
			// Prompt is a queued_command's text: how a task's notification
			// reaches an agent that is busy when it arrives.
			Prompt string `json:"prompt"`
		} `json:"attachment"`
	}
	if json.Unmarshal(rec.Line, &a) != nil {
		return
	}
	if a.Attachment.Type == "queued_command" {
		t.foldNotices(a.Attachment.Prompt)
		return
	}
	if a.Attachment.Type != "structured_output" {
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

// taskStarts match the start of a tool result that hands work to the
// background, capturing the task id its notification will name. The wordings
// are Claude Code's own, each seen in transcripts on this box (2.1.281 to
// 2.1.283):
//
//   - Bash with run_in_background: "Command running in background with ID: <id>."
//   - Bash the harness moved there, at its timeout or so a message can reach
//     the agent: "Command ... was moved to the background (ID: <id>)"
//   - Bash the user backgrounded: "Command was manually backgrounded by user with ID: <id>."
//   - Monitor: "Monitor started (task <id>, timeout ...)"
//   - Agent with run_in_background: "Async agent launched successfully. ... agentId: <id>"
//
// Anchored at the start, because an Agent that ran in the foreground also
// reports an "agentId:", and nothing will ever notify for it.
var taskStarts = []*regexp.Regexp{
	regexp.MustCompile(`^Command (?:running in background with ID: |was manually backgrounded by user with ID: |.*?moved to the background \(ID: )([A-Za-z0-9_-]+)`),
	regexp.MustCompile(`^Monitor started \(task ([A-Za-z0-9_-]+)`),
	regexp.MustCompile(`^Async agent launched successfully\.[\s\S]*?agentId: ([A-Za-z0-9_-]+)`),
}

// foldTasks reads a user record for background work starting (a tool result
// in one of taskStarts' wordings) or reporting back (a task notification,
// which is how a waiting agent is woken).
func (t *AgentTail) foldTasks(blocks []Block) {
	for _, b := range blocks {
		switch b.Type {
		case "tool_result":
			call, ok := t.calls[b.ToolUseID]
			delete(t.calls, b.ToolUseID)
			if !ok {
				continue
			}
			if id := taskStarted(strings.TrimSpace(decodeToolResult(b.Content))); id != "" && !t.finished[id] {
				t.tasks = append(t.tasks, agentTask{id: id, call: call})
			}
		case "text":
			// The record's own text only: a tool result that reads a file of
			// notifications back is not one.
			t.foldNotices(b.Text)
		}
	}
}

func taskStarted(text string) string {
	for _, re := range taskStarts {
		if m := re.FindStringSubmatch(text); m != nil {
			return m[1]
		}
	}
	return ""
}

// foldNotices retires each task that a <task-notification> in text reports
// finished. A notification reaches a waiting agent as a user record and a busy
// one as a queued_command attachment, and either can carry several.
func (t *AgentTail) foldNotices(text string) {
	for rest := text; ; {
		i := strings.Index(rest, "<task-notification>")
		if i < 0 {
			return
		}
		rest = rest[i+len("<task-notification>"):]
		body := rest
		if j := strings.Index(rest, "</task-notification>"); j >= 0 {
			body, rest = rest[:j], rest[j:]
		}
		id := strings.TrimSpace(element(body, "task-id"))
		if id == "" || !taskFinished(strings.TrimSpace(element(body, "status")), body) {
			continue
		}
		t.finished[id] = true
		t.tasks = slices.DeleteFunc(t.tasks, func(task agentTask) bool { return task.id == id })
		t.showWaitingOn()
	}
}

// taskFinished reads a notification's status. "completed", "failed",
// "killed", "stopped" and "expired" (a Monitor at its deadline) are ends;
// "running", "blocked", "pending" and no status at all are not. A background
// agent notifies "completed" each time it stops, including when it has only
// paused to wait on work of its own, and that notice says so.
func taskFinished(status, body string) bool {
	switch status {
	case "completed":
		return !strings.Contains(body, "background work of its own still running")
	case "failed", "killed", "stopped", "expired":
		return true
	}
	return false
}

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
