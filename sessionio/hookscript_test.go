package sessionio

import (
	"fmt"
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
// Every payload under testdata/hooks/ is a REAL hook stdin: most captured from
// claude 2.1.260 on 2026-09-04, and the three workflow ones — post_workflow_launch,
// stop_workflow_running and sessionstart_compact — from 2.1.269 on 2026-09-12,
// by running a real Workflow in a tmux session and logging every hook's stdin.
// Recorded rather than hand-written so a payload-shape change fails here instead
// of reaching the box. The pair matters: the launch records `w7t7pnsug` and the
// Stop taken while that same run was live lists it back.

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
	// Pid for the reason scratchSession gives: concurrent runs of this package
	// otherwise share a socket, and the kill-server below is unconditional.
	sock := fmt.Sprintf("hook-test-%d-%s", os.Getpid(),
		strings.NewReplacer("/", "-", " ", "-").Replace(t.Name()))
	exec.Command("tmux", "-L", sock, "kill-server").Run()
	if err := exec.Command("tmux", "-L", sock, "new-session", "-d", "-s", "demo", "sh").Run(); err != nil {
		t.Fatalf("new-session: %v", err)
	}
	t.Cleanup(func() { killSock(sock) })
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

	// Both launches, because stop.json was captured from a session running
	// both: since Stop rebuilds the set from that list rather than filtering
	// what a launch recorded, the fixture's own contents are now the scenario.
	e.fire(t, "running", "userprompt_human.json")
	e.fire(t, "running", "post_agent_launch.json")
	e.fire(t, "running", "post_bash_launch.json")

	if got := e.opt(t, OptionBackground); got != "a:a1cbb47bebad51b9b b:bmm8ohp9u" {
		t.Fatalf("%s after the two launches = %q, want both ids", OptionBackground, got)
	}

	e.fire(t, "done", "stop.json")

	if got := e.opt(t, OptionState); got != StateRunning {
		t.Fatalf("%s after Stop with outstanding work = %q, want %q", OptionState, got, StateRunning)
	}

	// A task-notification retires its own id straight away, without waiting
	// for the Stop that ends the turn it starts.
	e.fire(t, "running", "userprompt_notification_agent.json")
	if got := e.opt(t, OptionBackground); got != "b:bmm8ohp9u" {
		t.Fatalf("%s after the agent's task-notification = %q, want the command left", OptionBackground, got)
	}
	e.fire(t, "done", "stop_tasks_finished.json")
	if got := e.opt(t, OptionState); got != StateDone {
		t.Fatalf("%s after Stop with nothing outstanding = %q, want %q", OptionState, got, StateDone)
	}
}

// A session that backgrounds nothing must behave exactly as it did before.
// stop_tasks_finished.json is the Stop of such a turn: its background_tasks is
// the empty list.
func TestStopStillFinishesATurnThatBackgroundedNothing(t *testing.T) {
	e := newHookEnv(t)

	e.fire(t, "running", "userprompt_human.json")
	e.fire(t, "running", "pre_main.json")
	if got := e.opt(t, OptionState); got != StateRunning {
		t.Fatalf("%s mid-turn = %q, want %q", OptionState, got, StateRunning)
	}

	e.fire(t, "done", "stop_tasks_finished.json")
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

	// Both of the launches stop.json was captured with, so the Stop that holds
	// the session at running is the one that payload actually describes.
	e.fire(t, "running", "userprompt_human.json")
	e.fire(t, "running", "post_agent_launch.json")
	e.fire(t, "running", "post_bash_launch.json")
	e.fire(t, "done", "stop.json")

	before := e.opt(t, OptionState)
	e.fire(t, "running", "pre_subagent.json")
	if got := e.opt(t, OptionState); got != before {
		t.Fatalf("a subagent's PreToolUse moved %s from %q to %q", OptionState, before, got)
	}

	// Its background launches carry ids whose notifications go to the SUBAGENT,
	// never to this session, so counting one would leave an id nothing can remove.
	e.fire(t, "running", "post_bash_launch_by_subagent.json")
	if got := e.opt(t, OptionBackground); got != "a:a1cbb47bebad51b9b b:bmm8ohp9u" {
		t.Fatalf("%s = %q, want only the main thread's own launches", OptionBackground, got)
	}
	if strings.Contains(e.opt(t, OptionBackground), "bugtixgoo") {
		t.Fatalf("%s counted the subagent's own background command", OptionBackground)
	}
}

