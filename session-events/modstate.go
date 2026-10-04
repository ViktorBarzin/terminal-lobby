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

// stampState is one session's view of its options: what the mod's events
// say they should hold, and what they were last written as.
type stampState struct {
	state string
	// ask is @claude_ask: the newest of asks.
	ask string
	// asks are the dialogs open now, oldest first. More than one can stand:
	// a background subagent's permission prompt and the main thread's, or two
	// subagents'.
	asks []string
	// dialogs are the bodies of the asks, for the card and the answer routes:
	// one list, so every rule that closes a dialog closes it for every
	// reader. A level can list an ask whose body never arrived; it counts
	// for @claude_ask but has nothing to show.
	dialogs map[string]*modDialog
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
	// written is what the four state options were last written as, by a
	// write that succeeded. Changes are diffed against it, not against the
	// fold's previous step: memory that moved past a failed write, or a new
	// process that never saw what the last one wrote, would otherwise leave
	// tmux wrong with nothing to correct it.
	written stampOpts
	// reply and notice are the newest main-thread reply and PushNotification
	// message, each with the mod's time for the event that carried it. The
	// push sender takes a new stamp on @claude_reply or @claude_notice for a
	// new message, so each is written once, when its time is newer than the
	// one last written: a resent batch, or a level repeating it, writes
	// nothing.
	reply, notice stampNote
	// activity is the epoch second @last_activity was last stamped with.
	activity int64
}

// stampNote is a reply or notice text and its time in ms.
type stampNote struct {
	t    int64
	text string
}

// stampOpts are the options the fold owns: the four state options, and the
// times of the reply and notice written.
type stampOpts struct {
	state, ask, tool, bg string
	replyT, noticeT      int64
}

// opts is what the fold says the options should hold now.
func (s *stampState) opts() stampOpts {
	return stampOpts{state: s.state, ask: s.ask, tool: s.tool, bg: s.bg, replyT: s.reply.t, noticeT: s.notice.t}
}

// note takes a reply or notice when it is newer than the one held. An event's
// own t is the mod's clock; an event without one (a test) is stamped now.
func note(held *stampNote, t int64, text string, now time.Time) {
	if t <= 0 {
		t = now.UnixMilli()
	}
	if t > held.t {
		*held = stampNote{t: t, text: text}
	}
}

