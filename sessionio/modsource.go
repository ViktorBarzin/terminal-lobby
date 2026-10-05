package sessionio

import (
	"encoding/json"
	"errors"
	"slices"
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
	// ModSummaryEvent carries, as Text, the mod's one-line summary of the
	// conversation, for OptionSummary.
	ModSummaryEvent = "summary"
	// ModLevelEvent is the mod's whole view of the session at one moment
	// (mod 0.3.0): whether a main turn or a compaction runs, the main
	// thread's tool in flight, the agent list and the dialogs open. It
	// replaces what the server folded from earlier events, so a missed or
	// repeated edge cannot leave the session's options wrong.
	ModLevelEvent = "level"
	// ModCommandFailedEvent says a command the mod acked did not take effect
	// after all: a prompt a hook dropped, a slash command that failed.
	ModCommandFailedEvent = "command_failed"
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
	// Text is the result's flattened text, a delta's new words, a prompt's
	// text, or a summary.
	Text string `json:"text,omitempty"`

	// turn_start, delta, turn_end
	TurnID string `json:"turnId,omitempty"`
	// Step is a delta's model request within its turn. Index numbers a block
	// within one step only, so the mod merges deltas by both.
	Step       int             `json:"step,omitempty"`
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
	// Reason is why a permission prompt asks, or why a bye came (the
	// engine's SessionEndReason).
	Reason string `json:"reason,omitempty"`
	By     string `json:"by,omitempty"`

	// bye: the conversation it ends, from mod 0.3.0. A bye still queued when
	// /clear made a new conversation must not end the new one's connection.
	Sid string `json:"sid,omitempty"`

	// model
	Model  string `json:"model,omitempty"`
	Effort string `json:"effort,omitempty"`

	// agents
	Agents []ModAgent `json:"agents,omitempty"`

	// history, level. On a level, Tool above is the main thread's
	// tool_use_id in flight ("" for none) and Agents the whole agent list.
	Messages []ModHistoryMessage `json:"messages,omitempty"`
	Running  bool                `json:"running,omitempty"`
	// Compacting says a compaction runs, which keeps the session busy with
	// no turn open.
	Compacting bool `json:"compacting,omitempty"`
	// Asks are the tool ids of the dialogs open now, oldest first. Their
	// bodies came in earlier ask, plan and permission events.
	Asks []string `json:"asks,omitempty"`
	// Reply and Notice are a level's newest main-thread reply (the answer of
	// the last turn that ended with one) and newest PushNotification, each
	// with the t of the event that first carried it; absent when the mod has
	// none. A turn that ended while session-events was down has its reply
	// only here.
	Reply  *ModNote `json:"reply,omitempty"`
	Notice *ModNote `json:"notice,omitempty"`
	// More is set on every chunk of a long history but the last (ADR-0036).
	More bool `json:"more,omitempty"`
	// Last, on a history's final chunk (mod 0.4.0), is the uuid of the newest
	// main-thread row the history covers: the transcript is replayed up to it.
	Last string `json:"last,omitempty"`

	// ack, command_failed
	ID    string `json:"id,omitempty"`
	OK    bool   `json:"ok,omitempty"`
	Error string `json:"error,omitempty"`
	// Op is the failed command's op.
	Op string `json:"op,omitempty"`
}

// ModNote is a text and the time the mod first saw it, in ms.
type ModNote struct {
	T    int64  `json:"t"`
	Text string `json:"text"`
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
	ID          string      `json:"id"`
	Type        string      `json:"type"`
	Status      AgentStatus `json:"status"`
	Name        string      `json:"name,omitempty"`
	Description string      `json:"description,omitempty"`
	// TeammateID, ParentID and SpawnedBy pass through from the engine's
	// AgentInfo; nothing reads them yet.
	TeammateID string `json:"teammateId,omitempty"`
	ParentID   string `json:"parentId,omitempty"`
	SpawnedBy  string `json:"spawnedBy,omitempty"`
}

// AgentStatus is where an agent's loop stands, as the engine's AgentStatus
// names it.
type AgentStatus string

const (
	AgentStatusPending   AgentStatus = "pending"
	AgentStatusRunning   AgentStatus = "running"
	AgentStatusWaiting   AgentStatus = "waiting"
	AgentStatusIdle      AgentStatus = "idle"
	AgentStatusCompleted AgentStatus = "completed"
	AgentStatusFailed    AgentStatus = "failed"
	AgentStatusKilled    AgentStatus = "killed"
)

