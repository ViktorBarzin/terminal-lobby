package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"terminal-lobby/sessionio"
)

// internalMux serves the internal routes for a registry with a mod connected
// for wizard/demo. self says whether the caller runs as this service's own
// account; users is the roster.
func internalMux(t *testing.T, self bool) (*registry, *modConn, http.Handler) {
	t.Helper()
	rg, _ := newTestRegistry(t, "wizard/demo")
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	c := rg.mods.conn("wizard", "demo")
	g := internalGate{
		users: func() []string { return []string{"wizard", "emo"} },
		self: func(*http.Request) (bool, error) {
			if self {
				return true, nil
			}
			return false, errors.New("another account")
		},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /internal/v1/dialog/{user}/{session}", g.wrap(rg.handleInternalDialog()))
	mux.HandleFunc("POST /internal/v1/answer/{user}/{session}", g.wrap(rg.handleInternalAnswer()))
	return rg, c, mux
}

func internalReq(method, path, body string) *http.Request {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:40000"
	r.Host = "127.0.0.1:7685"
	r.Header.Set(internalHeader, "1")
	return r
}

func serve(h http.Handler, r *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec
}

func TestTheInternalRoutesLetOnlyThisServicesAccountIn(t *testing.T) {
	_, _, mux := internalMux(t, true)
	cases := map[string]func(*http.Request){
		"from the LAN":       func(r *http.Request) { r.RemoteAddr = "10.0.10.20:40000" },
		"another Host":       func(r *http.Request) { r.Host = "evil.example:7685" },
		"no internal header": func(r *http.Request) { r.Header.Del(internalHeader) },
		"a user not served":  func(r *http.Request) { r.URL.Path = "/internal/v1/dialog/root/demo"; r.SetPathValue("user", "root") },
		"a bad session name": func(r *http.Request) { r.URL.Path = "/internal/v1/dialog/wizard/de%20mo" },
	}
	for name, spoil := range cases {
		r := internalReq("GET", "/internal/v1/dialog/wizard/demo", "")
		spoil(r)
		if rec := serve(mux, r); rec.Code != http.StatusForbidden && rec.Code != http.StatusNotFound {
			t.Errorf("%s: %d, want refused", name, rec.Code)
		}
	}
	if rec := serve(mux, internalReq("GET", "/internal/v1/dialog/wizard/demo", "")); rec.Code != http.StatusNoContent {
		t.Fatalf("the service's own call: %d, want 204 with nothing open", rec.Code)
	}
	_, _, other := internalMux(t, false)
	if rec := serve(other, internalReq("GET", "/internal/v1/dialog/wizard/demo", "")); rec.Code != http.StatusForbidden {
		t.Fatalf("another account: %d, want 403", rec.Code)
	}
}

func TestTheDialogRouteReadsEachKind(t *testing.T) {
	_, c, mux := internalMux(t, true)
	if rec := serve(mux, internalReq("GET", "/internal/v1/dialog/wizard/nosuch", "")); rec.Code != http.StatusNotFound {
		t.Fatalf("a session with no mod: %d, want 404", rec.Code)
	}
	read := func() internalDialog {
		t.Helper()
		rec := serve(mux, internalReq("GET", "/internal/v1/dialog/wizard/demo", ""))
		if rec.Code != http.StatusOK {
			t.Fatalf("dialog: %d %s", rec.Code, rec.Body)
		}
		var d internalDialog
		if err := json.Unmarshal(rec.Body.Bytes(), &d); err != nil {
			t.Fatal(err)
		}
		return d
	}
	c.apply([]sessionio.ModEvent{askEvent("toolu_q", "Which?")})
	if d := read(); d.Kind != "ask" || d.ToolID != "toolu_q" || len(d.Questions) != 1 ||
		d.Questions[0].Question != "Which?" || len(d.Questions[0].Options) != 2 || d.Questions[0].Options[1].Label != "B" {
		t.Fatalf("ask = %+v", d)
	}
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModSettledEvent, ToolID: "toolu_q"},
		{Type: sessionio.ModPlanEvent, ToolID: "toolu_p", Plan: "1. build", PlanFilePath: "/tmp/p.md"}})
	if d := read(); d.Kind != "plan" || d.Plan != "1. build" || d.PlanFilePath != "/tmp/p.md" {
		t.Fatalf("plan = %+v", d)
	}
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModSettledEvent, ToolID: "toolu_p"},
		{Type: sessionio.ModPermissionEvent, ToolID: "toolu_b", Tool: "Bash", Input: json.RawMessage(`{"command":"make"}`)}})
	if d := read(); d.Kind != "permission" || d.Tool != "Bash" || d.Title != "Bash command" || len(d.Detail) != 1 || d.Detail[0] != "make" {
		t.Fatalf("permission = %+v", d)
	}
}

