package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"terminal-lobby/sessionio"
)

// The mode dial's half of POST /model/{session}: a body carrying "mode".
//
// What is under test is the route: check the identifier, hand the driver the
// session, encode what it reports, and record it. The walk itself (Shift+Tab
// one press at a time, the status line read back, the safety rule) is tested
// against a real tmux in sessionio/setmode_test.go.

type fakeModeSetter struct {
	res sessionio.ModeResult
	err error

	calls   int
	session string
	target  string
}

func (f *fakeModeSetter) SetMode(_ context.Context, _ string, session, target string) (sessionio.ModeResult, error) {
	f.calls++
	f.session, f.target = session, target
	return f.res, f.err
}

func postMode(t *testing.T, drv modeSetter, mode string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/model/demo", strings.NewReader(`{"mode":"`+mode+`"}`))
	req = req.WithContext(context.WithValue(req.Context(), osUserKey, "wizard"))
	rec := httptest.NewRecorder()
	serveMode(rec, req, drv, "wizard", "demo", mode)
	return rec
}

// The reply is the contract's, exactly: applied, the mode the status line
// shows at the end, and how many presses it took.
func TestModeRouteRepliesWithTheWalk(t *testing.T) {
	sink := captureEvents(t)
	drv := &fakeModeSetter{res: sessionio.ModeResult{Applied: true, Mode: "plan", Presses: 2, From: "manual"}}

	rec := postMode(t, drv, "plan")

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d (%s)", rec.Code, rec.Body.String())
	}
	if got := strings.TrimSpace(rec.Body.String()); got != `{"applied":true,"mode":"plan","presses":2}` {
		t.Errorf("reply = %s", got)
	}
	if drv.session != "demo" || drv.target != "plan" {
		t.Errorf("the driver was asked for %s on %s", drv.target, drv.session)
	}
	attrs := sink.only(t, "text.answer_sent")
	want := map[string]any{
		"tl.session": "demo", "tl.client": "api-mode", "tl.action": sessionio.ActionMode,
		"tl.from": "manual", "tl.to": "plan", "tl.count": float64(2),
	}
	for k, v := range want {
		if attrs[k] != v {
			t.Errorf("%s = %v, want %v", k, attrs[k], v)
		}
	}
	// A mode change answered no blocking prompt.
	if got := sink.names(t); len(got) != 1 {
		t.Errorf("recorded %v, want text.answer_sent alone", got)
	}
}

// "default" is the old name for manual and is taken as it.
func TestModeRouteTakesTheOldNameForManual(t *testing.T) {
	drv := &fakeModeSetter{res: sessionio.ModeResult{Applied: true, Mode: "manual"}}

	postMode(t, drv, "default")

	if drv.target != "manual" {
		t.Errorf("the driver was asked for %q, want manual", drv.target)
	}
}

// A refusal is a 200 carrying what the status line shows, as on POST /answer:
// the dial redraws from it instead of guessing.
func TestModeRouteRefusalIsA200(t *testing.T) {
	sink := captureEvents(t)
	drv := &fakeModeSetter{res: sessionio.ModeResult{
		Reason: sessionio.ModeUnsafePath, Mode: "manual", From: "manual",
	}}

	rec := postMode(t, drv, "auto")

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d (%s)", rec.Code, rec.Body.String())
	}
	if got := strings.TrimSpace(rec.Body.String()); got != `{"applied":false,"reason":"unsafe-path","mode":"manual","presses":0}` {
		t.Errorf("reply = %s", got)
	}
	attrs := sink.only(t, "text.answer_failed")
	if attrs["tl.reason"] != sessionio.ModeUnsafePath || attrs["tl.action"] != sessionio.ActionMode {
		t.Errorf("tl.reason=%v tl.action=%v", attrs["tl.reason"], attrs["tl.action"])
	}
}

// A mode the CLI does not have types nothing and records nothing: it is a
// malformed request, not a walk that failed.
func TestModeRouteRefusesAnUnknownMode(t *testing.T) {
	sink := captureEvents(t)
	drv := &fakeModeSetter{}

	rec := postMode(t, drv, "bypass")

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400 (%s)", rec.Code, rec.Body.String())
	}
	if drv.calls != 0 {
		t.Fatal("the driver ran for a mode that does not exist")
	}
	if got := sink.names(t); len(got) != 0 {
		t.Errorf("recorded %v for a malformed request", got)
	}
}

// A pane that cannot be read is the one failure that is an HTTP error, the
// same 502 POST /answer gives.
func TestModeRouteReportsAnUnreadablePaneAs502(t *testing.T) {
	sink := captureEvents(t)
	drv := &fakeModeSetter{err: errors.New("no server running on /tmp/tmux-1000/default")}

	rec := postMode(t, drv, "plan")

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status %d, want 502", rec.Code)
	}
	if attrs := sink.only(t, "text.answer_failed"); attrs["tl.reason"] != answerUnreadable {
		t.Errorf("tl.reason = %v, want %s", attrs["tl.reason"], answerUnreadable)
	}
}
