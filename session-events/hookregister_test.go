package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// `claude-se-hook session-start` and `prompt-submit` against a scratch tmux
// server, with a stand-in for the service that records what was registered.
//
// The case these pin was found on 2026-09-28: emo's `marinov` and `monitors`
// were stamped with transcripts under -home-emo-code that were never written,
// while the pane itself held the right one. A Claude whose pane has gone (a
// speculative pool slot released while its Claude was still starting) ran
// `tmux display -p '#S'`, which does not fail without a pane: tmux answers with
// the most recently active session instead. The hook then registered the dead
// slot's transcript against somebody else's session.

type hookEnv struct {
	sock    string
	tmuxVar string
	script  string

	mu   sync.Mutex
	regs []sessionStartBody
	url  string
}

func newHookEnv(t *testing.T, sessions ...string) *hookEnv {
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
	e := &hookEnv{script: script}
	e.sock = fmt.Sprintf("se-reg-%d-%s", os.Getpid(), strings.ReplaceAll(t.Name(), "/", "-"))
	exec.Command("tmux", "-L", e.sock, "kill-server").Run()
	for _, s := range sessions {
		if err := exec.Command("tmux", "-L", e.sock, "new-session", "-d", "-s", s, "sh").Run(); err != nil {
			t.Fatalf("new-session %s: %v", s, err)
		}
	}
	t.Cleanup(func() { exec.Command("tmux", "-L", e.sock, "kill-server").Run() })
	sockPath := e.tmux(t, "display-message", "-p", "#{socket_path}")
	e.tmuxVar = sockPath + ",0,0"

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/hooks/session-start" {
			http.NotFound(w, r)
			return
		}
		var b sessionStartBody
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &b); err != nil {
			t.Errorf("bad body %q: %v", body, err)
		}
		e.mu.Lock()
		e.regs = append(e.regs, b)
		e.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(srv.Close)
	e.url = srv.URL
	return e
}

func (e *hookEnv) tmux(t *testing.T, args ...string) string {
	t.Helper()
	out, err := exec.Command("tmux", append([]string{"-L", e.sock}, args...)...).Output()
	if err != nil {
		t.Fatalf("tmux %v: %v", args, err)
	}
	return strings.TrimSpace(string(out))
}

func (e *hookEnv) pane(t *testing.T, session string) string {
	return e.tmux(t, "display-message", "-p", "-t", "="+session+":", "#{pane_id}")
}

// run fires the hook the way the CLI does, from inside pane.
func (e *hookEnv) run(t *testing.T, event, pane, sid, transcript string) {
	t.Helper()
	cmd := exec.Command(e.script, event)
	cmd.Stdin = strings.NewReader(fmt.Sprintf(
		`{"session_id":%q,"cwd":"/home/x","transcript_path":%q}`, sid, transcript))
	cmd.Env = append(os.Environ(), "TMUX="+e.tmuxVar, "TMUX_PANE="+pane, "TL_SE_URL="+e.url)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("hook %s: %v %s", event, err, out)
	}
}

func (e *hookEnv) registered() []sessionStartBody {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]sessionStartBody(nil), e.regs...)
}

func TestTheHookRegistersNothingWhenItsPaneHasGone(t *testing.T) {
	e := newHookEnv(t, "busy", "slot")
	dead := e.pane(t, "slot")
	e.tmux(t, "kill-session", "-t", "=slot")
	// The fallback this guards against: without a pane, tmux names the
	// surviving session rather than failing.
	if got := e.tmux(t, "display-message", "-p", "#S"); got != "busy" {
		t.Skipf("tmux fallback names %q, not the surviving session; precondition not met", got)
	}

	e.run(t, "session-start", dead, "slot-sid", "/home/x/.claude/projects/-home-x/slot-sid.jsonl")

	if regs := e.registered(); len(regs) != 0 {
		t.Fatalf("a hook whose pane is gone registered %+v; it must register nothing", regs)
	}
}

func TestTheHookRegistersThePanesOwnSession(t *testing.T) {
	e := newHookEnv(t, "mine", "busy")
	// busy is the newer session, so it is what an untargeted query returns.
	pane := e.pane(t, "mine")

	e.run(t, "session-start", pane, "sid-1", "/p/sid-1.jsonl")

	regs := e.registered()
	if len(regs) != 1 || regs[0].TmuxSession != "mine" {
		t.Fatalf("registered %+v, want one registration for the pane's own session \"mine\"", regs)
	}
}