func TestTheAnswerRouteAnswersTheNamedDialog(t *testing.T) {
	_, c, mux := internalMux(t, true)
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModPermissionEvent, ToolID: "toolu_b", Tool: "Bash", Input: json.RawMessage(`{"command":"make"}`)}})
	sent := fakeMod(t, c)
	rec := serve(mux, internalReq("POST", "/internal/v1/answer/wizard/demo", `{"toolId":"toolu_b","permission":{"option":1}}`))
	var resp sessionio.AnswerResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if rec.Code != http.StatusOK || !resp.Applied {
		t.Fatalf("answer: %d %s", rec.Code, rec.Body)
	}
	if cmds := sent(); len(cmds) != 1 || cmds[0].ToolID != "toolu_b" || cmds[0].Decision != "allow" {
		t.Fatalf("sent %+v", cmds)
	}
	if rec := serve(mux, internalReq("POST", "/internal/v1/answer/wizard/demo", `{"toolId":"toolu_other","permission":{"option":1}}`)); rec.Code != http.StatusConflict {
		t.Fatalf("an answer for a dialog no longer open: %d, want 409", rec.Code)
	}
	if rec := serve(mux, internalReq("POST", "/internal/v1/answer/wizard/demo", `{"permission":{"option":1}}`)); rec.Code != http.StatusBadRequest {
		t.Fatalf("an answer naming no dialog: %d, want 400", rec.Code)
	}
	if rec := serve(mux, internalReq("POST", "/internal/v1/answer/wizard/nosuch", `{"toolId":"toolu_b","permission":{"option":1}}`)); rec.Code != http.StatusNotFound {
		t.Fatalf("a session with no mod: %d, want 404", rec.Code)
	}
}

// Measured live on 2026-10-02 (rv-par-6): the idle sweep killed a Claude, its
// mod said one last hello on the way out, and the connection stayed registered
// for up to modExpiry after the process was gone. The resumed Claude had no
// mod, but this route answered 204 ("a mod with nothing open") for it, so the
// agent API trusted the stale "done" the resume put back and failed a 45 s
// turn 18 s in. A mod holding no poll and silent past modLiveGap is gone.
func TestTheDialogRouteSaysNoModOnceTheModHasGoneQuiet(t *testing.T) {
	rg, _, mux := internalMux(t, true)
	var mu sync.Mutex
	clock := time.Now()
	rg.mods.now = func() time.Time { mu.Lock(); defer mu.Unlock(); return clock }
	advance := func(d time.Duration) { mu.Lock(); clock = clock.Add(d); mu.Unlock() }
	code := func() int {
		return serve(mux, internalReq("GET", "/internal/v1/dialog/wizard/demo", "")).Code
	}
	token, _ := rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	if got := code(); got != http.StatusNoContent {
		t.Fatalf("a mod that just said hello: %d, want 204", got)
	}

	// A held poll is a live mod, however long it has been held.
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		r := httptest.NewRequest("GET", "/mod/v1/poll?token="+token, nil).WithContext(ctx)
		rg.mods.handlePoll()(httptest.NewRecorder(), r)
	}()
	deadline := time.Now().Add(5 * time.Second)
	for !rg.mods.conn("wizard", "demo").alive(rg.mods.now()) || pollsOf(rg.mods.conn("wizard", "demo")) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("the poll never registered")
		}
		time.Sleep(time.Millisecond)
	}
	advance(2 * modLiveGap)
	if got := code(); got != http.StatusNoContent {
		t.Fatalf("a mod holding a poll: %d, want 204", got)
	}

	// The process dies: its poll ends with the connection, and nothing more
	// is heard from it.
	cancel()
	<-done
	if got := code(); got != http.StatusNotFound {
		t.Fatalf("a mod whose poll ended with its connection, silent for %s: %d, want 404", 2*modLiveGap, got)
	}
}

func pollsOf(c *modConn) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.polls
}
