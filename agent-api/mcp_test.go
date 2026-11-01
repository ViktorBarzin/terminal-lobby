package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"terminal-lobby/authuser"
	"terminal-lobby/t3client"
	"terminal-lobby/telemetry"
)

// A stand-in for one user's `t3 serve` /mcp, in JSON response mode, with the
// shapes v0.1.5 returns. t3client's own fake also covers the OAuth sign-in;
// this one only needs the token agent-api already holds, so the tests seed
// the token store instead of signing in.
type fakeT3MCP struct {
	t     *testing.T
	srv   *httptest.Server
	token string

	mu       sync.Mutex
	next     int
	sessions map[string]bool
	calls    []fakeT3Call
	deleted  []string
	bearers  []string
}

type fakeT3Call struct {
	Session string
	Name    string
	Args    map[string]any
}

// threadReadMarker is in every t3_thread_read answer, so a test can prove a
// response body never reaches the trace.
const threadReadMarker = "the-thread-said-this-and-it-is-not-for-the-trace"

func newFakeT3MCP(t *testing.T, token string) *fakeT3MCP {
	f := &fakeT3MCP{t: t, token: token, sessions: map[string]bool{}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeT3MCP) port() int {
	_, p, _ := net.SplitHostPort(strings.TrimPrefix(f.srv.URL, "http://"))
	var n int
	fmt.Sscan(p, &n)
	return n
}

func (f *fakeT3MCP) toolCalls() []fakeT3Call {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]fakeT3Call(nil), f.calls...)
}

func (f *fakeT3MCP) serve(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/mcp" {
		http.NotFound(w, r)
		return
	}
	f.mu.Lock()
	f.bearers = append(f.bearers, r.Header.Get("Authorization"))
	f.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer "+f.token {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(401)
		io.WriteString(w, `{"error":"invalid_mcp_credential"}`)
		return
	}
	sid := r.Header.Get("mcp-session-id")
	if r.Method == http.MethodDelete {
		f.mu.Lock()
		f.deleted = append(f.deleted, sid)
		delete(f.sessions, sid)
		f.mu.Unlock()
		w.WriteHeader(200)
		return
	}
	body, _ := io.ReadAll(r.Body)
	var msg struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		} `json:"params"`
	}
	if err := json.Unmarshal(body, &msg); err != nil {
		http.Error(w, "parse error", 400)
		return
	}
	reply := func(v map[string]any) {
		v["jsonrpc"] = "2.0"
		v["id"] = msg.ID
		w.Header().Set("content-type", "application/json")
		w.Header().Set("mcp-protocol-version", "2025-06-18")
		json.NewEncoder(w).Encode(v)
	}
	if msg.Method == "initialize" {
		f.mu.Lock()
		f.next++
		up := fmt.Sprintf("upstream-%d", f.next)
		f.sessions[up] = true
		f.mu.Unlock()
		w.Header().Set("mcp-session-id", up)
		reply(map[string]any{"result": map[string]any{"protocolVersion": "2025-06-18",
			"serverInfo": map[string]any{"name": "T3 Code", "version": "0.1.5"}}})
		return
	}
	f.mu.Lock()
	live := f.sessions[sid]
	f.mu.Unlock()
	if !live {
		w.WriteHeader(404)
		return
	}
	if len(msg.ID) == 0 {
		w.WriteHeader(202)
		return
	}
	if msg.Method != "tools/call" {
		reply(map[string]any{"result": map[string]any{"tools": []any{}}})
		return
	}
	f.mu.Lock()
	f.calls = append(f.calls, fakeT3Call{Session: sid, Name: msg.Params.Name, Args: msg.Params.Arguments})
	f.mu.Unlock()
	ok := func(out map[string]any) {
		text, _ := json.Marshal(out)
		reply(map[string]any{"result": map[string]any{"content": []any{map[string]any{"type": "text", "text": string(text)}},
			"structuredContent": out, "isError": false}})
	}
	switch msg.Params.Name {
	case "t3_thread_launch":
		ok(map[string]any{"threadId": "thread-launched", "projectId": "p1", "runId": "run-1", "status": "running"})
	case "t3_thread_read":
		if msg.Params.Arguments["threadId"] == "missing" {
			reply(map[string]any{"result": map[string]any{"content": []any{map[string]any{"type": "text",
				"text": `{"_tag":"OrchestratorMcpFailure","code":"thread_not_found","message":"no such thread"}`}}, "isError": true}})
			return
		}
		ok(map[string]any{"threadId": msg.Params.Arguments["threadId"], "messages": []any{threadReadMarker}})
	case "t3_thread_wait":
		ok(map[string]any{"threadId": msg.Params.Arguments["threadId"], "timedOut": true})
	default:
		reply(map[string]any{"error": map[string]any{"code": -32602, "message": "Tool '" + msg.Params.Name + "' not found"}})
	}
}

