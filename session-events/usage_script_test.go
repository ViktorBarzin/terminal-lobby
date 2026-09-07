package main

import (
	"encoding/json"
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

// Exercises devvm/tl-usage-record, the script that takes Claude Code's
// statusLine slot. It lives outside this module because it is a devvm artefact
// rather than Go, and it is tested here because this package owns the endpoint
// it posts to and the envelope it puts on the wire.
//
// The property every one of these guards is the same: whatever happens to the
// recording, the user's own statusline still draws. A statusline that breaks
// the prompt is worse than no feature.

// settleWindow is how long a POST that should NOT happen is given to prove it.
// Getting this wrong can only hide a defect, never invent one, so it is longer
// than the round trip a real POST takes on this box.
const settleWindow = time.Second

// recorderScript resolves the script from this package's directory.
func recorderScript(t *testing.T) string {
	t.Helper()
	p, err := filepath.Abs(filepath.Join("..", "devvm", "tl-usage-record"))
	if err != nil {
		t.Fatalf("resolve script: %v", err)
	}
	if _, err := os.Stat(p); err != nil {
		t.Skipf("recorder script not present: %v", err)
	}
	return p
}

// usageSink is a stand-in for session-events, collecting whatever the script
// posts. The POST is backgrounded by design, so nothing observes it
// synchronously and every assertion about it goes through waitFor.
type usageSink struct {
	mu   sync.Mutex
	got  []usageBody
	srv  *httptest.Server
	fail bool // answer 500, to prove a rejected POST changes nothing
}

func newUsageSink(t *testing.T) *usageSink {
	t.Helper()
	s := &usageSink{}
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(io.LimitReader(r.Body, hookBodyLimit))
		var b usageBody
		if json.Unmarshal(raw, &b) == nil {
			s.mu.Lock()
			s.got = append(s.got, b)
			s.mu.Unlock()
		}
		if s.fail {
			http.Error(w, "no", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(s.srv.Close)
	return s
}

func (s *usageSink) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.got)
}

func (s *usageSink) at(i int) usageBody {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.got[i]
}

// waitFor gives the backgrounded POST a bounded chance to land. A deadline
// rather than a sleep, so a fast machine does not wait and a loaded one does
// not flake. Generous on purpose: the wait only runs its full length when
// something is genuinely wrong, and a five-second version failed on a box
// running the rest of this suite alongside it.
func (s *usageSink) waitFor(t *testing.T, n int) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if s.count() >= n {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("the script posted %d readings, want %d", s.count(), n)
}

// recorderEnv is a scratch tmux server plus the script and the sink. TMUX is
// what makes a bare `tmux` inside the script talk to OUR server rather than the
// developer's own, so a test run can never stamp the session it is run from.
type recorderEnv struct {
	script, tmuxVar, pane, sock string
	sink                        *usageSink
}

func newRecorderEnv(t *testing.T) recorderEnv {
	t.Helper()
	for _, bin := range []string{"tmux", "jq", "curl"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skipf("%s not available", bin)
		}
	}
	script := recorderScript(t)
	sock := "usage-test-" + strings.NewReplacer("/", "-", " ", "-").Replace(t.Name())
	exec.Command("tmux", "-L", sock, "kill-server").Run()
	if err := exec.Command("tmux", "-L", sock, "new-session", "-d", "-s", "demo", "sh").Run(); err != nil {
		t.Fatalf("new-session: %v", err)
	}
	t.Cleanup(func() { exec.Command("tmux", "-L", sock, "kill-server").Run() })

	sockPath, err := exec.Command("tmux", "-L", sock, "display-message", "-p", "#{socket_path}").Output()
	if err != nil {
		t.Fatalf("socket_path: %v", err)
	}
	pane, err := exec.Command("tmux", "-L", sock, "display-message", "-p", "-t", "demo", "#{pane_id}").Output()
	if err != nil {
		t.Fatalf("pane_id: %v", err)
	}
	return recorderEnv{
		script:  script,
		tmuxVar: strings.TrimSpace(string(sockPath)) + ",0,0",
		pane:    strings.TrimSpace(string(pane)),
		sock:    sock,
		sink:    newUsageSink(t),
	}
}

