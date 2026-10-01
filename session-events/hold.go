package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"terminal-lobby/sessionio"
	"terminal-lobby/telemetry"
)

// A HELD QUESTION (ADR-0034). Claude Code runs the lobby's PermissionRequest
// hook for an AskUserQuestion while it draws its own menu, and the two race:
// whichever answers first wins. The hook (devvm/claude-se-hook question) posts
// its stdin here and waits. The question card answers through POST /answer
// with the whole call's answers, and this file hands the hook the JSON it
// prints for the CLI. When the terminal answers first, the transcript records
// the result and the hook is let go with nothing to print.
//
// This replaces reading the pane to find where the dialog is. Since the
// 2026-09-10 rework 27 of 237 pane-driven answers failed, and a dialog taller
// than the pane could not be read at all. The hook gets the question as data,
// the same payload T3 Code gets through the Agent SDK's canUseTool.
//
// Measured on CLI 2.1.283 and relied on here: the hook's stdin carries no
// tool_use_id; `updatedInput` replaces the tool input rather than merging into
// it; answer keys must equal the question text exactly; a multi-select answer
// wants one "A, B" string; the CLI does not kill the hook when the terminal
// answers first, and ignores what it prints afterwards.

// maxHold bounds one hold. The hook's own timeout in the managed settings is
// the same 24 h, so neither end outlives the other by design.
const maxHold = 24 * time.Hour

// hold is one question the hook is waiting on.
type hold struct {
	input     map[string]json.RawMessage // the tool input, echoed back whole
	questions []heldQuestion
	texts     string      // the question texts joined, which name the call
	reply     chan []byte // the hook's stdout; buffered, written once
	since     time.Time
	calls     int // how many calls the session held once this one was added
	once      sync.Once
}

// heldQuestion is the part of a question the answer is checked against.
type heldQuestion struct {
	Question    string `json:"question"`
	MultiSelect bool   `json:"multiSelect,omitempty"`
}

// settle hands the hook its output, once. A later call is a no-op and says so.
func (h *hold) settle(out []byte) bool {
	done := false
	h.once.Do(func() {
		h.reply <- out
		done = true
	})
	return done
}

// holdSet is every hold in the process, keyed by user and transcript. The
// transcript and not the tmux name, because a session can be renamed while its
// question waits, and the transcript is what both the hook and a lookup by
// name agree on.
//
// A session can hold SEVERAL calls at once. Claude Code runs the hook for every
// AskUserQuestion in one assistant message together, and the terminal shows
// their menus one after another. Measured 2026-10-01: five grilling rounds
// across two sessions asked two or three calls at once, and while a newer call
// replaced the older here, the card answered the last one and every other had
// to be answered in the terminal. They are kept in the order the hooks arrived,
// which is the order the terminal shows them in.
type holdSet struct {
	mu sync.Mutex
	m  map[string][]*hold
}

func newHoldSet() *holdSet { return &holdSet{m: map[string][]*hold{}} }

func holdKey(osUser, transcript string) string { return osUser + "\x00" + transcript }

// put adds h after the session's other holds and publishes the lot. A hold
// asking exactly what h asks is the same call asked again (Claude Code takes a
// dialog down and re-asks when something else claims the turn, and the first
// call never gets a result), so h takes its place and it is returned. n is how
// many calls the session holds now.
//
// publish runs under the set's lock, so two hooks changing one session's holds
// at once cannot publish them out of order.
func (s *holdSet) put(key string, h *hold, publish func(string) bool) (prev *hold, n int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	list := s.m[key]
	for i, o := range list {
		if o.texts == h.texts {
			prev = o
			list = append(list[:i:i], list[i+1:]...)
			break
		}
	}
	list = append(list, h)
	s.m[key] = list
	publish(heldBody(list))
	return prev, len(list)
}

// drop removes h and publishes what is left, and reports whether h was still
// held: a hold that was replaced is gone already.
func (s *holdSet) drop(key string, h *hold, publish func(string) bool) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	list := s.m[key]
	for i, o := range list {
		if o != h {
			continue
		}
		list = append(list[:i:i], list[i+1:]...)
		if len(list) == 0 {
			delete(s.m, key)
		} else {
			s.m[key] = list
		}
		publish(heldBody(list))
		return true
	}
	return false
}

// find returns the hold req answers, or nil. The call req names, when it names
// one. Otherwise, for a client from before Call: the first hold that asks one
// of the questions Answers is keyed by, and failing that the oldest, which is
// also where Chat goes. An answer that reaches the oldest with keys that are
// not its questions is refused as incomplete, as it always was.
func (s *holdSet) find(key string, req sessionio.AnswerRequest) *hold {
	s.mu.Lock()
	defer s.mu.Unlock()
	list := s.m[key]
	if len(list) == 0 {
		return nil
	}
	if len(req.Call) > 0 {
		want := strings.Join(req.Call, "\x00")
		for _, h := range list {
			if h.texts == want {
				return h
			}
		}
		return nil
	}
	for _, h := range list {
		for _, q := range h.questions {
			if _, ok := req.Answers[q.Question]; ok {
				return h
			}
		}
	}
	return list[0]
}

