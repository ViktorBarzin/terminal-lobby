package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"terminal-lobby/sessionio"
	"terminal-lobby/sessionio/siotest"
	"terminal-lobby/telemetry"
)

// POST /answer/{session}: one choice in, the next reading out.
//
// WHAT IS UNDER TEST HERE is the route and nothing else — bound the body,
// place the session, hand the driver the call as the transcript records it,
// encode what comes back, and record the shape of it. The DRIVER's own loop
// (refuse what is not drawn, inject, settle, capture, verify) is tested where
// it can be tested honestly, against a real tmux and a pty stand-in, in
// sessionio/answerdrive_test.go. Rebuilding a plausible-looking imitation of
// that loop here would only prove the imitation works.
//
// The readings the stand-in returns are parsed from the captures under
// sessionio/testdata, so what this route encodes is a reading of a screen CLI
// 2.1.267 actually drew rather than a Dialog assembled by hand.

// The transcript this route reads the question list out of: a two-question
// AskUserQuestion, written exactly as Claude Code records the call that
// produced dialog-multi.txt, so the transcript half and the pane half describe
// the same dialog.
const (
	answerUserLine = `{"type":"user","message":{"role":"user","content":"ask me two things"},` +
		`"uuid":"u1","timestamp":"2026-09-10T18:35:00Z"}`
	answerAskLine = `{"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use","content":[` +
		`{"type":"tool_use","id":"tu_1","name":"AskUserQuestion","input":{"questions":[` +
		`{"question":"Pick fruits","header":"Fruit","multiSelect":true,"options":[` +
		`{"label":"Apple","description":"Include apples."},{"label":"Pear"},{"label":"Plum"}]},` +
		`{"question":"Pick one drink","header":"Drink","options":[{"label":"Tea"},{"label":"Coffee"}]}]}}]},` +
		`"uuid":"a1","timestamp":"2026-09-10T18:35:01Z"}`
	answerResultLine = `{"type":"user","message":{"role":"user","content":[` +
		`{"type":"tool_result","tool_use_id":"tu_1","content":"Pear"}]},` +
		`"uuid":"a2","timestamp":"2026-09-10T18:35:09Z"}`
)

// fakeAnswerDriver stands in for sessionio.Injector.Answer: it records what the
// route handed it and returns a scripted reading.
type fakeAnswerDriver struct {
	resp sessionio.AnswerResponse
	err  error

	calls   int
	osUser  string
	session string
	req     sessionio.AnswerRequest
	known   []sessionio.DialogQuestion
}

func (f *fakeAnswerDriver) Answer(_ context.Context, osUser, session string,
	req sessionio.AnswerRequest, known []sessionio.DialogQuestion,
) (sessionio.AnswerResponse, error) {
	f.calls++
	f.osUser, f.session, f.req, f.known = osUser, session, req, known
	return f.resp, f.err
}

// answerEnv registers one session called "demo" for "wizard", lays down the
// transcript lines given, and returns a mux serving POST /answer over it.
func answerEnv(t *testing.T, drv answerDriver, lines ...string) http.Handler {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	home := t.TempDir()
	path := sessionio.TranscriptPath(sessionio.ProjectsRoot(home, "wizard"), "/home/wizard/x", "s1")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
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
	mux.HandleFunc("POST /answer/{session}", handleAnswer(rg, drv))
	return mux
}

// postAnswer sends one request as the authenticated wizard. The identity comes
// from the context because that is where authMiddleware leaves it.
func postAnswer(t *testing.T, h http.Handler, session, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/answer/"+session, strings.NewReader(body))
	req = req.WithContext(context.WithValue(req.Context(), osUserKey, "wizard"))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decodeAnswer(t *testing.T, rec *httptest.ResponseRecorder) sessionio.AnswerResponse {
	t.Helper()
	var got sessionio.AnswerResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("the reply is not an AnswerResponse (%v): %s", err, rec.Body.String())
	}
	return got
}

// fixtureDialog parses one of the real captures the parser is tested against.
func fixtureDialog(t *testing.T, name string) *sessionio.Dialog {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "sessionio", "testdata", name))
	if err != nil {
		t.Fatalf("reading the capture: %v", err)
	}
	d := sessionio.ParseDialog(string(raw))
	if d == nil {
		t.Fatalf("%s no longer parses as a dialog", name)
	}
	return d
}

// eventSink keeps the lines the emitter would have written to the journal.
type eventSink struct{ lines []string }

func (s *eventSink) Write(line string) { s.lines = append(s.lines, line) }

// captureEvents points this service's emitter at a sink for the test.
func captureEvents(t *testing.T) *eventSink {
	t.Helper()
	sink := &eventSink{}
	old := events
	events = telemetry.New("session-events", buildID, sink)
	t.Cleanup(func() { events = old })
	return sink
}