// run fires the script the way the CLI does: the statusLine payload on stdin,
// no arguments. inner is the statusLine command it should hand over to, and
// extra adds or overrides environment.
func (e recorderEnv) run(t *testing.T, payload, inner string, extra ...string) (string, int) {
	t.Helper()
	cmd := exec.Command(e.script)
	cmd.Stdin = strings.NewReader(payload)
	cmd.Env = append(os.Environ(),
		"TMUX="+e.tmuxVar,
		"TMUX_PANE="+e.pane,
		"TL_USAGE_ENDPOINT="+e.sink.srv.URL+"/hooks/usage",
		"TL_USAGE_INNER_COMMAND="+inner,
	)
	cmd.Env = append(cmd.Env, extra...)
	out, err := cmd.CombinedOutput()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatalf("run %s: %v\n%s", e.script, err, out)
	}
	return string(out), code
}

func recorderPayload(t *testing.T, name string) string {
	t.Helper()
	return statusLineFixture(t, name)
}

// --- the pass-through, which is the part that must never break ---------------

// The inner command runs, and its output reaches the terminal byte for byte.
func TestRecorderPassesTheInnerOutputThrough(t *testing.T) {
	e := newRecorderEnv(t)
	out, code := e.run(t, recorderPayload(t, "statusline_enterprise.json"), `printf 'opus | main | 3%%'`)
	if code != 0 {
		t.Fatalf("exit %d, want 0 (%q)", code, out)
	}
	if out != "opus | main | 3%" {
		t.Fatalf("statusline output = %q, want the inner command's own", out)
	}
}

// The inner command gets the same JSON on stdin, with nothing added — a
// statusline that parses the payload has to see what the CLI sent, and a
// trailing newline is a difference some parsers notice.
func TestRecorderHandsTheSameStdinToTheInnerCommand(t *testing.T) {
	e := newRecorderEnv(t)
	payload := recorderPayload(t, "statusline_enterprise.json")
	out, code := e.run(t, payload, "cat")
	if code != 0 {
		t.Fatalf("exit %d, want 0 (%q)", code, out)
	}
	if out != payload {
		t.Fatalf("the inner command read %q\nwant %q", out, payload)
	}
}

// An inner command that fails says so to the CLI. Swallowing its status would
// change how the user's own statusline behaves.
func TestRecorderPassesTheInnerExitCodeThrough(t *testing.T) {
	e := newRecorderEnv(t)
	out, code := e.run(t, recorderPayload(t, "statusline_enterprise.json"), `printf 'half'; exit 3`)
	if code != 3 {
		t.Fatalf("exit %d, want the inner command's 3", code)
	}
	if out != "half" {
		t.Fatalf("output = %q, want what the inner command managed to print", out)
	}
}

// session-events being down, or refusing the reading, must be invisible.
func TestRecorderSurvivesAnUnreachableService(t *testing.T) {
	e := newRecorderEnv(t)
	// A port nothing is listening on, reached through the same code path.
	out, code := e.run(t, recorderPayload(t, "statusline_enterprise.json"), `printf 'still here'`,
		"TL_USAGE_ENDPOINT=http://127.0.0.1:1/hooks/usage")
	if code != 0 || out != "still here" {
		t.Fatalf("exit %d output %q, want 0 and the inner output", code, out)
	}
}

func TestRecorderSurvivesAServiceThatRefusesTheReading(t *testing.T) {
	e := newRecorderEnv(t)
	e.sink.fail = true
	out, code := e.run(t, recorderPayload(t, "statusline_enterprise.json"), `printf 'still here'`)
	if code != 0 || out != "still here" {
		t.Fatalf("exit %d output %q, want 0 and the inner output", code, out)
	}
	e.sink.waitFor(t, 1)
}

// jqFreePath is a PATH holding the binaries the pass-through itself needs and
// deliberately not jq, so a test can run the script the way a box without jq
// would.
func jqFreePath(t *testing.T) string {
	t.Helper()
	bin := t.TempDir()
	for _, name := range []string{"env", "bash", "sh", "printf", "cat", "tmux", "curl"} {
		p, err := exec.LookPath(name)
		if err != nil {
			continue
		}
		if err := os.Symlink(p, filepath.Join(bin, name)); err != nil {
			t.Fatalf("link %s: %v", name, err)
		}
	}
	return bin
}

