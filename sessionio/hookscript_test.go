package sessionio

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Exercises devvm/claude-tmux-state — the other writer of @claude_state, and the
// only writer of @claude_bg (ADR-0001, docs/plans/2026-09-04-background-work-
// session-state-design.md). The script lives outside this module because it is a
// devvm artefact rather than Go, and it is tested here because this package owns
// the option names it writes and the semantics they carry.
//
// Every payload under testdata/hooks/ is a REAL hook stdin captured from claude
// 2.1.260 on 2026-09-04, except post_workflow_launch.json, whose tool_response is
// the shape a Workflow launch recorded in a transcript on 2026-09-02. Recorded
// rather than hand-written so a payload-shape change fails here instead of
// reaching the box.

// hookScript is the script under test, resolved from this package's directory.
func hookScript(t *testing.T) string {
	t.Helper()
	p, err := filepath.Abs(filepath.Join("..", "devvm", "claude-tmux-state"))
	if err != nil {
		t.Fatalf("resolve script: %v", err)
	}
	if _, err := os.Stat(p); err != nil {
		t.Skipf("hook script not present: %v", err)
	}
	return p
}

// hookEnv is a scratch tmux server plus the two variables the script refuses to
// run without. TMUX is what makes a bare `tmux` in the script talk to OUR server
// rather than the developer's own — the script must never be able to stamp the
// session the test is being run from.
type hookEnv struct {
	sock, pane, script, tmuxVar string
}

func newHookEnv(t *testing.T) hookEnv {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available")
	}
	script := hookScript(t)
	sock := "hook-test-" + strings.NewReplacer("/", "-", " ", "-").Replace(t.Name())
	exec.Command("tmux", "-L", sock, "kill-server").Run()
	if err := exec.Command("tmux", "-L", sock, "new-session", "-d", "-s", "demo", "sh").Run(); err != nil {
		t.Fatalf("new-session: %v", err)
	}
	t.Cleanup(func() { exec.Command("tmux", "-L", sock, "kill-server").Run() })
	time.Sleep(150 * time.Millisecond)

	sockPath, err := exec.Command("tmux", "-L", sock, "display-message", "-p", "#{socket_path}").Output()
	if err != nil {
		t.Fatalf("socket_path: %v", err)
	}
	pane, err := exec.Command("tmux", "-L", sock, "display-message", "-p", "-t", "demo", "#{pane_id}").Output()
	if err != nil {
		t.Fatalf("pane_id: %v", err)
	}
	return hookEnv{
		sock:   sock,
		pane:   strings.TrimSpace(string(pane)),
		script: script,
		// TMUX is "<socket path>,<pid>,<session index>"; the path is what
		// locates the server, which is how the script is kept off the tmux
		// session the test itself is running in.
		tmuxVar: strings.TrimSpace(string(sockPath)) + ",0,0",
	}
}

// fire runs the script the way the hook runner does: one argv word, the payload
// on stdin.
func (e hookEnv) fire(t *testing.T, mode, fixture string) {
	t.Helper()
	payload, err := os.ReadFile(filepath.Join("testdata", "hooks", fixture))
	if err != nil {
		t.Fatalf("read fixture %s: %v", fixture, err)
	}
	cmd := exec.Command(e.script, mode)
	cmd.Stdin = strings.NewReader(string(payload))
	cmd.Env = append(os.Environ(), "TMUX="+e.tmuxVar, "TMUX_PANE="+e.pane)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%s %s: %v\n%s", e.script, mode, err, out)
	}
	// The hook runner injects stdout of several events into the conversation,
	// so the script's contract is silence.
	if len(strings.TrimSpace(string(out))) != 0 {
		t.Fatalf("%s %s wrote to stdout/stderr, which the hook runner injects into the conversation:\n%s",
			e.script, mode, out)
	}
}

