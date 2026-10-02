package sessionio

import (
	"context"
	"os/exec"
	"reflect"
	"strings"
	"testing"
	"time"
)

// planSession starts the stand-in on its plan approval (fakeDialogPy,
// FAKEDIALOG_CALL=plan).
func planSession(t *testing.T, env string) (*Injector, string) {
	t.Helper()
	return standIn(t, "FAKEDIALOG_CALL=plan "+env, "Would you like to proceed?")
}

// paneOf reads the stand-in's pane.
func paneOf(t *testing.T, in *Injector, osUser string) string {
	t.Helper()
	pane, err := in.CapturePane(osUser, "demo")
	if err != nil {
		t.Fatalf("CapturePane: %v", err)
	}
	return pane
}

// The permission-mode driver: Shift+Tab one stop at a time, the status line
// read back after every press, and a walk that would pass through bypass or
// don't ask while Claude works refused before it starts.

// The status line of every mode, as CLI 2.1.281 draws it (captured
// 2026-09-24), plus 2.1.261's idle capture and a session mid-turn.
func TestPaneModeReadsTheStatusLine(t *testing.T) {
	for _, tc := range []struct{ fixture, mode string }{
		{"status-claude-manual.txt", ModeManual},
		{"status-claude-acceptedits.txt", ModeAcceptEdits},
		{"status-claude-plan.txt", ModePlan},
		{"status-claude-bypass.txt", ModeBypass},
		{"status-claude-auto.txt", ModeAuto},
		// "don't ask on", not "don't ask mode on".
		{"status-claude-dontask.txt", ModeDontAsk},
		{"status-claude-idle.txt", ModeBypass},
		{"status-claude-working.txt", ModeManual},
		// A conversation quoting every landmark of the plan dialog, over the
		// input box of a bypass session.
		{"plan-quoted-in-conversation.txt", ModeBypass},
		// Screens with no input box have no status line: a dialog takes its
		// place, which is also where Shift+Tab means something else.
		{"plan-first.txt", ""},
		{"dialog-single.txt", ""},
		{"picker-claude-model.txt", ""},
		{"status-codex-idle.txt", ""},
	} {
		t.Run(tc.fixture, func(t *testing.T) {
			if got := PaneMode(fixture(t, tc.fixture)); got != tc.mode {
				t.Errorf("PaneMode = %q, want %q", got, tc.mode)
			}
		})
	}
}

// Only the status line counts. The same words in the conversation, where a
// session discussing modes puts them, are not a reading.
func TestPaneModeIgnoresTheConversation(t *testing.T) {
	pane := "● The pane said:\n  ⏵⏵ auto mode on (shift+tab to cycle)\n  and then\n\n" +
		fixture(t, "plan-first.txt")
	if got := PaneMode(pane); got != "" {
		t.Errorf("PaneMode = %q, want nothing: the only status line is quoted", got)
	}
}

func TestNormalizeMode(t *testing.T) {
	for in, want := range map[string]string{
		"manual": ModeManual, "default": ModeManual, "acceptEdits": ModeAcceptEdits, "plan": ModePlan,
		"auto": ModeAuto, "bypassPermissions": ModeBypass, "dontAsk": ModeDontAsk,
	} {
		if got, ok := NormalizeMode(in); !ok || got != want {
			t.Errorf("NormalizeMode(%q) = %q, %v; want %q", in, got, ok, want)
		}
	}
	for _, bad := range []string{"", "bypass", "Plan", "yolo"} {
		if got, ok := NormalizeMode(bad); ok {
			t.Errorf("NormalizeMode(%q) = %q, accepted", bad, got)
		}
	}
}

