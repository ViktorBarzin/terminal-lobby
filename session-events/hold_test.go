package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"terminal-lobby/sessionio"
	"terminal-lobby/sessionio/siotest"
)

// A held question (ADR-0034): the PermissionRequest hook hands an
// AskUserQuestion to POST /hooks/question and waits, the card answers it
// through POST /answer, and the hook's reply is the JSON it prints for the
// CLI. The CLI draws its own menu the whole time, so the terminal can answer
// first, and the transcript saying so is what lets the hook go.

// holdInput is the tool input as the hook receives it on stdin. The extra
// top-level field stands for anything the CLI adds beside `questions`, which
// has to come back untouched because updatedInput replaces the input.
const holdInput = `{"questions":[` +
	`{"question":"Pick a colour","header":"Colour","options":[{"label":"Red"},{"label":"Blue"}]},` +
	`{"question":"Pick fruits","header":"Fruit","multiSelect":true,"options":[` +
	`{"label":"Apple","preview":"🍎"},{"label":"Pear"},{"label":"Plum"}]}],` +
	`"metadata":{"source":"test"}}`

// The same call as Claude Code records it, and the result the terminal's
// answer writes.
const (
	holdAskLine = `{"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use","content":[` +
		`{"type":"tool_use","id":"tu_h","name":"AskUserQuestion","input":` + holdInput + `}]},` +
		`"uuid":"h1","timestamp":"2026-09-27T12:00:01Z"}`
	holdResultLine = `{"type":"user","message":{"role":"user","content":[` +
		`{"type":"tool_result","tool_use_id":"tu_h","content":"Blue"}]},` +
		`"uuid":"h2","timestamp":"2026-09-27T12:00:09Z"}`
	holdEndLine = `{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[` +
		`{"type":"text","text":"ok"}]},"uuid":"h3","timestamp":"2026-09-27T12:00:10Z"}`
)

// holdSince is when the hook first ran, in epoch ms: before the call's
// timestamps above, so a result among them counts as this hold's.
var holdSince = time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC).UnixMilli()

type holdEnv struct {
	t    *testing.T
	rg   *registry
	path string
	mux  *http.ServeMux
}

