package sessionio

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

// The plan approval Claude Code draws after ExitPlanMode, read off the pane.
//
// Every capture here is a real screen: the 120-column ones from the probe of
// 2026-09-24 that first measured the dialog on CLI 2.1.281 (memory #13896),
// the 58-column and default-renderer ones from the same day's second pass,
// and two quoted copies, one in the conversation and one inside a plan, which
// must never be read as the dialog. The layout itself is in plandialog.go.

// The three approve options wizard's sessions draw, which carry the clear
// context option (showClearContextOnPlanAccept) and auto mode.
var planOptionsWizard = []PlanOption{
	{Number: 1, Label: "Yes, clear context (6% used) and use auto mode"},
	{Number: 2, Label: "Yes, and use auto mode"},
	{Number: 3, Label: "Yes, manually approve edits"},
}

func TestParsePlanDialogReadsTheOptionsAsDrawn(t *testing.T) {
	for _, tc := range []struct {
		fixture  string
		options  []PlanOption
		feedback int
		path     string
	}{
		// As first drawn, 120x50, the renderer wizard's sessions use.
		{"plan-first.txt", planOptionsWizard, 4, "~/.claude/plans/plan-how-to-create-calm-starfish.md"},
		// A plan longer than its panel: cut off with a grey ↓.
		{"plan-long.txt", planOptionsWizard, 4, "~/.claude/plans/plan-how-to-create-velvety-pearl.md"},
		// The same after PgDn: the title and the heading have scrolled away
		// with the plan, and only the ↑ at the panel's top says there is more.
		{"plan-long-scrolled.txt", planOptionsWizard, 4, "~/.claude/plans/plan-how-to-create-velvety-pearl.md"},
		// A 58-column pane: the question wraps, and the footer puts the path on
		// a line of its own.
		{"plan-narrow.txt", planOptionsWizard, 4, "~/.claude/plans/plan-do-not-execute-binary-kazoo.md"},
		// The default renderer (tui: default): no ▔ edge, a one-space indent.
		{"plan-default-tui.txt", planOptionsWizard, 4, "~/.claude/plans/plan-do-not-execute-floofy-engelbart.md"},
		// No clear context option and no auto mode, which is what an account
		// without either draws: two approve options, and the feedback row is 3.
		{"plan-no-auto.txt", []PlanOption{
			{Number: 1, Label: "Yes, auto-accept edits"},
			{Number: 2, Label: "Yes, manually approve edits"},
		}, 3, "~/.claude/plans/plan-do-not-execute-delightful-whisper.md"},
		// A plan whose own body quotes a dialog, "1. Yes, delete everything"
		// and a footer included. The options are the ones pinned under the
		// panel, never the ones inside it.
		{"plan-quoted-in-plan.txt", planOptionsWizard, 4, "~/.claude/plans/write-a-plan-do-warm-riddle.md"},
	} {
		t.Run(tc.fixture, func(t *testing.T) {
			d := ParsePlanDialog(fixture(t, tc.fixture))
			if d == nil {
				t.Fatal("the plan dialog did not parse")
			}
			if d.Kind != DialogKindPlan {
				t.Errorf("kind = %q, want %q", d.Kind, DialogKindPlan)
			}
			if !reflect.DeepEqual(d.Options, tc.options) {
				t.Errorf("options = %+v\nwant      %+v", d.Options, tc.options)
			}
			if d.FeedbackRow != tc.feedback {
				t.Errorf("feedbackRow = %d, want %d", d.FeedbackRow, tc.feedback)
			}
			if d.PlanPath != tc.path {
				t.Errorf("planPath = %q, want %q", d.PlanPath, tc.path)
			}
			if len(d.Questions) != 0 {
				t.Errorf("a plan reading carries questions: %+v", d.Questions)
			}
		})
	}
}

// The feedback row is an inline field, and typing REPLACES its label (CLI
// 2.1.281): "4. Tell Claude what to change" becomes "4. Also add a third
// step…". The options are unchanged, and the row is still the feedback row,
// found by where it is and by the hint under it rather than by what it says.
func TestParsePlanDialogReadsTheFeedbackRow(t *testing.T) {
	for _, tc := range []struct {
		fixture string
		cursor  int
		typed   string
	}{
		{"plan-first.txt", 1, ""},
		{"plan-feedback-focused.txt", 4, ""},
		{"plan-feedback-typed.txt", 4, "Also add a third step that prints the file size with wc -c."},
		// Wrapped over three lines at the label column, on a 58-column pane.
		{"plan-narrow-typed.txt", 4,
			"Please also add a third step that prints the byte count with wc -c and a fourth that deletes nothing."},
		// ↑ out of the field keeps the words in it.
		{"plan-narrow-typed-up.txt", 3,
			"Please also add a third step that prints the byte count with wc -c and a fourth that deletes nothing."},
	} {
		t.Run(tc.fixture, func(t *testing.T) {
			s, ok := parsePlan(strings.Split(fixture(t, tc.fixture), "\n"))
			if !ok {
				t.Fatal("the plan dialog did not parse")
			}
			if s.cursor != tc.cursor {
				t.Errorf("cursor on row %d, want %d", s.cursor, tc.cursor)
			}
			if s.typed != tc.typed || s.holdsText != (tc.typed != "") {
				t.Errorf("typed = %q (holds text %v), want %q", s.typed, s.holdsText, tc.typed)
			}
			if !reflect.DeepEqual(s.dialog.Options, planOptionsWizard) || s.dialog.FeedbackRow != 4 {
				t.Errorf("typing moved the options: %+v, feedback row %d", s.dialog.Options, s.dialog.FeedbackRow)
			}
		})
	}
}

