package t3client

// The one test against a real T3. It starts a throwaway `t3 serve` in a temp
// directory, signs in the way production does (a pairing code, then the
// headless OAuth flow), and drives the calls the lobby makes. It never sends
// a message, so no model turn runs and no subscription usage is spent.
//
//	T3CLIENT_IT=1 go test -run TestIntegration -v ./...
//
// T3CLIENT_T3_BIN overrides the binary (default
// ~/.t3/runtime/versions/0.1.5/t3). It uses the first free port in
// 3795-3799 and never touches a user's own server.

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

type t3Server struct {
	bin, home, base string
	port            int
	cmd             *exec.Cmd
}

func (s *t3Server) start(t *testing.T) {
	t.Helper()
	cmd := exec.Command(s.bin, "serve", "--port", fmt.Sprint(s.port), "--host", "127.0.0.1",
		"--base-dir", s.base, "--no-browser")
	cmd.Env = append(os.Environ(), "HOME="+s.home)
	cmd.Dir = s.home
	log, err := os.Create(filepath.Join(s.home, "serve.log"))
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stdout, cmd.Stderr = log, log
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	s.cmd = cmd
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/.well-known/t3/environment", s.port))
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				return
			}
		}
		time.Sleep(300 * time.Millisecond)
	}
	b, _ := os.ReadFile(log.Name())
	t.Fatalf("t3 serve did not come up on %d:\n%s", s.port, b)
}

func (s *t3Server) stop() {
	if s.cmd == nil || s.cmd.Process == nil {
		return
	}
	syscall.Kill(-s.cmd.Process.Pid, syscall.SIGTERM)
	done := make(chan struct{})
	go func() { s.cmd.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		syscall.Kill(-s.cmd.Process.Pid, syscall.SIGKILL)
		<-done
	}
	s.cmd = nil
}

func freePort(t *testing.T) int {
	for p := 3795; p <= 3799; p++ {
		l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
		if err != nil {
			continue
		}
		l.Close()
		// Also refuse a port someone holds on another address.
		if c, err := net.DialTimeout("tcp", fmt.Sprintf("localhost:%d", p), 200*time.Millisecond); err == nil {
			c.Close()
			continue
		}
		return p
	}
	t.Fatal("no free port in 3795-3799")
	return 0
}

