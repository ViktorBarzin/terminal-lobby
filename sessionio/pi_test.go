package sessionio

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Pi as a harness: when its pane can take a prompt, how a model switch is
// confirmed, and what a cancel sends. Live against isolated tmux servers, the
// same way ready_test.go drives Claude's readiness.

// piTitle is the OSC 0 sequence pi writes once startup has finished: `π - `
// and the directory's base name.
const piTitle = `\033]0;π - demo\007`

func TestPromptMarkIsExhaustive(t *testing.T) {
	for h, want := range map[Harness]string{
		HarnessClaude: promptMark,
		HarnessCodex:  codexPromptMark,
		HarnessPi:     "", // pi draws no fixed mark; its readiness is the pane title
		"":            promptMark,
	} {
		if got := PromptMark(h); got != want {
			t.Errorf("PromptMark(%q) = %q, want %q", h, got, want)
		}
	}
}

func TestIsPiTitle(t *testing.T) {
	for title, want := range map[string]bool{
		"π - demo":                           true,
		"π - Refactor auth - terminal-lobby": true,
		"π":                                  false,
		"π -":                                false,
		"✳ Claude Code":                      false,
		"devvm":                              false,
		"":                                   false,
		" π - demo":                          false,
	} {
		if got := IsPiTitle(title); got != want {
			t.Errorf("IsPiTitle(%q) = %v, want %v", title, got, want)
		}
	}
}

// testdata/pi-trust.txt is `capture-pane -p` of pi 0.87.1's startup trust
// dialog, taken on 2026-09-25 in a folder holding .pi/settings.json.
func TestPiAsksForTrust(t *testing.T) {
	dialog, err := os.ReadFile(filepath.Join("testdata", "pi-trust.txt"))
	if err != nil {
		t.Fatalf("read the recorded dialog: %v", err)
	}
	for pane, want := range map[string]bool{
		string(dialog):                                     true,
		"  > what does this repo do\n":                     false,
		"Do you trust this?\n":                             false,
		"The phrase Trust project folder appears in prose": false,
		// The question quoted in a conversation, with no dialog under it.
		"Pi asks: Trust project folder?\nand then it loads .pi settings\n": false,
		" Trust project folder?\n and we answered it\n":                    false,
	} {
		if got := PiAsksForTrust(pane); got != want {
			t.Errorf("PiAsksForTrust(%q) = %v, want %v", pane, got, want)
		}
	}
}

// The first prompt of a pi session waits for pi's title, which pi writes once
// startup has finished and any trust question has been answered.
func TestAwaitPiReadyWaitsForTheTitle(t *testing.T) {
	in, osUser, _ := paneSession(t, `sh -c 'sleep 1.2; printf "`+piTitle+`"; printf "\n  > "; sleep 60'`)

	start := time.Now()
	if err := in.AwaitReady(context.Background(), osUser, "demo", HarnessPi, 20*time.Second, 100*time.Millisecond); err != nil {
		t.Fatalf("AwaitReady(pi): %v", err)
	}
	if waited := time.Since(start); waited < time.Second {
		t.Fatalf("returned after %v, before pi could have titled its pane", waited)
	}
}

// A pi pane that is up but asking whether to trust the folder is NOT ready:
// the question is a list, and a pasted line plus Enter would answer it. This
// is the case where the title already stands, a trust question raised by a
// session switched to mid-life.
func TestAwaitPiReadyRefusesWhileTheTrustQuestionIsUp(t *testing.T) {
	in, osUser, _ := paneSession(t, `sh -c 'printf "`+piTitle+`"; printf "Trust project folder?\n/tmp/proj\n→ Trust\n  Do not trust\n"; sleep 60'`)

	err := in.AwaitReady(context.Background(), osUser, "demo", HarnessPi, 1500*time.Millisecond, 100*time.Millisecond)
	if err == nil {
		t.Fatal("a pane asking the trust question was reported ready")
	}
	if !strings.Contains(err.Error(), "demo") {
		t.Errorf("error should name the session: %v", err)
	}
}

func TestAwaitPiReadyGivesUpOnAPaneThatNeverTitles(t *testing.T) {
	// Claude's prompt mark is on screen: a pi wait must not take it for pi.
	in, osUser, _ := paneSession(t, `sh -c 'printf "\n`+promptMark+` "; sleep 60'`)
	if err := in.AwaitReady(context.Background(), osUser, "demo", HarnessPi, 1500*time.Millisecond, 100*time.Millisecond); err == nil {
		t.Fatal("a pane pi never titled was reported ready")
	}
}