// fireRaw is fire with the payload given directly. Only for a payload that is an
// ABSENCE — an empty stdin, which is what a hook runner older than the payload
// fields sends — since every real shape belongs in testdata/hooks as a capture.
func (e hookEnv) fireRaw(t *testing.T, mode, payload string) {
	t.Helper()
	cmd := exec.Command(e.script, mode)
	cmd.Stdin = strings.NewReader(payload)
	cmd.Env = append(os.Environ(), "TMUX="+e.tmuxVar, "TMUX_PANE="+e.pane)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%s %s: %v\n%s", e.script, mode, err, out)
	}
	if len(strings.TrimSpace(string(out))) != 0 {
		t.Fatalf("%s %s wrote to stdout/stderr:\n%s", e.script, mode, out)
	}
}

func (e hookEnv) opt(t *testing.T, name string) string {
	t.Helper()
	out, err := exec.Command("tmux", "-L", e.sock, "show-option", "-qv", "-t", "demo", name).Output()
	if err != nil {
		t.Fatalf("show-option %s: %v", name, err)
	}
	return strings.TrimSpace(string(out))
}

func (e hookEnv) set(t *testing.T, name, value string) {
	t.Helper()
	if err := exec.Command("tmux", "-L", e.sock, "set-option", "-t", "demo", name, value).Run(); err != nil {
		t.Fatalf("set-option %s=%s: %v", name, value, err)
	}
}

// The defect this design exists to fix: Stop fires at the end of the main turn
// while a background agent it launched is still running, and the sidebar reads
// Done. Measured on 2026-09-04 — Stop at 05:09:41, the agent finished 05:11:57.
func TestStopKeepsRunningWhileBackgroundWorkIsOutstanding(t *testing.T) {
	e := newHookEnv(t)

	e.fire(t, "running", "userprompt_human.json")
	e.fire(t, "running", "post_agent_launch.json")

	if got := e.opt(t, OptionBackground); got != "a:a1cbb47bebad51b9b" {
		t.Fatalf("%s after an async Agent launch = %q, want the agent id", OptionBackground, got)
	}

	e.fire(t, "done", "stop.json")

	if got := e.opt(t, OptionState); got != StateRunning {
		t.Fatalf("%s after Stop with outstanding work = %q, want %q", OptionState, got, StateRunning)
	}

	// The notification turn is what retires the id, and only then is the
	// session finished.
	e.fire(t, "running", "userprompt_notification_agent.json")
	if got := e.opt(t, OptionBackground); got != "" {
		t.Fatalf("%s after the task-notification = %q, want empty", OptionBackground, got)
	}
	e.fire(t, "done", "stop.json")
	if got := e.opt(t, OptionState); got != StateDone {
		t.Fatalf("%s after Stop with nothing outstanding = %q, want %q", OptionState, got, StateDone)
	}
}

// A session that backgrounds nothing must behave exactly as it did before.
func TestStopStillFinishesATurnThatBackgroundedNothing(t *testing.T) {
	e := newHookEnv(t)

	e.fire(t, "running", "userprompt_human.json")
	e.fire(t, "running", "pre_main.json")
	if got := e.opt(t, OptionState); got != StateRunning {
		t.Fatalf("%s mid-turn = %q, want %q", OptionState, got, StateRunning)
	}

	e.fire(t, "done", "stop.json")
	if got := e.opt(t, OptionState); got != StateDone {
		t.Fatalf("%s after Stop = %q, want %q", OptionState, got, StateDone)
	}
	if got := e.opt(t, OptionBackground); got != "" {
		t.Fatalf("%s = %q, want empty for a turn that launched nothing", OptionBackground, got)
	}
}