// Over reports whether the agent has finished for good: completed, failed or
// killed. Every other status is a loop that can still do work, a subagent
// waiting on its own background work included.
func (s AgentStatus) Over() bool {
	return s == AgentStatusCompleted || s == AgentStatusFailed || s == AgentStatusKilled
}

// Working reports whether the agent's loop has work in hand: pending (not
// started yet), running, or waiting on background work of its own. An idle
// agent sits between turns until a message wakes it, which is also how a
// finished subagent that can be resumed may be listed.
func (s AgentStatus) Working() bool {
	return s == AgentStatusPending || s == AgentStatusRunning || s == AgentStatusWaiting
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
	// sent are the queued prompts the lobby handed the mod (QueueSent),
	// oldest first, so one a hook then drops can leave the queue by its
	// command id.
	sent  []sentPrompt
	model ModelState
	// rows are the uuids already in the log. A mod re-sends a batch after a
	// failed request and history after a fresh hello, so a row can arrive
	// twice.
	rows map[string]bool
	// streamed is the main thread's reply text streamed since Claude last
	// stored a block. Claude stores nothing for a block a Stop cut short, so
	// this is what keeps the words the pane still shows.
	streamed strings.Builder
	// opened is the text of the prompt row that opened the current turn. A
	// prompt the mod submitted itself is reported when its turn starts, after
	// its row, and must not then read as one waiting behind that same turn.
	opened string
	// answered says the last history message was Claude replying without a
	// tool call, so the next person-or-harness message ends that turn (see
	// FeedHistory). Held across chunks; a live row clears it. Guarded by
	// normMu.
	answered bool
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
		f.mu.Lock()
		cut := f.mod.streamed.String()
		f.mod.streamed.Reset()
		f.mu.Unlock()
		f.normMu.Lock()
		var partial Event
		keep := ev.Aborted && strings.TrimSpace(cut) != "" && f.norm.turnID != "" && !f.norm.turnDone
		if keep {
			partial = f.norm.emit(KindText, ev.T)
			partial.Body = cut
		}
		e, ok := f.norm.EndTurn(ev.T, ev.Usage)
		f.normMu.Unlock()
		if keep {
			f.appendLive(partial)
		}
		if ok {
			f.appendLive(e)
		}
	case ModPromptEvent:
		f.feedPrompt(ev)
	case ModModelEvent:
		f.feedModel(ev)
	case ModCommandFailedEvent:
		f.feedCommandFailed(ev)
	}
}