// Typed words that wrap onto a line starting "2. " are still the words. The
// continuation sits at the label column, where no row's digit can: a row's
// label starts there, its digit three columns further left.
func TestParsePlanDialogKeepsWrappedWordsThatLookLikeARow(t *testing.T) {
	pane := strings.Replace(fixture(t, "plan-narrow-typed.txt"),
		"        byte count with", "        2. byte count with", 1)
	s, ok := parsePlan(strings.Split(pane, "\n"))
	if !ok {
		t.Fatal("the plan dialog did not parse")
	}
	want := "Please also add a third step that prints the 2. byte count with wc -c and a fourth that deletes nothing."
	if s.typed != want {
		t.Errorf("typed = %q\nwant    %q", s.typed, want)
	}
	if !reflect.DeepEqual(s.dialog.Options, planOptionsWizard) {
		t.Errorf("options = %+v", s.dialog.Options)
	}
}

// A copy of the dialog in the CONVERSATION is not the dialog. This one is real:
// Claude asked to echo the dialog's lines, with the input box and the status
// line under the reply. It carries every landmark, down to a hint at its
// label column, so what rules it out is where it sits. The dialog replaces the
// input box, so its footer is the last thing on the pane; a quotation always
// has the input box below it.
func TestParsePlanDialogRefusesAQuotedCopy(t *testing.T) {
	for _, name := range []string{
		"plan-quoted-in-conversation.txt",
		// After option 1: a new conversation carrying the plan, no dialog.
		"plan-after-clear.txt",
		// Other screens: a question, an idle prompt, the model picker.
		"dialog-single.txt",
		"status-claude-idle.txt",
		"picker-claude-model.txt",
	} {
		t.Run(name, func(t *testing.T) {
			if d := ParsePlanDialog(fixture(t, name)); d != nil {
				t.Fatalf("read as the plan dialog: %+v", d)
			}
		})
	}

	// The strictest copy there can be: the dialog's own lines, character for
	// character, with the input box and the status line of an idle session
	// drawn under them, which is what printing a capture of it looks like.
	// Only its place on the pane gives it away.
	t.Run("the dialog's own lines above the input box", func(t *testing.T) {
		dialog := strings.TrimRight(fixture(t, "plan-first.txt"), "\n")
		idle := strings.Split(strings.TrimRight(fixture(t, "status-claude-manual.txt"), "\n"), "\n")
		pane := dialog + "\n\n" + strings.Join(idle[len(idle)-5:], "\n") + "\n"
		if !strings.Contains(pane, "manual mode on") {
			t.Fatalf("the input box did not come across:\n%s", pane)
		}
		if d := ParsePlanDialog(pane); d != nil {
			t.Fatalf("read as the plan dialog: %+v", d)
		}
	})
}

// Every landmark below the plan is required. Each is taken away in turn from a
// real capture, and the result must not parse: the card types keys, and a
// screen that is merely similar is not one to type into.
func TestParsePlanDialogNeedsEveryPinnedLandmark(t *testing.T) {
	base := fixture(t, "plan-first.txt")
	if ParsePlanDialog(base) == nil {
		t.Fatal("the base capture no longer parses")
	}
	for _, tc := range []struct {
		name  string
		edits []string // from, to, from, to…
	}{
		{"no footer", []string{"   ctrl+g to edit in Vim · ~/.claude/plans/plan-how-to-create-calm-starfish.md", ""}},
		{"no hint", []string{"        shift+tab to approve with this feedback", ""}},
		{"no question", []string{"Would you like to proceed?", "Shall we?"}},
		{"no rule over the question", []string{"  " + strings.Repeat("─", 116) + "\n   Claude has written", "\n   Claude has written"}},
		{"numbering that skips", []string{"     3. Yes, manually approve edits", "     5. Yes, manually approve edits"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pane := base
			for i := 0; i+1 < len(tc.edits); i += 2 {
				next := strings.Replace(pane, tc.edits[i], tc.edits[i+1], 1)
				if next == pane {
					t.Fatalf("the edit %q did not apply", tc.edits[i])
				}
				pane = next
			}
			if d := ParsePlanDialog(pane); d != nil {
				t.Fatalf("parsed without it: %+v", d)
			}
		})
	}
}

