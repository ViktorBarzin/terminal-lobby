package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
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
	calls []string

	awaitErr     error // AwaitInputReady and AwaitReady
	piAwaitErr   error // AwaitPiReady
	trustPending bool
	options      map[string]string
	state        string
	harnessOf    sessionio.Harness
	promptErr    error
	cancelErr    error
	setModelOut  sessionio.ModelState
	setModelErr  error
	pane         string // CapturePane
	modeOut      sessionio.ModeResult

	awaitedWith sessionio.Harness
	cancelledAs sessionio.Harness
	setModelFor sessionio.Harness
	setModelReq sessionio.ModelState
	prompted    string
}

func (f *fakeTurns) called(name string) bool {
	for _, c := range f.calls {
		if c == name {
			return true
		}
	}
	return false
}

func (f *fakeTurns) AwaitInputReady(_ context.Context, _, _ string, wait, _ time.Duration) error {
	f.calls = append(f.calls, "AwaitInputReady")
	if wait != PromptReadyWait {
		return errors.New("the wait is not PromptReadyWait")
	}
	return f.awaitErr
}

func (f *fakeTurns) AwaitPiReady(_ context.Context, _, _ string, wait, _ time.Duration) error {
	f.calls = append(f.calls, "AwaitPiReady")
	if wait != PromptReadyWait {
		return errors.New("the wait is not PromptReadyWait")
	}
	return f.piAwaitErr
}

func (f *fakeTurns) AwaitReady(_ context.Context, _, _ string, h sessionio.Harness, wait, _ time.Duration) error {
	f.calls = append(f.calls, "AwaitReady")
	f.awaitedWith = h
	if wait != PromptReadyWait {
		return errors.New("the wait is not PromptReadyWait")
	}
	return f.awaitErr
}

func (f *fakeTurns) PiTrustPending(_, _ string) bool {
	f.calls = append(f.calls, "PiTrustPending")
	return f.trustPending
}

func (f *fakeTurns) Option(_, _, name string) (string, bool) {
	f.calls = append(f.calls, "Option "+name)
	return f.options[name], true
}

func (f *fakeTurns) State(_, _ string) string {
	f.calls = append(f.calls, "State")
	return f.state
}

func (f *fakeTurns) Prompt(_, _, text string) error {
	f.calls = append(f.calls, "Prompt")
	f.prompted = text
	return f.promptErr
}

func (f *fakeTurns) HarnessOf(_, _ string) sessionio.Harness {
	f.calls = append(f.calls, "HarnessOf")
	return f.harnessOf
}

func (f *fakeTurns) CancelHarness(_, _ string, h sessionio.Harness) error {
	f.calls = append(f.calls, "CancelHarness")
	f.cancelledAs = h
	return f.cancelErr
}

func (f *fakeTurns) SetModel(_ context.Context, _, _ string, h sessionio.Harness, want sessionio.ModelState) (sessionio.ModelState, error) {
	f.calls = append(f.calls, "SetModel")
	f.setModelFor, f.setModelReq = h, want
	return f.setModelOut, f.setModelErr
}

func (f *fakeTurns) CapturePane(_, _ string) (string, error) {
	f.calls = append(f.calls, "CapturePane")
	return f.pane, nil
}

func (f *fakeTurns) SetMode(_ context.Context, _, _, target string) (sessionio.ModeResult, error) {
	f.calls = append(f.calls, "SetMode "+target)
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
// read the turn state; a drawn question does not stop it either. The plan guard
// reads OptionAsk, but only to name the plan approval (plan.go planOpen), so a
// question that is not a plan refuses nothing.
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
