package t3client

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
)

const museInit = `{"jsonrpc":"2.0","id":"i-1","method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"muse","version":"3"}}}`

func forwardInit(t *testing.T, c *Client, caller string) string {
	t.Helper()
	resp, err := c.Forward(context.Background(), ForwardRequest{CallerID: caller, User: "wizard", Body: []byte(museInit)})
	if err != nil {
		t.Fatal(err)
	}
	sid := resp.Header.Get("mcp-session-id")
	if resp.Status != 200 || sid == "" {
		t.Fatalf("initialize: %d %q %s", resp.Status, sid, resp.Body)
	}
	if !bytes.Contains(resp.Body, []byte(`"id":"i-1"`)) || !bytes.Contains(resp.Body, []byte(`"T3 Code"`)) {
		t.Fatalf("initialize body %s", resp.Body)
	}
	n, err := c.Forward(context.Background(), ForwardRequest{CallerID: caller, User: "wizard", SessionID: sid,
		Body: []byte(`{"jsonrpc":"2.0","method":"notifications/initialized"}`)})
	if err != nil || n.Status != 202 {
		t.Fatalf("initialized: %d %v", n.Status, err)
	}
	return sid
}

func forwardCall(t *testing.T, c *Client, caller, sid, tool string) ForwardResponse {
	t.Helper()
	body := `{"jsonrpc":"2.0","id":42,"method":"tools/call","params":{"name":"` + tool + `","arguments":{"limit":1}}}`
	resp, err := c.Forward(context.Background(), ForwardRequest{CallerID: caller, User: "wizard", SessionID: sid, Body: []byte(body)})
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func TestForwardMapsSessions(t *testing.T) {
	f := newFakeT3(t)
	f.tool = echoTool
	c, _, _ := newTestClient(t, f)
	sid := forwardInit(t, c, "muse")
	if strings.HasPrefix(sid, "sess-") {
		t.Fatalf("the caller saw the upstream session id %q", sid)
	}
	var p struct {
		ClientInfo struct{ Name string } `json:"clientInfo"`
	}
	json.Unmarshal(f.initParams[0], &p)
	if p.ClientInfo.Name != "muse" {
		t.Fatalf("upstream initialize params %s, want the caller's", f.initParams[0])
	}
	resp := forwardCall(t, c, "muse", sid, "t3_thread_list")
	if resp.Status != 200 || !bytes.Contains(resp.Body, []byte(`"id":42`)) || !bytes.Contains(resp.Body, []byte(`"structuredContent"`)) {
		t.Fatalf("tools/call: %d %s", resp.Status, resp.Body)
	}
	if resp.Header.Get("mcp-session-id") != sid || resp.Header.Get("content-type") != "application/json" {
		t.Fatalf("headers %v", resp.Header)
	}
}

func TestForwardReplaysInitializeAfterRestart(t *testing.T) {
	f := newFakeT3(t)
	f.tool = echoTool
	c, _, _ := newTestClient(t, f)
	sid := forwardInit(t, c, "muse")
	f.restart()
	resp := forwardCall(t, c, "muse", sid, "t3_thread_list")
	if resp.Status != 200 {
		t.Fatalf("after restart: %d %s", resp.Status, resp.Body)
	}
	if _, _, inits := f.counts(); inits != 2 || !bytes.Contains(f.initParams[1], []byte(`"muse"`)) {
		t.Fatalf("inits=%d params=%s, want the caller's initialize replayed", inits, f.initParams[len(f.initParams)-1])
	}
	if resp.Header.Get("mcp-session-id") != sid {
		t.Fatal("the caller's session id changed across the re-initialize")
	}
}

func TestForwardSessionsBelongToTheirCaller(t *testing.T) {
	f := newFakeT3(t)
	f.tool = echoTool
	c, _, _ := newTestClient(t, f)
	a := forwardInit(t, c, "muse")
	b := forwardInit(t, c, "wa-bot")
	if a == b {
		t.Fatal("two callers share a session id")
	}
	if _, _, inits := f.counts(); inits != 2 {
		t.Fatalf("inits=%d, want one upstream session per caller", inits)
	}
	if r := forwardCall(t, c, "wa-bot", a, "t3_thread_list"); r.Status != 404 {
		t.Fatalf("a caller used another caller's session: %d", r.Status)
	}
	// Same caller, different OS user: also refused.
	r, _ := c.Forward(context.Background(), ForwardRequest{CallerID: "muse", User: "emo", SessionID: a,
		Body: []byte(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)})
	if r.Status != 404 {
		t.Fatalf("a session crossed users: %d", r.Status)
	}
}

func TestForwardRejectsBadRequests(t *testing.T) {
	f := newFakeT3(t)
	f.tool = echoTool
	c, _, _ := newTestClient(t, f)
	cases := []struct {
		sid, body string
		status    int
	}{
		{"", `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`, 400},
		{"nope", `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`, 404},
		{"", `not json`, 400},
		{"", `[{"jsonrpc":"2.0","id":1,"method":"initialize"}]`, 400},
	}
	for _, tc := range cases {
		r, err := c.Forward(context.Background(), ForwardRequest{CallerID: "muse", User: "wizard", SessionID: tc.sid, Body: []byte(tc.body)})
		if err != nil || r.Status != tc.status {
			t.Errorf("%q %s: %d %v, want %d", tc.sid, tc.body, r.Status, err, tc.status)
		}
		if !json.Valid(r.Body) {
			t.Errorf("%s: body is not JSON: %s", tc.body, r.Body)
		}
	}
	if _, _, inits := f.counts(); inits != 0 {
		t.Fatal("a refused request reached T3")
	}
}

func TestForwardRenewsOn401(t *testing.T) {
	f := newFakeT3(t)
	f.tool = echoTool
	c, _, _ := newTestClient(t, f)
	sid := forwardInit(t, c, "muse")
	f.revoke()
	if r := forwardCall(t, c, "muse", sid, "t3_thread_list"); r.Status != 200 {
		t.Fatalf("after revoke: %d %s", r.Status, r.Body)
	}
	if _, issued, _ := f.counts(); issued != 2 {
		t.Fatalf("issued %d, want 2", issued)
	}
}

func TestForwardEnd(t *testing.T) {
	f := newFakeT3(t)
	f.tool = echoTool
	c, _, _ := newTestClient(t, f)
	sid := forwardInit(t, c, "muse")
	c.EndForward(context.Background(), "wa-bot", "wizard", sid) // not the owner: ignored
	if r := forwardCall(t, c, "muse", sid, "t3_thread_list"); r.Status != 200 {
		t.Fatalf("another caller ended the session: %d", r.Status)
	}
	c.EndForward(context.Background(), "muse", "wizard", sid)
	if r := forwardCall(t, c, "muse", sid, "t3_thread_list"); r.Status != 404 {
		t.Fatalf("ended session still answers: %d", r.Status)
	}
}

func TestForwardMetrics(t *testing.T) {
	f := newFakeT3(t)
	c, _, m := newTestClient(t, f)
	f.tool = echoTool
	sid := forwardInit(t, c, "muse")
	forwardCall(t, c, "muse", sid, "t3_thread_list")
	f.tool = func(string, map[string]any) (any, *fakeToolErr) { return nil, &fakeToolErr{"thread_not_found", "gone"} }
	forwardCall(t, c, "muse", sid, "t3_thread_read")
	f.tool = nil
	forwardCall(t, c, "muse", sid, `evil\"name`)
	var buf bytes.Buffer
	m.Render(&buf)
	out := buf.String()
	for _, want := range []string{
		`tl_t3_calls_total{result="ok",service="tmux-api",tool="initialize",user="wizard"} 1`,
		`tl_t3_calls_total{result="ok",service="tmux-api",tool="t3_thread_list",user="wizard"} 1`,
		`tl_t3_calls_total{result="tool_error",service="tmux-api",tool="t3_thread_read",user="wizard"} 1`,
		`tl_t3_calls_total{result="rpc_error",service="tmux-api",tool="other",user="wizard"} 1`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("metrics lack %s\n%s", want, out)
		}
	}
	if strings.Contains(out, "evil") {
		t.Error("a caller-chosen tool name reached a label")
	}
}
