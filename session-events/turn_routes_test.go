package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"terminal-lobby/sessionio"
	"terminal-lobby/sessionio/siotest"
)

// The three routes that drive a session's turn: POST /prompt, POST /cancel and
// POST /model. They are tested through a stand-in for the Injector, for the
// reason answer_test.go gives: what the routes decide is worth testing on a box
// with no tmux server, and how the Injector types and waits is tested in
// sessionio against real ones.

// fakeTurns records what a route asked of the Injector and answers from its
// fields.
type fakeTurns struct {
	mu    sync.Mutex // calls: the input-line tests drive two routes at once
	calls []string

	// inReclaim, when set, runs inside ReclaimInterrupted, and inPrompt
	// inside Prompt: the seams the input-line tests hold a route open with.
	inReclaim func()
	inPrompt  func()

	awaitErr     error // AwaitInputReady and AwaitReady
	piAwaitErr   error // AwaitPiReady
	trustPending bool
	options      map[string]string
	state        string
	harnessOf    sessionio.Harness
	promptErr    error
	cancelErr    error
	clearTook    bool  // ClearQueue
	clearErr     error // ClearQueue
	reclaimTook  bool  // ReclaimInterrupted
	reclaimErr   error // ReclaimInterrupted
	setModelOut  sessionio.ModelState
	setModelErr  error
	pane         string // CapturePane
	modeOut      sessionio.ModeResult

	awaitedWith sessionio.Harness
	cancelledAs sessionio.Harness
	setModelFor sessionio.Harness
	setModelReq sessionio.ModelState
	prompted    string
	cleared     []string
	reclaimed   string
	stamped     map[string]string // SetOption
}

func (f *fakeTurns) record(name string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, name)
}

func (f *fakeTurns) called(name string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.calls {
		if c == name {
			return true
		}
	}
	return false
}

func (f *fakeTurns) AwaitInputReady(_ context.Context, _, _ string, wait, _ time.Duration) error {
	f.record("AwaitInputReady")
	if wait != PromptReadyWait {
		return errors.New("the wait is not PromptReadyWait")
	}
	return f.awaitErr
}

func (f *fakeTurns) AwaitPiReady(_ context.Context, _, _ string, wait, _ time.Duration) error {
	f.record("AwaitPiReady")
	if wait != PromptReadyWait {
		return errors.New("the wait is not PromptReadyWait")
	}
	return f.piAwaitErr
}

func (f *fakeTurns) AwaitReady(_ context.Context, _, _ string, h sessionio.Harness, wait, _ time.Duration) error {
	f.record("AwaitReady")
	f.awaitedWith = h
	if wait != PromptReadyWait {
		return errors.New("the wait is not PromptReadyWait")
	}
	return f.awaitErr
}

func (f *fakeTurns) PiTrustPending(_, _ string) bool {
	f.record("PiTrustPending")
	return f.trustPending
}

func (f *fakeTurns) Option(_, _, name string) (string, bool) {
	f.record("Option " + name)
	return f.options[name], true
}

func (f *fakeTurns) SetOption(_, _, name, value string) error {
	f.record("SetOption " + name)
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.stamped == nil {
		f.stamped = map[string]string{}
	}
	f.stamped[name] = value
	return nil
}

func (f *fakeTurns) State(_, _ string) string {
	f.record("State")
	return f.state
}

func (f *fakeTurns) Prompt(_, _, text string) error {
	f.record("Prompt")
	if f.inPrompt != nil {
		f.inPrompt()
	}
	f.prompted = text
	return f.promptErr
}

func (f *fakeTurns) HarnessOf(_, _ string) sessionio.Harness {
	f.record("HarnessOf")
	return f.harnessOf
}

func (f *fakeTurns) CancelHarness(_, _ string, h sessionio.Harness) error {
	f.record("CancelHarness")
	f.cancelledAs = h
	return f.cancelErr
}

func (f *fakeTurns) ClearQueue(_, _ string, queued []string) (bool, error) {
	f.record("ClearQueue")
	f.cleared = queued
	return f.clearTook, f.clearErr
}

func (f *fakeTurns) ReclaimInterrupted(_, _, text string) (bool, error) {
	f.record("ReclaimInterrupted")
	if f.inReclaim != nil {
		f.inReclaim()
	}
	f.reclaimed = text
	return f.reclaimTook, f.reclaimErr
}

func (f *fakeTurns) SetModel(_ context.Context, _, _ string, h sessionio.Harness, want sessionio.ModelState) (sessionio.ModelState, error) {
	f.record("SetModel")
	f.setModelFor, f.setModelReq = h, want
	return f.setModelOut, f.setModelErr
}

func (f *fakeTurns) CapturePane(_, _ string) (string, error) {
	f.record("CapturePane")
	return f.pane, nil
}

func (f *fakeTurns) SetMode(_ context.Context, _, _, target string) (sessionio.ModeResult, error) {
	f.record("SetMode " + target)
	return f.modeOut, nil
}

// turnMux serves the three routes over one fake, as the authenticated wizard.
func turnMux(t *testing.T, f *fakeTurns) http.Handler {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	rg := newRegistry(ctx, time.Millisecond, t.TempDir(), siotest.NewFakeOptions(), "wizard")
	mux := http.NewServeMux()
	mux.HandleFunc("POST /prompt/{session}", handlePrompt(rg, f))
	mux.HandleFunc("POST /cancel/{session}", handleCancel(rg, f))
	mux.HandleFunc("POST /model/{session}", handleModel(f))
	return mux
}