// The second defect: a subagent's OWN tool calls reach the main session's hooks,
// carrying agent_id. Stamping on those made the dot alternate between done and
// running for as long as a background agent worked, which is why the symptom was
// intermittent.
func TestASubagentsOwnToolCallsDoNotTouchTheSession(t *testing.T) {
	e := newHookEnv(t)

	e.fire(t, "running", "userprompt_human.json")
	e.fire(t, "running", "post_agent_launch.json")
	e.fire(t, "done", "stop.json")

	before := e.opt(t, OptionState)
	e.fire(t, "running", "pre_subagent.json")
	if got := e.opt(t, OptionState); got != before {
		t.Fatalf("a subagent's PreToolUse moved %s from %q to %q", OptionState, before, got)
	}

	// Its background launches carry ids whose notifications go to the SUBAGENT,
	// never to this session, so counting one would leave an id nothing can remove.
	e.fire(t, "running", "post_bash_launch_by_subagent.json")
	if got := e.opt(t, OptionBackground); got != "a:a1cbb47bebad51b9b" {
		t.Fatalf("%s = %q, want only the main thread's own launch", OptionBackground, got)
	}
}

// Each launch kind carries its id in a different field, and the kind is stored
// so the sidebar can say "2 agents" rather than only a total.
func TestEveryLaunchKindIsRecordedWithItsKind(t *testing.T) {
	for _, tc := range []struct{ name, fixture, want string }{
		{"background agent", "post_agent_launch.json", "a:a1cbb47bebad51b9b"},
		{"background command", "post_bash_launch.json", "b:bmm8ohp9u"},
		{"workflow", "post_workflow_launch.json", "w:wy71p4jz3"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newHookEnv(t)
			e.fire(t, "running", "userprompt_human.json")
			e.fire(t, "running", tc.fixture)
			if got := e.opt(t, OptionBackground); got != tc.want {
				t.Fatalf("%s = %q, want %q", OptionBackground, got, tc.want)
			}
			e.fire(t, "done", "stop.json")
			if got := e.opt(t, OptionState); got != StateRunning {
				t.Fatalf("%s after Stop = %q, want %q", OptionState, got, StateRunning)
			}
		})
	}
}

// Decided 2026-09-04: there is no expiry on an outstanding id, so a human prompt
// is what re-derives a session whose set went stale. The accepted cost is that a
// prompt sent DURING a live workflow reports done early.
func TestAHumanPromptClearsTheOutstandingSet(t *testing.T) {
	e := newHookEnv(t)
	e.set(t, OptionBackground, "a:stale1 b:stale2")

	e.fire(t, "running", "userprompt_human.json")

	if got := e.opt(t, OptionBackground); got != "" {
		t.Fatalf("%s after a human prompt = %q, want empty", OptionBackground, got)
	}
	e.fire(t, "done", "stop.json")
	if got := e.opt(t, OptionState); got != StateDone {
		t.Fatalf("%s = %q, want %q once the stale set is gone", OptionState, got, StateDone)
	}
}

// A task-notification retires ONE id and leaves the others, so a turn that
// launched three things stays running until the third reports.
func TestATaskNotificationRetiresOnlyItsOwnID(t *testing.T) {
	e := newHookEnv(t)
	e.fire(t, "running", "userprompt_human.json")
	e.fire(t, "running", "post_agent_launch.json")
	e.fire(t, "running", "post_bash_launch.json")

	e.fire(t, "running", "userprompt_notification_agent.json") // retires the agent
	if got := e.opt(t, OptionBackground); got != "b:bmm8ohp9u" {
		t.Fatalf("%s = %q, want the background command still outstanding", OptionBackground, got)
	}
	e.fire(t, "done", "stop.json")
	if got := e.opt(t, OptionState); got != StateRunning {
		t.Fatalf("%s = %q, want %q with one task left", OptionState, got, StateRunning)
	}
}

// A fresh claude has nothing outstanding, whatever the option survived from the
// process that died in this session.
func TestSessionStartClearsTheOutstandingSet(t *testing.T) {
	e := newHookEnv(t)
	e.set(t, OptionBackground, "a:leftover")

	e.fire(t, "done", "sessionstart.json")

	if got := e.opt(t, OptionBackground); got != "" {
		t.Fatalf("%s after SessionStart = %q, want empty", OptionBackground, got)
	}
	if got := e.opt(t, OptionState); got != StateDone {
		t.Fatalf("%s after SessionStart = %q, want %q", OptionState, got, StateDone)
	}
}

