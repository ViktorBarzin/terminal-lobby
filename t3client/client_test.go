package t3client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"terminal-lobby/telemetry"
)

// telemetry.Metrics is how the lobby services export Prometheus today.
var _ Metrics = (*telemetry.Metrics)(nil)

func newTestClient(t *testing.T, f *fakeT3) (*Client, *fakeClock, *telemetry.Metrics) {
	t.Helper()
	clock := newClock()
	m := telemetry.NewMetrics()
	c := New(Config{
		Service:     "tmux-api",
		Locator:     &Locator{Ports: fixedPort(t, f.srv.URL)},
		Credentials: &Credentials{Minter: f.minter(), Store: TokenStore{Dir: t.TempDir()}, Now: clock.Now},
		Metrics:     m,
		Now:         clock.Now,
	})
	return c, clock, m
}

func echoTool(name string, args map[string]any) (any, *fakeToolErr) {
	return map[string]any{"tool": name, "args": args}, nil
}

func TestCallInitializesOnce(t *testing.T) {
	f := newFakeT3(t)
	f.tool = echoTool
	c, _, _ := newTestClient(t, f)
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		out, err := c.Call(ctx, "wizard", "t3_project_list", map[string]any{"limit": 5})
		if err != nil {
			t.Fatal(err)
		}
		var got struct {
			Tool string
			Args map[string]any
		}
		if err := json.Unmarshal(out, &got); err != nil || got.Tool != "t3_project_list" || got.Args["limit"] != float64(5) {
			t.Fatalf("Call = %s, %v", out, err)
		}
	}
	if _, _, inits := f.counts(); inits != 1 {
		t.Fatalf("initialized %d times, want 1", inits)
	}
	if c.Service() != "tmux-api" {
		t.Fatal("service lost")
	}
	if tok, _ := c.cfg.Credentials.Store.Load("wizard"); tok.Label != "tmux-api" {
		t.Fatalf("token label %q, want the service name", tok.Label)
	}
}

func TestCallReinitializesAfterRestart(t *testing.T) {
	f := newFakeT3(t)
	f.tool = echoTool
	c, _, _ := newTestClient(t, f)
	ctx := context.Background()
	if _, err := c.Call(ctx, "wizard", "t3_project_list", nil); err != nil {
		t.Fatal(err)
	}
	f.restart()
	if _, err := c.Call(ctx, "wizard", "t3_project_list", nil); err != nil {
		t.Fatalf("call after restart: %v", err)
	}
	if _, _, inits := f.counts(); inits != 2 {
		t.Fatalf("initialized %d times, want 2", inits)
	}
}

func TestCallGivesUpAfterOneReinit(t *testing.T) {
	f := newFakeT3(t)
	f.tool = echoTool
	f.lose404 = true
	c, _, _ := newTestClient(t, f)
	_, err := c.Call(context.Background(), "wizard", "t3_project_list", nil)
	var he *HTTPError
	if !errors.As(err, &he) || he.Status != 404 {
		t.Fatalf("err = %v, want HTTP 404", err)
	}
	if _, _, inits := f.counts(); inits != 2 {
		t.Fatalf("initialized %d times, want 2 (one retry)", inits)
	}
}

func TestCallRenewsOn401(t *testing.T) {
	f := newFakeT3(t)
	f.tool = echoTool
	c, _, _ := newTestClient(t, f)
	ctx := context.Background()
	if _, err := c.Call(ctx, "wizard", "t3_project_list", nil); err != nil {
		t.Fatal(err)
	}
	f.revoke()
	if _, err := c.Call(ctx, "wizard", "t3_project_list", nil); err != nil {
		t.Fatalf("call after revoke: %v", err)
	}
	if _, issued, _ := f.counts(); issued != 2 {
		t.Fatalf("issued %d tokens, want 2", issued)
	}
}

func TestCallDecodesToolError(t *testing.T) {
	f := newFakeT3(t)
	f.tool = func(string, map[string]any) (any, *fakeToolErr) {
		return nil, &fakeToolErr{"thread_not_found", "Thread nope is no longer available."}
	}
	c, _, _ := newTestClient(t, f)
	_, err := c.Call(context.Background(), "wizard", "t3_thread_read", map[string]any{"threadId": "nope"})
	var te *ToolError
	if !errors.As(err, &te) {
		t.Fatalf("err = %v, want *ToolError", err)
	}
	if te.Tool != "t3_thread_read" || te.Code != "thread_not_found" || te.Message != "Thread nope is no longer available." {
		t.Fatalf("ToolError = %+v", te)
	}
	if !IsToolError(err, "thread_not_found") || IsToolError(err, "invalid_request") {
		t.Fatal("IsToolError does not match on code")
	}
}