// What a walk shows on its way, in the measured superset order: manual,
// acceptEdits, plan, bypassPermissions, auto. A session without bypass skips
// that stop; the safety check cannot know which kind it is looking at, so it
// counts the stop.
func TestModePathFollowsTheMeasuredCycle(t *testing.T) {
	for _, tc := range []struct {
		from, to string
		path     []string
		unsafe   bool
	}{
		{ModeManual, ModeAcceptEdits, nil, false},
		{ModeManual, ModePlan, []string{ModeAcceptEdits}, false},
		{ModeManual, ModeAuto, []string{ModeAcceptEdits, ModePlan, ModeBypass}, true},
		{ModePlan, ModeManual, []string{ModeBypass, ModeAuto}, true},
		{ModeBypass, ModeManual, []string{ModeAuto}, false},
		{ModeAuto, ModePlan, []string{ModeManual, ModeAcceptEdits}, false},
		// Choosing bypass is allowed; passing it is not.
		{ModePlan, ModeBypass, nil, false},
		// dontAsk is off the cycle: the first press leaves it for manual.
		{ModeDontAsk, ModeManual, nil, false},
		{ModeDontAsk, ModePlan, []string{ModeManual, ModeAcceptEdits}, false},
		// …and never comes back, so a walk to it shows the whole cycle.
		{ModeManual, ModeDontAsk, []string{ModeAcceptEdits, ModePlan, ModeBypass, ModeAuto, ModeManual}, true},
	} {
		if got := modePath(tc.from, tc.to); !reflect.DeepEqual(got, tc.path) {
			t.Errorf("modePath(%s, %s) = %v, want %v", tc.from, tc.to, got, tc.path)
		}
		if got := passesDanger(tc.from, tc.to); got != tc.unsafe {
			t.Errorf("passesDanger(%s, %s) = %v, want %v", tc.from, tc.to, got, tc.unsafe)
		}
	}
}

// The measured cycles, as the stand-in's FAKEDIALOG_MODES.
const (
	cyclePlain  = "manual,acceptEdits,plan,auto"
	cycleBypass = "manual,acceptEdits,plan,bypassPermissions,auto"
)

// composerSession starts the stand-in on its idle input box.
func composerSession(t *testing.T, env string) (*Injector, string) {
	t.Helper()
	return standIn(t, "FAKEDIALOG_CALL=composer "+env, "for agents")
}

// composerSessionAs starts the stand-in under Claude's name, with `flags` on
// its command line as the lobby passes them to claude.
func composerSessionAs(t *testing.T, env, flags string) (*Injector, string) {
	t.Helper()
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash not available")
	}
	return standInAs(t, "FAKEDIALOG_CALL=composer "+env, "for agents", "bash -c 'exec -a claude python3 %s "+flags+"'")
}

// visitedOn is the stand-in's list of every mode its status line has shown.
func visitedOn(t *testing.T, in *Injector, osUser string) []string {
	t.Helper()
	for _, line := range strings.Split(paneOf(t, in, osUser), "\n") {
		if rest, ok := strings.CutPrefix(strings.TrimSpace(line), "visited:"); ok {
			return strings.Fields(rest)
		}
	}
	t.Fatalf("the stand-in lists no modes:\n%s", paneOf(t, in, osUser))
	return nil
}

func setMode(t *testing.T, in *Injector, osUser, target string) ModeResult {
	t.Helper()
	res, err := in.SetMode(context.Background(), osUser, "demo", target)
	if err != nil {
		t.Fatalf("SetMode: %v", err)
	}
	return res
}

func stamp(t *testing.T, in *Injector, osUser, name, value string) {
	t.Helper()
	if err := in.SetOption(osUser, "demo", name, value); err != nil {
		t.Fatalf("stamping %s: %v", name, err)
	}
}

func TestSetModeWalksToTheModeItWasAskedFor(t *testing.T) {
	in, osUser := composerSession(t, "FAKEDIALOG_MODES="+cyclePlain+" ")

	res := setMode(t, in, osUser, ModePlan)

	if !res.Applied || res.Mode != ModePlan || res.Presses != 2 || res.From != ModeManual {
		t.Fatalf("got %+v, want plan after two presses from manual", res)
	}
	if got := visitedOn(t, in, osUser); !reflect.DeepEqual(got, []string{"manual", "acceptEdits", "plan"}) {
		t.Errorf("visited %v", got)
	}
}

// Already there: nothing is pressed. The Text view never writes to a pane
// except for a human action, and it does not write more than the action needs.
func TestSetModeTypesNothingWhenTheModeIsAlreadySet(t *testing.T) {
	in, osUser := composerSession(t, "FAKEDIALOG_MODES="+cyclePlain+" ")

	res := setMode(t, in, osUser, "default")

	if !res.Applied || res.Mode != ModeManual || res.Presses != 0 {
		t.Fatalf("got %+v, want manual with nothing pressed", res)
	}
}

