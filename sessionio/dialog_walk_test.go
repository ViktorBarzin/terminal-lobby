package sessionio

import "testing"

// How far through a multi-question call the terminal has got.
//
// A multi-question AskUserQuestion draws one question at a time, so the pane can
// only ever show the current one. Until 2026-09-04 the text view read that as
// "cannot be answered here" and handed the reader to the Terminal — for 22.4% of
// the 1,045 calls in this box's corpus, whenever the transcript record had not
// landed yet, which for two of five calls measured on 2026-08-28 was not until
// the question was answered.
//
// The tab bar is the progress signal: `☐` for a question still open, `☒` for one
// already answered. Reported so the card can say `n of N` from what the terminal
// is actually showing rather than from a count it keeps itself.
func TestDialogReportsHowFarTheWalkHasGot(t *testing.T) {
	for _, tc := range []struct {
		name         string
		fixture      string
		wantCount    int
		wantAnswered int
		wantQuestion string
	}{
		{
			name:         "nothing answered yet",
			fixture:      "dialog-multi.txt",
			wantCount:    2,
			wantAnswered: 0,
			wantQuestion: "Pick fruits",
		},
		{
			name:         "one answered, the second on screen",
			fixture:      "dialog-multi-second.txt",
			wantCount:    2,
			wantAnswered: 1,
			wantQuestion: "Pick one drink",
		},
		{
			name:         "every question answered, waiting for Submit",
			fixture:      "dialog-multi-review.txt",
			wantCount:    2,
			wantAnswered: 2,
			wantQuestion: "Ready to submit your answers?",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := ParseDialog(fixture(t, tc.fixture))
			if d == nil {
				t.Fatal("no dialog recognised")
			}
			if d.Count != tc.wantCount {
				t.Errorf("count = %d, want %d", d.Count, tc.wantCount)
			}
			if d.Answered != tc.wantAnswered {
				t.Errorf("answered = %d, want %d", d.Answered, tc.wantAnswered)
			}
			if len(d.Questions) != 1 || d.Questions[0].Question != tc.wantQuestion {
				t.Errorf("question = %+v, want %q", d.Questions, tc.wantQuestion)
			}
			if !d.Partial {
				t.Error("a multi-question dialog is still partial: the pane shows one question")
			}
		})
	}
}

// The second question's own options have to come through, since walking the call
// from the pane means answering each one as it is drawn.
func TestDialogCarriesTheDrawnQuestionsOptions(t *testing.T) {
	d := ParseDialog(fixture(t, "dialog-multi-second.txt"))
	if d == nil {
		t.Fatal("no dialog recognised")
	}
	q := d.Questions[0]
	if q.MultiSelect {
		t.Error("the second question is single-select; the first was the multi-select one")
	}
	if len(q.Options) != 2 || q.Options[0].Label != "Tea" || q.Options[1].Label != "Coffee" {
		t.Fatalf("options = %+v", q.Options)
	}
}

// A single-question call has nothing to walk, and must not start claiming it has.
func TestASingleQuestionReportsNoWalk(t *testing.T) {
	d := ParseDialog(fixture(t, "dialog-single.txt"))
	if d == nil {
		t.Fatal("no dialog recognised")
	}
	if d.Partial {
		t.Error("a single-question dialog is answerable whole")
	}
	if d.Answered != 0 || d.Count != 1 {
		t.Errorf("count=%d answered=%d, want 1 and 0", d.Count, d.Answered)
	}
}

// The glyphs count, not the header text: a header that happens to contain a box
// character must not shift the tally.
func TestAnsweredCountsGlyphsNotWords(t *testing.T) {
	for _, tc := range []struct {
		line string
		want int
	}{
		{"←  ☐ Fruit  ☐ Drink  ✔ Submit  →", 0},
		{"←  ☒ Fruit  ☐ Drink  ✔ Submit  →", 1},
		{"←  ☒ Fruit  ☒ Drink  ✔ Submit  →", 2},
		{"←  ☒ Order  ☒ Done means  ☐ Levers  ☐ Crowdsec now  ✔ Submit  →", 2},
	} {
		if got := tabAnswered(tc.line); got != tc.want {
			t.Errorf("tabAnswered(%q) = %d, want %d", tc.line, got, tc.want)
		}
	}
}
