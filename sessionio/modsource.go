package sessionio

import (
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// A session fed by the lobby's Claude Code mod (ADR-0036).
//
// The mod runs inside the Claude process and forwards what happens there as
// events: every row Claude stores (session.append), the structured result of
// every tool call, the turn boundaries, and the text Claude is streaming. A mod
// source is a FileSource whose log is fed by those events instead of by a tail
// of the transcript file. Everything downstream — the SSE stream, backfill,
// search, the session state frame — reads the same log it always did.
//
// The rows are the transcript's own records minus the bookkeeping the engine
// keeps beside them, so they are decoded into Records and handed to the same
// Normalizer, which is where every rendering rule for what Claude writes
// lives. Three things differ from a tail, and each is supplied here instead:
//
//   - A row carries no stop_reason, so the Normalizer never ends a turn on its
//     own. The mod's turn_end does, exactly once (Normalizer.EndTurn).
//   - A row carries no structured tool result. The mod sends it as a result
//     event just before the row, and it is attached as the record's
//     ToolUseResult.
//   - A row carries no timestamp. The mod stamps each event with the time it
//     saw it.

// The mod's event types (ADR-0036, "Wire protocol").
const (
	ModHistoryEvent    = "history"
	ModRowEvent        = "row"
	ModResultEvent     = "result"
	ModTurnStartEvent  = "turn_start"
	ModDeltaEvent      = "delta"
	ModTurnEndEvent    = "turn_end"
	ModPromptEvent     = "prompt"
	ModAskEvent        = "ask"
	ModPlanEvent       = "plan"
	ModPermissionEvent = "permission"
	ModSettledEvent    = "settled"
	ModModelEvent      = "model"
	ModAgentsEvent     = "agents"
	ModAckEvent        = "ack"
	ModByeEvent        = "bye"
)

// ModEvent is one event the mod posts. One struct for every type, because the
// fields overlap and the type says which are set.
type ModEvent struct {
	Type string `json:"type"`
	T    int64  `json:"t"`

	// row
	UUID    string          `json:"uuid,omitempty"`
	Door    string          `json:"door,omitempty"`
	Origin  json.RawMessage `json:"origin,omitempty"`
	Message *ModMessage     `json:"message,omitempty"`
	AgentID string          `json:"agentId,omitempty"`

	// result, ask, plan, permission, settled
	ToolID  string          `json:"toolId,omitempty"`
	Tool    string          `json:"tool,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	IsError bool            `json:"isError,omitempty"`
	// Text is the result's flattened text, a delta's new words, or a
	// prompt's text.
	Text string `json:"text,omitempty"`

	// turn_start, delta, turn_end
	TurnID     string          `json:"turnId,omitempty"`
	Aborted    bool            `json:"aborted,omitempty"`
	Answer     string          `json:"answer,omitempty"`
	Usage      json.RawMessage `json:"usage,omitempty"`
	DurationMs int64           `json:"durationMs,omitempty"`
	Index      int             `json:"index,omitempty"`
	Kind       string          `json:"kind,omitempty"`

	// ask, plan, permission
	Questions    json.RawMessage `json:"questions,omitempty"`
	Plan         string          `json:"plan,omitempty"`
	PlanFilePath string          `json:"planFilePath,omitempty"`
	Input        json.RawMessage `json:"input,omitempty"`
	Reason       string          `json:"reason,omitempty"`
	By           string          `json:"by,omitempty"`

	// model
	Model  string `json:"model,omitempty"`
	Effort string `json:"effort,omitempty"`

	// agents
	Agents []ModAgent `json:"agents,omitempty"`

	// history
	Messages []ModHistoryMessage `json:"messages,omitempty"`
	Running  bool                `json:"running,omitempty"`

	// ack
	ID    string `json:"id,omitempty"`
	OK    bool   `json:"ok,omitempty"`
	Error string `json:"error,omitempty"`
}

// ModMessage is a stored row's message: how the transcript files it and its
// content blocks.
type ModMessage struct {
	Type    string          `json:"type"`
	Name    string          `json:"name,omitempty"`
	Role    string          `json:"role,omitempty"`
	IsMeta  bool            `json:"isMeta,omitempty"`
	Content json.RawMessage `json:"content"`
}

// ModAgent is one entry of $.agent.list().
type ModAgent struct {
	ID          string `json:"id"`
	Type        string `json:"type"`
	Status      string `json:"status"`
	Name        string `json:"name,omitempty"`
	Description string `json:"description,omitempty"`
}

// ModHistoryMessage is one message as $.session.messages() returns it.
type ModHistoryMessage struct {
	Role        string          `json:"role"`
	Text        string          `json:"text"`
	ToolUses    []ModToolUse    `json:"toolUses,omitempty"`
	ToolResults json.RawMessage `json:"toolResults,omitempty"`
}

// ModToolUse is a tool call in a history message, with its outcome once Claude
// holds one.
type ModToolUse struct {
	ToolUseID string          `json:"tool_use_id"`
	Tool      string          `json:"tool"`
	Input     json.RawMessage `json:"input,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
	Text      string          `json:"text,omitempty"`
	IsError   bool            `json:"isError,omitempty"`
}

// modResult is a tool result waiting for its row.
type modResult struct {
	result json.RawMessage
}

// modFullBudget bounds the full tool results a mod source keeps for "show full
// output". A tail re-read the transcript for that click; a mod source has the
// payload already, and keeping the newest few megabytes covers the results a
// reader is likely to expand without holding a whole session's worth.
const modFullBudget = 16 << 20

// modState is what a mod source keeps beyond the Normalizer's own state.
type modState struct {
	pending map[string]modResult // results whose row has not arrived
	full    map[string]string    // full result text, for FullResult
	order   []string             // insertion order of full, oldest first
	size    int
	queued  []string // prompts typed while a turn ran, oldest first
	model   ModelState
	// rows are the uuids already in the log. A mod re-sends a batch after a
	// failed request and history after a fresh hello, so a row can arrive
	// twice.
	rows map[string]bool
	// opened is the text of the prompt row that opened the current turn. A
	// prompt the mod submitted itself is reported when its turn starts, after
	// its row, and must not then read as one waiting behind that same turn.
	opened string
}

// NewModSource builds a source fed by the mod. transcript is the file Claude
// is writing, used only to read back a picture by its row id; r reaches it
// (nil reads it directly).
func NewModSource(session, transcript string, r Reader) *FileSource {
	f := NewFileSourceWith(session, transcript, time.Second, r)
	// Every id this log assigns is its own: nothing replays a mod stream.
	f.diverged = true
	f.mod = &modState{pending: map[string]modResult{}, full: map[string]string{}, rows: map[string]bool{}}
	return f
}

// TurnOpen reports whether the main thread's current turn is still running.
func (f *FileSource) TurnOpen() bool {
	f.normMu.Lock()
	defer f.normMu.Unlock()
	return f.norm.turnID != "" && !f.norm.turnDone
}

// TurnID is the wire id of the current turn ("t7"), "" before the first.
func (f *FileSource) TurnID() string {
	f.normMu.Lock()
	defer f.normMu.Unlock()
	return f.norm.turnID
}

// Feed applies one mod event to the log. Events that are not conversation
// (dialogs, acks, agents) are the caller's and are ignored here.
func (f *FileSource) Feed(ev ModEvent) {
	if f.mod == nil {
		return
	}
	switch ev.Type {
	case ModRowEvent:
		f.feedRow(ev)
	case ModResultEvent:
		f.feedResult(ev)
	case ModDeltaEvent:
		f.feedDelta(ev)
	case ModTurnEndEvent:
		if ev.AgentID != "" {
			return // a subagent's loop ending says nothing about the main turn
		}
		f.normMu.Lock()
		e, ok := f.norm.EndTurn(ev.T, ev.Usage)
		f.normMu.Unlock()
		if ok {
			f.appendLive(e)
		}
	case ModPromptEvent:
		f.feedPrompt(ev)
	case ModModelEvent:
		f.feedModel(ev)
	}
}

func (f *FileSource) feedRow(ev ModEvent) {
	if ev.Message == nil {
		return
	}
	if ev.UUID != "" {
		f.mu.Lock()
		seen := f.mod.rows[ev.UUID]
		f.mod.rows[ev.UUID] = true
		f.mu.Unlock()
		if seen {
			return
		}
	}
	rec := Record{
		Type:        RecordType(ev.Message.Type),
		IsMeta:      ev.Message.IsMeta,
		IsSidechain: ev.AgentID != "",
		AgentID:     ev.AgentID,
		UUID:        ev.UUID,
		Timestamp:   rfc3339(ev.T),
		Origin:      ev.Origin,
		Message:     Message{Role: ev.Message.Role, Content: ev.Message.Content},
	}
	blocks := rec.Blocks()
	// A tool result row: attach the structured result the mod sent ahead of it.
	for _, bl := range blocks {
		if bl.Type == "tool_result" && bl.ToolUseID != "" {
			f.mu.Lock()
			if p, ok := f.mod.pending[bl.ToolUseID]; ok {
				rec.ToolUseResult = p.result
				delete(f.mod.pending, bl.ToolUseID)
			}
			f.mu.Unlock()
			break
		}
	}
	var lead []Event
	// A prompt that waited behind a turn arrives as a prompt row: it leaves the
	// queue as it opens its own turn.
	if ev.Door == "prompt" && rec.Role() == "user" && ev.AgentID == "" {
		text := strings.TrimSpace(rec.Text())
		f.mu.Lock()
		f.mod.opened = text
		for i, q := range f.mod.queued {
			if q == text {
				f.mod.queued = append(f.mod.queued[:i], f.mod.queued[i+1:]...)
				lead = append(lead, Event{Kind: KindMeta, Meta: MetaUnqueued, Body: q, At: ev.T})
				break
			}
		}
		f.mu.Unlock()
	}
	f.normMu.Lock()
	for i := range lead {
		lead[i].TurnID = f.norm.turnID
	}
	evs := f.norm.Record(rec)
	f.normMu.Unlock()
	for _, e := range append(lead, evs...) {
		f.appendLive(e)
	}
}

func (f *FileSource) feedResult(ev ModEvent) {
	if ev.ToolID == "" {
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(ev.Result) > 0 && string(ev.Result) != "null" {
		f.mod.pending[ev.ToolID] = modResult{result: ev.Result}
	}
	if ev.Text == "" {
		return
	}
	if _, ok := f.mod.full[ev.ToolID]; !ok {
		f.mod.order = append(f.mod.order, ev.ToolID)
	} else {
		f.mod.size -= len(f.mod.full[ev.ToolID])
	}
	f.mod.full[ev.ToolID] = ev.Text
	f.mod.size += len(ev.Text)
	for f.mod.size > modFullBudget && len(f.mod.order) > 1 {
		old := f.mod.order[0]
		f.mod.order = f.mod.order[1:]
		f.mod.size -= len(f.mod.full[old])
		delete(f.mod.full, old)
	}
}

// feedDelta streams new words of the reply. Deltas are live only: they take no
// id and never enter the log, because the row Claude stores for the same block
// arrives moments later and is what history keeps.
func (f *FileSource) feedDelta(ev ModEvent) {
	if ev.Text == "" || (ev.Kind != "text" && ev.Kind != "thinking") {
		return
	}
	turn := f.TurnID()
	f.broadcast(Event{
		Kind: KindDelta, TurnID: turn, Body: ev.Text, Stream: ev.Kind, Block: ev.Index,
		AgentID: ev.AgentID, Sidechain: ev.AgentID != "", At: ev.T,
	})
}

// feedPrompt records a prompt typed while a turn runs: Claude queues it, and
// the composer shows it waiting until its row arrives. A prompt sent while the
// session is idle opens its turn through its row, so it records nothing here.
func (f *FileSource) feedPrompt(ev ModEvent) {
	text := strings.TrimSpace(ev.Text)
	if text == "" || !f.TurnOpen() {
		return
	}
	f.mu.Lock()
	if text == f.mod.opened {
		f.mu.Unlock()
		return
	}
	f.mod.queued = append(f.mod.queued, text)
	f.mu.Unlock()
	f.appendLive(Event{Kind: KindMeta, Meta: MetaQueued, Body: text, TurnID: f.TurnID(), At: ev.T})
}

func (f *FileSource) feedModel(ev ModEvent) {
	now := ModelState{Model: ev.Model, Effort: ev.Effort}
	if now.Model == "" {
		return
	}
	f.mu.Lock()
	same := now == f.mod.model
	f.mod.model = now
	f.mu.Unlock()
	if same {
		return
	}
	f.normMu.Lock()
	f.norm.model = now
	turn := f.norm.turnID
	f.normMu.Unlock()
	f.appendLive(Event{Kind: KindMeta, Meta: MetaModel, Model: &now, TurnID: turn, At: ev.T})
}

// FeedHistory rebuilds the conversation from $.session.messages(), for a
// session this process has no log for. running says the main thread is mid-turn,
// which leaves the last turn open; otherwise it is closed.
func (f *FileSource) FeedHistory(msgs []ModHistoryMessage, running bool) {
	if f.mod == nil {
		return
	}
	uses := map[string]ModToolUse{}
	for _, m := range msgs {
		for _, u := range m.ToolUses {
			uses[u.ToolUseID] = u
		}
	}
	done := map[string]bool{}
	result := func(u ModToolUse) Record {
		done[u.ToolUseID] = true
		block, _ := json.Marshal([]map[string]any{{
			"type": "tool_result", "tool_use_id": u.ToolUseID, "content": u.Text, "is_error": u.IsError,
		}})
		return Record{Type: RecordUser, ToolUseResult: u.Result,
			Message: Message{Role: "user", Content: block}}
	}
	var recs []Record
	for _, m := range msgs {
		switch m.Role {
		case "user":
			var results []struct {
				ToolUseID string `json:"tool_use_id"`
			}
			if json.Unmarshal(m.ToolResults, &results) == nil && len(results) > 0 {
				for _, r := range results {
					if u, ok := uses[r.ToolUseID]; ok && !done[r.ToolUseID] {
						recs = append(recs, result(u))
					}
				}
				continue
			}
			if strings.TrimSpace(m.Text) == "" {
				continue
			}
			block, _ := json.Marshal([]map[string]any{{"type": "text", "text": m.Text}})
			recs = append(recs, Record{Type: RecordUser, Message: Message{Role: "user", Content: block}})
		case "assistant":
			var blocks []map[string]any
			if strings.TrimSpace(m.Text) != "" {
				blocks = append(blocks, map[string]any{"type": "text", "text": m.Text})
			}
			for _, u := range m.ToolUses {
				in := u.Input
				if len(in) == 0 {
					in = json.RawMessage(`{}`)
				}
				blocks = append(blocks, map[string]any{"type": "tool_use", "id": u.ToolUseID, "name": u.Tool, "input": in})
			}
			if len(blocks) == 0 {
				continue
			}
			content, _ := json.Marshal(blocks)
			recs = append(recs, Record{Type: RecordAssistant, Message: Message{Role: "assistant", Content: content}})
			// A result the user message does not carry still belongs right
			// after its call.
			for _, u := range m.ToolUses {
				if (len(u.Result) > 0 || u.Text != "") && !hasToolResults(msgs, u.ToolUseID) {
					recs = append(recs, result(u))
				}
			}
		}
	}
	f.normMu.Lock()
	var out []Event
	for _, rec := range recs {
		out = append(out, f.norm.Record(rec)...)
	}
	if !running {
		if e, ok := f.norm.EndTurn(0, nil); ok {
			out = append(out, e)
		}
	}
	f.normMu.Unlock()
	for _, e := range out {
		f.appendLive(e)
	}
}

// hasToolResults reports whether some user message in msgs carries the result
// of the call id, so the result is placed there rather than after the call.
func hasToolResults(msgs []ModHistoryMessage, id string) bool {
	for _, m := range msgs {
		if m.Role != "user" || len(m.ToolResults) == 0 {
			continue
		}
		var results []struct {
			ToolUseID string `json:"tool_use_id"`
		}
		if json.Unmarshal(m.ToolResults, &results) != nil {
			continue
		}
		for _, r := range results {
			if r.ToolUseID == id {
				return true
			}
		}
	}
	return false
}

// broadcast hands an event to every live subscriber without logging it.
func (f *FileSource) broadcast(e Event) {
	f.mu.Lock()
	defer f.mu.Unlock()
	e.Session = f.session
	for _, ch := range f.subs {
		select {
		case ch <- e:
		default: // a delta is worth less than keeping the stream: drop it
		}
	}
}

// modFullResult serves FullResult from what the mod sent, ok=false when it
// does not hold that result.
func (f *FileSource) modFullResult(toolID string) (string, bool) {
	if f.mod == nil {
		return "", false
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	s, ok := f.mod.full[toolID]
	return s, ok
}

// errNoResult is FullResult's answer for a mod source with no transcript to
// fall back on.
var errNoResult = errors.New("full result: not held")

// EndTurn closes the current turn on the mod's turn_end, once: the event and
// true when a turn was open.
func (n *Normalizer) EndTurn(at int64, usage json.RawMessage) (Event, bool) {
	if n.turnID == "" || n.turnDone {
		return Event{}, false
	}
	n.turnDone, n.doneMsg = true, ""
	e := n.emit(KindTurnEnd, at)
	e.Usage = usage
	return e, true
}

func rfc3339(ms int64) string {
	if ms <= 0 {
		return ""
	}
	return time.UnixMilli(ms).UTC().Format(time.RFC3339Nano)
}