func postTurn(t *testing.T, h http.Handler, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req = req.WithContext(context.WithValue(req.Context(), osUserKey, "wizard"))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// --- POST /prompt -------------------------------------------------------------

// The first prompt of a session waits for the pane to be able to take it. A
// session tmux has created accepts send-keys seconds before the harness in it
// reads them, and text sent into that window is lost with every layer reporting
// success (measured 2026-09-04: lost at +0s and +1s, landed at +2s and +3s).
func TestPromptCanWaitForThePaneToBeReady(t *testing.T) {
	f := &fakeTurns{awaitErr: errors.New("no prompt drawn")}
	rec := postTurn(t, turnMux(t, f), "/prompt/demo", `{"text":"hello","awaitReady":true}`)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d, want 503 while the pane is not ready", rec.Code)
	}
	if !f.called("AwaitInputReady") || f.called("Prompt") {
		t.Fatalf("calls = %q, want the wait and no injection", f.calls)
	}

	f = &fakeTurns{}
	if rec := postTurn(t, turnMux(t, f), "/prompt/demo", `{"text":"hello","awaitReady":true}`); rec.Code != http.StatusNoContent {
		t.Fatalf("status %d, want 204 once ready", rec.Code)
	}
	if f.prompted != "hello" {
		t.Fatalf("prompted %q", f.prompted)
	}
}

// A prompt the pane kept on its input line did not reach Claude, so the sender
// is told so, by name, and nothing records it as sent (sessionio.Prompt
// confirms the Enter; measured 2026-09-27, a send answered OK while its text
// sat unsubmitted).
func TestAPromptLeftOnTheInputLineIsNotReportedAsSent(t *testing.T) {
	f := &fakeTurns{promptErr: fmt.Errorf("wrapped: %w", sessionio.ErrPromptNotSubmitted)}
	rec := postTurn(t, turnMux(t, f), "/prompt/demo", `{"text":"hello"}`)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status %d, want 502", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "not submitted") {
		t.Fatalf("body %q, want it to say the prompt was not submitted", rec.Body.String())
	}
}

// Off by default: every caller but the first prompt of a session is talking to
// a pane someone is already looking at.
func TestWaitingIsOptIn(t *testing.T) {
	f := &fakeTurns{awaitErr: errors.New("would refuse")}
	if rec := postTurn(t, turnMux(t, f), "/prompt/demo", `{"text":"hello"}`); rec.Code != http.StatusNoContent {
		t.Fatalf("status %d, want 204", rec.Code)
	}
	if f.called("AwaitInputReady") || f.called("AwaitPiReady") {
		t.Fatalf("a request that did not ask for the wait waited: %q", f.calls)
	}
}

// A mid-turn send queues in Claude, so the lobby's turn gate went away and must
// not come back by reflex: a prompt that arrives mid-turn belongs in Claude's
// own queue, and a 409 loses it. The driver POST /prompt is handed cannot even
// read the turn state. The prompt guard reads OptionAsk, but only to name a
// dialog the transcript holds open (plan.go promptRefusal), so a marker with no
// such call behind it refuses nothing.
func TestPromptDoesNotGateOnTheTurnState(t *testing.T) {
	f := &fakeTurns{state: sessionio.StateRunning, options: map[string]string{sessionio.OptionAsk: "toolu_1"}}
	if rec := postTurn(t, turnMux(t, f), "/prompt/demo", `{"text":"queue this"}`); rec.Code != http.StatusNoContent {
		t.Fatalf("status %d, want 204 whatever the turn is doing", rec.Code)
	}
	if f.called("State") {
		t.Fatalf("POST /prompt read the turn state: %q", f.calls)
	}
}