// A mode the session does not offer comes back unavailable once the walk has
// gone round, and the walk ends where it started.
func TestSetModeReportsAModeTheSessionDoesNotOffer(t *testing.T) {
	in, osUser := composerSession(t, "FAKEDIALOG_MODES="+cyclePlain+" ")

	res := setMode(t, in, osUser, ModeBypass)

	if res.Applied || res.Reason != ModeUnavailable || res.Mode != ModeManual || res.Presses != 4 {
		t.Fatalf("got %+v, want unavailable, back at manual after four presses", res)
	}
}

// THE SAFETY RULE. While Claude works, a walk that would pass through bypass on
// its way somewhere else is refused before anything is pressed: bypass for the
// 120 ms between two presses is bypass for whatever tool call lands in them.
func TestSetModeRefusesAWalkThroughBypassWhileClaudeWorks(t *testing.T) {
	for _, tc := range []struct{ name, option, value string }{
		{"a running turn", OptionState, StateRunning},
		{"a session waiting on a person", OptionState, StateAwaiting},
		{"a background agent", OptionBackground, "a:task-1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in, osUser := composerSession(t, "FAKEDIALOG_MODES="+cycleBypass+" ")
			stamp(t, in, osUser, tc.option, tc.value)

			res := setMode(t, in, osUser, ModeAuto)

			if res.Applied || res.Reason != ModeUnsafePath || res.Presses != 0 || res.Mode != ModeManual {
				t.Fatalf("got %+v, want unsafe-path with nothing pressed", res)
			}
			if got := visitedOn(t, in, osUser); !reflect.DeepEqual(got, []string{"manual"}) {
				t.Errorf("the walk moved the mode: visited %v", got)
			}
		})
	}
}

// Round 7 (2026-09-28): a session started without a bypass flag refused Plan
// to Auto while Claude worked, "passes through Bypass", though Bypass is not on
// its cycle. The walk reads the flags the pane's Claude was started with.
func TestSetModeWalksPlanToAutoWhereBypassIsNotOnTheCycle(t *testing.T) {
	in, osUser := composerSessionAs(t, "FAKEDIALOG_MODES="+cyclePlain+" FAKEDIALOG_MODE=plan ", "")
	stamp(t, in, osUser, OptionState, StateRunning)

	res := setMode(t, in, osUser, ModeAuto)

	if !res.Applied || res.Mode != ModeAuto || res.Presses != 1 {
		t.Fatalf("got %+v, want auto after one press", res)
	}
}

// …and a Claude started with a bypass flag still has it on the cycle.
func TestSetModeRefusesPlanToAutoWhereTheFlagsPutBypassOnTheCycle(t *testing.T) {
	for _, flag := range []string{"--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--permission-mode bypassPermissions"} {
		t.Run(flag, func(t *testing.T) {
			in, osUser := composerSessionAs(t, "FAKEDIALOG_MODES="+cycleBypass+" FAKEDIALOG_MODE=plan ", flag)
			stamp(t, in, osUser, OptionState, StateRunning)

			res := setMode(t, in, osUser, ModeAuto)

			if res.Applied || res.Reason != ModeUnsafePath || res.Presses != 0 {
				t.Fatalf("got %+v, want unsafe-path with nothing pressed", res)
			}
		})
	}
}

func TestBypassOnCycleReadsClaudesFlags(t *testing.T) {
	for _, tc := range []struct {
		name  string
		argvs [][]string
		want  bool
	}{
		{"plain claude", [][]string{{"/bin/zsh", "-lic", "claude"}, {"/home/u/.local/bin/claude", "--session-id", "x"}}, false},
		{"skip flag", [][]string{{"/home/u/.local/bin/claude", "--dangerously-skip-permissions"}}, true},
		{"allow flag", [][]string{{"claude", "--allow-dangerously-skip-permissions"}}, true},
		{"permission mode", [][]string{{"claude", "--permission-mode", "bypassPermissions"}}, true},
		{"permission mode joined", [][]string{{"claude", "--permission-mode=bypassPermissions"}}, true},
		{"another mode", [][]string{{"claude", "--permission-mode", "plan"}}, false},
		// A shell naming the flag is not Claude holding it.
		{"flag on the shell only", [][]string{{"zsh", "-lic", "claude --dangerously-skip-permissions"}, {"claude"}}, false},
		{"node running claude", [][]string{{"node", "/usr/local/bin/claude", "--dangerously-skip-permissions"}}, true},
		// No Claude found: nothing says bypass is off, so it counts.
		{"no claude", [][]string{{"python3", "fake.py"}}, true},
		{"nothing read", nil, true},
		// A claude run from a tool call holds a flag the session's does not: counts.
		{"nested claude with the flag", [][]string{{"claude"}, {"claude", "-p", "--dangerously-skip-permissions"}}, true},
	} {
		if got := bypassFromArgvs(tc.argvs); got != tc.want {
			t.Errorf("%s: bypassFromArgvs = %v, want %v", tc.name, got, tc.want)
		}
	}
}

