package sessionio

import (
	"reflect"
	"strings"
	"testing"
)

// A question taller than the pane. Claude Code draws its dialogs on the
// alternate screen and cuts a dialog that does not fit off at the TOP, so the
// header, the question and the first options are not on screen at all, in the
// capture or in any scrollback. Captured 2026-09-27 on CLI 2.1.283 at 80x23:
// four options with descriptions of about 60 words each left "2. Salad" as the
// first line of the pane. The transcript holds the call, and it is what places
// such a screen.

// lunch is the call the capture was drawn from, as the transcript records it.
var lunch = []DialogQuestion{{
	Question: "What should we have for lunch this week, given that the office kitchen is closed?",
	Header:   "Lunch",
	Options: []DialogOption{
		{Label: "Soup"}, {Label: "Salad"}, {Label: "Sandwich"}, {Label: "Pasta"},
	},
}}

func clippedRegion(t *testing.T) []string {
	t.Helper()
	region := answerRegion(fixture(t, "dialog-clipped-top.txt"))
	if len(region) == 0 {
		t.Fatal("no region: the footer and the option list are on screen")
	}
	return region
}

func TestAClippedQuestionIsPlacedByTheCall(t *testing.T) {
	region := clippedRegion(t)
	if d := ParseDialog(strings.Join(region, "\n")); d != nil {
		t.Fatalf("ParseDialog read %+v; the capture is meant to be one it cannot read", d)
	}

	d := clippedQuestion(region, lunch)

	if d == nil {
		t.Fatal("clippedQuestion = nil, want the Lunch question")
	}
	if got := d.Questions[0]; got.Header != "Lunch" || len(got.Options) != 4 || got.MultiSelect {
		t.Errorf("question = %+v", got)
	}
	if d.Count != 1 || d.Partial {
		t.Errorf("count %d partial %v, want a one-question call", d.Count, d.Partial)
	}
}

// The digit is the call's own number for the option, which is the number the
// widget draws: it lists the options in the order the tool was called with.
func TestAClippedQuestionAnswersByTheCallsOrder(t *testing.T) {
	region := clippedRegion(t)
	d := clippedQuestion(region, lunch)
	if d == nil {
		t.Fatal("clippedQuestion = nil")
	}
	for label, digit := range map[string]string{"Soup": "1", "Salad": "2", "Pasta": "4"} {
		plan, err := planChoice(d, region, []string{label}, "")
		if err != nil {
			t.Fatalf("planChoice(%s): %v", label, err)
		}
		if want := [][]string{{digit}}; !reflect.DeepEqual(plan.Batches, want) {
			t.Errorf("planChoice(%s) = %v, want %v", label, plan.Batches, want)
		}
	}
	plan, err := planChoice(d, region, []string{"Type something"}, "a picnic")
	if err != nil {
		t.Fatalf("planChoice(free text): %v", err)
	}
	if !reflect.DeepEqual(plan.Batches, [][]string{{"5"}}) || plan.Text != "a picnic" {
		t.Errorf("free text plan = %+v, want 5, then the words", plan)
	}
	if _, err := planChoice(d, region, []string{"Chat about this"}, ""); err == nil {
		t.Error("the chat row was offered as an answer")
	}
	if _, err := planChoice(d, region, []string{"Noodles"}, ""); err == nil {
		t.Error("a label the call does not have was planned")
	}
}

// Every visible row has to be the call's own at the same number. Anything
// else is a screen the call does not explain, and typing a digit into it would
// be a guess.
func TestAClippedQuestionIsNotGuessed(t *testing.T) {
	region := clippedRegion(t)
	with := func(edit func(*DialogQuestion)) []DialogQuestion {
		q := lunch[0]
		q.Options = append([]DialogOption(nil), q.Options...)
		edit(&q)
		return []DialogQuestion{q}
	}
	for name, known := range map[string][]DialogQuestion{
		"no call":        nil,
		"another label":  with(func(q *DialogQuestion) { q.Options[2].Label = "Wrap" }),
		"another order":  with(func(q *DialogQuestion) { q.Options[1], q.Options[2] = q.Options[2], q.Options[1] }),
		"one more":       with(func(q *DialogQuestion) { q.Options = append(q.Options, DialogOption{Label: "Pizza"}) }),
		"a multi-select": with(func(q *DialogQuestion) { q.MultiSelect = true }),
		"two alike":      append(append([]DialogQuestion(nil), lunch...), lunch...),
	} {
		t.Run(name, func(t *testing.T) {
			if d := clippedQuestion(region, known); d != nil {
				t.Errorf("clippedQuestion = %+v, want nil", d)
			}
		})
	}
}

// The reading is placed only where the parse failed: a question the parser
// reads keeps the pane's own reading.
func TestPlacingLeavesAParsedReadingAlone(t *testing.T) {
	region := clippedRegion(t)
	r := answerReading{region: region}.placed(lunch)
	if r.dialog == nil || r.dialog.Questions[0].Header != "Lunch" {
		t.Fatalf("placed reading = %+v", r.dialog)
	}

	whole := answerRegion(fixture(t, "dialog-single.txt"))
	parsed := ParseDialog(strings.Join(whole, "\n"))
	if parsed == nil {
		t.Fatal("dialog-single.txt no longer parses")
	}
	if got := (answerReading{region: whole, dialog: parsed}).placed(lunch).dialog; got != parsed {
		t.Errorf("a parsed reading was replaced by %+v", got)
	}
	if got := (answerReading{}).placed(lunch); !got.gone() {
		t.Errorf("a pane with no dialog came back as %+v", got.dialog)
	}
}
