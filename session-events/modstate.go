package main

import (
	"encoding/json"
	"sort"
	"strconv"
	"strings"
	"time"

	"terminal-lobby/sessionio"
)

// What a Claude session's mod events say about its tmux session options
// (ADR-0036). The lobby's sidebar, push notifications, the mode walk and
// tmux-persist all read these options, and until the mod they were written by
// devvm/claude-tmux-state from Claude Code's settings hooks. The meanings are
// unchanged; only the writer moved:
//
//	@claude_state    running / awaiting / done (ADR-0001)
//	@claude_ask      the tool id of a dialog waiting on a person
//	@claude_tool     the tool id of the main thread's call in flight
//	@claude_bg       outstanding background work, `a:<id> w:<id> t:<name>`
//	@claude_reply    "<epoch> <text>" of the reply that ended the last turn
//	@claude_notice   "<epoch> <text>" of the newest PushNotification
//	@last_activity   epoch seconds of the last prompt or finished turn
//	@tl_summary      the mod's one-line summary, for tmux-api's auto-title
//	                 (new with the mod: the hooks had nothing to write here)
//
// The mod sees the session from inside, so none of the old script's guesses
// are needed: a turn starts and ends when Claude says so, a dialog is up from
// the moment Claude asks until it is settled, and a nested `claude -p` never
// reaches this code because its mod stays inert.

const (
	optReply    = "@claude_reply"
	optNotice   = "@claude_notice"
	optActivity = "@last_activity"
)

// replyCap bounds the reply and notice texts, as the hook script did.
const replyCap = 1000

// stampState is one session's view of its options, so only changes are
// written.
type stampState struct {
	state string
	// ask is @claude_ask: the newest of asks.
	ask string
	// asks are the dialogs open now, oldest first. More than one can stand:
	// a background subagent's permission prompt and the main thread's, or two
	// subagents'.
	asks []string
	// owner places a tool call: the agent whose row called it, "" for the
	// main thread, from the rows the mod forwards, until its result. tool.check
	// carries no agent id, so this is how a permission event is told apart
	// from the main thread's.
	owner    map[string]string
	tool     string
	bg       string
	turnOpen bool
	// agents is the newest $.agent.list(), and active the subagent loops
	// that have done something since their last turn_end. A teammate is
	// listed as running for as long as it exists, idle or not (measured
	// 2026-09-12 for the hook payload's list), so whether it is working is
	// read off its own loop instead.
	agents []sessionio.ModAgent
	active map[string]bool
}

// stampWrite is one batch of option changes, and the state transition it
// makes, for the log.
type stampWrite struct {
	set   map[string]string
	unset []string
	from  string
	to    string
}

func (w *stampWrite) put(name, value string) {
	if w.set == nil {
		w.set = map[string]string{}
	}
	w.set[name] = value
}

func (w stampWrite) empty() bool { return len(w.set) == 0 && len(w.unset) == 0 }

// ownerCap bounds owner: entries leave with their tool's result, and a
// session whose results never came starts the map over rather than growing.
const ownerCap = 1024