// …and when it is idle, the same walk goes through.
func TestSetModeWalksThroughBypassWhenIdle(t *testing.T) {
	in, osUser := composerSession(t, "FAKEDIALOG_MODES="+cycleBypass+" ")
	stamp(t, in, osUser, OptionState, StateDone)

	res := setMode(t, in, osUser, ModeAuto)

	if !res.Applied || res.Mode != ModeAuto || res.Presses != 4 {
		t.Fatalf("got %+v, want auto after four presses", res)
	}
}

// Bypass as the TARGET is the reader's own choice, working or not.
func TestSetModeMayChooseBypassItselfWhileClaudeWorks(t *testing.T) {
	in, osUser := composerSession(t, "FAKEDIALOG_MODES="+cycleBypass+" FAKEDIALOG_MODE=plan ")
	stamp(t, in, osUser, OptionState, StateRunning)

	res := setMode(t, in, osUser, ModeBypass)

	if !res.Applied || res.Mode != ModeBypass || res.Presses != 1 {
		t.Fatalf("got %+v, want bypass after one press", res)
	}
}

// A cycle that is not the measured one: bypass shows where the order said it
// could not. While Claude works the walk stops right there and says so, rather
// than pressing on through a mode it never meant to pass.
func TestSetModeStopsAtAnUnexpectedDangerousMode(t *testing.T) {
	in, osUser := composerSession(t, "FAKEDIALOG_MODES=manual,bypassPermissions,acceptEdits,plan,auto ")
	stamp(t, in, osUser, OptionState, StateRunning)

	res := setMode(t, in, osUser, ModeAcceptEdits)

	if res.Applied || res.Reason != ModeUnsafePath || res.Mode != ModeBypass || res.Presses != 1 {
		t.Fatalf("got %+v, want unsafe-path at bypass after one press", res)
	}
}

// dontAsk is where a session can start, and Shift+Tab leaves it for manual and
// never returns (measured on 2.1.281).
func TestSetModeLeavesDontAsk(t *testing.T) {
	in, osUser := composerSession(t, "FAKEDIALOG_MODES="+cyclePlain+" FAKEDIALOG_MODE=dontAsk ")

	res := setMode(t, in, osUser, ModePlan)

	if !res.Applied || res.Mode != ModePlan || res.Presses != 3 || res.From != ModeDontAsk {
		t.Fatalf("got %+v, want plan after three presses from dontAsk", res)
	}
}

// Shift+Tab over a dialog is not a mode change: on the plan approval's
// feedback row it approves the plan. A drawn dialog, or the hooks' marker that
// one is about to be drawn, refuses the walk before any press.
func TestSetModeRefusesWhileADialogIsUp(t *testing.T) {
	t.Run("the plan approval", func(t *testing.T) {
		in, osUser := planSession(t, "")
		res := setMode(t, in, osUser, ModeAuto)
		if res.Applied || res.Reason != ModeDialogOpen || res.Presses != 0 {
			t.Fatalf("got %+v, want dialog-open with nothing pressed", res)
		}
		if pane := paneOf(t, in, osUser); !strings.Contains(pane, "Would you like to proceed?") {
			t.Fatalf("the dialog went away:\n%s", pane)
		}
	})
	t.Run("the marker, with the dialog a moment away", func(t *testing.T) {
		in, osUser := composerSession(t, "FAKEDIALOG_MODES="+cyclePlain+" ")
		stamp(t, in, osUser, OptionAsk, "toolu_1")
		// The CLI draws the dialog about a second after the PreToolUse that
		// sets the marker (measured 2026-09-13).
		draw := time.AfterFunc(400*time.Millisecond, func() {
			_ = in.Command(osUser, "send-keys", "-t", exactPane("demo"), "-l", "!").Run()
		})
		t.Cleanup(func() { draw.Stop() })
		res := setMode(t, in, osUser, ModePlan)
		if res.Applied || res.Reason != ModeDialogOpen || res.Presses != 0 {
			t.Fatalf("got %+v, want dialog-open with nothing pressed", res)
		}
	})
}

