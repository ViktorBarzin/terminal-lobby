package sessionio

import "testing"

// The pickers, read off live panes on 2026-09-05: Claude Code 2.1.261 and
// codex-cli 0.144.3, both driven through the same tmux send-keys this package
// uses. Every fixture in this file is a `capture-pane -p` of the real dialog.

func TestPickerOptionsReadsClaudesModelList(t *testing.T) {
	opts := PickerOptions(fixture(t, "picker-claude-model.txt"))
	want := []PickerOption{
		{Index: 1, Label: "Default"},
		{Index: 2, Label: "Sonnet"},
		{Index: 3, Label: "Opus", Cursor: true},
		{Index: 4, Label: "Haiku"},
	}
	if len(opts) != len(want) {
		t.Fatalf("options = %+v, want %d of them", opts, len(want))
	}
	for i, w := range want {
		if opts[i] != w {
			t.Errorf("option %d = %+v, want %+v", i, opts[i], w)
		}
	}
}

// Codex pads its labels with two suffixes at once — "(default) (current)" —
// and neither is part of the name a caller asks for.
func TestPickerOptionsReadsCodexsModelList(t *testing.T) {
	opts := PickerOptions(fixture(t, "picker-codex-model.txt"))
	want := []PickerOption{
		{Index: 1, Label: "gpt-5.6-sol"},
		{Index: 2, Label: "gpt-5.6-terra", Cursor: true},
		{Index: 3, Label: "gpt-5.6-luna"},
		{Index: 4, Label: "gpt-5.5"},
		{Index: 5, Label: "gpt-5.4-mini"},
	}
	if len(opts) != len(want) {
		t.Fatalf("options = %+v, want %d of them", opts, len(want))
	}
	for i, w := range want {
		if opts[i] != w {
			t.Errorf("option %d = %+v, want %+v", i, opts[i], w)
		}
	}
}

func TestPickerOptionsReadsCodexsReasoningLevels(t *testing.T) {
	opts := PickerOptions(fixture(t, "picker-codex-effort.txt"))
	want := []string{"Low", "Medium", "High", "Extra high", "More reasoning…"}
	if len(opts) != len(want) {
		t.Fatalf("options = %+v, want %d of them", opts, len(want))
	}
	for i, w := range want {
		if opts[i].Label != w {
			t.Errorf("option %d = %q, want %q", i, opts[i].Label, w)
		}
	}
	if !opts[1].Cursor {
		t.Errorf("the cursor is on Medium in the fixture; options = %+v", opts)
	}
}

func TestPickerOptionsReadsCodexsAdvancedReasoning(t *testing.T) {
	opts := PickerOptions(fixture(t, "picker-codex-advanced.txt"))
	if len(opts) != 2 || opts[0].Label != "Max" || opts[1].Label != "Ultra" {
		t.Fatalf("options = %+v", opts)
	}
}

// A pane with no picker on it must not produce options, or a driver would send
// a digit into somebody's conversation.
func TestPickerOptionsIgnoresAPaneWithNoPicker(t *testing.T) {
	for _, name := range []string{"status-claude-idle.txt", "status-codex-idle.txt"} {
		if opts := PickerOptions(fixture(t, name)); len(opts) != 0 {
			t.Errorf("%s: options = %+v, want none", name, opts)
		}
	}
}

func TestFindOptionMatchesTheLabelWhateverItsCase(t *testing.T) {
	opts := PickerOptions(fixture(t, "picker-claude-model.txt"))
	for _, want := range []string{"opus", "OPUS", "Opus"} {
		o, ok := FindOption(opts, want)
		if !ok || o.Index != 3 {
			t.Errorf("FindOption(%q) = %+v, %v; want index 3", want, o, ok)
		}
	}
	if _, ok := FindOption(opts, "fable"); ok {
		t.Error("a model this account is not offered was matched anyway")
	}
}

// Claude's effort control is a slider, not a list: the levels are one row of
// words and the position is a ▲ under them. The driver needs the ORDER, which
// is what says how many times to press →.
func TestEffortLadderReadsClaudesSlider(t *testing.T) {
	ladder, ok := EffortLadder(fixture(t, "picker-claude-effort.txt"))
	if !ok {
		t.Fatal("the effort slider was not recognised")
	}
	want := []string{"low", "medium", "high", "xhigh", "max", "ultracode"}
	if len(ladder) != len(want) {
		t.Fatalf("ladder = %v, want %v", ladder, want)
	}
	for i, w := range want {
		if ladder[i] != w {
			t.Errorf("step %d = %q, want %q", i, ladder[i], w)
		}
	}
}

func TestEffortLadderIgnoresAPaneWithNoSlider(t *testing.T) {
	if _, ok := EffortLadder(fixture(t, "picker-claude-model.txt")); ok {
		t.Error("the model picker was read as an effort slider")
	}
}

// What the session says it is on, without opening anything. Claude draws the
// effort as a hint above its input; the model comes off the transcript, which
// is why nothing here reads one from a Claude pane.
func TestClaudeEffortHintReadsTheLiveLevel(t *testing.T) {
	if got := ClaudeEffortHint(fixture(t, "status-claude-idle.txt")); got != "max" {
		t.Fatalf("effort hint = %q, want %q", got, "max")
	}
	if got := ClaudeEffortHint("nothing to see here"); got != "" {
		t.Fatalf("effort hint on a bare pane = %q, want empty", got)
	}
}