// AwaitReady keeps Claude's and Codex's waits exactly as they were.
func TestAwaitReadyDispatchesByHarness(t *testing.T) {
	in, osUser, _ := paneSession(t, `sh -c 'printf "\n`+codexPromptMark+` "; sleep 60'`)
	time.Sleep(400 * time.Millisecond)
	if err := in.AwaitReady(context.Background(), osUser, "demo", HarnessCodex, 5*time.Second, 100*time.Millisecond); err != nil {
		t.Fatalf("codex wait: %v", err)
	}
	if err := in.AwaitReady(context.Background(), osUser, "demo", HarnessClaude, 1200*time.Millisecond, 100*time.Millisecond); err == nil {
		t.Fatal("a codex prompt satisfied Claude's wait")
	}
}

// fakePi runs a stand-in for pi in the pane: it reads submitted lines and, for
// `/model <ref>` and `/thinking <level>`, stamps the pane options the lobby's
// pi extension would, then records the line. Control characters are stripped
// because Prompt's C-e C-u prelude reaches a line-buffered reader literally.
func fakePi(t *testing.T, stamp bool) (*Injector, string, string, string) {
	t.Helper()
	dir := t.TempDir()
	lines := filepath.Join(dir, "lines")
	script := filepath.Join(dir, "fake-pi")
	body := `#!/usr/bin/env bash
printf '` + piTitle + `'
while IFS= read -r line; do
  line="${line//[$'\x01'-$'\x1f']/}"
  printf '%s\n' "$line" >> ` + shellQuoteTest(lines) + `
  [ "$STAMP" = 1 ] || continue
  case "$line" in
    "/model "*) tmux set-option -p -t "$TMUX_PANE" @tl_pi_model "${line#/model }" ;;
    "/thinking "*) tmux set-option -p -t "$TMUX_PANE" @tl_pi_thinking "${line#/thinking }" ;;
  esac
done
`
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	st := "0"
	if stamp {
		st = "1"
	}
	in, osUser, sock := paneSession(t, "env STAMP="+st+" "+script)
	time.Sleep(300 * time.Millisecond)
	return in, osUser, sock, lines
}

func shellQuoteTest(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

func readLines(t *testing.T, path string) []string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var out []string
	for _, line := range strings.Split(string(raw), "\n") {
		if line != "" {
			out = append(out, line)
		}
	}
	return out
}

func TestSetModelSwitchesPiAndReadsTheStampsBack(t *testing.T) {
	in, osUser, _, lines := fakePi(t, true)

	got, err := in.SetModel(context.Background(), osUser, "demo", HarnessPi,
		ModelState{Model: "anthropic/claude-opus-5", Effort: "high"})
	if err != nil {
		t.Fatalf("SetModel(pi): %v", err)
	}
	if got != (ModelState{Model: "anthropic/claude-opus-5", Effort: "high"}) {
		t.Fatalf("read back %+v", got)
	}
	typed := readLines(t, lines)
	want := []string{"/model anthropic/claude-opus-5", "/thinking high"}
	if strings.Join(typed, "|") != strings.Join(want, "|") {
		t.Fatalf("pi was sent %q, want %q", typed, want)
	}
}

// One field alone leaves the other untouched, and says what the pane holds for
// it rather than inventing a value.
func TestSetModelChangesOnlyWhatPiWasAskedTo(t *testing.T) {
	in, osUser, sock, lines := fakePi(t, true)
	if err := in.Command(osUser, "set-option", "-p", "-t", exactPane("demo"), OptionPiModel, "anthropic/claude-haiku-4-5").Run(); err != nil {
		t.Fatalf("seed the model stamp: %v", err)
	}
	_ = sock

	got, err := in.SetModel(context.Background(), osUser, "demo", HarnessPi, ModelState{Effort: "low"})
	if err != nil {
		t.Fatalf("SetModel(pi): %v", err)
	}
	if got != (ModelState{Model: "anthropic/claude-haiku-4-5", Effort: "low"}) {
		t.Fatalf("read back %+v", got)
	}
	if typed := readLines(t, lines); len(typed) != 1 || typed[0] != "/thinking low" {
		t.Fatalf("pi was sent %q, want only the /thinking line", typed)
	}
}

// A pi whose extension never confirms the switch is an error that names what
// the pane options DO say, not a silent success.
func TestSetModelSaysWhatPiReportsWhenTheSwitchDoesNotLand(t *testing.T) {
	in, osUser, _, _ := fakePi(t, false)
	if err := in.Command(osUser, "set-option", "-p", "-t", exactPane("demo"), OptionPiModel, "anthropic/claude-haiku-4-5").Run(); err != nil {
		t.Fatal(err)
	}

	start := time.Now()
	_, err := in.SetModel(context.Background(), osUser, "demo", HarnessPi, ModelState{Model: "anthropic/claude-opus-5"})
	if err == nil {
		t.Fatal("a switch pi never confirmed was reported as done")
	}
	if !strings.Contains(err.Error(), "anthropic/claude-haiku-4-5") {
		t.Errorf("the error does not say what the pane reads: %v", err)
	}
	if elapsed := time.Since(start); elapsed > 8*time.Second {
		t.Errorf("gave up after %v; the wait is meant to be about 3s", elapsed)
	}
}