// Esc on a question interrupts the turn, and none of the hooks the box wires
// fires for that, so the marker the PreToolUse set outlives the dialog
// (measured 2026-09-26 in a scratch session: the pane back at an empty prompt
// reading "auto mode on", @claude_ask still naming the escaped call). A marker
// over a status line that stays drawn is not a dialog, and it does not block
// the walk, nor does it later stop it midway.
func TestSetModeWalksPastAMarkerNoDialogFollowed(t *testing.T) {
	was := dialogDraw
	dialogDraw = 600 * time.Millisecond
	t.Cleanup(func() { dialogDraw = was })
	in, osUser := composerSession(t, "FAKEDIALOG_MODES="+cyclePlain+" ")
	stamp(t, in, osUser, OptionAsk, "toolu_escaped")

	res := setMode(t, in, osUser, ModePlan)

	if !res.Applied || res.Mode != ModePlan || res.Presses != 2 {
		t.Fatalf("got %+v, want plan after two presses", res)
	}
}

// The escaped question's marker also holds the session at awaiting: the hook
// script stamps awaiting for as long as the marker stands, and Esc fires no
// Stop. That awaiting is the stale marker's, not a person being waited on, so
// it does not make the walk through bypass unsafe (seen live on 2026-09-27:
// plan to auto refused as unsafe-path at an idle prompt).
func TestSetModeDoesNotCountAStaleMarkersAwaitingAsWork(t *testing.T) {
	was := dialogDraw
	dialogDraw = 600 * time.Millisecond
	t.Cleanup(func() { dialogDraw = was })
	in, osUser := composerSession(t, "FAKEDIALOG_MODES="+cycleBypass+" FAKEDIALOG_MODE=plan ")
	stamp(t, in, osUser, OptionAsk, "toolu_escaped")
	stamp(t, in, osUser, OptionState, StateAwaiting)

	res := setMode(t, in, osUser, ModeAuto)

	if !res.Applied || res.Mode != ModeAuto || res.Presses != 2 {
		t.Fatalf("got %+v, want auto after two presses", res)
	}
}

// A press the status line does not answer ends the walk: pressing again
// without knowing where the first one went could land anywhere.
func TestSetModeStopsWhenAPressDoesNotMove(t *testing.T) {
	in, osUser := composerSession(t, "FAKEDIALOG_MODES="+cyclePlain+" FAKEDIALOG_DEAF=1 ")

	res := setMode(t, in, osUser, ModePlan)

	if res.Applied || res.Reason != ModeUnverified || res.Presses != 1 || res.Mode != ModeManual {
		t.Fatalf("got %+v, want unverified after one press", res)
	}
}

// A status line slower than the settle is waited for, not pressed at again.
func TestSetModeWaitsForASlowRepaint(t *testing.T) {
	in, osUser := composerSession(t, "FAKEDIALOG_MODES="+cyclePlain+" FAKEDIALOG_MODE_LAG=0.3 ")

	res := setMode(t, in, osUser, ModePlan)

	if !res.Applied || res.Presses != 2 {
		t.Fatalf("got %+v, want plan after exactly two presses", res)
	}
	if got := visitedOn(t, in, osUser); !reflect.DeepEqual(got, []string{"manual", "acceptEdits", "plan"}) {
		t.Errorf("visited %v", got)
	}
}

// The press bound: never more than once round the measured cycle and one more.
// No six readable modes can outrun it, so the bound is lowered to show it is
// what stops the walk.
func TestSetModeNeverPressesPastTheBound(t *testing.T) {
	was := maxModePresses
	maxModePresses = 2
	t.Cleanup(func() { maxModePresses = was })
	in, osUser := composerSession(t, "FAKEDIALOG_MODES="+cyclePlain+" ")

	res := setMode(t, in, osUser, ModeAuto)

	if res.Applied || res.Reason != ModeUnavailable || res.Presses != 2 || res.Mode != ModePlan {
		t.Fatalf("got %+v, want unavailable at plan after two presses", res)
	}
}

