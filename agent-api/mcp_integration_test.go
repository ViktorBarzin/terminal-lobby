package main

// /mcp against a real T3. It starts a throwaway `t3 serve` in a temp
// directory and drives the pass-through as Muse would, through the real
// handler and gate: initialize, tools/list, a pinned t3_thread_launch with no
// message (so no model turn runs and no subscription usage is spent), a read
// back of what T3 made, and DELETE.
//
//	AGENTAPI_T3_IT=1 go test -run TestMCPIntegration -v .
//
// AGENTAPI_T3_BIN overrides the binary (default
// ~/.t3/runtime/versions/0.1.5/t3). It uses the first free port in 3795-3799
// and never touches a user's own server.

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"terminal-lobby/t3client"
)

func TestMCPIntegration(t *testing.T) {
	if os.Getenv("AGENTAPI_T3_IT") != "1" {
		t.Skip("set AGENTAPI_T3_IT=1 to run against a throwaway t3 serve")
	}
	bin := os.Getenv("AGENTAPI_T3_BIN")
	if bin == "" {
		home, _ := os.UserHomeDir()
		bin = filepath.Join(home, ".t3/runtime/versions/0.1.5/t3")
	}
	if _, err := os.Stat(bin); err != nil {
		t.Fatalf("no t3 binary: %v", err)
	}
	root := t.TempDir()
	home, base := filepath.Join(root, "home"), filepath.Join(root, "base")
	os.MkdirAll(home, 0o700)
	os.MkdirAll(base, 0o700)
	port := itFreePort(t)
	stop := itStartT3(t, bin, home, base, port)
	t.Cleanup(stop)

	h := newHarness(t)
	h.srv.T3 = t3client.New(t3client.Config{
		Service: "agent-api",
		Locator: &t3client.Locator{Ports: func(string) (int, error) { return port, nil }},
		Credentials: &t3client.Credentials{
			Label: "agent-api",
			Store: t3client.TokenStore{Dir: filepath.Join(root, "state", "t3")},
			Minter: t3client.ExecMinter{Argv: func(string) []string {
				return []string{"env", "HOME=" + home, bin, "auth", "pairing", "create", "--base-dir", base, "--json"}
			}},
		},
	})
	h.srv.CallerPins = map[string]callerPin{testActor: {Model: "claude-opus-5-5", Effort: "high", PermissionMode: "plan"}}
	rig := &mcpRig{h: h}

	sid := rig.initialize(testToken)
	t.Logf("session %s", sid)

	w := rig.post(testToken, sid, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "t3_thread_launch") {
		t.Fatalf("tools/list: %d %.300s", w.Code, w.Body.String())
	}

	// The caller asks for full access on another model; the pin says plan
	// mode on Opus 5.5 at high effort.
	w = rig.post(testToken, sid, toolCall(2, "t3_thread_launch",
		`{"scratch":true,"title":"agent-api it","runtimeMode":"full-access","modelSelection":{"instanceId":"claudeAgent","model":"claude-fable-5"}}`))
	launched := itResult(t, w)
	if launched["runId"] != nil {
		t.Fatalf("a launch with no message started a run: %v", launched)
	}
	sel, _ := launched["modelSelection"].(map[string]any)
	if sel["model"] != "claude-opus-5-5" || !strings.Contains(fmt.Sprint(sel["options"]), "effort value:high") {
		t.Fatalf("T3 made %v", sel)
	}
	thread, _ := launched["threadId"].(string)
	t.Logf("launched %s with %v", thread, sel)

	project, _ := launched["projectId"].(string)
	w = rig.post(testToken, sid, toolCall(3, "t3_thread_list", fmt.Sprintf(`{"projectId":%q}`, project)))
	list := itResult(t, w)
	b, _ := json.Marshal(list)
	if !strings.Contains(string(b), thread) || !strings.Contains(string(b), `"approval-required"`) || !strings.Contains(string(b), `"plan"`) {
		t.Fatalf("listed %s", b)
	}
	t.Log("T3 lists the thread as approval-required in plan mode")

	if w := rig.h.do(request{method: "DELETE", path: "/mcp", token: testToken, headers: map[string]string{"Mcp-Session-Id": sid}}); w.Code != 204 {
		t.Fatalf("DELETE: %d", w.Code)
	}
	if w := rig.post(testToken, sid, toolCall(4, "t3_thread_list", fmt.Sprintf(`{"projectId":%q}`, project))); w.Code != 404 {
		t.Fatalf("after DELETE: %d", w.Code)
	}
	for _, e := range rig.mcpTrace() {
		t.Logf("trace: %s %s %s %s %s %d %v", e.Verb, e.MCPMethod, e.Tool, e.ThreadID, e.Result, e.Status, e.Rewritten)
	}
}

// itResult is a tools/call's structuredContent, failing on anything else.
func itResult(t *testing.T, w interface {
	Result() *http.Response
}) map[string]any {
	t.Helper()
	resp := w.Result()
	var m struct {
		Error  any `json:"error"`
		Result struct {
			IsError    bool           `json:"isError"`
			Content    []any          `json:"content"`
			Structured map[string]any `json:"structuredContent"`
		} `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&m); err != nil || resp.StatusCode != 200 || m.Error != nil || m.Result.IsError {
		t.Fatalf("tools/call: %d %v error=%v content=%v", resp.StatusCode, err, m.Error, m.Result.Content)
	}
	return m.Result.Structured
}

func itStartT3(t *testing.T, bin, home, base string, port int) func() {
	t.Helper()
	cmd := exec.Command(bin, "serve", "--port", fmt.Sprint(port), "--host", "127.0.0.1", "--base-dir", base, "--no-browser")
	cmd.Env = append(os.Environ(), "HOME="+home)
	cmd.Dir = home
	log, err := os.Create(filepath.Join(home, "serve.log"))
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stdout, cmd.Stderr = log, log
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	stop := func() {
		syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
		done := make(chan struct{})
		go func() { cmd.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			<-done
		}
	}
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/.well-known/t3/environment", port))
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				return stop
			}
		}
		time.Sleep(300 * time.Millisecond)
	}
	stop()
	b, _ := os.ReadFile(log.Name())
	t.Fatalf("t3 serve did not come up on %d:\n%s", port, b)
	return nil
}

func itFreePort(t *testing.T) int {
	for p := 3795; p <= 3799; p++ {
		l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
		if err != nil {
			continue
		}
		l.Close()
		if c, err := net.DialTimeout("tcp", fmt.Sprintf("localhost:%d", p), 200*time.Millisecond); err == nil {
			c.Close()
			continue
		}
		return p
	}
	t.Fatal("no free port in 3795-3799")
	return 0
}
