package main

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"terminal-lobby/sessionio"
	"terminal-lobby/sessionio/siotest"
)

// `claude-se-hook question` end to end: the real script, a real loopback
// connection through both hook gates, and the real hold. The script is a
// devvm artefact rather than Go; it is tested here because this package owns
// the route it talks to and the output it prints.
//
// The stdin fixture follows the keys Claude Code 2.1.283 sent a
// PermissionRequest hook in the 2026-09-27 probe (captured for ExitPlanMode),
// with an AskUserQuestion tool_input.

type scriptEnv struct {
	rg      *registry
	osUser  string
	path    string
	url     string
	tmuxVar string
	pane    string
	script  string
}

func newScriptEnv(t *testing.T) *scriptEnv {
	t.Helper()
	for _, bin := range []string{"tmux", "jq", "curl"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skipf("%s not available", bin)
		}
	}
	script, err := filepath.Abs(filepath.Join("..", "devvm", "claude-se-hook"))
	if err != nil {
		t.Fatal(err)
	}
	me, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}

	// A scratch tmux server with a session called demo: the script names its
	// session from its pane ($TMUX_PANE), and TMUX pointing here keeps it off
	// the developer's own server.
	sock := fmt.Sprintf("se-hook-%d-%s", os.Getpid(), strings.ReplaceAll(t.Name(), "/", "-"))
	exec.Command("tmux", "-L", sock, "kill-server").Run()
	if err := exec.Command("tmux", "-L", sock, "new-session", "-d", "-s", "demo", "sh").Run(); err != nil {
		t.Fatalf("new-session: %v", err)
	}
	t.Cleanup(func() { exec.Command("tmux", "-L", sock, "kill-server").Run() })
	sockPath, err := exec.Command("tmux", "-L", sock, "display-message", "-p", "#{socket_path}").Output()
	if err != nil {
		t.Fatalf("socket_path: %v", err)
	}

	pane, err := exec.Command("tmux", "-L", sock, "display-message", "-p", "-t", "=demo:", "#{pane_id}").Output()
	if err != nil {
		t.Fatalf("pane_id: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	home := t.TempDir()
	path := sessionio.TranscriptPath(sessionio.ProjectsRoot(home, me.Username), "/home/x", "s1")
	os.MkdirAll(filepath.Dir(path), 0o755)
	os.WriteFile(path, nil, 0o644)
	rg := newRegistry(ctx, time.Millisecond, home, siotest.NewFakeOptions(me.Username+"/demo"), me.Username)
	w := httptest.NewRecorder()
	rg.handleSessionStart()(w, httptest.NewRequest(http.MethodPost, "/hooks/session-start",
		strings.NewReader(`{"user":"`+me.Username+`","session_id":"s1","cwd":"/home/x","tmux_session":"demo"}`)))
	if w.Code != http.StatusNoContent {
		t.Fatalf("session-start: %d %s", w.Code, w.Body.String())
	}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /hooks/question", localhostOnly(peerOwnsClaim(rg.handleQuestionHook())))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return &scriptEnv{
		rg: rg, osUser: me.Username, path: path, url: srv.URL, script: script,
		tmuxVar: strings.TrimSpace(string(sockPath)) + ",0,0",
		pane:    strings.TrimSpace(string(pane)),
	}
}

// run starts the hook the way the CLI does and returns its stdout once it
// exits.
func (e *scriptEnv) run(t *testing.T, url string) (<-chan string, *exec.Cmd) {
	t.Helper()
	payload, err := os.ReadFile(filepath.Join("testdata", "permissionrequest_askuserquestion.json"))
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(e.script, "question")
	cmd.Stdin = strings.NewReader(strings.Replace(string(payload), "TRANSCRIPT", e.path, 1))
	cmd.Env = append(os.Environ(), "TMUX="+e.tmuxVar, "TMUX_PANE="+e.pane, "TL_SE_URL="+url, "USER="+e.osUser)
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan string, 1)
	go func() {
		cmd.Wait()
		done <- out.String()
	}()
	t.Cleanup(func() { cmd.Process.Kill() })
	return done, cmd
}

func (e *scriptEnv) waitHeld(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if e.rg.holds.get(holdKey(e.osUser, e.path)) != nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("the hook never held the question")
}

func TestTheHookScriptPrintsTheCardsAnswer(t *testing.T) {
	e := newScriptEnv(t)
	done, _ := e.run(t, e.url)
	e.waitHeld(t)

	resp := e.rg.settleHeld(e.osUser, e.path, sessionio.AnswerRequest{
		Answers: map[string][]string{"Pick a colour": {"Blue"}, "Pick fruits": {"Apple", "Plum"}},
	})
	if !resp.Applied {
		t.Fatalf("settle: %+v", resp)
	}
	select {
	case out := <-done:
		if !strings.Contains(out, `"behavior":"allow"`) || !strings.Contains(out, `"Pick fruits":"Apple, Plum"`) {
			t.Fatalf("the hook printed %q", out)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the hook did not exit after the answer")
	}
}

func TestTheHookScriptPrintsNothingWhenTheTerminalWins(t *testing.T) {
	e := newScriptEnv(t)
	done, _ := e.run(t, e.url)
	e.waitHeld(t)

	f, _ := os.OpenFile(e.path, os.O_APPEND|os.O_WRONLY, 0o644)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	fmt.Fprintln(f, `{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[`+
		`{"type":"text","text":"ok"}]},"uuid":"z1","timestamp":"`+now+`"}`)
	f.Close()

	select {
	case out := <-done:
		if strings.TrimSpace(out) != "" {
			t.Fatalf("the hook printed %q; with the terminal's answer in, it must print nothing", out)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the hook did not exit once the turn ended")
	}
}

// A service without the route, the box before this release, answers 404: the
// hook leaves at once and the CLI's menu is all there is, as before.
func TestTheHookScriptLeavesAtOnceWithoutTheRoute(t *testing.T) {
	e := newScriptEnv(t)
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()
	done, _ := e.run(t, srv.URL)
	select {
	case out := <-done:
		if strings.TrimSpace(out) != "" {
			t.Fatalf("printed %q", out)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the hook kept waiting on a service that has no such route")
	}
}

// Timed out by the CLI, the hook takes its request with it, and the held
// question is withdrawn rather than left waiting on nobody.
func TestTheHookScriptWithdrawsTheQuestionWhenStopped(t *testing.T) {
	e := newScriptEnv(t)
	done, cmd := e.run(t, e.url)
	e.waitHeld(t)
	cmd.Process.Signal(os.Interrupt)
	<-done
	deadline := time.Now().Add(5 * time.Second)
	for e.rg.holds.get(holdKey(e.osUser, e.path)) != nil {
		if time.Now().After(deadline) {
			t.Fatal("the question is still held after the hook was stopped")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