// THE GLYPH RAMPS WITH THE LEVEL, and the top step does not even end the same
// way. Read off a live pane on 2026-09-05 by setting each level in turn: a
// reader keyed to the ◈ of `max` — the level the first capture happened to be
// on — answered nothing for the other five, so a successful change came back
// with no effort in it at all.
func TestClaudeEffortHintReadsEveryStepOfTheRamp(t *testing.T) {
	for line, want := range map[string]string{
		"                    ○ low · /effort":                                       "low",
		"                    ◐ medium · /effort":                                    "medium",
		"                    ● high · /effort":                                      "high",
		"                    ◉ xhigh · /effort":                                     "xhigh",
		"                    ◈ max · /effort":                                       "max",
		"  ✦ ultracode · xhigh effort + dynamic workflows for maximum thoroughness": "ultracode",
	} {
		if got := ClaudeEffortHint("some pane\n" + line + "\n❯ \n"); got != want {
			t.Errorf("hint %q = %q, want %q", line, got, want)
		}
	}
}

// The hint names a level from the ladder and nothing else. Prose that happens
// to carry one of those words is not a reading — the receipt of the change is
// on the pane too, and it names the level in a sentence.
func TestClaudeEffortHintIgnoresProseThatNamesALevel(t *testing.T) {
	for _, pane := range []string{
		"  ⎿  to ultracode (this session only): xhigh + dynamic workflow",
		"  CLAUDE_CODE_EFFORT_LEVEL=max overrides this session — clear it and high takes over",
		"Set model to `Sonnet 5` for this session only",
	} {
		if got := ClaudeEffortHint(pane); got != "" {
			t.Errorf("hint on %q = %q, want empty", pane, got)
		}
	}
}

// Codex has no transcript this package can read, so its pane IS the source:
// the footer carries the model and the reasoning level in one line.
func TestCodexStateReadsTheFooter(t *testing.T) {
	got := CodexState(fixture(t, "status-codex-idle.txt"))
	if got.Model != "gpt-5.6-terra" || got.Effort != "medium" {
		t.Fatalf("state = %+v, want gpt-5.6-terra/medium", got)
	}
}

// Codex fetches its model list after the TUI is already up, and says so. A
// reading taken in that window would report "loading" as the model name.
func TestCodexStateSaysNothingWhileTheListIsStillLoading(t *testing.T) {
	pane := "" +
		"│ model:       loading   /model to change │\n" +
		"│ directory:   /tmp                       │\n" +
		"  gpt-5.6-terra default · /tmp\n"
	if got := CodexState(pane); got.Effort != "" {
		t.Fatalf("state = %+v, want no effort while the list is loading", got)
	}
}

func TestCodexEffortLabelNamesTheRowToPick(t *testing.T) {
	for id, want := range map[string]string{
		"low": "Low", "medium": "Medium", "high": "High",
		"xhigh": "Extra high", "max": "Max", "ultra": "Ultra",
	} {
		got, ok := CodexEffortLabel(id)
		if !ok || got != want {
			t.Errorf("CodexEffortLabel(%q) = %q, %v; want %q", id, got, ok, want)
		}
	}
	if _, ok := CodexEffortLabel("ultracode"); ok {
		t.Error("ultracode is Claude's top step, not one codex offers")
	}
}

// Max and Ultra are not on codex's first reasoning screen: they sit behind
// "More reasoning…", so reaching them is two presses rather than one.
func TestCodexEffortIsBehindAnExtraScreenOnlyForMaxAndUltra(t *testing.T) {
	for id, want := range map[string]bool{
		"low": false, "medium": false, "high": false, "xhigh": false,
		"max": true, "ultra": true,
	} {
		if got := CodexEffortIsAdvanced(id); got != want {
			t.Errorf("CodexEffortIsAdvanced(%q) = %v, want %v", id, got, want)
		}
	}
}

// Switching the model of a conversation that already has a warm cache raises a
// SECOND dialog — not the picker, a yes/no about paying to re-read the history
// — and it carries no select-widget footer. Captured live on 2026-09-05 by
// moving a session that had taken a turn; a fresh one never shows it, which is
// why every earlier probe missed it.
func TestSwitchPromptIsRecognisedWithoutAPickerFooter(t *testing.T) {
	pane := fixture(t, "confirm-claude-switch.txt")
	if len(PickerOptions(pane)) != 0 {
		t.Fatal("the confirmation was read as a picker; it has no picker footer")
	}
	yes, ok := SwitchPrompt(pane)
	if !ok {
		t.Fatal("the switch confirmation was not recognised")
	}
	if yes != "Yes, switch to Opus 5" {
		t.Fatalf("the row to answer with = %q", yes)
	}
}

func TestSwitchPromptIgnoresEveryOtherScreen(t *testing.T) {
	for _, name := range []string{
		"picker-claude-model.txt", "picker-claude-effort.txt",
		"picker-codex-model.txt", "status-claude-idle.txt",
	} {
		if _, ok := SwitchPrompt(fixture(t, name)); ok {
			t.Errorf("%s was read as a switch confirmation", name)
		}
	}
}