// recorded is one decoded journal line.
type recorded struct {
	Name  string         `json:"event.name"`
	Attrs map[string]any `json:"attrs"`
}

// all decodes what the sink holds, in order.
func (s *eventSink) all(t *testing.T) []recorded {
	t.Helper()
	out := make([]recorded, 0, len(s.lines))
	for _, line := range s.lines {
		var rec recorded
		raw := strings.TrimPrefix(line, telemetry.Marker+" ")
		if err := json.Unmarshal([]byte(raw), &rec); err != nil {
			t.Fatalf("the event is not JSON (%v): %s", err, line)
		}
		out = append(out, rec)
	}
	return out
}

// names is what the request recorded, in order, for a test that cares about
// which records it produced rather than what any one of them says.
func (s *eventSink) names(t *testing.T) []string {
	t.Helper()
	var out []string
	for _, rec := range s.all(t) {
		out = append(out, rec.Name)
	}
	return out
}

// only returns the attrs of the one event with this name, failing if there is
// not exactly one of it: a route that emits the same name twice doubles every
// count drawn from it.
//
// BY NAME, rather than "the only event there is", because one applied answer
// records two different things. text.answer_sent counts what the text view
// attempted and carries the shape of the call; claude.answered is ADR-0006's
// record of a blocking prompt being answered, whichever surface answered it,
// and the /keys and /answer-text routes this one replaces both emit it.
func (s *eventSink) only(t *testing.T, name string) map[string]any {
	t.Helper()
	var found []recorded
	for _, rec := range s.all(t) {
		if rec.Name == name {
			found = append(found, rec)
		}
	}
	if len(found) != 1 {
		t.Fatalf("want exactly one %s, got %d: %v", name, len(found), s.names(t))
	}
	return found[0].Attrs
}

// A session nobody registered gets no keys typed into it. This is the one
// refusal that is an HTTP error: there is no pane to read, so there is no
// reading to answer with.
//
// AND IT IS RECORDED. The walk this route replaces counted the same failure —
// any POST the lobby did not answer 2xx became `refused` (answer.logic.ts:330
// in the build being deleted) — so a silent 404 here would take a failure
// class to zero at the cutover and read as one that had stopped happening. It
// is worth seeing: rg.source answers false when the tmux→transcript mapping
// has gone (registry.go:118), which is a killed or renamed session under a
// card still on the reader's screen, and sendAnswer shows them nothing for it.
func TestAnswerRefusesAnUnregisteredSession(t *testing.T) {
	sink := captureEvents(t)
	drv := &fakeAnswerDriver{}
	h := answerEnv(t, drv, answerUserLine, answerAskLine)

	rec := postAnswer(t, h, "ghost", `{"header":"Fruit","choice":"Pear"}`)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status %d, want 404 (%s)", rec.Code, rec.Body.String())
	}
	if drv.calls != 0 {
		t.Fatalf("the driver ran %d times for a session that was never registered", drv.calls)
	}
	attrs := sink.only(t, "text.answer_failed")
	if attrs["tl.reason"] != answerNoSession {
		t.Errorf("tl.reason = %v, want %q — a word of its own, because nothing was "+
			"refused by a dialog here", attrs["tl.reason"], answerNoSession)
	}
	if attrs["tl.session"] != "ghost" {
		t.Errorf("tl.session = %v, want the session that was asked for", attrs["tl.session"])
	}
}

// A REFUSAL IS A 200 CARRYING THE CURRENT READING, and that is the whole point
// of this route.
//
// The shipped client latched on a refusal: it held the plan it had already
// computed, disabled Send, and told the reader to open the Terminal. Answering
// a refusal with a fresh reading is what lets the card re-render against what
// is actually on screen and the reader carry on. An HTTP error would give it
// nothing to render, which is the old behaviour wearing a different status
// code.
func TestAnswerRefusalIsA200CarryingWhatIsOnScreen(t *testing.T) {
	for _, tc := range []struct {
		name, body, reason string
	}{
		{
			"a question the pane is not drawing",
			`{"header":"Drink","choice":"Tea"}`,
			sessionio.AnswerNotDrawn,
		},
		{
			"an option the drawn question does not offer",
			`{"header":"Fruit","choice":"Durian"}`,
			sessionio.AnswerUnknownOption,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sink := captureEvents(t)
			drv := &fakeAnswerDriver{resp: sessionio.AnswerResponse{
				Reason: tc.reason, Dialog: fixtureDialog(t, "dialog-multi.txt"),
			}}
			h := answerEnv(t, drv, answerUserLine, answerAskLine)

			rec := postAnswer(t, h, "demo", tc.body)

			if rec.Code != http.StatusOK {
				t.Fatalf("status %d, want 200 — a refusal carries a reading, not an error (%s)",
					rec.Code, rec.Body.String())
			}
			got := decodeAnswer(t, rec)
			if got.Applied || got.Reason != tc.reason {
				t.Fatalf("applied=%v reason=%q, want false and %q", got.Applied, got.Reason, tc.reason)
			}
			if got.Dialog == nil || len(got.Dialog.Questions) == 0 ||
				got.Dialog.Questions[0].Question != "Pick fruits" {
				t.Fatalf("a refusal must carry what IS on screen, so the card re-renders "+
					"instead of latching; dialog = %+v", got.Dialog)
			}
			attrs := sink.only(t, "text.answer_failed")
			if attrs["tl.reason"] != tc.reason {
				t.Errorf("tl.reason = %v, want %q", attrs["tl.reason"], tc.reason)
			}
			// Nothing was answered, so ADR-0006's record of a prompt being
			// answered must not fire. A refusal that counted as an answer
			// would inflate the series the /keys route has always fed.
			if got := sink.names(t); len(got) != 1 {
				t.Errorf("a refusal recorded %v, want text.answer_failed alone", got)
			}
		})
	}
}