// flush is the write that brings the options from written to the fold. full
// writes all four state options whatever written says: set when there is a
// value, unset when there is none. A reply or notice is written only when it
// is newer than the one last written, full or not. It reports the state
// transition against what was written, for the log.
func (s *stampState) flush(full bool) stampWrite {
	var w stampWrite
	now := s.opts()
	put := func(name, was, v string) {
		switch {
		case !full && was == v:
		case v == "":
			w.unset = append(w.unset, name)
		default:
			w.put(name, v)
		}
	}
	put(sessionio.OptionState, s.written.state, now.state)
	put(sessionio.OptionAsk, s.written.ask, now.ask)
	put(sessionio.OptionTool, s.written.tool, now.tool)
	put(sessionio.OptionBackground, s.written.bg, now.bg)
	if s.reply.t > s.written.replyT {
		w.put(optReply, stampText(time.UnixMilli(s.reply.t), s.reply.text))
	}
	if s.notice.t > s.written.noticeT {
		w.put(optNotice, stampText(time.UnixMilli(s.notice.t), s.notice.text))
	}
	w.from, w.to = s.written.state, now.state
	return w
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

// apply folds one mod event into the state, and returns the writes of the
// options the event itself names: the activity stamp and the summary. The
// state options, the reply and the notice are written by flush.
func (s *stampState) apply(ev sessionio.ModEvent, now time.Time) stampWrite {
	var w stampWrite
	main := ev.AgentID == ""
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
			s.stampActivity(&w, now.Unix())
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
					note(&s.notice, ev.T, in.Message, now)
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
				// From mod 0.3.0 a permission names its subagent when the mod
				// could place it, which keeps it past the main turn's end even
				// when no row placed it here (after a restart).
				s.place(ev.ToolID, ev.AgentID)
			}
			s.dropAsks(func(id string) bool { return id == ev.ToolID })
			s.asks = append(s.asks, ev.ToolID)
			if d := dialogOf(ev); d != nil {
				if s.dialogs == nil {
					s.dialogs = map[string]*modDialog{}
				}
				s.dialogs[ev.ToolID] = d
			}
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
		s.stampActivity(&w, now.Unix())
		if strings.TrimSpace(ev.Answer) != "" {
			note(&s.reply, ev.T, ev.Answer, now)
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
	case sessionio.ModLevelEvent:
		// The mod's whole view at one moment replaces what was folded from
		// edges before it. A dialog it still lists keeps the body it came
		// with; one it does not list is over.
		s.turnOpen = ev.Running || ev.Compacting
		s.tool = ev.Tool
		s.agents = ev.Agents
		s.asks = s.asks[:0:0]
		for _, id := range ev.Asks {
			if id != "" && !containsStr(s.asks, id) {
				s.asks = append(s.asks, id)
			}
		}
		s.bg = bgTokens(s.agents, s.active)
		s.state = s.idleState()
		if r := ev.Reply; r != nil && strings.TrimSpace(r.Text) != "" && r.T > 0 {
			newer := r.T > s.reply.t
			note(&s.reply, r.T, r.Text, now)
			// A turn whose turn_end the snapshot dropped ended when its
			// reply did. While a turn runs, the newest activity is its
			// prompt, which no level carries, so the stamp is left alone.
			if newer && !s.turnOpen && r.T/1000 > s.activity {
				s.stampActivity(&w, r.T/1000)
			}
		}
		if n := ev.Notice; n != nil && strings.TrimSpace(n.Text) != "" && n.T > 0 {
			note(&s.notice, n.T, n.Text, now)
		}
	case sessionio.ModByeEvent:
		// The caller writes all four options empty on a bye.
		*s = stampState{written: s.written}
		return w
	}
	for id := range s.dialogs {
		if !containsStr(s.asks, id) {
			delete(s.dialogs, id)
		}
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
	return w
}

// stampActivity puts @last_activity.
func (s *stampState) stampActivity(w *stampWrite, epoch int64) {
	s.activity = epoch
	w.put(optActivity, strconv.FormatInt(epoch, 10))
}

// open is the dialogs waiting on a person that have a body to show, oldest
// first.
func (s *stampState) open() []*modDialog {
	var out []*modDialog
	for _, id := range s.asks {
		if d := s.dialogs[id]; d != nil {
			out = append(out, d)
		}
	}
	return out
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

// bgTokens is @claude_bg for an agent list: the background subagents and
// workflows that have not finished by id, and the teammates whose loop is
// active by name. Sorted so an unchanged set reads the same and writes nothing.
//
// A subagent or workflow counts while it is pending, running or waiting: one
// that is pending has not started yet, and one that is waiting waits on
// background work of its own (AgentStatus, CLI 2.1.289). An idle one does not
// count: idle is between turns until a message wakes it, and a finished
// subagent that can be resumed may be listed so, which would keep the session
// running for good. A teammate counts by its own loop whatever its listed
// status, because the list called an idle teammate running when measured on
// 2026-09-12 and the engine's types now say it reads idle.
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
		var tok string
		switch {
		case a.Type == "":
			continue
		case a.Type == "teammate":
			if !active[a.ID] {
				continue
			}
			name := a.Name
			if name == "" {
				name = a.ID
			}
			tok = "t:" + name
		case !a.Status.Working():
			continue
		case a.Type == "workflow":
			tok = "w:" + a.ID
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
// text JSON-escaped without its quotes, cut to replyCap. tmux reads an
// argument ending in ';' as a command separator and drops it (measured on tmux
// 3.4), so a final one is written as its JSON escape, which the decode brings
// back, as the hook script did.
func stampText(now time.Time, text string) string {
	if len(text) > replyCap {
		text = strings.ToValidUTF8(text[:replyCap], "")
	}
	b, _ := json.Marshal(text)
	raw := strings.TrimSuffix(strings.TrimPrefix(string(b), `"`), `"`)
	if strings.HasSuffix(raw, ";") {
		raw = strings.TrimSuffix(raw, ";") + `\u003b`
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