// Each launch kind carries its id in a different field, and the kind is stored
// so the sidebar can say "2 agents" rather than only a total.
func TestEveryLaunchKindIsRecordedWithItsKind(t *testing.T) {
	// The Stop fixture per kind is the one taken while THAT kind was live, so
	// each subtest exercises a launch against a harness list that still carries
	// it. stop.json lists the agent and the command; stop_workflow_running.json
	// lists the workflow.
	for _, tc := range []struct{ name, fixture, want, stop string }{
		{"background agent", "post_agent_launch.json", "a:a1cbb47bebad51b9b", "stop.json"},
		{"background command", "post_bash_launch.json", "b:bmm8ohp9u", "stop.json"},
		{"workflow", "post_workflow_launch.json", "w:w7t7pnsug", "stop_workflow_running.json"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newHookEnv(t)
			e.fire(t, "running", "userprompt_human.json")
			e.fire(t, "running", tc.fixture)
			if got := e.opt(t, OptionBackground); got != tc.want {
				t.Fatalf("%s = %q, want %q", OptionBackground, got, tc.want)
			}
			e.fire(t, "done", tc.stop)
			if got := e.opt(t, OptionState); got != StateRunning {
				t.Fatalf("%s after Stop = %q, want %q", OptionState, got, StateRunning)
			}
		})
	}
}

// Talking to a session does not end the work it is already doing.
//
// This is the bug Viktor reported on 2026-09-12 ("Claude starts a workflow, then
// the status for that session becomes green"). Until then a human prompt wiped
// the whole outstanding set, on the reasoning that nothing else could re-derive
// a set that had gone stale. Measured across the 105 workflow runs recorded on
// this box, 43 of them (40%) had a human prompt land while the run was still
// going — every one of those painted the session done with the workflow live.
//
// The prune at Stop is the re-derivation that wipe was standing in for, so the
// wipe is gone and this is what replaces it.
func TestAHumanPromptDoesNotDropLiveWork(t *testing.T) {
	e := newHookEnv(t)
	e.fire(t, "running", "userprompt_human.json")
	e.fire(t, "running", "post_workflow_launch.json")

	e.fire(t, "running", "userprompt_human.json") // the person says something else
	if got := e.opt(t, OptionBackground); got != "w:w7t7pnsug" {
		t.Fatalf("%s after a human prompt = %q, want the live workflow still there", OptionBackground, got)
	}

	e.fire(t, "done", "stop_workflow_running.json")
	if got := e.opt(t, OptionState); got != StateRunning {
		t.Fatalf("%s = %q, want %q: the workflow is still running", OptionState, got, StateRunning)
	}
}