const (
	fakeT3Token = "t3-access-token-that-must-never-reach-the-caller"
	// A second credential, mapped to emo, to show the user comes from the
	// credential and not from anything the caller says.
	testEmoActor = "emobot"
	testEmoToken = "E3moTokenForTheSecondAccount00000"
)

type mcpRig struct {
	h       *harness
	wizard  *fakeT3MCP
	emo     *fakeT3MCP
	metrics *telemetry.Metrics
}

// newMCPRig is the harness with a real t3client in front of two fake T3s, one
// per user, and a token already in the store so no sign-in runs.
func newMCPRig(t *testing.T) *mcpRig {
	t.Helper()
	h := newHarness(t)
	rig := &mcpRig{h: h, wizard: newFakeT3MCP(t, fakeT3Token), emo: newFakeT3MCP(t, fakeT3Token), metrics: telemetry.NewMetrics()}

	// Add emobot -> emo to the harness's credentials file.
	tokensPath := h.srv.Gate.Config.BearerTokensPath
	b, err := os.ReadFile(tokensPath)
	if err != nil {
		t.Fatal(err)
	}
	b = append(b, []byte(testEmoActor+"  "+authuser.BearerDigest(testEmoToken)+"  emo\n")...)
	if err := os.WriteFile(tokensPath, b, 0o640); err != nil {
		t.Fatal(err)
	}

	store := t3client.TokenStore{Dir: filepath.Join(t.TempDir(), "t3")}
	now := time.Now()
	for _, u := range []string{testOSUser, "emo"} {
		if err := store.Save(u, t3client.Token{AccessToken: fakeT3Token, Label: "agent-api", IssuedAt: now, ExpiresAt: now.Add(30 * 24 * time.Hour)}); err != nil {
			t.Fatal(err)
		}
	}
	ports := map[string]int{testOSUser: rig.wizard.port(), "emo": rig.emo.port()}
	h.srv.T3 = t3client.New(t3client.Config{
		Service: "agent-api",
		Locator: &t3client.Locator{Ports: func(user string) (int, error) {
			if p, ok := ports[user]; ok {
				return p, nil
			}
			return 0, fmt.Errorf("t3client: user %s has no T3 server", user)
		}},
		Credentials: &t3client.Credentials{
			Label: "agent-api",
			Store: store,
			Minter: t3client.MinterFunc(func(_ context.Context, user string) (string, error) {
				return "", errors.New("no sign-in in these tests")
			}),
		},
		Metrics: rig.metrics,
	})
	return rig
}

const mcpInit = `{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"muse","version":"1"}}}`