func TestCallDecodesRPCError(t *testing.T) {
	f := newFakeT3(t)
	c, _, _ := newTestClient(t, f)
	_, err := c.Call(context.Background(), "wizard", "t3_nope", nil)
	var re *RPCError
	if !errors.As(err, &re) || re.Code != -32602 || !strings.Contains(re.Message, "not found") {
		t.Fatalf("err = %v, want RPC -32602", err)
	}
}

func TestCallHonoursContextTimeout(t *testing.T) {
	f := newFakeT3(t)
	f.tool = func(string, map[string]any) (any, *fakeToolErr) {
		time.Sleep(500 * time.Millisecond)
		return map[string]any{}, nil
	}
	c, _, _ := newTestClient(t, f)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, err := c.Call(ctx, "wizard", "t3_project_list", nil); err != nil { // warm the session
		t.Fatal(err)
	}
	short, cancel2 := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel2()
	start := time.Now()
	_, err := c.Call(short, "wizard", "t3_project_list", nil)
	if err == nil || time.Since(start) > 400*time.Millisecond {
		t.Fatalf("err = %v after %v, want a timeout near 50ms", err, time.Since(start))
	}
	if r := resultOf(err); r != "timeout" {
		t.Fatalf("result label %q, want timeout", r)
	}
}

func TestCallConcurrentSharesOneSession(t *testing.T) {
	f := newFakeT3(t)
	f.tool = echoTool
	c, _, _ := newTestClient(t, f)
	var wg sync.WaitGroup
	errs := make(chan error, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := c.Call(context.Background(), "wizard", "t3_project_list", nil)
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	regs, issued, inits := f.counts()
	if regs != 1 || issued != 1 || inits != 1 {
		t.Fatalf("registers=%d issued=%d inits=%d, want 1 each", regs, issued, inits)
	}
}

func TestCallMetrics(t *testing.T) {
	f := newFakeT3(t)
	c, clock, m := newTestClient(t, f)
	ctx := context.Background()
	f.tool = echoTool
	c.Call(ctx, "wizard", "t3_thread_list", nil)
	c.Call(ctx, "wizard", "t3_thread_list", nil)
	f.tool = func(string, map[string]any) (any, *fakeToolErr) { return nil, &fakeToolErr{"x", "y"} }
	c.Call(ctx, "wizard", "t3_thread_read", nil)
	f.tool = nil
	c.Call(ctx, "wizard", "t3_thread_read", nil)
	bad := New(Config{Service: "tmux-api", Locator: &Locator{Ports: func(string) (int, error) { return 1, nil }},
		Credentials: &Credentials{Minter: f.minter(), Store: TokenStore{Dir: t.TempDir()}}, Metrics: m})
	bad.Call(ctx, "emo", "t3_thread_list", nil)

	var buf bytes.Buffer
	m.Render(&buf)
	out := buf.String()
	for _, want := range []string{
		`tl_t3_calls_total{result="ok",service="tmux-api",tool="t3_thread_list",user="wizard"} 2`,
		`tl_t3_calls_total{result="tool_error",service="tmux-api",tool="t3_thread_read",user="wizard"} 1`,
		`tl_t3_calls_total{result="rpc_error",service="tmux-api",tool="t3_thread_read",user="wizard"} 1`,
		`tl_t3_calls_total{result="unreachable",service="tmux-api",tool="t3_thread_list",user="emo"} 1`,
		`tl_t3_last_success_timestamp_seconds{service="tmux-api",user="wizard"} ` + itoa(clock.Now().Unix()),
	} {
		if !strings.Contains(out, want) {
			t.Errorf("metrics lack %s\n%s", want, out)
		}
	}
	if strings.Contains(out, `tl_t3_last_success_timestamp_seconds{service="tmux-api",user="emo"}`) {
		t.Error("a failed user has a last-success time")
	}
}

func TestParseRPCEventStream(t *testing.T) {
	body := "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/message\"}\n\n" +
		"event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"structuredContent\":{\"a\":1},\"isError\":false}}\n\n"
	msg, err := parseRPC("text/event-stream", []byte(body), 7)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(msg.Result, []byte(`"a":1`)) {
		t.Fatalf("result %s", msg.Result)
	}
}