// The plan approval is the one screen a prompt must never reach: its Enter
// picks the highlighted row, which approves the plan. The refusal names the
// reason so the sender keeps its text, and nothing is typed.
func TestPromptRefusesWhileThePlanIsOpen(t *testing.T) {
	f := &fakeTurns{pane: capture(t, "plan-first.txt")}
	rec := postTurn(t, turnMux(t, f), "/prompt/demo", `{"text":"do it differently"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status %d, want 409 while the plan is drawn", rec.Code)
	}
	if got := strings.TrimSpace(rec.Body.String()); got != `{"applied":false,"reason":"plan-open"}` {
		t.Errorf("body = %s", got)
	}
	if f.called("Prompt") {
		t.Fatal("a prompt was typed into the plan approval")
	}
}

// A tool permission prompt is the same kind of screen: a paste lands on its
// menu, a digit in the text picks a row, and the Enter picks the highlighted
// one, which is "Yes". So it refuses the same way, with a reason of its own.
func TestPromptRefusesWhileAPermissionPromptIsOpen(t *testing.T) {
	f := &fakeTurns{pane: capture(t, "permission-bash.txt")}
	rec := postTurn(t, turnMux(t, f), "/prompt/demo", `{"text":"actually, don't"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status %d, want 409 while the permission prompt is drawn", rec.Code)
	}
	if got := strings.TrimSpace(rec.Body.String()); got != `{"applied":false,"reason":"permission-open"}` {
		t.Errorf("body = %s", got)
	}
	if f.called("Prompt") {
		t.Fatal("a prompt was typed into the permission prompt")
	}
}

// A question is refused the same way: the Enter at the end of a prompt picks
// its highlighted row, and the words are lost.
func TestPromptRefusesWhileAQuestionIsOpen(t *testing.T) {
	f := &fakeTurns{pane: capture(t, "dialog-single.txt")}
	rec := postTurn(t, turnMux(t, f), "/prompt/demo", `{"text":"my queued follow-up note"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status %d, want 409 while a question is drawn", rec.Code)
	}
	if got := strings.TrimSpace(rec.Body.String()); got != `{"applied":false,"reason":"question-open"}` {
		t.Errorf("body = %s", got)
	}
	if f.called("Prompt") {
		t.Fatal("a prompt was typed into the question")
	}
}

// A pane with no plan on it takes the prompt as before.
func TestPromptPassesWhenNoPlanIsDrawn(t *testing.T) {
	f := &fakeTurns{pane: "❯ \n"}
	if rec := postTurn(t, turnMux(t, f), "/prompt/demo", `{"text":"hello"}`); rec.Code != http.StatusNoContent {
		t.Fatalf("status %d, want 204", rec.Code)
	}
	if f.prompted != "hello" {
		t.Fatalf("prompted %q", f.prompted)
	}
}

// A SUSPENDED session is the one thing refused: there is no Claude in it to
// queue anything, and every layer below reports success anyway (measured on
// tmux 3.4, 2026-09-19).
func TestPromptRefusesASuspendedSession(t *testing.T) {
	f := &fakeTurns{options: map[string]string{sessionio.OptionSuspended: "1790000000"}}
	rec := postTurn(t, turnMux(t, f), "/prompt/demo", `{"text":"hello"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status %d, want 409", rec.Code)
	}
	if f.called("Prompt") {
		t.Fatal("a suspended session was typed into")
	}
	if !strings.Contains(rec.Body.String(), "demo") {
		t.Errorf("the refusal does not name the session: %s", rec.Body.String())
	}
}

func TestPromptNeedsText(t *testing.T) {
	for _, body := range []string{``, `{}`, `{"text":""}`, `not json`} {
		f := &fakeTurns{}
		if rec := postTurn(t, turnMux(t, f), "/prompt/demo", body); rec.Code != http.StatusBadRequest {
			t.Errorf("body %q: status %d, want 400", body, rec.Code)
		}
		if f.called("Prompt") {
			t.Errorf("body %q was injected", body)
		}
	}
}

// For pi, ready means pi has titled its pane, which it does once startup has
// finished and any trust question is answered. Claude's ❯ says nothing about pi.
func TestPromptWaitsForPisTitleWhenTheToolIsPi(t *testing.T) {
	f := &fakeTurns{}
	if rec := postTurn(t, turnMux(t, f), "/prompt/demo", `{"text":"hi pi","awaitReady":true,"tool":"pi"}`); rec.Code != http.StatusNoContent {
		t.Fatalf("status %d, want 204", rec.Code)
	}
	if !f.called("AwaitPiReady") || f.called("AwaitInputReady") {
		t.Fatalf("calls = %q, want pi's wait and not Claude's", f.calls)
	}
	if f.prompted != "hi pi" {
		t.Fatalf("prompted %q", f.prompted)
	}
}

// Same 503-until-ready semantics as Claude's wait, and the same deadline.
func TestPromptAnswers503UntilPiIsReady(t *testing.T) {
	f := &fakeTurns{piAwaitErr: errors.New("no title yet")}
	rec := postTurn(t, turnMux(t, f), "/prompt/demo", `{"text":"hi pi","awaitReady":true,"tool":"pi"}`)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d, want 503", rec.Code)
	}
	if f.called("Prompt") {
		t.Fatal("a pi that was not ready was typed into")
	}
}

// Pi's trust question is a list, and a pasted line plus Enter would answer it
// with its first row, "Trust". No prompt goes in while it is up, whether the
// caller asked for the wait or not.
func TestPromptNeverTypesIntoPisTrustQuestion(t *testing.T) {
	for _, body := range []string{
		`{"text":"hi pi","tool":"pi"}`,
		`{"text":"hi pi","awaitReady":true,"tool":"pi"}`,
	} {
		f := &fakeTurns{trustPending: true}
		rec := postTurn(t, turnMux(t, f), "/prompt/demo", body)
		if rec.Code != http.StatusConflict {
			t.Errorf("body %s: status %d, want 409", body, rec.Code)
		}
		if f.called("Prompt") {
			t.Errorf("body %s: typed into the trust question", body)
		}
	}
}

// Codex draws its › as a menu cursor too, so its wait reads for the input line
// alone (sessionio.AwaitCodexReady). The first prompt of a codex session was
// posted blind before and its Enter was lost while codex started (deployed
// review round 1, 2026-09-28).
func TestPromptWaitsForCodexsInputLineWhenTheToolIsCodex(t *testing.T) {
	f := &fakeTurns{}
	if rec := postTurn(t, turnMux(t, f), "/prompt/demo", `{"text":"say pong","awaitReady":true,"tool":"codex"}`); rec.Code != http.StatusNoContent {
		t.Fatalf("status %d, want 204", rec.Code)
	}
	if !f.called("AwaitReady") || f.awaitedWith != sessionio.HarnessCodex || f.called("AwaitInputReady") {
		t.Fatalf("calls = %q awaited as %q, want codex's wait and not Claude's", f.calls, f.awaitedWith)
	}
	if f.prompted != "say pong" {
		t.Fatalf("prompted %q", f.prompted)
	}
}

func TestPromptAnswers503UntilCodexIsReady(t *testing.T) {
	f := &fakeTurns{awaitErr: errors.New("a menu is up")}
	rec := postTurn(t, turnMux(t, f), "/prompt/demo", `{"text":"say pong","awaitReady":true,"tool":"codex"}`)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d, want 503", rec.Code)
	}
	if f.called("Prompt") {
		t.Fatal("a codex that was not ready was typed into")
	}
}