// A choice that lands: the request reaches the driver as it was sent, and the
// reply is the next screen rather than a prediction of it.
func TestAnswerAppliesAChoiceAndReturnsTheNextScreen(t *testing.T) {
	sink := captureEvents(t)
	drv := &fakeAnswerDriver{resp: sessionio.AnswerResponse{
		Applied: true, Dialog: fixtureDialog(t, "dialog-multi-second.txt"),
	}}
	h := answerEnv(t, drv, answerUserLine, answerAskLine)

	rec := postAnswer(t, h, "demo", `{"header":"Fruit","choice":"Pear"}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	if drv.osUser != "wizard" || drv.session != "demo" {
		t.Errorf("the driver was called for %s/%s, want wizard/demo", drv.osUser, drv.session)
	}
	if drv.req.Header != "Fruit" || drv.req.Choice != "Pear" {
		t.Errorf("the driver got %+v, want the header and choice that were posted", drv.req)
	}
	got := decodeAnswer(t, rec)
	if !got.Applied {
		t.Fatalf("applied=false for a choice the driver took: %+v", got)
	}
	if got.Dialog == nil || got.Dialog.Questions[0].Question != "Pick one drink" {
		t.Fatalf("the reply must carry the screen that came NEXT: %+v", got.Dialog)
	}
	sink.only(t, "text.answer_sent")
}

// Submit reaches the driver as a submit, and a dialog that has gone is
// reported as done rather than as an empty reading.
func TestAnswerSubmitReportsTheDialogGone(t *testing.T) {
	drv := &fakeAnswerDriver{resp: sessionio.AnswerResponse{Applied: true, Done: true}}
	h := answerEnv(t, drv, answerUserLine, answerAskLine)

	rec := postAnswer(t, h, "demo", `{"submit":true}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	if !drv.req.Submit {
		t.Errorf("the driver got %+v, want Submit true", drv.req)
	}
	got := decodeAnswer(t, rec)
	if !got.Applied || !got.Done {
		t.Fatalf("applied=%v done=%v, want both true", got.Applied, got.Done)
	}
	if got.Dialog != nil || got.Pane != "" {
		t.Errorf("a finished dialog has nothing left to draw: %+v", got)
	}
}

// The body is bounded, and the bound sits above the largest legitimate
// request. Both halves matter: a cap that a real free-text answer trips is a
// cap that breaks the feature.
func TestAnswerBoundsTheBody(t *testing.T) {
	t.Run("a free-text answer at the injector's own limit is accepted", func(t *testing.T) {
		drv := &fakeAnswerDriver{resp: sessionio.AnswerResponse{Applied: true}}
		h := answerEnv(t, drv, answerUserLine, answerAskLine)
		body, err := json.Marshal(sessionio.AnswerRequest{
			Header: "Fruit", Choice: "Type something",
			Text: strings.Repeat("m", sessionio.MaxAnswerText),
		})
		if err != nil {
			t.Fatal(err)
		}

		rec := postAnswer(t, h, "demo", string(body))

		if rec.Code != http.StatusOK {
			t.Fatalf("status %d for a %d-byte body, want 200 — the cap must clear "+
				"sessionio.MaxAnswerText (%s)", rec.Code, len(body), rec.Body.String())
		}
	})

	t.Run("a body over the cap is refused before anything is typed", func(t *testing.T) {
		drv := &fakeAnswerDriver{}
		h := answerEnv(t, drv, answerUserLine, answerAskLine)
		body := `{"header":"Fruit","choice":"Pear","text":"` +
			strings.Repeat("x", answerBodyLimit) + `"}`

		rec := postAnswer(t, h, "demo", body)

		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status %d for a %d-byte body, want 400 (%s)",
				rec.Code, len(body), rec.Body.String())
		}
		if drv.calls != 0 {
			t.Fatalf("the driver ran %d times on an oversized body", drv.calls)
		}
	})
}