// The head of the panel is never required: PgDn scrolls "Ready to code?" and
// "Here is Claude's plan:" away with the plan (plan-long-scrolled.txt), and on
// a 58-column pane long feedback squeezes them out (plan-narrow-typed.txt lost
// the heading). A panel squeezed to nothing, with neither line and no scroll
// mark, still leaves the pinned block below it, which is what the parse
// stands on.
func TestParsePlanDialogDoesNotNeedThePanelHead(t *testing.T) {
	pane := fixture(t, "plan-first.txt")
	for _, edit := range [][2]string{{"   Ready to code?", "   Ready?"}, {"   Here is Claude's plan:", "   Here:"}} {
		next := strings.Replace(pane, edit[0], edit[1], 1)
		if next == pane {
			t.Fatalf("the edit %q did not apply", edit[0])
		}
		pane = next
	}
	d := ParsePlanDialog(pane)
	if d == nil {
		t.Fatal("the dialog did not parse without its head")
	}
	if !reflect.DeepEqual(d.Options, planOptionsWizard) || d.FeedbackRow != 4 {
		t.Errorf("options = %+v, feedback row %d", d.Options, d.FeedbackRow)
	}
}

// Each parser leaves the other's screens alone: no plan capture reads as a
// question, and no question capture as a plan. The model pickers and the
// review screen are in the second list too, since they share the question's
// select widget.
func TestEachParserIsNilOnTheOthersCaptures(t *testing.T) {
	entries, err := os.ReadDir("testdata")
	if err != nil {
		t.Fatal(err)
	}
	var plans, others int
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".txt") {
			continue
		}
		pane := fixture(t, name)
		switch {
		case strings.HasPrefix(name, "plan-"):
			plans++
			if d := ParseDialog(pane); d != nil {
				t.Errorf("%s read as a question: %+v", name, d)
			}
		case strings.HasPrefix(name, "dialog-") || strings.HasPrefix(name, "picker-") || strings.HasPrefix(name, "confirm-"):
			others++
			if d := ParsePlanDialog(pane); d != nil {
				t.Errorf("%s read as the plan dialog: %+v", name, d)
			}
		}
	}
	if plans < 10 || others < 20 {
		t.Fatalf("only %d plan and %d other captures found; the test would prove little", plans, others)
	}
}

// What only the driver needs stays off the wire: where the cursor is, and the
// words in the feedback field. The words are the reader's own, and the card
// has them already, in the composer that typed them.
func TestPlanReadingKeepsTheCursorAndTheTypedWordsOffTheWire(t *testing.T) {
	b, err := json.Marshal(ParsePlanDialog(fixture(t, "plan-feedback-typed.txt")))
	if err != nil {
		t.Fatal(err)
	}
	for _, leak := range []string{"Also add a third step", "cursor", "typed", "holdsText"} {
		if strings.Contains(string(b), leak) {
			t.Errorf("the wire carries %q: %s", leak, b)
		}
	}
}

// The wire shape is the contract the Text view reads, exactly: the kind, the
// approve options with their numbers and labels, the feedback row and the
// plan file. The pane watcher sends it as the body of an `asking` event and
// POST /answer as its `dialog`, the same two places a question reading goes.
func TestPlanReadingWireShape(t *testing.T) {
	b, err := json.Marshal(ParsePlanDialog(fixture(t, "plan-no-auto.txt")))
	if err != nil {
		t.Fatal(err)
	}
	want := `{"kind":"plan","options":[{"number":1,"label":"Yes, auto-accept edits"},` +
		`{"number":2,"label":"Yes, manually approve edits"}],"feedbackRow":3,` +
		`"planPath":"~/.claude/plans/plan-do-not-execute-delightful-whisper.md"}`
	if string(b) != want {
		t.Errorf("wire = %s\nwant   %s", b, want)
	}
}

// A question reading is unchanged by the plan fields beside it: no kind, no
// options at the top level, the same keys it always had.
func TestQuestionReadingWireShapeIsUnchanged(t *testing.T) {
	b, err := json.Marshal(ParseDialog(fixture(t, "dialog-single.txt")))
	if err != nil {
		t.Fatal(err)
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(b, &top); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"kind", "options", "feedbackRow", "planPath"} {
		if _, ok := top[k]; ok {
			t.Errorf("a question reading carries %q: %s", k, b)
		}
	}
	for _, k := range []string{"questions", "count"} {
		if _, ok := top[k]; !ok {
			t.Errorf("a question reading lost %q: %s", k, b)
		}
	}
}

// The question parser leaves the plan dialog alone. It has no "Enter to select
// … Esc to cancel" footer and no free-text or chat row, so it is not a
// question, and the pane watcher asks the plan parser first anyway.
func TestParseDialogDoesNotReadThePlanDialogAsAQuestion(t *testing.T) {
	for _, name := range []string{"plan-first.txt", "plan-feedback-typed.txt", "plan-quoted-in-plan.txt"} {
		if d := ParseDialog(fixture(t, name)); d != nil {
			t.Errorf("%s read as a question: %+v", name, d)
		}
	}
}