// Claude's route is untouched when the tool is absent or claude: its own wait,
// and no pi check at all.
func TestPromptKeepsClaudesPath(t *testing.T) {
	for _, body := range []string{`{"text":"hi","awaitReady":true}`, `{"text":"hi","awaitReady":true,"tool":"claude"}`} {
		f := &fakeTurns{trustPending: true}
		if rec := postTurn(t, turnMux(t, f), "/prompt/demo", body); rec.Code != http.StatusNoContent {
			t.Fatalf("body %s: status %d, want 204", body, rec.Code)
		}
		if !f.called("AwaitInputReady") || f.called("AwaitPiReady") || f.called("PiTrustPending") {
			t.Fatalf("body %s: calls = %q, want Claude's wait and nothing of pi's", body, f.calls)
		}
	}
}

// --- POST /cancel -------------------------------------------------------------

func TestCancelUsesTheHarnessTheCallerNames(t *testing.T) {
	f := &fakeTurns{harnessOf: ""}
	if rec := postTurn(t, turnMux(t, f), "/cancel/demo", `{"tool":"pi"}`); rec.Code != http.StatusNoContent {
		t.Fatalf("status %d, want 204", rec.Code)
	}
	if f.cancelledAs != sessionio.HarnessPi || f.called("HarnessOf") {
		t.Fatalf("cancelled as %q with calls %q, want pi without asking the pane", f.cancelledAs, f.calls)
	}
}

// Every caller before pi sends no body at all, and the route still has to tell
// a pi pane from a Claude one. The pane says so: pi titles it.
func TestCancelWithNoBodyAsksThePane(t *testing.T) {
	for _, tc := range []struct {
		pane sessionio.Harness
		body string
	}{
		{sessionio.HarnessPi, ``},
		{"", ``},
		{sessionio.HarnessPi, `{}`},
		{"", `{"tool":""}`},
	} {
		f := &fakeTurns{harnessOf: tc.pane}
		if rec := postTurn(t, turnMux(t, f), "/cancel/demo", tc.body); rec.Code != http.StatusNoContent {
			t.Fatalf("body %q: status %d, want 204", tc.body, rec.Code)
		}
		if f.cancelledAs != tc.pane {
			t.Errorf("body %q, pane %q: cancelled as %q", tc.body, tc.pane, f.cancelledAs)
		}
	}
}

func TestCancelReportsAFailedInterrupt(t *testing.T) {
	f := &fakeTurns{cancelErr: errors.New("no such session")}
	if rec := postTurn(t, turnMux(t, f), "/cancel/demo", ``); rec.Code != http.StatusBadGateway {
		t.Fatalf("status %d, want 502", rec.Code)
	}
}