// A permission prompt has no marker of its own: nothing but the pane says one
// is coming. Shift+Tab over it is an answer ("Yes, and switch to accept edits"
// on a Write), which is how a mode picked about 150 ms before a prompt drew
// approved a file write nobody answered (deployed review round 5,
// 2026-09-29). The hooks stamp OptionTool on the PreToolUse that comes before
// any prompt, so a walk that finds a call in flight waits to see whether a
// dialog follows before it presses.
func TestSetModeWaitsOnAToolCallThatMayDrawAPrompt(t *testing.T) {
	was := toolDraw
	toolDraw = 900 * time.Millisecond
	t.Cleanup(func() { toolDraw = was })

	t.Run("the prompt draws: nothing is pressed", func(t *testing.T) {
		in, osUser := composerSession(t, "FAKEDIALOG_MODES="+cyclePlain+" ")
		stamp(t, in, osUser, OptionTool, "toolu_write")
		draw := time.AfterFunc(300*time.Millisecond, func() {
			_ = in.Command(osUser, "send-keys", "-t", exactPane("demo"), "-l", "!").Run()
		})
		t.Cleanup(func() { draw.Stop() })

		res := setMode(t, in, osUser, ModeAuto)

		if res.Applied || res.Reason != ModeDialogOpen || res.Presses != 0 {
			t.Fatalf("got %+v, want dialog-open with nothing pressed", res)
		}
		if pane := paneOf(t, in, osUser); !strings.Contains(pane, "Would you like to proceed?") {
			t.Fatalf("the dialog went away:\n%s", pane)
		}
	})

	t.Run("no prompt follows: the walk goes on", func(t *testing.T) {
		in, osUser := composerSession(t, "FAKEDIALOG_MODES="+cyclePlain+" ")
		stamp(t, in, osUser, OptionTool, "toolu_long_bash")

		res := setMode(t, in, osUser, ModePlan)

		if !res.Applied || res.Mode != ModePlan || res.Presses != 2 {
			t.Fatalf("got %+v, want plan after two presses", res)
		}
	})

	t.Run("a call that starts mid-walk stops it before the next press", func(t *testing.T) {
		in, osUser := composerSession(t, "FAKEDIALOG_MODES="+cyclePlain+" FAKEDIALOG_MODE_LAG=0.3 ")
		// Lands while the first press is being read back.
		start := time.AfterFunc(150*time.Millisecond, func() {
			_ = in.SetOption(osUser, "demo", OptionTool, "toolu_edit")
		})
		draw := time.AfterFunc(700*time.Millisecond, func() {
			_ = in.Command(osUser, "send-keys", "-t", exactPane("demo"), "-l", "!").Run()
		})
		t.Cleanup(func() { start.Stop(); draw.Stop() })

		res := setMode(t, in, osUser, ModeAuto)

		if res.Applied || res.Reason != ModeDialogOpen || res.Presses != 1 {
			t.Fatalf("got %+v, want dialog-open after the one press made before the call", res)
		}
		if pane := paneOf(t, in, osUser); !strings.Contains(pane, "Would you like to proceed?") {
			t.Fatalf("the dialog went away:\n%s", pane)
		}
	})
}

// Just before every press the pane is read again: a dialog drawn since the last
// reading is where the next Shift+Tab would land.
func TestSetModeReadsThePaneBeforeEveryPress(t *testing.T) {
	in, osUser := composerSession(t, "FAKEDIALOG_MODES="+cyclePlain+" ")
	if err := in.Command(osUser, "send-keys", "-t", exactPane("demo"), "-l", "!").Run(); err != nil {
		t.Fatal(err)
	}
	for deadline := time.Now().Add(3 * time.Second); !strings.Contains(paneOf(t, in, osUser), "Would you like to proceed?"); {
		if time.Now().After(deadline) {
			t.Fatalf("the dialog never drew:\n%s", paneOf(t, in, osUser))
		}
		time.Sleep(50 * time.Millisecond)
	}
	// The walk's opening read is past: the pre-press read is what must see it.
	if blocked, err := in.paneBlocksPress(osUser, "demo", ModeManual); err != nil || !blocked {
		t.Fatalf("paneBlocksPress = %v, %v; want the drawn dialog to block", blocked, err)
	}
}