// Nothing is typed for a value the launch gate would refuse. The text goes into
// somebody's live pane, where a newline would submit a second line.
func TestSetModelRefusesPiValuesOutsideTheGate(t *testing.T) {
	in, osUser, _, lines := fakePi(t, true)
	for _, want := range []ModelState{
		{Model: "anthropic/x\n/quit"},
		{Model: "anthropic/x y"},
		{Model: "/model"},
		{Effort: "ultracode"},
		{Effort: "high\n"},
	} {
		if _, err := in.SetModel(context.Background(), osUser, "demo", HarnessPi, want); err == nil {
			t.Errorf("SetModel(pi, %+v) was accepted", want)
		}
	}
	time.Sleep(300 * time.Millisecond)
	if typed := readLines(t, lines); len(typed) != 0 {
		t.Fatalf("refused values still reached the pane: %q", typed)
	}
}

// rawKeyPane records the first byte the pane receives, in raw mode, so a test
// can tell Escape (0x1b) from Ctrl-C (0x03).
func rawKeyPane(t *testing.T) (*Injector, string, string) {
	t.Helper()
	out := filepath.Join(t.TempDir(), "byte")
	in, osUser, _ := paneSession(t, `bash -c 'stty raw -echo; dd bs=1 count=1 2>/dev/null | od -An -tx1 > `+out+`; sleep 30'`)
	time.Sleep(400 * time.Millisecond)
	return in, osUser, out
}

func firstByte(t *testing.T, path string) string {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if raw, err := os.ReadFile(path); err == nil && strings.TrimSpace(string(raw)) != "" {
			return strings.TrimSpace(string(raw))
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("the pane never received a byte")
	return ""
}

// Pi's interrupt is Escape. Ctrl-C clears its editor, and a second one exits
// pi, which closes the session.
func TestCancelSendsPiEscape(t *testing.T) {
	in, osUser, out := rawKeyPane(t)
	if err := in.CancelHarness(osUser, "demo", HarnessPi); err != nil {
		t.Fatalf("CancelHarness(pi): %v", err)
	}
	if got := firstByte(t, out); got != "1b" {
		t.Fatalf("pi was sent %s, want Escape (1b)", got)
	}
}

func TestCancelStillSendsClaudeCtrlC(t *testing.T) {
	for _, h := range []Harness{HarnessClaude, HarnessCodex, ""} {
		in, osUser, out := rawKeyPane(t)
		if err := in.CancelHarness(osUser, "demo", h); err != nil {
			t.Fatalf("CancelHarness(%q): %v", h, err)
		}
		if got := firstByte(t, out); got != "03" {
			t.Fatalf("%q was sent %s, want Ctrl-C (03)", h, got)
		}
	}
}

// An interrupted pi turn is settled here as well as by the extension, in case
// pi does not report the settle for an aborted run. Only a RUNNING session is
// settled: an awaiting one had a dialog up, which Escape dismisses without
// ending the turn, and the extension re-stamps it from ui_prompt_end.
func TestCancelSettlesARunningPiTurn(t *testing.T) {
	for _, tc := range []struct{ before, after string }{
		{StateRunning, StateDone},
		{StateAwaiting, StateAwaiting},
		{StateDone, StateDone},
		{"", ""},
	} {
		in, osUser, _ := rawKeyPane(t)
		if tc.before != "" {
			if err := in.SetOption(osUser, "demo", OptionState, tc.before); err != nil {
				t.Fatal(err)
			}
		}
		if err := in.CancelHarness(osUser, "demo", HarnessPi); err != nil {
			t.Fatal(err)
		}
		if got := in.State(osUser, "demo"); got != tc.after {
			t.Errorf("state %q became %q after a pi cancel, want %q", tc.before, got, tc.after)
		}
	}
}

// Cancel with no harness named still decides for itself: a pane pi has titled
// is pi's, whatever the caller knew.
func TestHarnessOfReadsPisTitle(t *testing.T) {
	in, osUser, _ := paneSession(t, `sh -c 'printf "`+piTitle+`"; sleep 60'`)
	time.Sleep(400 * time.Millisecond)
	if got := in.HarnessOf(osUser, "demo"); got != HarnessPi {
		t.Fatalf("HarnessOf = %q, want pi", got)
	}
	in2, osUser2, _ := paneSession(t, `sh -c 'printf "\033]0;✳ Claude Code\007"; sleep 60'`)
	time.Sleep(400 * time.Millisecond)
	if got := in2.HarnessOf(osUser2, "demo"); got != "" {
		t.Fatalf("HarnessOf = %q for a Claude pane, want no opinion", got)
	}
}