// THE EVENT CARRIES THE SESSION, and carries nothing that was on screen.
//
// The browser emitted this pair with user.id and tl.device and no session
// name, so a recorded failure could not be tied back to the transcript it came
// from — the design doc lists that as the thing that would have made the
// investigation short. The content check is the other half: a dialog quotes
// whatever the session was working on, so the record says how many questions
// and of what shape, never a word of them.
func TestAnswerEventCarriesTheSessionAndNoContent(t *testing.T) {
	sink := captureEvents(t)
	drv := &fakeAnswerDriver{resp: sessionio.AnswerResponse{
		Reason: sessionio.AnswerNotDrawn, Dialog: fixtureDialog(t, "dialog-multi.txt"),
	}}
	h := answerEnv(t, drv, answerUserLine, answerAskLine)

	postAnswer(t, h, "demo", `{"header":"Drink","choice":"Tea","text":"a secret of mine"}`)

	attrs := sink.only(t, "text.answer_failed")
	if attrs["tl.session"] != "demo" {
		t.Errorf("tl.session = %v, want demo", attrs["tl.session"])
	}
	// Non-optional, because the historical records of these two names are the
	// browser walk this route replaces: a query that does not split on the
	// surface renders a rewrite as a trend.
	if attrs["tl.client"] == nil || attrs["tl.client"] == "" {
		t.Errorf("tl.client is missing; the cutover is invisible without it: %v", attrs)
	}
	if attrs["tl.questions"] != float64(2) || attrs["tl.multi"] != true {
		t.Errorf("tl.questions=%v tl.multi=%v, want 2 and true", attrs["tl.questions"], attrs["tl.multi"])
	}
	for _, banned := range []string{"Pick fruits", "Pick one drink", "Pear", "Tea", "a secret of mine"} {
		for k, v := range attrs {
			if s, ok := v.(string); ok && strings.Contains(s, banned) {
				t.Errorf("%s = %q carries screen content (%q); ADR-0006 keeps these records "+
					"free of anything a dialog quoted", k, s, banned)
			}
		}
	}
}

// The call's question list comes from the transcript, because the pane cannot
// supply it: a multi-question dialog draws no per-question header and marks
// the current tab in colour, which capture-pane -p does not carry. Without it
// the driver cannot place the walk, so ← to an earlier question refuses.
func TestAnswerHandsTheDriverTheCallAsTheTranscriptRecordsIt(t *testing.T) {
	drv := &fakeAnswerDriver{resp: sessionio.AnswerResponse{Applied: true}}
	h := answerEnv(t, drv, answerUserLine, answerAskLine)

	postAnswer(t, h, "demo", `{"back":"Fruit"}`)

	if len(drv.known) != 2 {
		t.Fatalf("the driver got %d questions, want the 2 the call carries: %+v", len(drv.known), drv.known)
	}
	if drv.known[0].Header != "Fruit" || drv.known[1].Header != "Drink" {
		t.Errorf("headers = %q, %q", drv.known[0].Header, drv.known[1].Header)
	}
	if !drv.known[0].MultiSelect || len(drv.known[0].Options) != 3 {
		t.Errorf("the multiSelect flag and the options must survive: %+v", drv.known[0])
	}
}

// THE NEWEST UNRESOLVED CALL IS THE ONE HANDED OVER, and an older one never
// stands in for it.
//
// Claude Code can abandon an AskUserQuestion and ask again without the first
// ever getting a result — the frontend carries a rule for exactly that shape
// (timeline.logic.ts pendingQuestion) — which leaves two lists inside the
// window this route reads. The older one is worse than none: placement
// matches the DRAWN question's text against the list it is given
// (answerplan.go questionOnScreen), so a list belonging to another call can
// only miss, or, where the two calls word a question the same way, place the
// pane inside the wrong call and check the request's header against the wrong
// headers. Nothing else on this box can supply the list, so which one this
// picks is the whole of the route's contribution to placement.
func TestAnswerHandsOverTheNewestUnresolvedCall(t *testing.T) {
	// An earlier call that never got a result, worded so nothing about it can
	// be confused with the two-question call that follows it.
	const abandonedAskLine = `{"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use",` +
		`"content":[{"type":"tool_use","id":"tu_0","name":"AskUserQuestion","input":{"questions":[` +
		`{"question":"Which font should the badge use?","header":"Font","options":[` +
		`{"label":"Sans"},{"label":"Serif"}]}]}}]},` +
		`"uuid":"a0","timestamp":"2026-09-10T18:34:50Z"}`

	t.Run("two calls in flight", func(t *testing.T) {
		drv := &fakeAnswerDriver{resp: sessionio.AnswerResponse{Applied: true}}
		h := answerEnv(t, drv, answerUserLine, abandonedAskLine, answerAskLine)

		postAnswer(t, h, "demo", `{"header":"Fruit","choice":"Pear"}`)

		if len(drv.known) != 2 {
			t.Fatalf("the driver got %d questions, want the newest call's 2: %+v",
				len(drv.known), drv.known)
		}
		for _, q := range drv.known {
			if q.Header == "Font" {
				t.Fatalf("the abandoned call's question was handed over: %+v", drv.known)
			}
		}
	})

	t.Run("the newest is answered and the abandoned one does not come back", func(t *testing.T) {
		drv := &fakeAnswerDriver{resp: sessionio.AnswerResponse{Reason: sessionio.AnswerNoDialog}}
		h := answerEnv(t, drv, answerUserLine, abandonedAskLine, answerAskLine, answerResultLine)

		postAnswer(t, h, "demo", `{"header":"Font","choice":"Sans"}`)

		if len(drv.known) != 0 {
			t.Fatalf("an older call's questions described the dialog after the newest "+
				"was answered: %+v", drv.known)
		}
	})
}