// No jq means no envelope to post, but the explicit inner command still runs.
func TestRecorderSurvivesAMissingJQ(t *testing.T) {
	e := newRecorderEnv(t)
	out, code := e.run(t, recorderPayload(t, "statusline_enterprise.json"), `printf 'no jq here'`,
		"PATH="+jqFreePath(t))
	if code != 0 || out != "no jq here" {
		t.Fatalf("exit %d output %q, want 0 and the inner output", code, out)
	}
	if n := e.sink.count(); n != 0 {
		t.Fatalf("posted %d readings without jq to build the envelope", n)
	}
}

// Losing the recording is the price of a missing jq. Losing the user's own
// prompt is not: their statusLine is theirs, and this script only borrowed the
// slot. So the command is read out of their settings with or without jq.
func TestRecorderRunsTheUsersStatusLineWithoutJQ(t *testing.T) {
	e := newRecorderEnv(t)
	cfg := t.TempDir()
	settings := `{"statusLine":{"type":"command","command":"printf 'their own prompt'","padding":0}}`
	if err := os.WriteFile(filepath.Join(cfg, "settings.json"), []byte(settings), 0o600); err != nil {
		t.Fatal(err)
	}
	out, code := e.run(t, recorderPayload(t, "statusline_enterprise.json"), "",
		"CLAUDE_CONFIG_DIR="+cfg, "PATH="+jqFreePath(t))
	if code != 0 || out != "their own prompt" {
		t.Fatalf("exit %d output %q, want the user's own statusLine to have run", code, out)
	}
}

// The fallback parser refuses what it cannot read rather than running half a
// command. A command carrying an escaped quote is past what parameter expansion
// can take apart, and half of somebody's prompt is worse than none of it.
func TestRecorderFallbackRefusesACommandItCannotParse(t *testing.T) {
	e := newRecorderEnv(t)
	cfg := t.TempDir()
	settings := `{"statusLine":{"command":"printf 'say \"hi\"'"}}`
	if err := os.WriteFile(filepath.Join(cfg, "settings.json"), []byte(settings), 0o600); err != nil {
		t.Fatal(err)
	}
	out, code := e.run(t, recorderPayload(t, "statusline_enterprise.json"), "",
		"CLAUDE_CONFIG_DIR="+cfg, "PATH="+jqFreePath(t))
	if code != 0 {
		t.Fatalf("exit %d, want 0", code)
	}
	if out != "" {
		t.Fatalf("output = %q, want nothing rather than a truncated command", out)
	}
	// With jq present the same file runs normally.
	out, code = e.run(t, recorderPayload(t, "statusline_enterprise.json"), "", "CLAUDE_CONFIG_DIR="+cfg)
	if code != 0 || out != `say "hi"` {
		t.Fatalf("with jq: exit %d output %q, want the command from settings.json", code, out)
	}
}

// A user who never set a statusLine has no inner command. Claude Code shows its
// own default, so the right output is none at all.
func TestRecorderIsSilentWithNoInnerCommand(t *testing.T) {
	e := newRecorderEnv(t)
	out, code := e.run(t, recorderPayload(t, "statusline_enterprise.json"), "",
		"CLAUDE_CONFIG_DIR="+t.TempDir())
	if code != 0 {
		t.Fatalf("exit %d, want 0 (%q)", code, out)
	}
	if out != "" {
		t.Fatalf("output = %q, want nothing", out)
	}
	// The recording still happens: having no statusline of your own is not a
	// reason to have no spend figures.
	e.sink.waitFor(t, 1)
}

// The inner command comes from the user's own settings when the environment
// names none, because managed settings hold OUR entry and leave theirs in place.
func TestRecorderReadsTheInnerCommandFromUserSettings(t *testing.T) {
	e := newRecorderEnv(t)
	cfg := t.TempDir()
	settings := `{"statusLine":{"type":"command","command":"printf 'from settings'","padding":0}}`
	if err := os.WriteFile(filepath.Join(cfg, "settings.json"), []byte(settings), 0o600); err != nil {
		t.Fatal(err)
	}
	out, code := e.run(t, recorderPayload(t, "statusline_enterprise.json"), "",
		"CLAUDE_CONFIG_DIR="+cfg)
	if code != 0 || out != "from settings" {
		t.Fatalf("exit %d output %q, want the command from settings.json", code, out)
	}
}