// apply folds one mod event into the state and returns the writes it implies.
func (s *stampState) apply(ev sessionio.ModEvent, now time.Time) stampWrite {
	var w stampWrite
	main := ev.AgentID == ""
	prev := *s
	if !main {
		if s.active == nil {
			s.active = map[string]bool{}
		}
		if ev.Type == sessionio.ModTurnEndEvent {
			delete(s.active, ev.AgentID)
		} else {
			s.active[ev.AgentID] = true
		}
		s.bg = bgTokens(s.agents, s.active)
		if !s.turnOpen {
			s.state = s.idleState()
		}
	}
	switch ev.Type {
	case sessionio.ModRowEvent:
		if ev.Message == nil {
			break
		}
		if main && ev.Door == "prompt" && ev.Message.Role == "user" {
			// A person typed: no main-thread dialog can still be up.
			s.dropAsks(s.mainEnded)
			s.turnOpen, s.tool = true, ""
			s.state = sessionio.StateRunning
			w.put(optActivity, strconv.FormatInt(now.Unix(), 10))
			break
		}
		for _, bl := range blocksOf(ev.Message.Content) {
			if bl.Type != "tool_use" || bl.ID == "" {
				continue
			}
			s.place(bl.ID, ev.AgentID)
			if !main {
				continue
			}
			s.tool = bl.ID
			if strings.HasSuffix(bl.Name, "PushNotification") {
				var in struct {
					Message string `json:"message"`
				}
				if json.Unmarshal(bl.Input, &in) == nil && strings.TrimSpace(in.Message) != "" {
					w.put(optNotice, stampText(now, in.Message))
				}
			}
		}
	case sessionio.ModTurnStartEvent:
		if main {
			s.turnOpen = true
			s.state = sessionio.StateRunning
		}
	case sessionio.ModHistoryEvent:
		// The turn lives in this process's memory, so a restart mid-turn
		// starts over without it. The history after the next hello says
		// whether a main-thread turn is running; only its last chunk speaks.
		if !ev.More {
			s.turnOpen = ev.Running
			s.state = s.idleState()
		}
	case sessionio.ModResultEvent:
		if main && s.tool == ev.ToolID {
			s.tool = ""
		}
		if ev.ToolID != "" {
			// A tool that has a result is not waiting on anyone.
			s.dropAsks(func(id string) bool { return id == ev.ToolID })
			delete(s.owner, ev.ToolID)
		}
	case sessionio.ModAskEvent, sessionio.ModPlanEvent, sessionio.ModPermissionEvent:
		if ev.ToolID != "" {
			if !main {
				s.place(ev.ToolID, ev.AgentID)
			}
			s.dropAsks(func(id string) bool { return id == ev.ToolID })
			s.asks = append(s.asks, ev.ToolID)
		}
	case sessionio.ModSettledEvent:
		if ev.ToolID == "" {
			if n := len(s.asks); n > 0 {
				s.asks = s.asks[:n-1]
			}
		} else {
			s.dropAsks(func(id string) bool { return id == ev.ToolID })
		}
	case sessionio.ModTurnEndEvent:
		if !main {
			// A subagent's loop ended, so none of its dialogs stand, nor one
			// nothing placed once no loop at all could have asked it.
			s.dropAsks(func(id string) bool {
				who, placed := s.owner[id]
				if placed {
					return who == ev.AgentID
				}
				return !s.turnOpen && len(s.active) == 0
			})
			break
		}
		s.turnOpen, s.tool = false, ""
		s.dropAsks(s.mainEnded)
		s.state = s.idleState()
		w.put(optActivity, strconv.FormatInt(now.Unix(), 10))
		if strings.TrimSpace(ev.Answer) != "" {
			w.put(optReply, stampText(now, ev.Answer))
		}
	case sessionio.ModSummaryEvent:
		// tmux-api adopts it as the title while the session has none.
		if t := strings.TrimSpace(ev.Text); main && t != "" {
			w.put(sessionio.OptionSummary, t)
		}
	case sessionio.ModAgentsEvent:
		s.agents = ev.Agents
		s.bg = bgTokens(s.agents, s.active)
		if !s.turnOpen {
			s.state = s.idleState()
		}
	case sessionio.ModByeEvent:
		*s = stampState{}
		w.unset = []string{sessionio.OptionState, sessionio.OptionBackground, sessionio.OptionAsk, sessionio.OptionTool}
		w.from, w.to = prev.state, ""
		return w
	}
	// An open dialog outranks everything above: whatever the event, a
	// session with a dialog up is awaiting, and the newest dialog is the one
	// @claude_ask names.
	s.ask = ""
	if n := len(s.asks); n > 0 {
		s.ask = s.asks[n-1]
		s.state = sessionio.StateAwaiting
	} else if s.state == sessionio.StateAwaiting {
		s.state = s.idleState()
	}
	diff := func(name, was, now string) {
		if was == now {
			return
		}
		if now == "" {
			w.unset = append(w.unset, name)
			return
		}
		w.put(name, now)
	}
	diff(sessionio.OptionState, prev.state, s.state)
	diff(sessionio.OptionAsk, prev.ask, s.ask)
	diff(sessionio.OptionTool, prev.tool, s.tool)
	diff(sessionio.OptionBackground, prev.bg, s.bg)
	w.from, w.to = prev.state, s.state
	return w
}