// THE LIST SURVIVES A TURN BOUNDARY, which is the cheap half of keeping the
// driver able to place the pane.
//
// A multi-question dialog draws no per-question header (verified 2026-09-11:
// both dialog-multi.txt and dialog-multi-second.txt parse to
// Questions[0].Header == "" with Headers ["Fruit" "Drink"]), so with no list
// nothing on screen says which question of the call is drawn and placement
// falls back to what the tab bar alone can prove. Every request that runs
// without a list is a request running on the weaker check, so how far back
// this reads is a correctness knob, not a performance one: answerKnownTurns
// is 2, and narrowing it to the newest turn would drop a call whose turn
// boundary lands between the question and the answer.
func TestAnswerFindsTheCallWhenItIsNotInTheNewestTurn(t *testing.T) {
	nextTurn := `{"type":"user","message":{"role":"user","content":"and while you wait"},` +
		`"uuid":"u2","timestamp":"2026-09-10T18:35:04Z"}`
	drv := &fakeAnswerDriver{resp: sessionio.AnswerResponse{Applied: true}}
	h := answerEnv(t, drv, answerUserLine, answerAskLine, nextTurn)

	postAnswer(t, h, "demo", `{"header":"Fruit","choice":"Pear"}`)

	if len(drv.known) != 2 {
		t.Fatalf("the driver got %d questions for a call one turn back, want 2: %+v",
			len(drv.known), drv.known)
	}
}

// A call whose result has arrived is answered and gone. Passing its questions
// on would describe a dialog that is no longer up.
func TestAnswerSendsNoQuestionListOnceTheCallHasBeenAnswered(t *testing.T) {
	drv := &fakeAnswerDriver{resp: sessionio.AnswerResponse{Reason: sessionio.AnswerNoDialog}}
	h := answerEnv(t, drv, answerUserLine, answerAskLine, answerResultLine)

	postAnswer(t, h, "demo", `{"header":"Fruit","choice":"Pear"}`)

	if len(drv.known) != 0 {
		t.Fatalf("an answered call was still handed over as pending: %+v", drv.known)
	}
}

// THE RECORD SAYS WHERE ITS OWN NUMBERS CAME FROM, because tl.multi does not
// mean the same thing in the two branches.
//
// From the call's transcript record it means "any question in this call is
// multi-select". From the reply's reading it can only mean "the question the
// pane was drawing when the reply was taken is multi-select" — a
// multi-question dialog draws one question at a time, and the reading is
// taken after the keys went in. Folded together under one name, the same call
// reports multi=true or multi=false depending only on whether Claude Code had
// written the record yet, which is the variable the design doc measures as
// 10x apart in freshness.
//
// `tl.source` is the browser walk's own word for this (TextView.tsx:384 in
// the build being deleted, "transcript" or "pane"), so the two populations
// still split the same way.
func TestAnswerEventSaysWhereItsShapeCameFrom(t *testing.T) {
	// Claude Code does not always write the AskUserQuestion record while the
	// dialog is up — measured 2026-08-28, two of five consecutive calls were
	// not written until the question had been answered, 112 s later in one
	// case. Both branches below are that measurement's two sides.
	t.Run("the call's record is in hand", func(t *testing.T) {
		sink := captureEvents(t)
		drv := &fakeAnswerDriver{resp: sessionio.AnswerResponse{
			Applied: true, Dialog: fixtureDialog(t, "dialog-multi-second.txt"),
		}}
		h := answerEnv(t, drv, answerUserLine, answerAskLine)

		postAnswer(t, h, "demo", `{"header":"Fruit","choice":"Pear"}`)

		attrs := sink.only(t, "text.answer_sent")
		if attrs["tl.source"] != "transcript" {
			t.Errorf("tl.source = %v, want transcript", attrs["tl.source"])
		}
		// The record's two questions, and its multiSelect flag — not the
		// single-select question the reply happens to be showing.
		if attrs["tl.questions"] != float64(2) || attrs["tl.multi"] != true {
			t.Errorf("tl.questions=%v tl.multi=%v, want 2 and true from the record",
				attrs["tl.questions"], attrs["tl.multi"])
		}
	})

	t.Run("the record has not landed yet", func(t *testing.T) {
		sink := captureEvents(t)
		drv := &fakeAnswerDriver{resp: sessionio.AnswerResponse{
			Applied: true, Dialog: fixtureDialog(t, "dialog-multi-second.txt"),
		}}
		h := answerEnv(t, drv, answerUserLine) // no AskUserQuestion recorded yet

		postAnswer(t, h, "demo", `{"header":"Drink","choice":"Tea"}`)

		if len(drv.known) != 0 {
			t.Fatalf("there is no record to pass on yet: %+v", drv.known)
		}
		attrs := sink.only(t, "text.answer_sent")
		if attrs["tl.source"] != "pane" {
			t.Errorf("tl.source = %v, want pane — this multi=false describes one "+
				"drawn question, not the call", attrs["tl.source"])
		}
		if attrs["tl.questions"] != float64(2) {
			t.Errorf("tl.questions = %v, want the 2 the tab bar counts", attrs["tl.questions"])
		}
		if attrs["tl.multi"] != false {
			t.Errorf("tl.multi = %v, want false — the drawn question is single-select", attrs["tl.multi"])
		}
	})
}