func (rig *mcpRig) post(token, session, body string) *httptest.ResponseRecorder {
	rig.h.t.Helper()
	headers := map[string]string{"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
	if session != "" {
		headers["Mcp-Session-Id"] = session
		headers["Mcp-Protocol-Version"] = "2025-06-18"
	}
	return rig.h.do(request{method: "POST", path: "/mcp", body: body, token: token, headers: headers})
}

// initialize opens a session for the token's caller and returns agent-api's id
// for it.
func (rig *mcpRig) initialize(token string) string {
	rig.h.t.Helper()
	w := rig.post(token, "", mcpInit)
	if w.Code != 200 {
		rig.h.t.Fatalf("initialize: %d %s", w.Code, w.Body.String())
	}
	sid := w.Header().Get("Mcp-Session-Id")
	if sid == "" {
		rig.h.t.Fatalf("initialize returned no session id: %v", w.Header())
	}
	if n := rig.post(token, sid, `{"jsonrpc":"2.0","method":"notifications/initialized"}`); n.Code != 202 {
		rig.h.t.Fatalf("initialized: %d %s", n.Code, n.Body.String())
	}
	return sid
}

func toolCall(id int, tool, args string) string {
	return fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"tools/call","params":{"name":%q,"arguments":%s}}`, id, tool, args)
}

func (rig *mcpRig) mcpTrace() []TraceEntry {
	var out []TraceEntry
	for _, e := range rig.h.traceLines() {
		if strings.HasSuffix(e.Verb, " /mcp") {
			out = append(out, e)
		}
	}
	return out
}

// /mcp is behind the same gate as /v1: no bearer, a token this box did not
// issue, or the browser's header credentials reach nothing, on every method.
func TestMCPRequiresAuth(t *testing.T) {
	rig := newMCPRig(t)
	for _, method := range []string{"POST", "DELETE", "GET"} {
		t.Run(method, func(t *testing.T) {
			if w := rig.h.do(request{method: method, path: "/mcp", body: mcpInit}); w.Code != 401 {
				t.Errorf("no credential: %d, want 401", w.Code)
			}
			if w := rig.h.do(request{method: method, path: "/mcp", body: mcpInit, token: strings.Repeat("q", 40)}); w.Code != 401 {
				t.Errorf("unknown token: %d, want 401", w.Code)
			}
			w := rig.h.do(request{method: method, path: "/mcp", body: mcpInit, header: "vbarzin", secret: "x"})
			if w.Code < 400 {
				t.Errorf("an identity header alone was served: %d %s", w.Code, w.Body.String())
			}
		})
	}
	if calls := rig.wizard.toolCalls(); len(calls) != 0 {
		t.Fatalf("an unauthenticated request reached T3: %v", calls)
	}
	rig.wizard.mu.Lock()
	defer rig.wizard.mu.Unlock()
	if rig.wizard.next != 0 {
		t.Fatal("an unauthenticated initialize reached T3")
	}
}

// The caller speaks MCP with its agent-api bearer; T3 sees agent-api's own
// token, and the session id the caller holds is agent-api's, not T3's.
func TestMCPForwardsWithTheLobbysCredential(t *testing.T) {
	rig := newMCPRig(t)
	w := rig.post(testToken, "", mcpInit)
	if w.Code != 200 {
		t.Fatalf("initialize: %d %s", w.Code, w.Body.String())
	}
	sid := w.Header().Get("Mcp-Session-Id")
	if !strings.HasPrefix(sid, "tl-") {
		t.Fatalf("session id %q is not agent-api's", sid)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("content-type %q", ct)
	}
	if pv := w.Header().Get("Mcp-Protocol-Version"); pv != "2025-06-18" {
		t.Errorf("mcp-protocol-version %q", pv)
	}
	if !strings.Contains(w.Body.String(), `"T3 Code"`) {
		t.Errorf("initialize body %s", w.Body.String())
	}

	r := rig.post(testToken, sid, toolCall(1, "t3_thread_read", `{"threadId":"thread-a"}`))
	if r.Code != 200 || !strings.Contains(r.Body.String(), threadReadMarker) {
		t.Fatalf("tools/call: %d %s", r.Code, r.Body.String())
	}
	if r.Header().Get("Mcp-Session-Id") != sid {
		t.Errorf("the answer names session %q, want the caller's %q", r.Header().Get("Mcp-Session-Id"), sid)
	}
	calls := rig.wizard.toolCalls()
	if len(calls) != 1 || calls[0].Session != "upstream-1" {
		t.Fatalf("T3 saw %+v, want one call on upstream-1", calls)
	}
	rig.wizard.mu.Lock()
	for _, b := range rig.wizard.bearers {
		if b != "Bearer "+fakeT3Token {
			t.Errorf("T3 was sent %q, want agent-api's own token", b)
		}
	}
	rig.wizard.mu.Unlock()
	if strings.Contains(w.Body.String()+r.Body.String(), fakeT3Token) {
		t.Fatal("the T3 token reached the caller")
	}
}

// The OS user is the credential's. muse maps to wizard and emobot to emo, so
// each reaches its own user's T3.
func TestMCPResolvesTheCallersUser(t *testing.T) {
	rig := newMCPRig(t)
	museSID := rig.initialize(testToken)
	emoSID := rig.initialize(testEmoToken)
	rig.post(testToken, museSID, toolCall(1, "t3_thread_read", `{"threadId":"w"}`))
	rig.post(testEmoToken, emoSID, toolCall(1, "t3_thread_read", `{"threadId":"e"}`))
	if c := rig.wizard.toolCalls(); len(c) != 1 || c[0].Args["threadId"] != "w" {
		t.Errorf("wizard's T3 saw %+v", c)
	}
	if c := rig.emo.toolCalls(); len(c) != 1 || c[0].Args["threadId"] != "e" {
		t.Errorf("emo's T3 saw %+v", c)
	}
}

// A session id is good only for the caller that opened it, even when another
// caller maps to the same OS user.
func TestMCPSessionsBelongToTheirCaller(t *testing.T) {
	rig := newMCPRig(t)
	sid := rig.initialize(testToken)
	w := rig.post(testOtherToken, sid, toolCall(1, "t3_thread_read", `{"threadId":"x"}`))
	if w.Code != 404 {
		t.Fatalf("scratch used muse's session: %d %s", w.Code, w.Body.String())
	}
	if len(rig.wizard.toolCalls()) != 0 {
		t.Fatal("the borrowed session reached T3")
	}
}

// A pinned caller's launch reaches T3 with the pin applied; the trace keeps
// the caller's own words and names what was changed.
func TestMCPPinsTheLaunch(t *testing.T) {
	rig := newMCPRig(t)
	rig.h.srv.CallerPins = map[string]callerPin{testActor: {Model: "claude-opus-5-5", Effort: "high", PermissionMode: "bypassPermissions"}}
	sid := rig.initialize(testToken)
	launch := toolCall(3, "t3_thread_launch", `{"title":"t","projectId":"p1","message":"go","runtimeMode":"approval-required","modelSelection":{"instanceId":"claudeAgent","model":"claude-opus-5"}}`)
	w := rig.post(testToken, sid, launch)
	if w.Code != 200 {
		t.Fatalf("launch: %d %s", w.Code, w.Body.String())
	}
	calls := rig.wizard.toolCalls()
	if len(calls) != 1 {
		t.Fatalf("T3 saw %d calls", len(calls))
	}
	a := calls[0].Args
	sel, _ := a["modelSelection"].(map[string]any)
	if a["runtimeMode"] != "full-access" || a["interactionMode"] != "default" || sel["model"] != "claude-opus-5-5" || sel["instanceId"] != "claudeAgent" {
		t.Fatalf("T3 got %v", a)
	}
	if opts, _ := sel["options"].([]any); len(opts) != 1 || fmt.Sprint(opts[0]) != "map[id:effort value:high]" {
		t.Fatalf("options %v", sel["options"])
	}
	if a["message"] != "go" || a["projectId"] != "p1" {
		t.Fatalf("the rest of the call changed: %v", a)
	}

	// Another caller with no pin launches as it asks.
	other := rig.initialize(testOtherToken)
	rig.post(testOtherToken, other, launch)
	if a := rig.wizard.toolCalls()[1].Args; a["runtimeMode"] != "approval-required" {
		t.Fatalf("an unpinned caller was pinned: %v", a)
	}

	var e TraceEntry
	for _, l := range rig.mcpTrace() {
		if l.Tool == "t3_thread_launch" && l.Actor == testActor {
			e = l
		}
	}
	if !strings.Contains(string(e.Request), `"approval-required"`) {
		t.Errorf("the trace records %s, want the caller's own request", e.Request)
	}
	if strings.Join(e.Rewritten, ",") != "modelSelection,runtimeMode,interactionMode" {
		t.Errorf("rewritten %v", e.Rewritten)
	}
	if e.ThreadID != "thread-launched" {
		t.Errorf("thread id %q, want the launched thread's", e.ThreadID)
	}
}

// A wait the caller leaves open is capped at the /v1 ceiling, so T3 answers
// before the edge gives up.
func TestMCPCapsAWait(t *testing.T) {
	rig := newMCPRig(t)
	sid := rig.initialize(testToken)
	if w := rig.post(testToken, sid, toolCall(1, "t3_thread_wait", `{"threadId":"t"}`)); w.Code != 200 {
		t.Fatalf("wait: %d %s", w.Code, w.Body.String())
	}
	if got := rig.wizard.toolCalls()[0].Args["timeoutMs"]; got != float64(maxWaitSeconds*1000) {
		t.Fatalf("T3 got timeoutMs %v, want %d", got, maxWaitSeconds*1000)
	}
}

func TestMCPDeleteEndsTheSession(t *testing.T) {
	rig := newMCPRig(t)
	sid := rig.initialize(testToken)

	// Another caller cannot end it.
	if w := rig.h.do(request{method: "DELETE", path: "/mcp", token: testOtherToken, headers: map[string]string{"Mcp-Session-Id": sid}}); w.Code != 204 {
		t.Fatalf("delete by another caller: %d", w.Code)
	}
	if w := rig.post(testToken, sid, toolCall(1, "t3_thread_read", `{"threadId":"x"}`)); w.Code != 200 {
		t.Fatalf("another caller's DELETE ended muse's session: %d", w.Code)
	}

	w := rig.h.do(request{method: "DELETE", path: "/mcp", token: testToken, headers: map[string]string{"Mcp-Session-Id": sid}})
	if w.Code != 204 {
		t.Fatalf("delete: %d %s", w.Code, w.Body.String())
	}
	rig.wizard.mu.Lock()
	deleted := append([]string(nil), rig.wizard.deleted...)
	rig.wizard.mu.Unlock()
	if len(deleted) != 1 || deleted[0] != "upstream-1" {
		t.Fatalf("T3 saw DELETE for %v, want upstream-1", deleted)
	}
	if w := rig.post(testToken, sid, toolCall(2, "t3_thread_read", `{"threadId":"x"}`)); w.Code != 404 {
		t.Fatalf("an ended session still answers: %d", w.Code)
	}

	if w := rig.h.do(request{method: "DELETE", path: "/mcp", token: testToken}); w.Code != 400 {
		t.Fatalf("delete with no session: %d, want 400", w.Code)
	}
}

// T3 has no server-to-client stream, so GET is refused the way the MCP spec
// asks: 405.
func TestMCPGetIsNotAllowed(t *testing.T) {
	rig := newMCPRig(t)
	w := rig.h.do(request{method: "GET", path: "/mcp", token: testToken})
	if w.Code != 405 {
		t.Fatalf("GET: %d, want 405", w.Code)
	}
	if allow := w.Header().Get("Allow"); allow != "POST, DELETE" {
		t.Errorf("Allow %q", allow)
	}
}

func TestMCPRefusesABatch(t *testing.T) {
	rig := newMCPRig(t)
	sid := rig.initialize(testToken)
	w := rig.post(testToken, sid, "["+toolCall(1, "t3_thread_read", `{}`)+"]")
	if w.Code != 400 || !strings.Contains(w.Body.String(), "batch") {
		t.Fatalf("batch: %d %s", w.Code, w.Body.String())
	}
}

// One line per call, carrying what the call was and how it ended, and never
// what T3 answered.
func TestMCPTracesEachCall(t *testing.T) {
	rig := newMCPRig(t)
	sid := rig.initialize(testToken)
	rig.post(testToken, sid, toolCall(1, "t3_thread_read", `{"threadId":"thread-a"}`))
	rig.post(testToken, sid, toolCall(2, "t3_thread_read", `{"threadId":"missing"}`))
	rig.post(testToken, sid, toolCall(3, "t3_nonesuch", `{}`))
	rig.h.do(request{method: "DELETE", path: "/mcp", token: testToken, headers: map[string]string{"Mcp-Session-Id": sid}})

	lines := rig.mcpTrace()
	type row struct{ verb, method, tool, thread, result string }
	var got []row
	for _, e := range lines {
		got = append(got, row{e.Verb, e.MCPMethod, e.Tool, e.ThreadID, e.Result})
		if e.Actor != testActor {
			t.Errorf("actor %q", e.Actor)
		}
		if e.TS == "" || e.TraceID == "" {
			t.Errorf("an unstamped line: %+v", e)
		}
	}
	want := []row{
		{"POST /mcp", "initialize", "", "", "ok"},
		{"POST /mcp", "notifications/initialized", "", "", "accepted"},
		{"POST /mcp", "tools/call", "t3_thread_read", "thread-a", "ok"},
		{"POST /mcp", "tools/call", "t3_thread_read", "missing", "tool_error"},
		{"POST /mcp", "tools/call", "t3_nonesuch", "", "rpc_error"},
		{"DELETE /mcp", "", "", "", "ok"},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("trace\n got %v\nwant %v", got, want)
	}
	if lines[3].Status != 200 || lines[5].Status != 204 {
		t.Errorf("statuses %d %d", lines[3].Status, lines[5].Status)
	}
	if !strings.Contains(string(lines[3].Response), "thread_not_found") {
		t.Errorf("a tool error's reason is missing from the trace: %s", lines[3].Response)
	}
	trace := rig.h.trace.String()
	for _, secret := range []string{threadReadMarker, fakeT3Token, testToken} {
		if strings.Contains(trace, secret) {
			t.Errorf("the trace holds %q", secret)
		}
	}
}

// A box with no T3 wired answers in JSON-RPC, and a T3 that is down is a 502
// the caller can tell from a refusal.
func TestMCPWhenT3IsMissingOrDown(t *testing.T) {
	t.Run("not configured", func(t *testing.T) {
		h := newHarness(t)
		w := h.do(request{method: "POST", path: "/mcp", body: mcpInit, token: testToken})
		if w.Code != 503 || !strings.Contains(w.Body.String(), `"jsonrpc"`) {
			t.Fatalf("%d %s", w.Code, w.Body.String())
		}
	})
	t.Run("down", func(t *testing.T) {
		rig := newMCPRig(t)
		rig.wizard.srv.Close()
		w := rig.post(testToken, "", mcpInit)
		if w.Code != 502 || !strings.Contains(w.Body.String(), `"jsonrpc"`) {
			t.Fatalf("%d %s", w.Code, w.Body.String())
		}
		if l := rig.mcpTrace(); len(l) != 1 || l[0].Result != "unreachable" || l[0].Status != 502 {
			t.Fatalf("trace %+v", l)
		}
	})
}

// The pass-through's calls are counted in the lobby's T3 metrics, which
// /metrics serves.
func TestMCPCountsCalls(t *testing.T) {
	rig := newMCPRig(t)
	rig.h.srv.Metrics = rig.metrics
	sid := rig.initialize(testToken)
	rig.post(testToken, sid, toolCall(1, "t3_thread_read", `{"threadId":"a"}`))
	w := rig.h.do(request{method: "GET", path: "/metrics"})
	if w.Code != 200 {
		t.Fatalf("/metrics: %d", w.Code)
	}
	if want := `tl_t3_calls_total{result="ok",service="agent-api",tool="t3_thread_read",user="wizard"} 1`; !strings.Contains(w.Body.String(), want) {
		t.Fatalf("missing %s in\n%s", want, w.Body.String())
	}
}

// Muse's real pin: inherit, inherit, bypass. Whatever model it names, the
// launch runs the box default model and effort.
func TestMCPInheritPinRunsTheBoxDefault(t *testing.T) {
	rig := newMCPRig(t)
	rig.h.srv.Models = models{Default: "claude-opus-5-5", DefaultEffort: "high"}
	rig.h.srv.CallerPins = map[string]callerPin{testActor: {Model: pinInherit, Effort: pinInherit, PermissionMode: "bypassPermissions"}}
	sid := rig.initialize(testToken)
	w := rig.post(testToken, sid, toolCall(1, "t3_thread_launch",
		`{"title":"t","projectId":"p1","modelSelection":{"instanceId":"claudeAgent","model":"claude-opus-5","options":[{"id":"effort","value":"max"}]}}`))
	if w.Code != 200 {
		t.Fatalf("launch: %d %s", w.Code, w.Body.String())
	}
	sel, _ := rig.wizard.toolCalls()[0].Args["modelSelection"].(map[string]any)
	if sel["model"] != "claude-opus-5-5" || fmt.Sprint(sel["options"]) != "[map[id:effort value:high]]" {
		t.Fatalf("T3 got %v", sel)
	}
}