// newHoldEnv registers "demo" for "wizard" over a transcript holding lines.
func newHoldEnv(t *testing.T, lines ...string) *holdEnv {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	home := t.TempDir()
	path := sessionio.TranscriptPath(sessionio.ProjectsRoot(home, "wizard"), "/home/wizard/x", "s1")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	body := ""
	if len(lines) > 0 {
		body = strings.Join(lines, "\n") + "\n"
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	rg := newRegistry(ctx, time.Millisecond, home, siotest.NewFakeOptions("wizard/demo"), "wizard")
	w := httptest.NewRecorder()
	rg.handleSessionStart()(w, httptest.NewRequest(http.MethodPost, "/hooks/session-start",
		strings.NewReader(`{"user":"wizard","session_id":"s1","cwd":"/home/wizard/x","tmux_session":"demo"}`)))
	if w.Code != http.StatusNoContent {
		t.Fatalf("session-start: %d (%s)", w.Code, w.Body.String())
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /answer/{session}", handleAnswer(rg, &fakeAnswerDriver{}))
	return &holdEnv{t: t, rg: rg, path: path, mux: mux}
}

// appendLines writes more of the transcript, as the CLI would.
func (e *holdEnv) appendLines(lines ...string) {
	e.t.Helper()
	f, err := os.OpenFile(e.path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		e.t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(strings.Join(lines, "\n") + "\n"); err != nil {
		e.t.Fatal(err)
	}
}

// hookCall is one POST /hooks/question in flight.
type hookCall struct {
	rec    *httptest.ResponseRecorder
	done   chan struct{}
	cancel context.CancelFunc
}

// hook starts the hook's request with the given tool and input and returns
// while it waits.
func (e *holdEnv) hook(tool, input string, since int64) *hookCall {
	e.t.Helper()
	body := `{"user":"wizard","tmux_session":"demo","session_id":"s1","transcript_path":"` + e.path +
		`","hook_event_name":"PermissionRequest","tool_name":"` + tool + `","tool_input":` + input +
		`,"since":` + jsonInt(since) + `}`
	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodPost, "/hooks/question", strings.NewReader(body)).WithContext(ctx)
	c := &hookCall{rec: httptest.NewRecorder(), done: make(chan struct{}), cancel: cancel}
	go func() {
		defer close(c.done)
		e.rg.handleQuestionHook()(c.rec, req)
	}()
	// Wait for the request to return, so no hold outlives its test and emits
	// into the next one's sink.
	e.t.Cleanup(func() {
		cancel()
		<-c.done
	})
	return c
}

func jsonInt(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}

// wait returns once the hook's request has been answered.
func (c *hookCall) wait(t *testing.T) *httptest.ResponseRecorder {
	t.Helper()
	select {
	case <-c.done:
		return c.rec
	case <-time.After(3 * time.Second):
		t.Fatal("the hook is still waiting")
		return nil
	}
}

// stillWaiting fails if the hook's request has been answered.
func (c *hookCall) stillWaiting(t *testing.T) {
	t.Helper()
	select {
	case <-c.done:
		t.Fatalf("the hook was answered (%d %s) and should still be waiting", c.rec.Code, c.rec.Body.String())
	case <-time.After(100 * time.Millisecond):
	}
}

// held is the newest MetaHeld body the session's stream carries, and whether
// there is one at all.
func (e *holdEnv) held() (string, bool) {
	fs, ok := e.rg.source("wizard", "demo")
	if !ok {
		e.t.Fatal("session not registered")
	}
	body, seen := "", false
	for _, ev := range fs.Replay(0) {
		if ev.Kind == sessionio.KindMeta && ev.Meta == sessionio.MetaHeld {
			body, seen = ev.Body, true
		}
	}
	return body, seen
}

// waitHeld waits for the stream to say a question is held.
func (e *holdEnv) waitHeld() string {
	e.t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if b, _ := e.held(); b != "" {
			return b
		}
		time.Sleep(5 * time.Millisecond)
	}
	e.t.Fatal("the stream never said a question was held")
	return ""
}

// waitReleased waits for the stream to withdraw the held question.
func (e *holdEnv) waitReleased() {
	e.t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if b, seen := e.held(); seen && b == "" {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	b, _ := e.held()
	e.t.Fatalf("the held question was not withdrawn; newest reading %q", b)
}

func (e *holdEnv) answer(body string) sessionio.AnswerResponse {
	e.t.Helper()
	rec := postAnswer(e.t, e.mux, "demo", body)
	if rec.Code != http.StatusOK {
		e.t.Fatalf("POST /answer: %d %s", rec.Code, rec.Body.String())
	}
	return decodeAnswer(e.t, rec)
}

// hookOutput decodes what the hook prints.
type hookOutput struct {
	HookSpecificOutput struct {
		HookEventName string `json:"hookEventName"`
		Decision      struct {
			Behavior     string                     `json:"behavior"`
			Message      string                     `json:"message"`
			UpdatedInput map[string]json.RawMessage `json:"updatedInput"`
		} `json:"decision"`
	} `json:"hookSpecificOutput"`
}

func decodeHook(t *testing.T, rec *httptest.ResponseRecorder) hookOutput {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("hook reply: want 200 carrying a decision, got %d %s", rec.Code, rec.Body.String())
	}
	var out hookOutput
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("hook reply is not hook output (%v): %s", err, rec.Body.String())
	}
	if out.HookSpecificOutput.HookEventName != "PermissionRequest" {
		t.Fatalf("hookEventName = %q", out.HookSpecificOutput.HookEventName)
	}
	return out
}