// AN ANSWER THAT LANDED IS STILL A BLOCKING PROMPT ANSWERED.
//
// docs/adr/0006-usage-telemetry.md lists claude.answered under session-events,
// and POST /keys and POST /answer-text are where it came from. This route
// takes both of their jobs for the text view, so without emitting it the name
// goes to roughly zero at the cutover while answers carry on, and every panel
// over it reads as a feature that stopped being used. tl.client keeps the two
// values the ADR and the catalog in telemetry/events.go already document,
// because what reaches the pane is unchanged; `api-answer` on
// text.answer_sent is what makes the new surface visible.
func TestAnswerRecordsTheBlockingPromptAsAnswered(t *testing.T) {
	for _, tc := range []struct {
		name, body, client string
		count              float64
	}{
		// One digit, which is what the walk sent for the same answer.
		{"a choice", `{"header":"Fruit","choice":"Pear"}`, "api", 1},
		// The characters, the unit POST /answer-text has always recorded.
		{"free text", `{"header":"Fruit","choice":"Type something","text":"kiwi"}`, "api-text", 4},
		// The keys, the unit POST /keys has always recorded.
		{"the raw-key hatch", `{"keys":["Down","Enter"]}`, "api", 2},
		// The Enter on the review screen, which the walk also sent as one key.
		{"submit", `{"submit":true}`, "api", 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sink := captureEvents(t)
			drv := &fakeAnswerDriver{resp: sessionio.AnswerResponse{Applied: true}}
			h := answerEnv(t, drv, answerUserLine, answerAskLine)

			postAnswer(t, h, "demo", tc.body)

			attrs := sink.only(t, "claude.answered")
			if attrs["tl.session"] != "demo" {
				t.Errorf("tl.session = %v, want demo", attrs["tl.session"])
			}
			if attrs["tl.client"] != tc.client {
				t.Errorf("tl.client = %v, want %q", attrs["tl.client"], tc.client)
			}
			if attrs["tl.count"] != tc.count {
				t.Errorf("tl.count = %v, want %v", attrs["tl.count"], tc.count)
			}
			// The size of the answer, never the answer. A dialog quotes
			// whatever the session was working on (ADR-0006).
			for k, v := range attrs {
				if s, ok := v.(string); ok && strings.Contains(s, "kiwi") {
					t.Errorf("%s = %q carries what was typed", k, s)
				}
			}
		})
	}

	// A refusal answered nothing. Counting one would inflate the series the
	// /keys route has fed since ADR-0006, and this route's own
	// text.answer_failed already records that the attempt happened.
	t.Run("a refusal records no answer", func(t *testing.T) {
		sink := captureEvents(t)
		drv := &fakeAnswerDriver{resp: sessionio.AnswerResponse{
			Reason: sessionio.AnswerNotDrawn, Dialog: fixtureDialog(t, "dialog-multi.txt"),
		}}
		h := answerEnv(t, drv, answerUserLine, answerAskLine)

		postAnswer(t, h, "demo", `{"header":"Drink","choice":"Tea"}`)

		if got := sink.names(t); len(got) != 1 || got[0] != "text.answer_failed" {
			t.Fatalf("a refusal recorded %v, want text.answer_failed alone", got)
		}
	})
}