// SessionEnd unsets both, so a name reused by a later session never serves the
// dead conversation's state.
func TestSessionEndClearsBoth(t *testing.T) {
	e := newHookEnv(t)
	e.set(t, OptionState, StateRunning)
	e.set(t, OptionBackground, "a:x")

	e.fire(t, "clear", "stop.json")

	if got := e.opt(t, OptionState); got != "" {
		t.Fatalf("%s after SessionEnd = %q, want unset", OptionState, got)
	}
	if got := e.opt(t, OptionBackground); got != "" {
		t.Fatalf("%s after SessionEnd = %q, want unset", OptionBackground, got)
	}
}

// The idle-reminder Notification promotes running→awaiting only for a session
// that is genuinely mid-turn (ADR-0001: a done session stays green). A session
// held at running by outstanding background work is not mid-turn, so the same
// reasoning applies to it.
func TestAnIdleReminderDoesNotRepaintASessionHeldByBackgroundWork(t *testing.T) {
	e := newHookEnv(t)
	e.fire(t, "running", "userprompt_human.json")
	e.fire(t, "running", "post_agent_launch.json")
	e.fire(t, "done", "stop.json")

	e.fire(t, "notify", "notification.json")

	if got := e.opt(t, OptionState); got != StateRunning {
		t.Fatalf("%s after an idle reminder = %q, want %q", OptionState, got, StateRunning)
	}
}

// An interrupt ends the turn, and a task the interrupted turn launched will
// never report back into it. Cancel already owns the @claude_state transition
// (ADR-0001); it owns this one for the same reason, and because a left-behind
// id is the one way a set with no expiry can latch.
func TestCancelAlsoClearsTheOutstandingSet(t *testing.T) {
	in, osUser, sock := scratchSession(t)
	for _, o := range [][2]string{{OptionState, StateRunning}, {OptionBackground, "a:x w:y"}} {
		if err := exec.Command("tmux", "-L", sock, "set-option", "-t", "demo", o[0], o[1]).Run(); err != nil {
			t.Fatalf("seed %s: %v", o[0], err)
		}
	}

	if err := in.Cancel(osUser, "demo"); err != nil {
		t.Fatalf("Cancel: %v", err)
	}

	out, err := exec.Command("tmux", "-L", sock, "show-option", "-qv", "-t", "demo", OptionBackground).Output()
	if err != nil {
		t.Fatalf("show-option: %v", err)
	}
	if got := strings.TrimSpace(string(out)); got != "" {
		t.Fatalf("%s after Cancel = %q, want empty", OptionBackground, got)
	}
	if got := in.State(osUser, "demo"); got != StateDone {
		t.Fatalf("%s after Cancel = %q, want %q", OptionState, got, StateDone)
	}
}

// A plain shell has no Claude and must never grow a state dot, so a payload that
// arrives with nothing stamped leaves the session unstamped.
func TestAnUnstampedSessionStaysUnstampedOnANotification(t *testing.T) {
	e := newHookEnv(t)

	e.fire(t, "notify", "notification.json")

	if got := e.opt(t, OptionState); got != "" {
		t.Fatalf("%s = %q, want unset for a session no Claude ran in", OptionState, got)
	}
}