func TestAHeldQuestionIsAnsweredFromTheCard(t *testing.T) {
	sink := captureEvents(t)
	e := newHoldEnv(t)
	c := e.hook("AskUserQuestion", holdInput, holdSince)

	held := e.waitHeld()
	// The card is drawn from this, previews and all, before the transcript
	// has the call.
	var got struct {
		Questions []map[string]any `json:"questions"`
	}
	if err := json.Unmarshal([]byte(held), &got); err != nil || len(got.Questions) != 2 {
		t.Fatalf("held body = %s (%v)", held, err)
	}
	if !strings.Contains(held, `"preview":"🍎"`) {
		t.Fatalf("the held questions lost the option preview: %s", held)
	}

	resp := e.answer(`{"answers":{"Pick a colour":["Blue"],"Pick fruits":["Apple","Plum"]}}`)
	if !resp.Applied || !resp.Done {
		t.Fatalf("answer: %+v", resp)
	}
	// The record says what shape of call was answered, as the pane-driven
	// answers always did.
	if got := sink.only(t, "text.answer_sent"); got["tl.questions"] != float64(2) || got["tl.multi"] != true ||
		got["tl.action"] != "answers" {
		t.Fatalf("text.answer_sent attrs = %v", got)
	}

	out := decodeHook(t, c.wait(t))
	d := out.HookSpecificOutput.Decision
	if d.Behavior != "allow" {
		t.Fatalf("behavior = %q", d.Behavior)
	}
	// Multi-select answers go as one "A, B" string: an array reaches the
	// model as "A,B" and the CLI draws no answer row for it (measured on
	// 2.1.283).
	var answers map[string]string
	if err := json.Unmarshal(d.UpdatedInput["answers"], &answers); err != nil {
		t.Fatalf("answers: %v (%s)", err, d.UpdatedInput["answers"])
	}
	if answers["Pick a colour"] != "Blue" || answers["Pick fruits"] != "Apple, Plum" || len(answers) != 2 {
		t.Fatalf("answers = %v", answers)
	}
	// updatedInput REPLACES the input, so everything the CLI sent comes back
	// byte for byte beside the answers.
	var in map[string]json.RawMessage
	json.Unmarshal([]byte(holdInput), &in)
	for k, v := range in {
		if string(d.UpdatedInput[k]) != string(v) {
			t.Fatalf("updatedInput[%q] = %s, want %s", k, d.UpdatedInput[k], v)
		}
	}
	e.waitReleased()
}

func TestChatAboutThisDeclinesWithTheReadersWords(t *testing.T) {
	e := newHoldEnv(t)
	c := e.hook("AskUserQuestion", holdInput, holdSince)
	e.waitHeld()

	resp := e.answer(`{"chat":"neither, use green"}`)
	if !resp.Applied {
		t.Fatalf("chat: %+v", resp)
	}
	d := decodeHook(t, c.wait(t)).HookSpecificOutput.Decision
	if d.Behavior != "deny" || !strings.Contains(d.Message, "neither, use green") {
		t.Fatalf("decision = %+v", d)
	}
	e.waitReleased()
}

func TestChatAboutThisWithNoWordsStillDeclines(t *testing.T) {
	e := newHoldEnv(t)
	c := e.hook("AskUserQuestion", holdInput, holdSince)
	e.waitHeld()

	e.answer(`{"chat":""}`)
	d := decodeHook(t, c.wait(t)).HookSpecificOutput.Decision
	if d.Behavior != "deny" || strings.TrimSpace(d.Message) == "" {
		t.Fatalf("decision = %+v", d)
	}
}

func TestAnIncompleteAnswerIsRefusedAndTheHookKeepsWaiting(t *testing.T) {
	e := newHoldEnv(t)
	c := e.hook("AskUserQuestion", holdInput, holdSince)
	e.waitHeld()

	for _, body := range []string{
		`{"answers":{"Pick a colour":["Blue"]}}`,
		`{"answers":{"Pick a colour":["Blue"],"Pick fruits":[]}}`,
		`{"answers":{"Pick a colour":["Blue"],"Pick fruits":["  "]}}`,
		// A key that is not the question's text exactly, the trailing "?"
		// that reached Claude as "did not answer" in the probe.
		`{"answers":{"Pick a colour":["Blue"],"Pick fruits?":["Pear"]}}`,
	} {
		resp := e.answer(body)
		if resp.Applied || resp.Reason != sessionio.AnswerIncomplete {
			t.Fatalf("%s: %+v", body, resp)
		}
	}
	c.stillWaiting(t)
}