// A pane that cannot be read at all is the one driver failure that is an HTTP
// error, and it is recorded under the word the browser walk used for the same
// thing so the two populations stay comparable.
func TestAnswerReportsAPaneItCannotReadAs502(t *testing.T) {
	sink := captureEvents(t)
	drv := &fakeAnswerDriver{err: errors.New("no server running on /tmp/tmux-1000/default")}
	h := answerEnv(t, drv, answerUserLine, answerAskLine)

	rec := postAnswer(t, h, "demo", `{"header":"Fruit","choice":"Pear"}`)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status %d, want 502 (%s)", rec.Code, rec.Body.String())
	}
	attrs := sink.only(t, "text.answer_failed")
	if attrs["tl.reason"] != "unreadable" {
		t.Errorf("tl.reason = %v, want unreadable", attrs["tl.reason"])
	}
}

// A reader who navigated away mid-request is not a failure of this route.
//
// The verify window runs to 600 ms (sessionio.answerVerify), so a phone that
// drops the connection part-way through is ordinary rather than rare, and
// counting each one as a failed answer would put the connection quality of the
// building into the reason breakdown this event exists to measure.
func TestAnswerRecordsNothingWhenTheReaderHangsUp(t *testing.T) {
	sink := captureEvents(t)
	drv := &fakeAnswerDriver{err: context.Canceled}
	h := answerEnv(t, drv, answerUserLine, answerAskLine)

	postAnswer(t, h, "demo", `{"header":"Fruit","choice":"Pear"}`)

	if len(sink.lines) != 0 {
		t.Fatalf("an abandoned request was recorded as an answer: %v", sink.lines)
	}
}

// THE DRIFT FINGERPRINT REACHES THE JOURNAL, which is the only place it can be
// read across sessions.
//
// Claude Code ships roughly daily and the captures under sessionio/testdata do
// not, so a restyle that moves a string the parser hangs off passes CI intact
// and arrives as a reader stuck on a dialog. sessionio computes which landmarks
// the screen carried (ParseDialogMarkers) and hands it back on every reply the
// parser could not read; before this attribute existed the reading lived for
// one HTTP response body and nothing held it, so "this marker has been missing
// for three days" was not a question anyone could ask.
//
// The fingerprint is built here rather than parsed from a capture on purpose:
// what this test pins is the route's encoding of a reading, and the parser's
// own reading of real screens is pinned in sessionio/dialogmarkers_test.go.
func TestAnswerEventNamesTheLandmarksThatWereMissing(t *testing.T) {
	sink := captureEvents(t)
	// A retitled review screen and a dropped "Chat about this" row, the shape
	// the next CLI restyle is most likely to take: everything else intact.
	drv := &fakeAnswerDriver{resp: sessionio.AnswerResponse{
		Reason: sessionio.AnswerUnverified,
		Pane:   "some screen the parser refused",
		Markers: &sessionio.DialogMarkers{
			TabBar: true, AnsweredBox: true, OpenBox: true,
			ReadyPrompt: true, Footer: true, NumberedList: true, FreeText: true,
		},
	}}
	h := answerEnv(t, drv, answerUserLine, answerAskLine)

	postAnswer(t, h, "demo", `{"header":"Drink","choice":"Tea"}`)

	attrs := sink.only(t, "text.answer_failed")
	// Declaration order, and the JSON field names, so the series, the response
	// body and answer-api.ts all say the marker the same way.
	if got := attrs["tl.markers_missing"]; got != "reviewTitle,chatOption" {
		t.Errorf("tl.markers_missing = %v, want reviewTitle,chatOption", got)
	}
}