// feedCommandFailed shows a command that did not take effect as an error row
// in the session's own timeline: the web had already been told it was sent.
func (f *FileSource) feedCommandFailed(ev ModEvent) {
	if ev.Op == "prompt" {
		f.mu.Lock()
		var text string
		left := false
		if i := slices.IndexFunc(f.mod.sent, func(p sentPrompt) bool { return p.id == ev.ID }); i >= 0 {
			text = f.mod.sent[i].text
			f.mod.sent = slices.Delete(f.mod.sent, i, i+1)
			if q := slices.Index(f.mod.queued, text); q >= 0 {
				f.mod.queued = slices.Delete(f.mod.queued, q, q+1)
				left = true
			}
		}
		f.mu.Unlock()
		if left {
			f.appendLive(Event{Kind: KindMeta, Meta: MetaUnqueued, Body: text, TurnID: f.TurnID(), At: ev.T})
		}
	}
	what := "the lobby's " + ev.Op
	if ev.Op == "prompt" {
		what = "the prompt sent from the lobby"
	}
	body := strings.TrimSpace("Claude did not run " + what + ": " + ev.Error)
	f.appendLive(Event{Kind: KindError, Body: body, TurnID: f.TurnID(), At: ev.T})
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
	// A stored block of the reply supersedes what streamed for it.
	if ev.AgentID == "" && rec.Role() == "assistant" {
		f.mu.Lock()
		f.mod.streamed.Reset()
		f.mu.Unlock()
	}
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
				f.forgetSent(q)
				lead = append(lead, Event{Kind: KindMeta, Meta: MetaUnqueued, Body: q, At: ev.T})
				break
			}
		}
		f.mu.Unlock()
	}
	f.normMu.Lock()
	f.mod.answered = false
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
	if ev.Kind == "text" && ev.AgentID == "" {
		f.mu.Lock()
		f.mod.streamed.WriteString(ev.Text)
		f.mu.Unlock()
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
//
// Nor does a prompt the lobby sent through the mod. The mod reports one only
// once it has opened its own turn, so it is never waiting by then; one sent
// mid-turn was queued when the mod took it (QueueSent). Two of them run back
// to back put the first one's report after the second one's row, where it read
// as a prompt waiting behind the second and never left the queue.
func (f *FileSource) feedPrompt(ev ModEvent) {
	text := strings.TrimSpace(ev.Text)
	if text == "" || fromLobby(ev.Origin) || !f.TurnOpen() {
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

// Queue shows a prompt session-events is holding behind the running turn as
// queued, at `at` (epoch ms). Its row leaves the queue as it arrives, as a
// prompt the mod reported would (feedRow).
func (f *FileSource) Queue(text string, at int64) {
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	turn := f.TurnID()
	f.mu.Lock()
	f.mod.queued = append(f.mod.queued, text)
	f.mu.Unlock()
	f.appendLive(Event{Kind: KindMeta, Meta: MetaQueued, Body: text, TurnID: turn, At: at})
}

// Unqueue takes prompts handed back to the web off the queue at `at` (epoch
// ms), so every device stops showing them as waiting. A text the queue does
// not hold is skipped.
func (f *FileSource) Unqueue(texts []string, at int64) {
	turn := f.TurnID()
	f.mu.Lock()
	var gone []Event
	for _, t := range texts {
		t = strings.TrimSpace(t)
		for i, q := range f.mod.queued {
			if q == t {
				f.mod.queued = append(f.mod.queued[:i], f.mod.queued[i+1:]...)
				f.forgetSent(q)
				gone = append(gone, Event{Kind: KindMeta, Meta: MetaUnqueued, Body: q, TurnID: turn, At: at})
				break
			}
		}
	}
	f.mu.Unlock()
	for _, e := range gone {
		f.appendLive(e)
	}
}

// lobbyPlugin is the name Claude Code gives the lobby's mod in a prompt's
// origin.
const lobbyPlugin = "terminal-lobby"

// fromLobby reports whether a prompt's origin is the lobby's mod.
func fromLobby(origin json.RawMessage) bool {
	var o struct {
		Kind string `json:"kind"`
		Name string `json:"name"`
	}
	return json.Unmarshal(origin, &o) == nil && o.Kind == "plugin" && o.Name == lobbyPlugin
}

// QueueSent records a prompt the lobby has just handed the mod (command id)
// as waiting, when a turn is running. Claude holds such a prompt until the
// session is idle and the mod reports it only then (Claude Code 2.1.289,
// measured 2026-10-05), so without this only the device that sent it knew it
// was waiting. Its row takes it off the queue as it opens its turn, as for a
// typed one. A slash command runs as one and leaves no prompt row, so it is
// not queued. Reports whether the prompt was queued.
func (f *FileSource) QueueSent(id, text string) bool {
	text = strings.TrimSpace(text)
	if f.mod == nil || text == "" || strings.HasPrefix(text, "/") || !f.TurnOpen() {
		return false
	}
	f.mu.Lock()
	f.mod.queued = append(f.mod.queued, text)
	f.mod.sent = append(f.mod.sent, sentPrompt{id: id, text: text})
	f.mu.Unlock()
	f.appendLive(Event{Kind: KindMeta, Meta: MetaQueued, Body: text, TurnID: f.TurnID(), At: time.Now().UnixMilli()})
	return true
}

// sentPrompt is a prompt QueueSent put on the queue, and the command that
// carried it.
type sentPrompt struct{ id, text string }

// forgetSent drops the oldest sent entry for text, which has left the queue.
// Called with f.mu held.
func (f *FileSource) forgetSent(text string) {
	if i := slices.IndexFunc(f.mod.sent, func(p sentPrompt) bool { return p.text == text }); i >= 0 {
		f.mod.sent = slices.Delete(f.mod.sent, i, i+1)
	}
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
//
// History carries no stop_reason and no turn_end, so a turn is closed where
// Claude replied without calling a tool and the next message is a person's
// prompt or the harness's own notice. Without that, every turn up to the next
// prompt ran together: a background task's notification and Claude's reply to
// it joined the turn before, whose final answer the Text view then folded into
// its work as an interim note.
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
	// endsBefore[i]: the turn ends ahead of recs[i]. answered is read and
	// written under normMu, which also orders history chunks.
	endsBefore := map[int]bool{}
	f.normMu.Lock()
	answered := f.mod.answered
	f.normMu.Unlock()
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
				answered = false
				continue
			}
			if strings.TrimSpace(m.Text) == "" {
				continue
			}
			if answered {
				endsBefore[len(recs)] = true
				answered = false
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
			answered = len(m.ToolUses) == 0
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
	f.mod.answered = answered
	var out []Event
	for i, rec := range recs {
		if endsBefore[i] {
			if e, ok := f.norm.EndTurn(0, nil); ok {
				out = append(out, e)
			}
		}
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