func TestAnAnswerWithNothingHeldSaysSo(t *testing.T) {
	e := newHoldEnv(t, holdAskLine)
	resp := e.answer(`{"answers":{"Pick a colour":["Blue"],"Pick fruits":["Pear"]}}`)
	if resp.Applied || resp.Reason != sessionio.AnswerNotHeld {
		t.Fatalf("resp = %+v", resp)
	}
	resp = e.answer(`{"chat":"hi"}`)
	if resp.Applied || resp.Reason != sessionio.AnswerNotHeld {
		t.Fatalf("resp = %+v", resp)
	}
}

func TestTheTerminalAnsweringFirstLetsTheHookGo(t *testing.T) {
	e := newHoldEnv(t)
	c := e.hook("AskUserQuestion", holdInput, holdSince)
	e.waitHeld()

	// The CLI writes the call and its result, possibly together: the record
	// is sometimes not written until the question is answered.
	e.appendLines(holdAskLine, holdResultLine)

	rec := c.wait(t)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("hook reply: want 204, got %d %s", rec.Code, rec.Body.String())
	}
	e.waitReleased()
	if resp := e.answer(`{"answers":{"Pick a colour":["Red"],"Pick fruits":["Pear"]}}`); resp.Reason != sessionio.AnswerNotHeld {
		t.Fatalf("a released question still took an answer: %+v", resp)
	}
}

func TestTheTurnEndingLetsTheHookGo(t *testing.T) {
	e := newHoldEnv(t, holdAskLine)
	c := e.hook("AskUserQuestion", holdInput, holdSince)
	e.waitHeld()

	e.appendLines(holdEndLine)
	if rec := c.wait(t); rec.Code != http.StatusNoContent {
		t.Fatalf("hook reply: want 204, got %d", rec.Code)
	}
	e.waitReleased()
}

func TestAHookThatHangsUpWithdrawsTheQuestion(t *testing.T) {
	e := newHoldEnv(t)
	c := e.hook("AskUserQuestion", holdInput, holdSince)
	e.waitHeld()

	c.cancel()
	c.wait(t)
	e.waitReleased()
}

// A hook reconnecting after session-events restarted must not wait on a call
// the terminal answered while nothing was listening.
func TestAQuestionAnsweredBeforeTheHoldIsNotHeld(t *testing.T) {
	e := newHoldEnv(t, holdAskLine, holdResultLine)
	c := e.hook("AskUserQuestion", holdInput, holdSince)
	if rec := c.wait(t); rec.Code != http.StatusNoContent {
		t.Fatalf("hook reply: want 204, got %d %s", rec.Code, rec.Body.String())
	}
	if b, _ := e.held(); b != "" {
		t.Fatalf("a settled call was published as held: %s", b)
	}
}

// The same question asked and answered EARLIER in the session is not this
// call's answer.
func TestAnEarlierIdenticalCallDoesNotReleaseANewOne(t *testing.T) {
	e := newHoldEnv(t, holdAskLine, holdResultLine)
	later := time.Date(2026, 9, 27, 12, 5, 0, 0, time.UTC).UnixMilli()
	c := e.hook("AskUserQuestion", holdInput, later)
	e.waitHeld()
	c.stillWaiting(t)
}

func TestOtherToolsAreNotHeld(t *testing.T) {
	e := newHoldEnv(t)
	c := e.hook("Bash", `{"command":"ls"}`, holdSince)
	if rec := c.wait(t); rec.Code != http.StatusNoContent {
		t.Fatalf("hook reply: want 204, got %d", rec.Code)
	}
	if _, seen := e.held(); seen {
		t.Fatal("a Bash permission was published as a held question")
	}
}

// heldCalls is the newest MetaHeld body's calls, each as its question texts.
func (e *holdEnv) heldCalls() [][]string {
	e.t.Helper()
	b, _ := e.held()
	if b == "" {
		return nil
	}
	type texts struct {
		Questions []struct {
			Question string `json:"question"`
		} `json:"questions"`
	}
	var got struct {
		texts
		Calls []texts `json:"calls"`
	}
	if err := json.Unmarshal([]byte(b), &got); err != nil {
		e.t.Fatalf("held body %s: %v", b, err)
	}
	var out [][]string
	for _, c := range got.Calls {
		var qs []string
		for _, q := range c.Questions {
			qs = append(qs, q.Question)
		}
		out = append(out, qs)
	}
	// The top level is the first call, for a page from before "calls".
	if len(out) == 0 || len(got.Questions) != len(out[0]) || got.Questions[0].Question != out[0][0] {
		e.t.Fatalf("held body's top-level questions are not its first call's: %s", b)
	}
	return out
}