// The fingerprint stays out of the journal when it would only add noise.
func TestAnswerEventOmitsTheFingerprintWhenItSaysNothing(t *testing.T) {
	// Every landmark dark is markerScope finding no dialog at all: a pane that
	// has scrolled, or a restyle so total the answer path could not drive the
	// screen anyway. It is not a dialog that lost its furniture, which is the
	// only thing this series is asked to show.
	t.Run("nothing found on the pane", func(t *testing.T) {
		sink := captureEvents(t)
		drv := &fakeAnswerDriver{resp: sessionio.AnswerResponse{
			Reason: sessionio.AnswerNoDialog, Markers: &sessionio.DialogMarkers{},
		}}
		h := answerEnv(t, drv, answerUserLine, answerAskLine)

		postAnswer(t, h, "demo", `{"header":"Drink","choice":"Tea"}`)

		attrs := sink.only(t, "text.answer_failed")
		if got, ok := attrs["tl.markers_missing"]; ok {
			t.Errorf("a screen nothing was found on recorded a fingerprint (%v); "+
				"those outnumber the real readings", got)
		}
	})

	// An operator menu is the noise this filter exists to exclude, and it is
	// the reason the transcript decides rather than the fingerprint. /model,
	// /effort and the resume picker are the same select widget as a dialog and
	// light numberedList the way one does, so the fingerprint alone cannot
	// tell them apart. What separates them is that no AskUserQuestion is open
	// when one is on screen, which is this env with no ask line in it.
	t.Run("a menu, with no question open", func(t *testing.T) {
		sink := captureEvents(t)
		drv := &fakeAnswerDriver{resp: sessionio.AnswerResponse{
			Reason:  sessionio.AnswerNoDialog,
			Markers: &sessionio.DialogMarkers{NumberedList: true, Footer: true},
		}}
		h := answerEnv(t, drv, answerUserLine) // no AskUserQuestion in the window

		postAnswer(t, h, "demo", `{"header":"Drink","choice":"Tea"}`)

		attrs := sink.only(t, "text.answer_failed")
		if got, ok := attrs["tl.markers_missing"]; ok {
			t.Errorf("a menu recorded a fingerprint (%v); nobody was waiting on a "+
				"question, so nothing about the dialog moved", got)
		}
	})

	// Every landmark present and the parse still failed is a parser bug rather
	// than drift, and tl.reason already describes it. An empty value would sit
	// in the series looking like a reading.
	t.Run("every landmark present", func(t *testing.T) {
		sink := captureEvents(t)
		drv := &fakeAnswerDriver{resp: sessionio.AnswerResponse{
			Reason: sessionio.AnswerUnverified,
			Markers: &sessionio.DialogMarkers{
				TabBar: true, AnsweredBox: true, OpenBox: true, ReviewTitle: true,
				ReadyPrompt: true, Footer: true, NumberedList: true, FreeText: true,
				ChatOption: true,
			},
		}}
		h := answerEnv(t, drv, answerUserLine, answerAskLine)

		postAnswer(t, h, "demo", `{"header":"Drink","choice":"Tea"}`)

		attrs := sink.only(t, "text.answer_failed")
		if got, ok := attrs["tl.markers_missing"]; ok {
			t.Errorf("tl.markers_missing = %q on a screen with nothing missing", got)
		}
	})
}

// A REFUSED DIALOG IS RECORDED EVEN THOUGH THE REASON IS no-dialog, which is
// the case the fingerprint exists for and the one an earlier filter here threw
// away.
//
// AnswerNoDialog does not mean what its comment in answerapi.go says. The
// driver returns it for `before.dialog == nil` (answerdrive.go), which covers
// both "no dialog on the pane" and "a dialog the parser could not read", and
// the second IS drift. Measured live 2026-09-11 against a real tmux pane
// holding a frame the parser refuses: the reply came back reason no-dialog
// with openBox, footer and numberedList lit against six dark, and the journal
// line carried no fingerprint at all because the filter was reading the
// reason. This test is that screen.
func TestAnswerEventRecordsDriftEvenWhenTheReasonIsNoDialog(t *testing.T) {
	sink := captureEvents(t)
	drv := &fakeAnswerDriver{resp: sessionio.AnswerResponse{
		Reason: sessionio.AnswerNoDialog,
		Pane:   "a dialog frame the parser refused",
		Markers: &sessionio.DialogMarkers{
			OpenBox: true, Footer: true, NumberedList: true,
		},
	}}
	h := answerEnv(t, drv, answerUserLine, answerAskLine)

	postAnswer(t, h, "demo", `{"header":"Drink","choice":"Tea"}`)

	attrs := sink.only(t, "text.answer_failed")
	want := "tabBar,answeredBox,reviewTitle,readyPrompt,freeText,chatOption"
	if got := attrs["tl.markers_missing"]; got != want {
		t.Errorf("tl.markers_missing = %v, want %q. A dialog the parser cannot read "+
			"reports itself as no-dialog, so filtering that reason out is filtering "+
			"out drift", got, want)
	}
}

// darkMarkers hand-lists the nine field names, so a tenth landmark added to
// DialogMarkers would be silently absent from every record and nothing would
// fail. This is the thing that fails instead.
//
// A zero DialogMarkers has every landmark dark, so the helper must name all of
// them, and the count it should reach is the struct's own field count rather
// than a literal 9 repeated here. The alternative was reflection inside
// darkMarkers, which removes the duplicate list but puts it on the emit path;
// the names also have to stay in declaration order for markerCount to mean
// what the guard uses it for, and a test reads that more plainly than a
// reflective loop would.
func TestDarkMarkersNamesEveryLandmarkTheStructCarries(t *testing.T) {
	dark := darkMarkers(sessionio.DialogMarkers{})
	if want := reflect.TypeOf(sessionio.DialogMarkers{}).NumField(); len(dark) != want {
		t.Fatalf("darkMarkers names %d landmarks and DialogMarkers carries %d: %v.\n"+
			"A field added to the struct needs a line in darkMarkers, or it never "+
			"reaches a record", len(dark), want, dark)
	}
	if len(dark) != markerCount {
		t.Errorf("markerCount is %d and darkMarkers names %d; the guard uses the "+
			"first to recognise an all-dark reading", markerCount, len(dark))
	}
}