// The other half of dropping that wipe: a set that HAS gone stale still drains,
// one turn later, because the harness's own list says the ids are gone. Nothing
// expires an id, so this is the only path left that clears one nobody retired.
func TestAStaleSetDrainsAtTheNextStop(t *testing.T) {
	e := newHookEnv(t)
	e.set(t, OptionBackground, "a:stale1 b:stale2")

	e.fire(t, "running", "userprompt_human.json")
	e.fire(t, "done", "stop_tasks_finished.json")

	if got := e.opt(t, OptionBackground); got != "" {
		t.Fatalf("%s = %q, want empty: the harness lists neither id", OptionBackground, got)
	}
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

// A compaction is the SAME claude process carrying on, so the tasks it launched
// are still running and their ids must survive. SessionStart fires for four
// sources — startup, resume, clear and compact (all four confirmed on 2.1.269,
// 2026-09-12) — and only the first two are a new process.
//
// A long workflow all but guarantees a compaction: the longest real run on this
// box was 2h22m. Wiping here painted those sessions done with the run live, and
// unlike the human-prompt path it needed nobody to type anything.
func TestACompactionKeepsTheOutstandingSet(t *testing.T) {
	e := newHookEnv(t)
	e.fire(t, "running", "userprompt_human.json")
	e.fire(t, "running", "post_workflow_launch.json")

	e.fire(t, "done", "sessionstart_compact.json")

	if got := e.opt(t, OptionBackground); got != "w:w7t7pnsug" {
		t.Fatalf("%s after a compaction = %q, want the live workflow still there", OptionBackground, got)
	}
	// Keeping the id and stamping done anyway would paint the session green all
	// the same, so the state has to follow the set here as it does at Stop.
	if got := e.opt(t, OptionState); got != StateRunning {
		t.Fatalf("%s after a compaction = %q, want %q: the workflow outlived it", OptionState, got, StateRunning)
	}
	e.fire(t, "done", "stop_workflow_running.json")
	if got := e.opt(t, OptionState); got != StateRunning {
		t.Fatalf("%s = %q, want %q: the workflow is still running", OptionState, got, StateRunning)
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

// An interrupt ends the TURN. It does not end the work the session already
// started, which is a separate thing and was measured on 2026-09-12: a live
// workflow kept counting through a C-c ("0/1 agents done · 25s" at the moment
// of the interrupt, still climbing after), and a background command's output
// file went from line 39 to line 55 across one. So Cancel stamps from the set
// rather than emptying it, the same way Stop does.
//
// Cancel still owns the @claude_state transition (ADR-0001) — an interrupt
// fires no Stop hook, so nothing else would move the stamp off running.
func TestCancelStampsFromTheOutstandingSet(t *testing.T) {
	for _, tc := range []struct{ name, seed, want string }{
		{"work survives the interrupt", "a:x w:y", StateRunning},
		{"nothing outstanding", "", StateDone},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in, osUser, sock := scratchSession(t)
			if err := exec.Command("tmux", "-L", sock, "set-option", "-t", "demo", OptionState, StateRunning).Run(); err != nil {
				t.Fatalf("seed %s: %v", OptionState, err)
			}
			if tc.seed != "" {
				if err := exec.Command("tmux", "-L", sock, "set-option", "-t", "demo", OptionBackground, tc.seed).Run(); err != nil {
					t.Fatalf("seed %s: %v", OptionBackground, err)
				}
			}

			if err := in.Cancel(osUser, "demo"); err != nil {
				t.Fatalf("Cancel: %v", err)
			}

			out, err := exec.Command("tmux", "-L", sock, "show-option", "-qv", "-t", "demo", OptionBackground).Output()
			if err != nil {
				t.Fatalf("show-option: %v", err)
			}
			if got := strings.TrimSpace(string(out)); got != tc.seed {
				t.Fatalf("%s after Cancel = %q, want it untouched at %q", OptionBackground, got, tc.seed)
			}
			if got := in.State(osUser, "demo"); got != tc.want {
				t.Fatalf("%s after Cancel = %q, want %q", OptionState, got, tc.want)
			}
		})
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

// A workflow prunes like everything else. Until 2026-09-12 it was exempt,
// because whether a running Workflow appears in background_tasks at all was
// unmeasured and pruning one would have risked reporting done mid-run. It does
// appear: stop_workflow_running.json is a Stop taken 2 seconds into a live run,
// and the entry reads {"id":"w7t7pnsug","type":"workflow","status":"running"}.
// The two tests below are the two directions of that one fact.
func TestStopKeepsARunningWorkflow(t *testing.T) {
	e := newHookEnv(t)

	e.fire(t, "running", "userprompt_human.json")
	e.fire(t, "running", "post_workflow_launch.json")

	e.fire(t, "done", "stop_workflow_running.json")

	if got := e.opt(t, OptionBackground); got != "w:w7t7pnsug" {
		t.Errorf("%s = %q, want the running workflow kept", OptionBackground, got)
	}
	if st := e.opt(t, OptionState); st != StateRunning {
		t.Errorf("%s = %q, want %q", OptionState, st, StateRunning)
	}
}

// The strand this half fixes: a workflow whose completion is absorbed into the
// running turn fires no UserPromptSubmit, so nothing retired its id and the
// session sat at running for good. Measured 2026-09-04 over 122 transcripts, 18
// of 54 workflow completions arrived that way.
func TestStopPrunesAFinishedWorkflow(t *testing.T) {
	e := newHookEnv(t)

	e.fire(t, "running", "userprompt_human.json")
	e.fire(t, "running", "post_workflow_launch.json")
	if e.opt(t, OptionBackground) == "" {
		t.Fatal("the workflow launch was not recorded, so there is nothing to prune")
	}

	e.fire(t, "done", "stop_tasks_finished.json")

	if got := e.opt(t, OptionBackground); got != "" {
		t.Errorf("%s = %q, want empty: the harness no longer lists the run", OptionBackground, got)
	}
	if st := e.opt(t, OptionState); st != StateDone {
		t.Errorf("%s = %q, want %q", OptionState, st, StateDone)
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

// The defect Viktor reported next, on 2026-09-12: "the session status when we
// have sub-agents or agent teams is not correctly shown. Even though the
// agents are running, the session says it's green or done."
//
// A TEAMMATE — the Agent tool given a `name`, which is what an agent team is
// made of — was invisible to every signal this script had. Its launch answers
// `teammate_spawned` rather than `async_launched`, so record_launch saw
// nothing; the Stop registry calls it `tocihyt26` while the launch calls it
// `counter@session-337349ca`, so no recorded id would have survived a prune;
// and when it finishes, no task-notification arrives at all. 85 of the 136
// Agent launches in the transcripts on this box that week were that shape.
//
// SubagentStart is the signal that works, and it is better than the launch
// would have been: it fires on every activation, so a teammate woken by
// SendMessage or by a person typing into its pane starts the session working
// again too. Every fixture below is real hook stdin from one run on 2.1.269.
func TestATeammateHoldsTheSessionRunning(t *testing.T) {
	e := newHookEnv(t)

	e.fire(t, "running", "userprompt_human.json")
	e.fire(t, "running", "subagentstart_teammate.json")

	if got := e.opt(t, OptionBackground); got != "t:probe2" {
		t.Fatalf("%s after a teammate started = %q, want the teammate by name", OptionBackground, got)
	}

	e.fire(t, "done", "stop_teammate_working.json")
	if got := e.opt(t, OptionState); got != StateRunning {
		t.Errorf("%s at Stop with the teammate working = %q, want %q", OptionState, got, StateRunning)
	}
	if got := e.opt(t, OptionBackground); got != "t:probe2" {
		t.Errorf("%s = %q, want the teammate carried through the sync", OptionBackground, got)
	}

	e.fire(t, "teammate-idle", "teammate_idle.json")
	if got := e.opt(t, OptionBackground); got != "" {
		t.Errorf("%s after TeammateIdle = %q, want empty", OptionBackground, got)
	}

	e.fire(t, "done", "stop_teammate_idle.json")
	if got := e.opt(t, OptionState); got != StateDone {
		t.Errorf("%s once the teammate is idle = %q, want %q", OptionState, got, StateDone)
	}
}

// Why the teammate is tracked by name rather than read off the Stop registry
// like everything else: the registry cannot tell the two apart.
//
// Both fixtures are real Stop payloads carrying one teammate. In the first the
// teammate had been working for a second; in the second it had answered and
// the harness's own bar showed it "idle". The entry reads status "running" in
// both, and a third Stop taken 3m30s later still did. So adopting a teammate
// from the list would pin every session that ever spawned one at running —
// which refuses the model picker and holds a T3 attach pin open, with nothing
// left to retire the id.
func TestATeammateIsNeverAdoptedFromTheRegistry(t *testing.T) {
	for _, stop := range []string{"stop_teammate_working.json", "stop_teammate_idle.json"} {
		t.Run(stop, func(t *testing.T) {
			e := newHookEnv(t)
			e.fire(t, "running", "userprompt_human.json")

			e.fire(t, "done", stop)

			if got := e.opt(t, OptionBackground); got != "" {
				t.Errorf("%s = %q, want empty: the list cannot say a teammate is working", OptionBackground, got)
			}
			if got := e.opt(t, OptionState); got != StateDone {
				t.Errorf("%s = %q, want %q", OptionState, got, StateDone)
			}
		})
	}
}

// A plain background subagent fires SubagentStart too, and is left alone: the
// registry lists it honestly and drops it the moment it finishes, so recording
// the name as well would be a second id to retire. The two are told apart by
// the id the harness builds — a1cbb…/a8574… for a subagent, `a<name>-<hash>`
// for a teammate.
func TestAPlainSubagentIsLeftToTheRegistry(t *testing.T) {
	e := newHookEnv(t)
	e.fire(t, "running", "userprompt_human.json")
	e.fire(t, "running", "post_agent_launch.json")

	e.fire(t, "running", "subagentstart_subagent.json")

	if got := e.opt(t, OptionBackground); got != "a:a1cbb47bebad51b9b" {
		t.Errorf("%s = %q, want only the launch's own id", OptionBackground, got)
	}
}

// The team disbanding is the other way a name token goes. Nothing else retires
// one if TeammateIdle never arrives — a teammate removed by hand, or a hook
// that did not run — so a Stop whose registry lists no teammate at all drops
// them, and the session is not left stuck at running.
func TestNoTeammateInTheListDropsTheNames(t *testing.T) {
	e := newHookEnv(t)
	e.set(t, OptionBackground, "t:probe2")
	e.fire(t, "running", "userprompt_human.json")

	e.fire(t, "done", "stop_tasks_finished.json")

	if got := e.opt(t, OptionBackground); got != "" {
		t.Errorf("%s = %q, want empty: the harness lists no teammate", OptionBackground, got)
	}
	if got := e.opt(t, OptionState); got != StateDone {
		t.Errorf("%s = %q, want %q", OptionState, got, StateDone)
	}
}

// Reading the registry rather than reconciling against it is what makes the
// fix general: work this script never saw launched is picked up at the next
// Stop anyway. That is what covers a compaction, an interrupt, and a claude
// restarted under the same tmux session.
func TestStopAdoptsWorkNoLaunchRecorded(t *testing.T) {
	for _, tc := range []struct{ name, stop, want string }{
		{"an agent and a command", "stop.json", "a:a1cbb47bebad51b9b b:bmm8ohp9u"},
		{"a workflow", "stop_workflow_running.json", "w:w7t7pnsug"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newHookEnv(t)
			e.fire(t, "running", "userprompt_human.json")

			e.fire(t, "done", tc.stop)

			if got := e.opt(t, OptionBackground); got != tc.want {
				t.Errorf("%s from an empty set = %q, want %q", OptionBackground, got, tc.want)
			}
			if got := e.opt(t, OptionState); got != StateRunning {
				t.Errorf("%s = %q, want %q", OptionState, got, StateRunning)
			}
		})
	}
}