// waitCalls waits for the stream to hold exactly these calls, in order, each
// named by its first question.
func (e *holdEnv) waitCalls(first ...string) {
	e.t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		var got []string
		for _, c := range e.heldCalls() {
			got = append(got, c[0])
		}
		if strings.Join(got, "|") == strings.Join(first, "|") {
			return
		}
		if time.Now().After(deadline) {
			e.t.Fatalf("held calls = %q, want %q", got, first)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// sizeInput is a second call asked alongside holdInput. Claude Code runs the
// hook for every AskUserQuestion in one assistant message at once, while the
// terminal shows their menus one after another (measured 2026-10-01: five
// grilling rounds of two or three parallel calls across two sessions).
const sizeInput = `{"questions":[{"question":"Pick a size","header":"Size","options":[{"label":"S"},{"label":"L"}]}]}`

const (
	sizeAskLine = `{"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use","content":[` +
		`{"type":"tool_use","id":"tu_s","name":"AskUserQuestion","input":` + sizeInput + `}]},` +
		`"uuid":"s1","timestamp":"2026-09-27T12:00:02Z"}`
	sizeResultLine = `{"type":"user","message":{"role":"user","content":[` +
		`{"type":"tool_result","tool_use_id":"tu_s","content":"L"}]},` +
		`"uuid":"s2","timestamp":"2026-09-27T12:00:08Z"}`
)

// heldPair starts holdInput's hook and then sizeInput's, and waits until both
// are held, oldest first.
func (e *holdEnv) heldPair() (first, second *hookCall) {
	e.t.Helper()
	first = e.hook("AskUserQuestion", holdInput, holdSince)
	e.waitCalls("Pick a colour")
	second = e.hook("AskUserQuestion", sizeInput, holdSince+1)
	e.waitCalls("Pick a colour", "Pick a size")
	return first, second
}

// Two calls asked together are both held, oldest first, and each is answered
// on its own. Until 2026-10-01 the second replaced the first, which left the
// first answerable only in the terminal.
func TestParallelCallsAreHeldTogetherAndAnsweredOneByOne(t *testing.T) {
	sink := captureEvents(t)
	e := newHoldEnv(t)
	first, second := e.heldPair()
	first.stillWaiting(t)

	resp := e.answer(`{"call":["Pick a size"],"answers":{"Pick a size":["L"]}}`)
	if !resp.Applied {
		t.Fatalf("answer to the second call: %+v", resp)
	}
	if got := sink.only(t, "text.answer_sent"); got["tl.questions"] != float64(1) || got["tl.multi"] != false {
		t.Fatalf("text.answer_sent describes the wrong call: %v", got)
	}
	if d := decodeHook(t, second.wait(t)).HookSpecificOutput.Decision; d.Behavior != "allow" {
		t.Fatalf("second decision = %+v", d)
	}
	e.waitCalls("Pick a colour")
	first.stillWaiting(t)

	resp = e.answer(`{"call":["Pick a colour","Pick fruits"],` +
		`"answers":{"Pick a colour":["Red"],"Pick fruits":["Pear"]}}`)
	if !resp.Applied {
		t.Fatalf("answer to the first call: %+v", resp)
	}
	var answers map[string]string
	d := decodeHook(t, first.wait(t)).HookSpecificOutput.Decision
	if err := json.Unmarshal(d.UpdatedInput["answers"], &answers); err != nil || answers["Pick a colour"] != "Red" {
		t.Fatalf("first answers = %v (%v)", answers, err)
	}
	e.waitReleased()
}

// An answer that does not name its call goes to the call its keys belong to,
// and "Chat about this" with no call declines the oldest: what a page from
// before "call" sends.
func TestAnAnswerWithoutACallFindsItsOwn(t *testing.T) {
	e := newHoldEnv(t)
	first, second := e.heldPair()

	if resp := e.answer(`{"answers":{"Pick a size":["S"]}}`); !resp.Applied {
		t.Fatalf("keyed answer: %+v", resp)
	}
	decodeHook(t, second.wait(t))
	e.waitCalls("Pick a colour")

	if resp := e.answer(`{"chat":"later"}`); !resp.Applied {
		t.Fatalf("chat: %+v", resp)
	}
	if d := decodeHook(t, first.wait(t)).HookSpecificOutput.Decision; d.Behavior != "deny" {
		t.Fatalf("chat decision = %+v", d)
	}
	e.waitReleased()
}

// "Chat about this" declines only the call it names.
func TestChatAboutThisDeclinesOnlyItsCall(t *testing.T) {
	e := newHoldEnv(t)
	first, second := e.heldPair()

	if resp := e.answer(`{"call":["Pick a size"],"chat":"skip sizes"}`); !resp.Applied {
		t.Fatalf("chat: %+v", resp)
	}
	if d := decodeHook(t, second.wait(t)).HookSpecificOutput.Decision; d.Behavior != "deny" {
		t.Fatalf("decision = %+v", d)
	}
	e.waitCalls("Pick a colour")
	first.stillWaiting(t)
}

// An answer naming a call nothing holds is refused, and nothing is settled.
func TestAnAnswerNamingAnUnheldCallIsRefused(t *testing.T) {
	e := newHoldEnv(t)
	c := e.hook("AskUserQuestion", holdInput, holdSince)
	e.waitCalls("Pick a colour")
	for _, body := range []string{
		`{"call":["Pick a size"],"answers":{"Pick a size":["L"]}}`,
		`{"call":["Pick a size"],"chat":"no"}`,
	} {
		if resp := e.answer(body); resp.Applied || resp.Reason != sessionio.AnswerNotHeld {
			t.Fatalf("%s: %+v", body, resp)
		}
	}
	c.stillWaiting(t)
}

// The terminal answering one of two parallel calls lets only that hook go.
func TestTheTerminalAnsweringOneParallelCallKeepsTheOther(t *testing.T) {
	e := newHoldEnv(t)
	first, second := e.heldPair()

	e.appendLines(holdAskLine, sizeAskLine, holdResultLine)
	if rec := first.wait(t); rec.Code != http.StatusNoContent {
		t.Fatalf("first hook: want 204, got %d", rec.Code)
	}
	e.waitCalls("Pick a size")
	second.stillWaiting(t)

	e.appendLines(sizeResultLine)
	if rec := second.wait(t); rec.Code != http.StatusNoContent {
		t.Fatalf("second hook: want 204, got %d", rec.Code)
	}
	e.waitReleased()
}

// The same call asked again replaces the one before it: Claude Code takes a
// dialog down and re-asks when something else claims the turn, and the first
// call never gets a result.
func TestTheSameCallAskedAgainReplacesTheOlder(t *testing.T) {
	e := newHoldEnv(t)
	old := e.hook("AskUserQuestion", holdInput, holdSince)
	e.waitCalls("Pick a colour")

	c := e.hook("AskUserQuestion", holdInput, holdSince+1)
	if rec := old.wait(t); rec.Code != http.StatusNoContent {
		t.Fatalf("older hook: want 204, got %d", rec.Code)
	}
	e.waitCalls("Pick a colour")
	e.answer(`{"answers":{"Pick a colour":["Red"],"Pick fruits":["Pear"]}}`)
	if d := decodeHook(t, c.wait(t)).HookSpecificOutput.Decision; d.Behavior != "allow" {
		t.Fatalf("decision = %+v", d)
	}
}

func TestAnUnregisteredSessionIsNotHeld(t *testing.T) {
	e := newHoldEnv(t)
	body := `{"user":"wizard","tmux_session":"ghost","session_id":"s9","transcript_path":"/nope",` +
		`"tool_name":"AskUserQuestion","tool_input":` + holdInput + `,"since":1}`
	rec := httptest.NewRecorder()
	e.rg.handleQuestionHook()(rec, httptest.NewRequest(http.MethodPost, "/hooks/question", strings.NewReader(body)))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("want 204 so the hook leaves the menu to the terminal, got %d", rec.Code)
	}
}