func TestIntegration(t *testing.T) {
	if os.Getenv("T3CLIENT_IT") != "1" {
		t.Skip("set T3CLIENT_IT=1 to run against a throwaway t3 serve")
	}
	bin := os.Getenv("T3CLIENT_T3_BIN")
	if bin == "" {
		home, _ := os.UserHomeDir()
		bin = filepath.Join(home, ".t3/runtime/versions/0.1.5/t3")
	}
	if _, err := os.Stat(bin); err != nil {
		t.Fatalf("no t3 binary: %v", err)
	}
	root := t.TempDir()
	srv := &t3Server{bin: bin, home: filepath.Join(root, "home"), base: filepath.Join(root, "base"), port: freePort(t)}
	os.MkdirAll(srv.home, 0o700)
	os.MkdirAll(srv.base, 0o700)
	srv.start(t)
	t.Cleanup(srv.stop)
	t.Logf("t3 serve on 127.0.0.1:%d, base %s", srv.port, srv.base)

	mints := 0
	minter := ExecMinter{Argv: func(user string) []string {
		mints++
		return []string{"env", "HOME=" + srv.home, bin, "auth", "pairing", "create", "--base-dir", srv.base, "--json"}
	}}
	hosts, err := ParseHosts("wizard=t3.example.test", "example.test")
	if err != nil {
		t.Fatal(err)
	}
	seen := &statusCounter{}
	c := New(Config{
		Service:     "t3client-it",
		HTTP:        &http.Client{Transport: seen},
		Locator:     &Locator{Ports: func(string) (int, error) { return srv.port, nil }, Hosts: hosts},
		Credentials: &Credentials{Minter: minter, Store: TokenStore{Dir: filepath.Join(root, "state")}},
	})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	const user = "wizard"

	ws := filepath.Join(root, "ws")
	os.MkdirAll(filepath.Join(ws, "sub"), 0o755)
	c.cfg.Toplevel = func(_ context.Context, _, dir string) (string, error) { return ws, nil }
	p, err := c.ProjectForDir(ctx, user, filepath.Join(ws, "sub"))
	if err != nil {
		t.Fatalf("ProjectForDir: %v", err)
	}
	if p.WorkspaceRoot != ws || p.Title != "ws" {
		t.Fatalf("project %+v", p)
	}
	again, err := c.ProjectForDir(ctx, user, ws)
	if err != nil || again.ID != p.ID {
		t.Fatalf("second ProjectForDir = %+v, %v; want %s", again, err, p.ID)
	}
	t.Logf("project %s at %s", p.ID, p.WorkspaceRoot)

	l, err := c.Launch(ctx, user, LaunchRequest{ProjectID: p.ID, Title: "t3client it", Model: "claude-opus-5-5"})
	if err != nil {
		t.Fatalf("Launch: %v", err)
	}
	t.Logf("launched %s (alias %s, run %q, status %q)", l.ThreadID, Alias(l.ThreadID), l.RunID, l.Status)
	if l.RunID != "" {
		t.Fatalf("a launch without a prompt started run %s", l.RunID)
	}

	find := func() *Thread {
		ts, err := c.ListThreads(ctx, user)
		if err != nil {
			t.Fatalf("ListThreads: %v", err)
		}
		for i := range ts {
			if ts[i].ThreadID == l.ThreadID {
				return &ts[i]
			}
		}
		return nil
	}
	th := find()
	if th == nil || th.Title != "t3client it" || th.RuntimeMode != "full-access" || th.ProviderInstanceID != "claudeAgent" {
		t.Fatalf("listed thread %+v", th)
	}
	t.Logf("listed: status %s -> lobby %s", th.Status, th.LobbyState())

	loc, err := c.Locator().Locate(ctx, user)
	if err != nil {
		t.Fatal(err)
	}
	// T3's own link and ours must escape the id the same way.
	link, _ := url.Parse(th.Link)
	web, _ := url.Parse(loc.WebURL(l.ThreadID))
	if link.EscapedPath() != web.EscapedPath() || web.Host != "t3.example.test" {
		t.Fatalf("WebURL %s does not match T3's link %s", web, link)
	}
	t.Logf("web %s, app %s", loc.WebURL(l.ThreadID), loc.AppURL(l.ThreadID))

	if err := c.Rename(ctx, user, l.ThreadID, "renamed by it"); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if th := find(); th == nil || th.Title != "renamed by it" {
		t.Fatalf("after rename %+v", th)
	}

	// A T3 restart drops MCP sessions; the token survives in T3's database
	// and the client re-initializes.
	srv.stop()
	srv.start(t)
	before := seen.get(404)
	if th := find(); th == nil {
		t.Fatal("thread missing after restart")
	}
	if seen.get(404) == before {
		t.Fatal("no 404 after the restart, so the re-initialize path did not run")
	}
	t.Log("re-initialized after a T3 restart (T3 answered 404 to the old session)")

	// The pass-through, end to end.
	r, err := c.Forward(ctx, ForwardRequest{CallerID: "it", User: user, Body: []byte(museInit)})
	if err != nil || r.Status != 200 {
		t.Fatalf("Forward initialize: %d %v %s", r.Status, err, r.Body)
	}
	sid := r.Header.Get("mcp-session-id")
	c.Forward(ctx, ForwardRequest{CallerID: "it", User: user, SessionID: sid, Body: []byte(`{"jsonrpc":"2.0","method":"notifications/initialized"}`)})
	r, err = c.Forward(ctx, ForwardRequest{CallerID: "it", User: user, SessionID: sid, Body: []byte(`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)})
	if err != nil || r.Status != 200 || !strings.Contains(string(r.Body), "t3_thread_launch") {
		t.Fatalf("Forward tools/list: %d %v %.200s", r.Status, err, r.Body)
	}
	t.Log("forwarded tools/list")

	if err := c.Archive(ctx, user, l.ThreadID); err != nil {
		t.Fatalf("Archive: %v", err)
	}
	if th := find(); th != nil {
		t.Fatalf("archived thread still listed: %+v", th)
	}
	if mints != 1 {
		t.Fatalf("minted %d pairing codes, want 1", mints)
	}
	t.Log("archived; one pairing code made one token for the whole run")
}

type statusCounter struct {
	mu sync.Mutex
	n  map[int]int
}

func (s *statusCounter) RoundTrip(r *http.Request) (*http.Response, error) {
	resp, err := http.DefaultTransport.RoundTrip(r)
	if err == nil {
		s.mu.Lock()
		if s.n == nil {
			s.n = map[int]int{}
		}
		s.n[resp.StatusCode]++
		s.mu.Unlock()
	}
	return resp, err
}

func (s *statusCounter) get(code int) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.n[code]
}