// settings.local.json wins, matching Claude Code's own precedence.
func TestRecorderPrefersLocalSettings(t *testing.T) {
	e := newRecorderEnv(t)
	cfg := t.TempDir()
	for name, cmd := range map[string]string{
		"settings.json":       "printf 'global'",
		"settings.local.json": "printf 'local'",
	} {
		doc := `{"statusLine":{"type":"command","command":"` + cmd + `"}}`
		if err := os.WriteFile(filepath.Join(cfg, name), []byte(doc), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	out, _ := e.run(t, recorderPayload(t, "statusline_enterprise.json"), "", "CLAUDE_CONFIG_DIR="+cfg)
	if out != "local" {
		t.Fatalf("output = %q, want the local settings' command", out)
	}
}

// A settings file pointing the inner slot back at this script would recurse
// until the box ran out of processes.
func TestRecorderRefusesToRunItself(t *testing.T) {
	e := newRecorderEnv(t)
	out, code := e.run(t, recorderPayload(t, "statusline_enterprise.json"), e.script)
	if code != 0 {
		t.Fatalf("exit %d, want 0", code)
	}
	if out != "" {
		t.Fatalf("output = %q, want nothing from a refused self-exec", out)
	}
}

// --- the recording ----------------------------------------------------------

// The envelope carries the payload untouched plus the two facts it does not
// have: whose it is, and which lobby session it belongs to.
func TestRecorderPostsTheEnvelope(t *testing.T) {
	e := newRecorderEnv(t)
	e.run(t, recorderPayload(t, "statusline_subscriber.json"), `printf 'x'`)
	e.sink.waitFor(t, 1)

	b := e.sink.at(0)
	if b.User == "" {
		t.Error("the envelope names no user, so peerOwnsClaim would refuse it")
	}
	if b.TmuxSession != "demo" {
		t.Errorf("tmux_session = %q, want demo", b.TmuxSession)
	}
	if b.StatusLine == nil {
		t.Fatal("the envelope carries no statusline")
	}
	if b.StatusLine.SessionID != "7b1c9d4f-2a35-4e88-b0c1-5f6a7b8c9d01" {
		t.Errorf("session id = %q", b.StatusLine.SessionID)
	}
	if b.StatusLine.Cost.TotalCostUSD != 1.75 {
		t.Errorf("cost = %v, want 1.75", b.StatusLine.Cost.TotalCostUSD)
	}
	// The payload is forwarded whole, so a key this build does not read still
	// reaches a service that does.
	if b.StatusLine.RateLimits == nil || b.StatusLine.RateLimits.FiveHour == nil {
		t.Fatal("rate_limits did not survive the trip")
	}
	if b.StatusLine.RateLimits.FiveHour.UsedPercentage != 37 {
		t.Errorf("five_hour = %v%%, want 37", b.StatusLine.RateLimits.FiveHour.UsedPercentage)
	}
}

// The statusLine renders many times a turn. A render where the running total
// has not moved carries no new spend and is dropped, which is what keeps a
// per-render POST off the wire.
func TestRecorderPostsOnlyWhenTheTotalMoves(t *testing.T) {
	e := newRecorderEnv(t)
	payload := recorderPayload(t, "statusline_enterprise.json")

	e.run(t, payload, `printf 'x'`)
	e.sink.waitFor(t, 1)

	for i := 0; i < 3; i++ {
		e.run(t, payload, `printf 'x'`)
	}
	// Give a POST that should not happen every chance to arrive.
	time.Sleep(settleWindow)
	if n := e.sink.count(); n != 1 {
		t.Fatalf("posted %d readings for an unchanged total, want 1", n)
	}

	// A turn that spends money moves the total, and that reading is posted.
	moved := strings.Replace(payload, `"total_cost_usd":0.329`, `"total_cost_usd":0.44`, 1)
	if moved == payload {
		t.Fatal("the fixture no longer carries the total this test edits")
	}
	e.run(t, moved, `printf 'x'`)
	e.sink.waitFor(t, 2)
	if got := e.sink.at(1).StatusLine.Cost.TotalCostUSD; got != 0.44 {
		t.Fatalf("second reading = %v, want 0.44", got)
	}
}

// Two agent panes in one tmux session are two conversations with two running
// totals, so the throttle has to remember them separately. A session-scoped
// option would have each pane comparing against the other's total: the two
// almost never match, so every render of both panes posts, and on the renders
// where they do match a real reading is dropped.
func TestRecorderThrottlesEachPaneOnItsOwnTotal(t *testing.T) {
	e := newRecorderEnv(t)
	other, err := exec.Command("tmux", "-L", e.sock, "split-window", "-d", "-P", "-F", "#{pane_id}", "-t", "demo", "sh").Output()
	if err != nil {
		t.Fatalf("split-window: %v", err)
	}
	paneB := strings.TrimSpace(string(other))
	if paneB == "" || paneB == e.pane {
		t.Fatalf("second pane = %q, first = %q", paneB, e.pane)
	}
	payload := func(cost string) string {
		return `{"session_id":"s1","cost":{"total_cost_usd":` + cost + `}}`
	}

	// The same total in both panes is two readings, not one.
	e.run(t, payload("1.23"), `printf 'x'`)
	e.sink.waitFor(t, 1)
	e.run(t, payload("1.23"), `printf 'x'`, "TMUX_PANE="+paneB)
	e.sink.waitFor(t, 2)

	// And a pane that has not moved is still dropped.
	e.run(t, payload("1.23"), `printf 'x'`)
	e.run(t, payload("1.23"), `printf 'x'`, "TMUX_PANE="+paneB)
	time.Sleep(settleWindow)
	if n := e.sink.count(); n != 2 {
		t.Fatalf("posted %d readings, want 2: each pane throttles on its own total", n)
	}

	// A pane whose total moves posts again.
	e.run(t, payload("2.40"), `printf 'x'`, "TMUX_PANE="+paneB)
	e.sink.waitFor(t, 3)
}

// The throttle reads the total with shell parameter expansion rather than jq,
// because it decides whether to fork at all. That parser has to hold for the
// shapes the key actually appears in, and fall back to posting whenever it
// cannot be sure — a duplicate reading is harmless, a dropped one is not.
func TestRecorderThrottleParsesTheTotalItIsGiven(t *testing.T) {
	for _, tc := range []struct {
		name, payload string
		// wantSecond is how many readings the sink holds after the same
		// payload has been sent twice.
		wantSecond int
	}{
		{"mid-object", `{"cost":{"total_cost_usd":0.329,"total_duration_ms":9},"session_id":"s1"}`, 1},
		{"last key of the object", `{"session_id":"s1","cost":{"total_cost_usd":0.5}}`, 1},
		{"a whole number", `{"session_id":"s1","cost":{"total_cost_usd":12}}`, 1},
		// Shapes the parser cannot read post every time rather than guessing.
		{"no cost at all", `{"session_id":"s1","model":{"id":"claude-opus-5"}}`, 2},
		{"spaced out", `{"session_id":"s1","cost":{"total_cost_usd": 0.5}}`, 2},
		{"null", `{"session_id":"s1","cost":{"total_cost_usd":null}}`, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newRecorderEnv(t)
			e.run(t, tc.payload, `printf 'x'`)
			e.sink.waitFor(t, 1)
			e.run(t, tc.payload, `printf 'x'`)
			if tc.wantSecond > 1 {
				e.sink.waitFor(t, tc.wantSecond)
				return
			}
			time.Sleep(settleWindow)
			if n := e.sink.count(); n != tc.wantSecond {
				t.Fatalf("posted %d readings, want %d", n, tc.wantSecond)
			}
		})
	}
}

// Outside tmux there is no lobby session to attribute spend to, and headless
// and t3 Claude instances read the same managed settings. They still get their
// statusline.
func TestRecorderRecordsNothingOutsideTmux(t *testing.T) {
	e := newRecorderEnv(t)
	cmd := exec.Command(e.script)
	cmd.Stdin = strings.NewReader(recorderPayload(t, "statusline_enterprise.json"))
	// os.Environ may carry the developer's own TMUX; the point of this test is
	// its absence, so the environment is built from nothing.
	cmd.Env = []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + t.TempDir(),
		"TL_USAGE_ENDPOINT=" + e.sink.srv.URL + "/hooks/usage",
		"TL_USAGE_INNER_COMMAND=printf 'headless'",
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("run: %v\n%s", err, out)
	}
	if string(out) != "headless" {
		t.Fatalf("output = %q, want the inner command's", out)
	}
	time.Sleep(settleWindow)
	if n := e.sink.count(); n != 0 {
		t.Fatalf("posted %d readings from outside tmux", n)
	}
}