// place records which agent called a tool.
func (s *stampState) place(toolID, agentID string) {
	if s.owner == nil || len(s.owner) >= ownerCap {
		s.owner = map[string]string{}
	}
	s.owner[toolID] = agentID
}

// mainEnded reports whether a dialog is over once the main thread's turn has
// ended or a person has typed a prompt. The main thread's own dialogs are,
// which is the safety net for a settled event that never came. A subagent's
// are not: a background subagent goes on after the main turn, and its
// permission prompt can open half a second before that turn ends. A dialog
// no row placed could be either, and is kept while a subagent loop is active.
func (s *stampState) mainEnded(toolID string) bool {
	if who, placed := s.owner[toolID]; placed {
		return who == ""
	}
	return len(s.active) == 0
}

// dropAsks removes the open dialogs gone reports, keeping the order.
func (s *stampState) dropAsks(gone func(toolID string) bool) {
	kept := s.asks[:0:0]
	for _, id := range s.asks {
		if !gone(id) {
			kept = append(kept, id)
		}
	}
	s.asks = kept
}

// idleState is the state once nothing waits on a person: still running while
// background work is outstanding or the turn is open, done otherwise.
func (s *stampState) idleState() string {
	if s.turnOpen || s.bg != "" {
		return sessionio.StateRunning
	}
	return sessionio.StateDone
}

// bgTokens is @claude_bg for an agent list: the running background subagents
// and workflows by id, and the teammates whose loop is active by name. Sorted
// so an unchanged set reads the same and writes nothing.
//
// $.agent.list() gives a subagent's type as its agent definition
// (general-purpose, Explore, a plugin's `<plugin>:<name>`), an open set, not
// the "subagent" of the Stop hook's registry. Until 2026-10-02 only the
// registry's words were matched here, so a background general-purpose agent
// counted for nothing and the session read done while it worked. Every type
// but a teammate and a workflow is a subagent.
func bgTokens(agents []sessionio.ModAgent, active map[string]bool) string {
	var out []string
	for _, a := range agents {
		if a.Status != "running" {
			continue
		}
		var tok string
		switch a.Type {
		case "":
			continue
		case "workflow":
			tok = "w:" + a.ID
		case "teammate":
			if !active[a.ID] {
				continue
			}
			name := a.Name
			if name == "" {
				name = a.ID
			}
			tok = "t:" + name
		default:
			tok = "a:" + a.ID
		}
		if idOK(strings.SplitN(tok, ":", 2)[1]) {
			out = append(out, tok)
		}
	}
	sort.Strings(out)
	return strings.Join(out, " ")
}

// idOK is the hook script's id charset: an id lands in an option value that
// other code matches as a pattern, so [A-Za-z0-9_-] is its whole validation.
func idOK(s string) bool {
	if s == "" || len(s) > 128 {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-') {
			return false
		}
	}
	return true
}

// stampText is "<epoch> <text>" in the form sessionio.ParseNotice reads: the
// text JSON-escaped without its quotes, cut to replyCap, and never ending in a
// ';', which tmux would take as a command separator.
func stampText(now time.Time, text string) string {
	if len(text) > replyCap {
		text = strings.ToValidUTF8(text[:replyCap], "")
	}
	b, _ := json.Marshal(text)
	raw := strings.TrimSuffix(strings.TrimPrefix(string(b), `"`), `"`)
	if strings.HasSuffix(raw, ";") {
		raw = strings.TrimSuffix(raw, ";") + `;`
	}
	return strconv.FormatInt(now.Unix(), 10) + " " + raw
}

// blocksOf decodes a row's content blocks; nil for anything else.
func blocksOf(content json.RawMessage) []sessionio.Block {
	var bl []sessionio.Block
	if json.Unmarshal(content, &bl) != nil {
		return nil
	}
	return bl
}