// questionHookBody is the hook's stdin plus the three fields the hook adds.
type questionHookBody struct {
	User           string          `json:"user"`
	TmuxSession    string          `json:"tmux_session"`
	TranscriptPath string          `json:"transcript_path"`
	ToolName       string          `json:"tool_name"`
	ToolInput      json.RawMessage `json:"tool_input"`
	// Since is when the hook first ran, epoch ms. It stays the same across the
	// hook's reconnects, which is what lets a hold that begins after a restart
	// see a result the terminal wrote while nothing was listening.
	Since int64 `json:"since"`
}

// handleQuestionHook serves POST /hooks/question. Every answer that is not a
// decision is 204, which the hook turns into printing nothing, and printing
// nothing leaves the CLI's menu to the terminal. So an unregistered session, a
// tool that is not AskUserQuestion, and a call already settled all fall back to
// the behaviour the CLI has without us.
func (rg *registry) handleQuestionHook() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b questionHookBody
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, hookBodyLimit)).Decode(&b) != nil ||
			b.User == "" || b.TmuxSession == "" {
			http.Error(w, "bad body (need user, tmux_session, tool_input)", http.StatusBadRequest)
			return
		}
		if b.ToolName != askQuestionTool {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		var input map[string]json.RawMessage
		var parsed struct {
			Questions []heldQuestion `json:"questions"`
		}
		if json.Unmarshal(b.ToolInput, &input) != nil || json.Unmarshal(b.ToolInput, &parsed) != nil ||
			len(parsed.Questions) == 0 {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		ls, ok := rg.live(b.User, b.TmuxSession)
		if !ok {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		fs := ls.fs
		since := time.UnixMilli(b.Since)
		if b.Since <= 0 {
			since = time.Now()
		}
		h := &hold{input: input, questions: parsed.Questions, texts: joinTexts(parsed.Questions),
			reply: make(chan []byte, 1), since: since}

		// Subscribe BEFORE reading what is already there, so nothing written
		// between the two is missed. Holding a subscription also keeps the
		// source alive through the idle sweep for as long as the hook waits.
		live, unsubscribe := fs.Subscribe()
		defer unsubscribe()
		watch := newSettleWatch(h)
		for _, e := range fs.ReplayWindow(0, answerKnownTurns) {
			if watch.settledBy(e) {
				emitHold(b.User, b.TmuxSession, "already", h)
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}

		key := holdKey(b.User, fs.Path())
		prev, n := rg.holds.put(key, h, fs.SetHeld)
		if prev != nil {
			prev.settle(nil)
		}
		h.calls = n
		// Withdrawn only while it is still held: the same call asked again
		// has taken its place by now.
		defer rg.holds.drop(key, h, fs.SetHeld)
		emitHold(b.User, b.TmuxSession, "held", h)

		limit := time.NewTimer(maxHold)
		defer limit.Stop()
		for {
			select {
			case <-r.Context().Done():
				emitHold(b.User, b.TmuxSession, "hung-up", h)
				return
			case out := <-h.reply:
				if out == nil {
					emitHold(b.User, b.TmuxSession, "replaced", h)
					w.WriteHeader(http.StatusNoContent)
					return
				}
				emitHold(b.User, b.TmuxSession, "answered", h)
				w.Header().Set("Content-Type", "application/json")
				w.Write(out)
				return
			case e, open := <-live:
				if !open {
					// The source was retired: the tmux name points at another
					// transcript now, so this Claude is gone.
					emitHold(b.User, b.TmuxSession, "gone", h)
					w.WriteHeader(http.StatusNoContent)
					return
				}
				if watch.settledBy(e) {
					emitHold(b.User, b.TmuxSession, "terminal", h)
					w.WriteHeader(http.StatusNoContent)
					return
				}
			case <-limit.C:
				emitHold(b.User, b.TmuxSession, "expired", h)
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
	}
}

// heldBody is the MetaHeld body for a session's holds, or "" for none: each
// call's questions exactly as sent, oldest first, under "calls", and the
// oldest's again under "questions", which is all a page from before "calls"
// reads. That page then answers the oldest, by its keys, which find accepts.
func heldBody(list []*hold) string {
	if len(list) == 0 {
		return ""
	}
	type call struct {
		Questions json.RawMessage `json:"questions"`
	}
	calls := make([]call, len(list))
	for i, h := range list {
		calls[i] = call{Questions: h.input["questions"]}
	}
	b, err := json.Marshal(struct {
		Questions json.RawMessage `json:"questions"`
		Calls     []call          `json:"calls"`
	}{calls[0].Questions, calls})
	if err != nil {
		return ""
	}
	return string(b)
}

// settleWatch reads the transcript for the sign that a held call is over: its
// own result, or the turn ending. The call is recognised by its question text,
// since the hook's stdin has no tool id; one asked and answered before the hold
// began is ignored by time.
type settleWatch struct {
	h     *hold
	texts string          // the call's question texts, joined
	ids   map[string]bool // AskUserQuestion calls asking exactly this
}

func newSettleWatch(h *hold) *settleWatch {
	return &settleWatch{h: h, texts: h.texts, ids: map[string]bool{}}
}

func joinTexts(qs []heldQuestion) string {
	t := make([]string, len(qs))
	for i, q := range qs {
		t[i] = q.Question
	}
	return strings.Join(t, "\x00")
}

func (s *settleWatch) settledBy(e sessionio.Event) bool {
	switch e.Kind {
	case sessionio.KindToolUse:
		if e.Tool != askQuestionTool {
			return false
		}
		var in struct {
			Questions []heldQuestion `json:"questions"`
		}
		if json.Unmarshal([]byte(e.Body), &in) == nil && joinTexts(in.Questions) == s.texts {
			s.ids[e.ToolID] = true
		}
	case sessionio.KindToolResult:
		return s.ids[e.ToolID] && s.after(e)
	case sessionio.KindTurnEnd:
		return s.after(e)
	}
	return false
}

// after is whether e happened once the hook was running. An event with no time
// counts, since a live event is by definition after the subscription.
func (s *settleWatch) after(e sessionio.Event) bool {
	return e.At == 0 || !time.UnixMilli(e.At).Before(s.h.since)
}

// heldQuestions is the shape of the held call req answers, for the answer
// record's tl.questions and tl.multi, or nil when no such call is held.
func (rg *registry) heldQuestions(osUser, transcript string, req sessionio.AnswerRequest) []sessionio.DialogQuestion {
	h := rg.holds.find(holdKey(osUser, transcript), req)
	if h == nil {
		return nil
	}
	out := make([]sessionio.DialogQuestion, len(h.questions))
	for i, q := range h.questions {
		out[i] = sessionio.DialogQuestion{Question: q.Question, MultiSelect: q.MultiSelect}
	}
	return out
}

// settleHeld answers the held call req names with its Answers or Chat. The
// reply carries no dialog: once the hook has the answer the CLI takes its menu
// down and the transcript records the result.
func (rg *registry) settleHeld(osUser, transcript string, req sessionio.AnswerRequest) sessionio.AnswerResponse {
	h := rg.holds.find(holdKey(osUser, transcript), req)
	if h == nil {
		return sessionio.AnswerResponse{Reason: sessionio.AnswerNotHeld}
	}
	var decision any
	if req.Chat != nil {
		decision = map[string]any{"behavior": "deny", "message": chatMessage(*req.Chat)}
	} else {
		answers, ok := h.answers(req.Answers)
		if !ok {
			return sessionio.AnswerResponse{Reason: sessionio.AnswerIncomplete}
		}
		updated := make(map[string]any, len(h.input)+1)
		for k, v := range h.input {
			updated[k] = v
		}
		updated["answers"] = answers
		decision = map[string]any{"behavior": "allow", "updatedInput": updated}
	}
	out, err := json.Marshal(map[string]any{"hookSpecificOutput": map[string]any{
		"hookEventName": "PermissionRequest", "decision": decision,
	}})
	if err != nil || !h.settle(out) {
		// Already settled: another tap, or the hook let go a moment ago.
		return sessionio.AnswerResponse{Reason: sessionio.AnswerNotHeld}
	}
	return sessionio.AnswerResponse{Applied: true, Done: true}
}

// answers builds the CLI's answer map from the card's, keyed by the held
// question text, or reports that a question is left without an answer. Claude
// reads a missing answer as a skipped question, so a partial map is refused
// rather than sent.
func (h *hold) answers(got map[string][]string) (map[string]string, bool) {
	out := make(map[string]string, len(h.questions))
	for _, q := range h.questions {
		var picks []string
		for _, p := range got[q.Question] {
			if p = strings.TrimSpace(p); p != "" {
				picks = append(picks, p)
			}
		}
		if len(picks) == 0 {
			return nil, false
		}
		out[q.Question] = strings.Join(picks, ", ")
	}
	return out, true
}

// chatMessage is what Claude reads when the reader declines the question to
// talk instead. The CLI shows a deny message as an error, so the words say
// plainly that this is the reader's choice and what to do next.
func chatMessage(words string) string {
	words = strings.TrimSpace(words)
	if words == "" {
		return "The user chose not to answer these questions and wants to talk about them instead. " +
			"Do not ask them again; wait for the user's next message."
	}
	return "The user chose not to pick an answer and replied instead: " + words
}

// emitHold records a hold beginning or ending: tl.outcome says how,
// tl.questions how many questions the call asked, and tl.calls how many calls
// the session held once it was added (above 1 for calls asked together). Never
// the questions themselves (ADR-0008).
func emitHold(osUser, session, outcome string, h *hold) {
	events.Emit("question.hold", osUser, telemetry.Attrs{
		"tl.session": session, "tl.outcome": outcome, "tl.questions": len(h.questions),
		"tl.calls": h.calls, "tl.held_ms": time.Since(h.since).Milliseconds(),
	})
}