// The strand this prune exists to fix.
//
// The set's only drain was a UserPromptSubmit carrying <task-notification>, and
// that fires only when the task finishes BETWEEN turns. A task that finishes
// mid-turn has its notification absorbed into the running turn — the transcript
// records `queue-operation` enqueue then remove with reason absorbed_mid_turn —
// and no UserPromptSubmit fires at all, so the id stayed for good.
//
// Measured over 122 transcripts on 2026-09-04, how a completion reached the
// session: commands 258 as a prompt against 765 absorbed or silently removed;
// agents 57 against 35; workflows 36 against 18. So roughly a quarter of command
// completions were visible to this hook.
//
// stop_tasks_finished.json is a REAL Stop payload captured from that exact
// sequence: a background command launched and finished inside one turn, leaving
// `background_tasks` empty while @claude_bg still held its id.
func TestStopPrunesWorkTheHarnessNoLongerLists(t *testing.T) {
	e := newHookEnv(t)

	e.fire(t, "running", "userprompt_human.json")
	e.fire(t, "running", "post_bash_launch.json")
	if got := e.opt(t, OptionBackground); got == "" {
		t.Fatal("the launch was not recorded, so there is nothing to prune")
	}

	// The harness says nothing is outstanding. It is authoritative: a task that
	// has finished, or been stopped with TaskStop, leaves the list at once
	// (measured live 2026-09-04).
	e.fire(t, "done", "stop_tasks_finished.json")

	if got := e.opt(t, OptionBackground); got != "" {
		t.Errorf("%s after Stop with an empty background_tasks = %q, want empty", OptionBackground, got)
	}
	if got := e.opt(t, OptionState); got != StateDone {
		t.Errorf("%s = %q, want %q: the work is over and nothing will retire the id", OptionState, got, StateDone)
	}
}

// The other half: an id the harness DOES still list survives, so a session with
// live work is not reported finished.
func TestStopKeepsWorkTheHarnessStillLists(t *testing.T) {
	e := newHookEnv(t)

	e.fire(t, "running", "userprompt_human.json")
	e.fire(t, "running", "post_agent_launch.json")
	e.fire(t, "running", "post_bash_launch.json")

	// stop.json lists both of those ids as running.
	e.fire(t, "done", "stop.json")

	got := e.opt(t, OptionBackground)
	for _, want := range []string{"a:a1cbb47bebad51b9b", "b:bmm8ohp9u"} {
		if !strings.Contains(got, want) {
			t.Errorf("%s = %q, want it to still contain %q", OptionBackground, got, want)
		}
	}
	if st := e.opt(t, OptionState); st != StateRunning {
		t.Errorf("%s = %q, want %q", OptionState, st, StateRunning)
	}
}

// A workflow id is NOT pruned. Whether a running Workflow appears in
// background_tasks is unverified — the two kinds confirmed in a real payload are
// "shell" and "subagent" — so pruning one would risk reporting done in the
// middle of a half-hour run. Workflows stay on the notification drain until that
// is measured.
func TestStopDoesNotPruneAWorkflow(t *testing.T) {
	e := newHookEnv(t)

	e.fire(t, "running", "userprompt_human.json")
	e.fire(t, "running", "post_workflow_launch.json")
	before := e.opt(t, OptionBackground)
	if before == "" {
		t.Fatal("the workflow launch was not recorded")
	}

	e.fire(t, "done", "stop_tasks_finished.json")

	if got := e.opt(t, OptionBackground); got != before {
		t.Errorf("%s = %q, want it unchanged at %q", OptionBackground, got, before)
	}
	if st := e.opt(t, OptionState); st != StateRunning {
		t.Errorf("%s = %q, want %q", OptionState, st, StateRunning)
	}
}

// A payload with no background_tasks field prunes nothing, so an older harness
// keeps the behaviour this script had before. Exercised through the no-payload
// path, which is the documented pre-2026-09-04 fallback: no hook_event_name, so
// the argv word alone decides and the prune never runs.
func TestStopWithoutTheFieldPrunesNothing(t *testing.T) {
	e := newHookEnv(t)

	e.fire(t, "running", "userprompt_human.json")
	e.fire(t, "running", "post_bash_launch.json")
	before := e.opt(t, OptionBackground)
	if before == "" {
		t.Fatal("the launch was not recorded, so there is nothing to leave alone")
	}

	e.fireRaw(t, "done", "")

	if got := e.opt(t, OptionBackground); got != before {
		t.Errorf("%s = %q, want it unchanged at %q", OptionBackground, got, before)
	}
}
