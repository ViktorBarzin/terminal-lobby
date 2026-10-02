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
	state    string
	ask      string
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
		if !s.turnOpen && s.ask == "" {
			s.state = s.idleState()
		}
	}
	switch ev.Type {
	case sessionio.ModRowEvent:
		if !main || ev.Message == nil {
			break
		}
		if ev.Door == "prompt" && ev.Message.Role == "user" {
			s.turnOpen, s.ask, s.tool = true, "", ""
			s.state = sessionio.StateRunning
			w.put(optActivity, strconv.FormatInt(now.Unix(), 10))
			break
		}
		for _, bl := range blocksOf(ev.Message.Content) {
			if bl.Type != "tool_use" || bl.ID == "" {
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
			if s.ask == "" {
				s.state = sessionio.StateRunning
			}
		}
	case sessionio.ModResultEvent:
		if main && s.tool == ev.ToolID {
			s.tool = ""
		}
	case sessionio.ModAskEvent, sessionio.ModPlanEvent, sessionio.ModPermissionEvent:
		if main && ev.ToolID != "" {
			s.ask, s.state = ev.ToolID, sessionio.StateAwaiting
		}
	case sessionio.ModSettledEvent:
		if s.ask != "" && (ev.ToolID == "" || ev.ToolID == s.ask) {
			s.ask = ""
			s.state = s.idleState()
		}
	case sessionio.ModTurnEndEvent:
		if !main {
			break
		}
		s.turnOpen, s.ask, s.tool = false, "", ""
		s.state = s.idleState()
		w.put(optActivity, strconv.FormatInt(now.Unix(), 10))
		if strings.TrimSpace(ev.Answer) != "" {
			w.put(optReply, stampText(now, ev.Answer))
		}
	case sessionio.ModAgentsEvent:
		s.agents = ev.Agents
		s.bg = bgTokens(s.agents, s.active)
		if !s.turnOpen && s.ask == "" {
			s.state = s.idleState()
		}
	case sessionio.ModByeEvent:
		*s = stampState{}
		w.unset = []string{sessionio.OptionState, sessionio.OptionBackground, sessionio.OptionAsk, sessionio.OptionTool}
		w.from, w.to = prev.state, ""
		return w
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
func bgTokens(agents []sessionio.ModAgent, active map[string]bool) string {
	var out []string
	for _, a := range agents {
		if a.Status != "running" {
			continue
		}
		var tok string
		switch a.Type {
		case "subagent", "local_agent", "agent":
			tok = "a:" + a.ID
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
			continue
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
