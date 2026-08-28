package sessionio

import (
	"os"
	"testing"
)

func fixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	return string(b)
}

// The shape 84% of this box's 900 AskUserQuestion calls take: one question,
// one answer. Captured off a live pane on 2026-08-28.
func TestParseDialogReadsASingleQuestion(t *testing.T) {
	d := ParseDialog(fixture(t, "dialog-single.txt"))
	if d == nil {
		t.Fatal("a live question dialog was not recognised")
	}
	if d.Count != 1 || d.Partial {
		t.Fatalf("count=%d partial=%v, want 1 and false", d.Count, d.Partial)
	}
	if len(d.Questions) != 1 {
		t.Fatalf("questions = %+v", d.Questions)
	}
	q := d.Questions[0]
	if q.Header != "Font" || q.Question != "Which font should the badge use?" {
		t.Fatalf("question = %+v", q)
	}
	if q.MultiSelect {
		t.Fatal("a single-select question was read as multi-select")
	}
	// The tool's own two extra options are the CLI's, not the caller's — the
	// card adds its own, so carrying them would double them up.
	if len(q.Options) != 2 {
		t.Fatalf("options = %+v", q.Options)
	}
	if q.Options[0].Label != "Sans" || q.Options[0].Description != "A sans-serif typeface." {
		t.Fatalf("option 1 = %+v", q.Options[0])
	}
	if q.Options[1].Label != "Serif" || q.Options[1].Description != "A serif typeface." {
		t.Fatalf("option 2 = %+v", q.Options[1])
	}
}

// A call with several questions shows ONE of them at a time plus a tab bar. The
// pane cannot say what the others hold, so the dialog is reported as partial and
// carries the headers it can see — enough to tell the reader what is being
// asked, not enough to answer it from here.
func TestParseDialogReadsTheQuestionOnScreenAndSaysTheRestAreHidden(t *testing.T) {
	d := ParseDialog(fixture(t, "dialog-multi.txt"))
	if d == nil {
		t.Fatal("a multi-question dialog was not recognised")
	}
	if d.Count != 2 || !d.Partial {
		t.Fatalf("count=%d partial=%v, want 2 and true", d.Count, d.Partial)
	}
	if len(d.Headers) != 2 || d.Headers[0] != "Fruit" || d.Headers[1] != "Drink" {
		t.Fatalf("headers = %v", d.Headers)
	}
	if len(d.Questions) != 1 {
		t.Fatalf("questions = %+v", d.Questions)
	}
	q := d.Questions[0]
	if q.Question != "Pick fruits" || !q.MultiSelect {
		t.Fatalf("question = %+v", q)
	}
	if len(q.Options) != 3 || q.Options[0].Label != "Apple" || q.Options[2].Label != "Plum" {
		t.Fatalf("options = %+v", q.Options)
	}
	if q.Options[0].Description != "Include apples." {
		t.Fatalf("description = %q", q.Options[0].Description)
	}
}

// A pane with no dialog on it must not produce one.
func TestParseDialogIgnoresAnOrdinaryPane(t *testing.T) {
	if d := ParseDialog(fixture(t, "dialog-none.txt")); d != nil {
		t.Fatalf("an ordinary pane parsed as a dialog: %+v", d)
	}
	if d := ParseDialog(""); d != nil {
		t.Fatalf("an empty pane parsed as a dialog: %+v", d)
	}
}

// The CLI draws every one of its pickers with the same select widget — /model,
// /effort, the resume list. Only an AskUserQuestion carries the tool's own two
// synthetic options, and requiring one of them is what keeps a menu the operator
// opened from being mirrored as a question Claude asked.
func TestParseDialogIgnoresTheCLIsOwnMenus(t *testing.T) {
	menu := `
 Select a model
❯ 1. Opus 5
     Most capable
  2. Sonnet 5
     Fast
Enter to select · ↑/↓ to navigate · Esc to cancel
`
	if d := ParseDialog(menu); d != nil {
		t.Fatalf("the model picker parsed as a question: %+v", d)
	}
}

// The end of a multi-question walk is a review screen. It is not a question, and
// mirroring its "Submit answers / Cancel" as one would offer an answer nobody
// asked for.
func TestParseDialogIgnoresTheReviewScreen(t *testing.T) {
	review := `
←  ☒ Fruit  ☒ Drink  ✔ Submit  →
Review your answers
 ● Pick fruits
   → Apple, Plum
Ready to submit your answers?
❯ 1. Submit answers
  2. Cancel
`
	if d := ParseDialog(review); d != nil {
		t.Fatalf("the review screen parsed as a question: %+v", d)
	}
}

// The dialog is drawn above the composer, so the composer's top border lands in
// the middle of the option list — the last option and the footer sit below it.
// A parser that stopped at the rule would lose them.
func TestParseDialogReadsPastTheComposerBorder(t *testing.T) {
	d := ParseDialog(fixture(t, "dialog-single.txt"))
	if d == nil {
		t.Fatal("dialog not recognised")
	}
	if d.Questions[0].Options[1].Label != "Serif" {
		t.Fatalf("the option below the border was lost: %+v", d.Questions[0].Options)
	}
}