// The pane remembers what it last registered, so prompt-submit used to trust
// that alone. A session stamp overwritten from elsewhere then stayed wrong for
// the rest of the Claude's life, because the pane's record still matched.
func TestAPromptHealsASessionStampWrittenFromElsewhere(t *testing.T) {
	e := newHookEnv(t, "mine")
	pane := e.pane(t, "mine")
	const tp = "/p/sid-1.jsonl"
	e.run(t, "session-start", pane, "sid-1", tp)
	e.tmux(t, "set-option", "-t", "=mine:", "@claude_transcript", tp)

	// Unchanged: no network work on the hot path.
	e.run(t, "prompt-submit", pane, "sid-1", tp)
	if n := len(e.registered()); n != 1 {
		t.Fatalf("an unchanged binding re-registered (%d registrations, want 1)", n)
	}

	e.tmux(t, "set-option", "-t", "=mine:", "@claude_transcript", "/p/somebody-else.jsonl")
	e.run(t, "prompt-submit", pane, "sid-1", tp)
	regs := e.registered()
	if len(regs) != 2 || regs[1].TmuxSession != "mine" || regs[1].TranscriptPath != tp {
		t.Fatalf("registrations %+v; the prompt should have re-registered %s for \"mine\"", regs, tp)
	}
}

// runUnder fires the hook from inside session's pane, as a child of `claudes`
// nested processes named claude: the process tree a real hook sees. The pane's
// own claude is the only claude between a hook and the tmux server; a claude an
// agent started from a tool call has a second one above it. Run from the pane
// rather than from the test, because a test run from a Claude session already
// has a real claude among its own ancestors.
func (e *hookEnv) runUnder(t *testing.T, claudes int, event, session, sid, transcript string) {
	t.Helper()
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("sh not available")
	}
	dir := t.TempDir()
	// The kernel names a process after the file it was started from, so a link
	// called claude gives a shell the name the script looks for.
	claude := filepath.Join(dir, "claude")
	if err := os.Symlink(sh, claude); err != nil {
		t.Fatal(err)
	}
	payload := filepath.Join(dir, "payload.json")
	body := fmt.Sprintf(`{"session_id":%q,"cwd":"/home/x","transcript_path":%q}`, sid, transcript)
	if err := os.WriteFile(payload, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	// The trailing `:` keeps each shell alive around its child, rather than
	// letting it exec the command in its own place.
	cmd := "TL_SE_URL=" + shellQuote(e.url) + " " + shellQuote(e.script) + " " + event + " <" + shellQuote(payload) + "; :"
	for range claudes {
		cmd = shellQuote(claude) + " -c " + shellQuote(cmd) + "; :"
	}
	ch := fmt.Sprintf("fired-%d", time.Now().UnixNano())
	e.tmux(t, "new-window", "-d", "-t", "="+session+":", cmd+"; tmux wait-for -S "+ch)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := exec.CommandContext(ctx, "tmux", "-L", e.sock, "wait-for", ch).Run(); err != nil {
		t.Fatalf("waiting for the hook in the pane: %v", err)
	}
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// A nested `claude -p`, started by an agent from inside a session, fires
// SessionStart and UserPromptSubmit with the session's TMUX_PANE. Registered,
// it pointed the session's text view at the nested claude's transcript, and
// the text view showed that one-prompt conversation and none of the session's
// own agents.
func TestANestedClaudeRegistersNothing(t *testing.T) {
	e := newHookEnv(t, "mine")

	e.runUnder(t, 1, "session-start", "mine", "outer", "/p/outer.jsonl")
	e.runUnder(t, 2, "session-start", "mine", "nested", "/p/nested.jsonl")
	e.runUnder(t, 2, "prompt-submit", "mine", "nested", "/p/nested.jsonl")

	regs := e.registered()
	if len(regs) != 1 || regs[0].SessionID != "outer" {
		t.Fatalf("registered %+v, want only the pane's own claude (session_id outer)", regs)
	}
}