// Stop with prompts queued mid-turn hands them back to the composer. CLI
// 2.1.283 submits every queued prompt as the next turn on an interrupt, so the
// queue comes off FIRST (sessionio.ClearQueue), and the reply says whether it
// did: the Text view puts the text back in the field only then.
func TestCancelTakesTheQueueOffBeforeTheInterrupt(t *testing.T) {
	f := &fakeTurns{clearTook: true}
	rec := postTurn(t, turnMux(t, f), "/cancel/demo", `{"restoreQueue":["first","second\nline two"]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want 200", rec.Code)
	}
	var got struct {
		Restored bool `json:"restored"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil || !got.Restored {
		t.Fatalf("body %q, want {\"restored\":true}", rec.Body.String())
	}
	if strings.Join(f.cleared, "|") != "first|second\nline two" {
		t.Fatalf("cleared %q", f.cleared)
	}
	clear, cancel := -1, -1
	for i, c := range f.calls {
		switch c {
		case "ClearQueue":
			clear = i
		case "CancelHarness":
			cancel = i
		}
	}
	if clear < 0 || cancel < clear {
		t.Fatalf("calls = %q, want ClearQueue before CancelHarness", f.calls)
	}
}

// A queue the pane would not give up is still interrupted, and the caller is
// told nothing came back, so it leaves the ghosts alone: they run.
func TestCancelSaysWhenTheQueueStayed(t *testing.T) {
	f := &fakeTurns{clearTook: false}
	rec := postTurn(t, turnMux(t, f), "/cancel/demo", `{"restoreQueue":["first"]}`)
	if rec.Code != http.StatusOK || !f.called("CancelHarness") {
		t.Fatalf("status %d, calls %q, want 200 and an interrupt", rec.Code, f.calls)
	}
	if strings.TrimSpace(rec.Body.String()) != `{"restored":false}` {
		t.Fatalf("body %q, want restored false", rec.Body.String())
	}
}

// Only Claude has the queue this pops. pi and Codex are interrupted as before.
func TestCancelRestoresOnlyClaudesQueue(t *testing.T) {
	for _, body := range []string{`{"tool":"pi","restoreQueue":["x"]}`, `{"tool":"codex","restoreQueue":["x"]}`} {
		f := &fakeTurns{clearTook: true}
		rec := postTurn(t, turnMux(t, f), "/cancel/demo", body)
		if f.called("ClearQueue") || !f.called("CancelHarness") {
			t.Fatalf("body %s: calls %q, want the interrupt alone", body, f.calls)
		}
		if strings.TrimSpace(rec.Body.String()) != `{"restored":false}` {
			t.Fatalf("body %s: reply %q, want restored false", body, rec.Body.String())
		}
	}
}

// A cancel with no queue to hand back is the cancel it always was: no pop, and
// the same empty 204 every earlier caller reads.
func TestCancelWithoutAQueueDoesNotTouchIt(t *testing.T) {
	for _, body := range []string{``, `{}`, `{"restoreQueue":[]}`} {
		f := &fakeTurns{}
		if rec := postTurn(t, turnMux(t, f), "/cancel/demo", body); rec.Code != http.StatusNoContent {
			t.Fatalf("body %q: status %d, want 204", body, rec.Code)
		}
		if f.called("ClearQueue") {
			t.Fatalf("body %q: calls %q, want no pop", body, f.calls)
		}
	}
}

// A pop that failed in tmux may have left the queue half-drawn in the box, so
// the interrupt is not sent over it.
func TestCancelStopsWhenThePopFails(t *testing.T) {
	f := &fakeTurns{clearErr: errors.New("tmux gone")}
	rec := postTurn(t, turnMux(t, f), "/cancel/demo", `{"restoreQueue":["first"]}`)
	if rec.Code != http.StatusBadGateway || f.called("CancelHarness") {
		t.Fatalf("status %d, calls %q, want 502 and no interrupt", rec.Code, f.calls)
	}
}

// A Stop that lands before Claude has written anything puts the prompt back on
// the pane's input line, where the Text view never shows it and the next send
// erases it. Named in returnPrompt, it is taken off that line AFTER the
// interrupt, and the reply says so: the Text view puts it back in the field.
func TestCancelReturnsTheInterruptedPrompt(t *testing.T) {
	f := &fakeTurns{reclaimTook: true}
	rec := postTurn(t, turnMux(t, f), "/cancel/demo", `{"returnPrompt":"Write a long story"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want 200", rec.Code)
	}
	var got struct {
		Restored bool `json:"restored"`
		Returned bool `json:"returned"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil || !got.Returned || got.Restored {
		t.Fatalf("body %q, want returned true and nothing restored", rec.Body.String())
	}
	if f.reclaimed != "Write a long story" {
		t.Fatalf("reclaimed %q", f.reclaimed)
	}
	cancel, reclaim := -1, -1
	for i, c := range f.calls {
		switch c {
		case "CancelHarness":
			cancel = i
		case "ReclaimInterrupted":
			reclaim = i
		}
	}
	if cancel < 0 || reclaim < cancel {
		t.Fatalf("calls = %q, want CancelHarness before ReclaimInterrupted", f.calls)
	}
}

// The marker and the turn end the cancel streams live only in this process,
// so the session is stamped too: a session-events started later reads the
// stamp and does not show the taken-back prompt as a running turn (deployed
// review round 1, 2026-09-28).
func TestCancelStampsTheSessionWhenThePromptCameBack(t *testing.T) {
	f := &fakeTurns{reclaimTook: true}
	postTurn(t, turnMux(t, f), "/cancel/demo", `{"returnPrompt":"Write a long story"}`)
	stamp := f.stamped[sessionio.OptionRewound]
	n := sessionio.NewNormalizer("demo")
	n.Line([]byte(`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Write a long story"}]},"timestamp":"2020-01-01T00:00:00Z"}`))
	if stamp == "" || len(n.RestoreRewound(stamp)) == 0 {
		t.Fatalf("stamp %q does not name the returned prompt", stamp)
	}
	for _, g := range []*fakeTurns{{}, {reclaimErr: errors.New("tmux gone")}} {
		postTurn(t, turnMux(t, g), "/cancel/demo", `{"returnPrompt":"Write a long story"}`)
		if g.called("SetOption " + sessionio.OptionRewound) {
			t.Fatalf("stamped a prompt that did not come back (calls %q)", g.calls)
		}
	}
}

// Claude had started answering: nothing came back, and the caller is told so.
// A failed read of the pane is the same answer, since the interrupt landed.
func TestCancelSaysWhenNothingCameBack(t *testing.T) {
	for _, f := range []*fakeTurns{{}, {reclaimErr: errors.New("tmux gone")}} {
		rec := postTurn(t, turnMux(t, f), "/cancel/demo", `{"returnPrompt":"Write a long story"}`)
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d, want 200", rec.Code)
		}
		if strings.TrimSpace(rec.Body.String()) != `{"restored":false}` {
			t.Fatalf("body %q, want nothing returned", rec.Body.String())
		}
	}
}

// Only Claude puts a prompt back this way.
func TestCancelReturnsOnlyClaudesPrompt(t *testing.T) {
	f := &fakeTurns{reclaimTook: true}
	rec := postTurn(t, turnMux(t, f), "/cancel/demo", `{"tool":"pi","returnPrompt":"x"}`)
	if f.called("ReclaimInterrupted") || !f.called("CancelHarness") {
		t.Fatalf("calls %q, want the interrupt alone", f.calls)
	}
	if strings.TrimSpace(rec.Body.String()) != `{"restored":false}` {
		t.Fatalf("reply %q, want nothing returned", rec.Body.String())
	}
}

// Found in the round 7 check (2026-09-28): a prompt sent 300 ms after an early
// Stop was typed onto the input line while the cancel was still taking the
// stopped prompt off it. The reclaim's Backspaces erased the new text, the
// Enter landed on an empty line, and the route answered 204 for a prompt the
// CLI never saw. A prompt now waits for a Stop that holds the line.
func TestPromptWaitsForAStopTakingThePromptBack(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	f := &fakeTurns{reclaimTook: true}
	f.inReclaim = func() {
		close(entered)
		<-release
	}
	mux := turnMux(t, f)
	stopped := make(chan *httptest.ResponseRecorder, 1)
	go func() { stopped <- postTurn(t, mux, "/cancel/demo", `{"returnPrompt":"first"}`) }()
	<-entered

	sent := make(chan *httptest.ResponseRecorder, 1)
	go func() { sent <- postTurn(t, mux, "/prompt/demo", `{"text":"second"}`) }()
	select {
	case <-sent:
		t.Fatal("the prompt went in while the Stop was still clearing the input line")
	case <-time.After(150 * time.Millisecond):
	}
	if f.called("Prompt") {
		t.Fatal("Prompt typed onto the line the Stop was clearing")
	}
	close(release)
	if rec := <-stopped; rec.Code != http.StatusOK {
		t.Fatalf("cancel status %d", rec.Code)
	}
	if rec := <-sent; rec.Code != http.StatusNoContent || !f.called("Prompt") {
		t.Fatalf("prompt status %d, calls %q: want it sent once the Stop let go", rec.Code, f.calls)
	}
}

// The other order: a Stop pressed while a prompt is still being typed waits
// for it, so the interrupt cannot land between its paste and its Enter.
func TestStopWaitsForAPromptBeingTyped(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	f := &fakeTurns{}
	f.inPrompt = func() {
		close(entered)
		<-release
	}
	mux := turnMux(t, f)
	sent := make(chan *httptest.ResponseRecorder, 1)
	go func() { sent <- postTurn(t, mux, "/prompt/demo", `{"text":"hello"}`) }()
	<-entered
	stopped := make(chan *httptest.ResponseRecorder, 1)
	go func() { stopped <- postTurn(t, mux, "/cancel/demo", ``) }()
	select {
	case <-stopped:
		t.Fatal("the Stop went in while a prompt was being typed")
	case <-time.After(150 * time.Millisecond):
	}
	close(release)
	<-sent
	if rec := <-stopped; rec.Code != http.StatusNoContent || !f.called("CancelHarness") {
		t.Fatalf("cancel status %d, calls %q", rec.Code, f.calls)
	}
}

// Two sessions do not wait for each other.
func TestInputLineLockIsPerSession(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	defer close(release)
	f := &fakeTurns{reclaimTook: true}
	f.inReclaim = func() {
		close(entered)
		<-release
	}
	mux := turnMux(t, f)
	go postTurn(t, mux, "/cancel/demo", `{"returnPrompt":"first"}`)
	<-entered
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- postTurn(t, mux, "/prompt/other", `{"text":"hi"}`) }()
	select {
	case rec := <-done:
		if rec.Code != http.StatusNoContent {
			t.Fatalf("status %d", rec.Code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("a prompt to another session waited on this session's Stop")
	}
}

// --- POST /model --------------------------------------------------------------

func decodeState(t *testing.T, rec *httptest.ResponseRecorder) sessionio.ModelState {
	t.Helper()
	var st sessionio.ModelState
	if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
		t.Fatalf("decode %s: %v", rec.Body.String(), err)
	}
	return st
}

func TestModelSwitchesPi(t *testing.T) {
	f := &fakeTurns{state: sessionio.StateDone, setModelOut: sessionio.ModelState{Model: "anthropic/claude-opus-5", Effort: "high"}}
	rec := postTurn(t, turnMux(t, f), "/model/demo", `{"tool":"pi","model":"anthropic/claude-opus-5","effort":"high"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d (%s), want 200", rec.Code, rec.Body.String())
	}
	if f.setModelFor != sessionio.HarnessPi || f.setModelReq != (sessionio.ModelState{Model: "anthropic/claude-opus-5", Effort: "high"}) {
		t.Fatalf("SetModel(%q, %+v)", f.setModelFor, f.setModelReq)
	}
	if got := decodeState(t, rec); got != f.setModelOut {
		t.Fatalf("answered %+v, want what the pane read back", got)
	}
}

// The values go into somebody's pane as typed lines, so they are held to the
// launch gate before anything is typed.
func TestModelRefusesPiValuesOutsideTheGate(t *testing.T) {
	for _, body := range []string{
		`{"tool":"pi","model":"anthropic/x\n/quit"}`,
		`{"tool":"pi","model":"anthropic/x y"}`,
		`{"tool":"pi","model":"/model"}`,
		`{"tool":"pi","effort":"ultracode"}`,
		`{"tool":"pi","model":"anthropic/claude-opus-5","effort":"HIGH"}`,
	} {
		f := &fakeTurns{state: sessionio.StateDone}
		if rec := postTurn(t, turnMux(t, f), "/model/demo", body); rec.Code != http.StatusBadRequest {
			t.Errorf("body %s: status %d, want 400", body, rec.Code)
		}
		if f.called("SetModel") {
			t.Errorf("body %s reached the pane", body)
		}
	}
}

// The existing rule, for pi too: nothing is typed over a turn in flight.
func TestModelRefusesARunningPi(t *testing.T) {
	f := &fakeTurns{state: sessionio.StateRunning}
	if rec := postTurn(t, turnMux(t, f), "/model/demo", `{"tool":"pi","model":"anthropic/claude-opus-5"}`); rec.Code != http.StatusConflict {
		t.Fatalf("status %d, want 409", rec.Code)
	}
	if f.called("SetModel") {
		t.Fatal("a running pi was typed into")
	}
}

// An awaiting pi has a dialog up: its extension stamps awaiting for a blocking
// prompt and for the trust question and for nothing else. `/model` typed there
// would go into the dialog. The trust question is checked on the pane as well,
// for a pi without the extension, which stamps nothing.
func TestModelRefusesAPiThatIsAsking(t *testing.T) {
	for name, f := range map[string]*fakeTurns{
		"awaiting":      {state: sessionio.StateAwaiting},
		"trust pending": {state: "", trustPending: true},
	} {
		t.Run(name, func(t *testing.T) {
			if rec := postTurn(t, turnMux(t, f), "/model/demo", `{"tool":"pi","effort":"low"}`); rec.Code != http.StatusConflict {
				t.Fatalf("status %d, want 409", rec.Code)
			}
			if f.called("SetModel") {
				t.Fatal("a pi with a dialog up was typed into")
			}
		})
	}
}

// Claude's awaiting is not a dialog (its idle notification stamps it too), so
// the pi rule stays pi's.
func TestModelStillSwitchesAnAwaitingClaude(t *testing.T) {
	f := &fakeTurns{state: sessionio.StateAwaiting}
	if rec := postTurn(t, turnMux(t, f), "/model/demo", `{"tool":"claude","model":"Haiku"}`); rec.Code != http.StatusOK {
		t.Fatalf("status %d (%s), want 200", rec.Code, rec.Body.String())
	}
	if f.called("PiTrustPending") {
		t.Fatal("a Claude session was checked for pi's trust question")
	}
}

// awaitReady waits by the harness's own evidence.
func TestModelWaitsByTheHarnessesOwnSignal(t *testing.T) {
	for _, h := range []sessionio.Harness{sessionio.HarnessClaude, sessionio.HarnessCodex, sessionio.HarnessPi} {
		f := &fakeTurns{state: sessionio.StateDone}
		body := `{"tool":"` + string(h) + `","effort":"high","awaitReady":true}`
		if rec := postTurn(t, turnMux(t, f), "/model/demo", body); rec.Code != http.StatusOK {
			t.Fatalf("%s: status %d (%s)", h, rec.Code, rec.Body.String())
		}
		if f.awaitedWith != h {
			t.Errorf("%s: waited as %q", h, f.awaitedWith)
		}
	}
	f := &fakeTurns{awaitErr: errors.New("not up")}
	if rec := postTurn(t, turnMux(t, f), "/model/demo", `{"tool":"pi","effort":"high","awaitReady":true}`); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d, want 503 while pi is not ready", rec.Code)
	}
}

func TestModelRefusesAHarnessWithNoModel(t *testing.T) {
	for _, tool := range []string{"shell", "", "bash"} {
		f := &fakeTurns{}
		if rec := postTurn(t, turnMux(t, f), "/model/demo", `{"tool":"`+tool+`","model":"x"}`); rec.Code != http.StatusBadRequest {
			t.Errorf("tool %q: status %d, want 400", tool, rec.Code)
		}
	}
}

// A switch pi never confirmed is a 502 carrying what the pane options say.
func TestModelReportsAPiSwitchThatDidNotLand(t *testing.T) {
	f := &fakeTurns{state: sessionio.StateDone,
		setModelErr: errors.New(`pi did not switch to "anthropic/claude-opus-5" within 3s: the pane reads model "anthropic/claude-haiku-4-5", thinking "low"`)}
	rec := postTurn(t, turnMux(t, f), "/model/demo", `{"tool":"pi","model":"anthropic/claude-opus-5"}`)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status %d, want 502", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "anthropic/claude-haiku-4-5") {
		t.Errorf("the answer does not say what the pane reads: %s", rec.Body.String())
	}
}

// A mode request goes to the walk before the model half's refusals. The walk
// runs while Claude works, with the safety rule in the driver, and checks for a
// dialog itself; the model half refuses a running turn and a drawn question
// outright, which on a mode request would make every working session's dial a
// 409. It takes no tool, since the walk is Claude's Shift+Tab.
func TestModelSendsAModeRequestToTheWalkFirst(t *testing.T) {
	f := &fakeTurns{
		state:   sessionio.StateRunning,
		options: map[string]string{sessionio.OptionAsk: "toolu_1"},
		modeOut: sessionio.ModeResult{Applied: true, Mode: "plan", Presses: 1, From: "manual"},
	}
	rec := postTurn(t, turnMux(t, f), "/model/demo", `{"mode":"plan"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if !f.called("SetMode plan") {
		t.Fatalf("calls = %q, want the mode walk", f.calls)
	}
	if f.called("State") || f.called("SetModel") {
		t.Fatalf("a mode request met the model half: %q", f.calls)
	}
	var got sessionio.ModeResult
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil || !got.Applied || got.Mode != "plan" {
		t.Fatalf("reply %s (%v)", rec.Body.String(), err)
	}
}

// A request is a mode, or a model and an effort, never both.
func TestModelRefusesAModeWithAModel(t *testing.T) {
	for _, body := range []string{`{"mode":"plan","model":"opus"}`, `{"mode":"plan","effort":"high"}`} {
		f := &fakeTurns{}
		if rec := postTurn(t, turnMux(t, f), "/model/demo", body); rec.Code != http.StatusBadRequest {
			t.Errorf("body %s: status %d, want 400", body, rec.Code)
		}
		if len(f.calls) != 0 {
			t.Errorf("body %s: calls %q, want none", body, f.calls)
		}
	}
}

// Deployed review round 4 (2026-09-28): a prompt sent as Claude drew a
// permission dialog was answered 204 and never reached Claude, and its Enter
// approved the Bash call. The guard read the pane once, before the paste.
// sessionio now stops a prompt whose input box has gone (ErrInputGone), and
// the route refuses it the way it refuses one sent while the dialog is up, so
// the sender keeps its text.
func TestPromptThatMetADialogIsRefusedWithItsReason(t *testing.T) {
	f := &fakeTurns{pane: "❯ \n", promptErr: fmt.Errorf("wrapped: %w", sessionio.ErrInputGone)}
	f.inPrompt = func() { f.pane = capture(t, "permission-bash.txt") }
	rec := postTurn(t, turnMux(t, f), "/prompt/demo", `{"text":"queued note 12"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status %d, want 409 for a prompt that met a dialog", rec.Code)
	}
	if got := strings.TrimSpace(rec.Body.String()); got != `{"applied":false,"reason":"permission-open"}` {
		t.Errorf("body = %s", got)
	}
}

// A dialog the pane readers do not know yet, or one still drawing, is refused
// all the same, under a reason of its own.
func TestPromptThatMetAnUnknownDialogIsRefused(t *testing.T) {
	f := &fakeTurns{pane: "❯ \n", promptErr: sessionio.ErrInputGone}
	f.inPrompt = func() { f.pane = "Something is drawing\n" }
	rec := postTurn(t, turnMux(t, f), "/prompt/demo", `{"text":"queued note 12"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status %d, want 409", rec.Code)
	}
	if got := strings.TrimSpace(rec.Body.String()); got != `{"applied":false,"reason":"dialog-open"}` {
		t.Errorf("body = %s", got)
	}
}

// Deployed review round 4 (2026-09-28): the first prompt from the new-session
// box, in a git repository Claude had not been told to trust, met Claude's
// folder-trust dialog. Its Enter picked "❯ No, exit", Claude quit, the
// one-pane session died, and the route answered 204. The pane as CLI 2.1.283
// drew it:
const claudeTrustPane = `
──────────────────────────────────────────────
 Accessing workspace:

 /var/tmp/t3r4/repo

 Quick safety check: Is this a project you
 created or one you trust?

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel
`

func TestPromptNeverTypesIntoClaudesTrustDialog(t *testing.T) {
	f := &fakeTurns{pane: claudeTrustPane}
	rec := postTurn(t, turnMux(t, f), "/prompt/demo", `{"text":"say hi"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status %d, want 409 while Claude asks about trust", rec.Code)
	}
	if got := strings.TrimSpace(rec.Body.String()); got != `{"applied":false,"reason":"trust-open"}` {
		t.Errorf("body = %s", got)
	}
	if f.called("Prompt") {
		t.Fatal("a prompt was typed into the trust dialog")
	}
}

// The first prompt waits for the input box, which the dialog never draws, so
// the wait gives up; the sender is told why at once rather than retrying a
// wait that cannot end until someone answers in the Terminal.
func TestPromptWaitingOnTheTrustDialogSaysSo(t *testing.T) {
	f := &fakeTurns{pane: claudeTrustPane, awaitErr: errors.New("no input box")}
	rec := postTurn(t, turnMux(t, f), "/prompt/demo", `{"text":"say hi","awaitReady":true}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status %d, want 409 while Claude asks about trust", rec.Code)
	}
	if got := strings.TrimSpace(rec.Body.String()); got != `{"applied":false,"reason":"trust-open"}` {
		t.Errorf("body = %s", got)
	}
	if f.called("Prompt") {
		t.Fatal("a prompt was typed into the trust dialog")
	}
}
