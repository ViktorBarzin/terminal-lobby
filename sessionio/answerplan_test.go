package sessionio

import (
	"strings"
	"testing"
)

// The two questions of the dialog-multi* captures, as the transcript records
// them. This is the "known question list" the walk matches the drawn text
// against — the call itself, not anything read off the pane.
var multiKnown = []DialogQuestion{
	{Header: "Fruit", Question: "Pick fruits"},
	{Header: "Drink", Question: "Pick one drink"},
}

// midToggle is the state a multi-select question is in between the first Space
// and the Enter that leaves it: the tab bar has already flipped to ☒ while the
// pane is still drawing the question. Measured against CLI 2.1.267 on
// 2026-09-10, which is why Answered cannot be a position index.
func midToggle(t *testing.T) string {
	t.Helper()
	pane := fixture(t, "dialog-multi.txt")
	out := strings.Replace(pane, "←  ☐ Fruit  ☐ Drink  ✔ Submit  →", "←  ☒ Fruit  ☐ Drink  ✔ Submit  →", 1)
	if out == pane {
		t.Fatal("the fixture's tab bar has moved; this test edits it by hand")
	}
	return out
}

// THE DEFECT THIS PORT FIXES. The shipped landed() searched the whole capture,
// so a check could pass on text that was on screen before anything was typed —
// and a conversation that has already answered three questions carries all of
// them in its scrollback. dialog-multi.txt is exactly that pane: "Which colour
// should the badge be?" is nine lines of history above a dialog asking about
// fruit.
func TestAnswerRegionExcludesTheConversationAboveIt(t *testing.T) {
	pane := fixture(t, "dialog-multi.txt")
	region := answerRegion(pane)
	if len(region) == 0 {
		t.Fatal("no dialog region found in a capture that is showing a dialog")
	}
	if !answerRegionHas(region, "Pick fruits") {
		t.Errorf("the drawn question is not in the region:\n%s", strings.Join(region, "\n"))
	}
	for _, scrollback := range []string{
		"Which colour should the badge be?",
		"Which shape should the badge be?",
		"You picked Small. Badge so far: blue, square, small.",
	} {
		if !strings.Contains(pane, scrollback) {
			t.Fatalf("the fixture no longer carries %q, so this test proves nothing", scrollback)
		}
		if answerRegionHas(region, scrollback) {
			t.Errorf("%q was matched from the conversation above the dialog", scrollback)
		}
	}
}

// The region runs from the dialog's top edge — the tab bar, or the header of a
// single-question call — to the footer.
func TestAnswerRegionRunsFromTheTopEdgeToTheFooter(t *testing.T) {
	for _, tc := range []struct{ fixture, first, last string }{
		{"dialog-multi.txt", "←  ☐ Fruit  ☐ Drink  ✔ Submit  →", "Enter to select · Tab/Arrow keys to navigate · Esc to cancel"},
		{"dialog-single.txt", "☐ Font", "Enter to select · ↑/↓ to navigate · Esc to cancel"},
		{"dialog-multi-review.txt", "←  ☒ Fruit  ☒ Drink  ✔ Submit  →", "Enter to select · Tab/Arrow keys to navigate · Esc to cancel"},
		// 58 columns: the footer wraps, and the region carries both of its
		// lines. It has to, or the region does not parse on its own and the
		// read falls back to the whole capture — which is where a conversation
		// that quotes "Review your answers" turns this question into a Submit.
		{"dialog-narrow-footer.txt", "←  ☐ Gesture scope  ☐ CSS floor  ✔ Submit  →", "cancel"},
		// The cursor on a multi-select's commit row, "❯    Submit". Until
		// 2026-09-23 the walk up from the footer stopped there and the region
		// began at the chat row, one row with nothing to parse.
		{"dialog-multiselect-on-commit.txt", "←  ☒ Fruit  ✔ Submit  →", "Enter to select · ↑/↓ to navigate · ctrl+g to edit in Vim · Esc to cancel"},
	} {
		t.Run(tc.fixture, func(t *testing.T) {
			region := answerRegion(fixture(t, tc.fixture))
			if len(region) == 0 {
				t.Fatal("no region")
			}
			if got := strings.TrimSpace(region[0]); got != tc.first {
				t.Errorf("region starts at %q, want %q", got, tc.first)
			}
			if got := strings.TrimSpace(region[len(region)-1]); got != tc.last {
				t.Errorf("region ends at %q, want %q", got, tc.last)
			}
		})
	}
}

// A pane with no dialog on it has no region, and neither does the model picker
// — which draws with the same select widget and must never be answered as a
// question.
func TestAnswerRegionIsEmptyWithoutADialog(t *testing.T) {
	for _, name := range []string{"dialog-none.txt", "picker-claude-model.txt"} {
		if region := answerRegion(fixture(t, name)); len(region) != 0 {
			t.Errorf("%s: found a dialog region:\n%s", name, strings.Join(region, "\n"))
		}
	}
}

// THE OTHER HALF OF THE SAME DEFECT. A capture whose tab bar has scrolled off
// the top — a long question and its options on a phone-sized pane — used to
// fall back to "the 48 lines above the footer", which on a short pane is the
// whole capture, conversation included. Every check downstream then searched
// the conversation again: the review wording, the free-text read-back, the
// option rows. The dialog's own shape says where it starts instead.
func TestAnswerRegionStopsAtTheDialogWhenTheTabBarHasScrolledOff(t *testing.T) {
	pane := strings.Join([]string{
		"  Earlier I said: Include apples.",
		"  and you replied quince",
		"",
		"Pick fruits",
		"",
		"❯ 1. Apple",
		"  2. Pear",
		"  3. Type something.",
		"  4. Chat about this",
		"",
		"Enter to select · ↑/↓ to navigate · Esc to cancel",
	}, "\n")
	if ParseDialog(pane) == nil {
		t.Fatal("this capture still has to parse as a dialog, or it proves nothing")
	}
	region := answerRegion(pane)
	if len(region) == 0 {
		t.Fatal("a dialog the parser can read must have a region")
	}
	if got := strings.TrimSpace(region[0]); got != "Pick fruits" {
		t.Errorf("the region starts at %q, want the question", got)
	}
	for _, scrollback := range []string{"Earlier I said: Include apples.", "and you replied quince"} {
		if answerRegionHas(region, scrollback) {
			t.Errorf("%q was matched from the conversation above the dialog", scrollback)
		}
	}
}

// A region is parsed on its own, so it has to carry everything ParseDialog
// needs — including the second line of a footer the terminal wrapped. Without
// it the parse fails on every pane under 60 columns and the read falls back to
// the whole capture, where "Review your answers" in the conversation turns the
// question on screen into a Submit with no options.
func TestANarrowRegionParsesOnItsOwn(t *testing.T) {
	pane := fixture(t, "dialog-narrow-footer.txt")
	region := answerRegion(pane)
	d := ParseDialog(strings.Join(region, "\n"))
	if d == nil {
		t.Fatal("the 58-column region did not parse on its own")
	}
	if len(d.Questions[0].Options) != 3 {
		t.Errorf("%d options, want the three the pane draws", len(d.Questions[0].Options))
	}
	if !strings.HasPrefix(d.Questions[0].Question, "At 2,700 lines") {
		t.Errorf("question = %q, want the one on screen", d.Questions[0].Question)
	}
}

// Wrapping and truncation are the two things the CLI does to a question that a
// naive string compare fails on. The border glyph goes before the whitespace
// collapse, or "Push, then — which mechanism │ delivers" reads as two
// fragments that match nothing.
func TestAnswerRegionHasSurvivesWrappingAndTruncation(t *testing.T) {
	region := answerRegion(fixture(t, "dialog-wrapped.txt"))
	whole := `Push, then — which mechanism delivers "a package was published, go get it"? (In all four, apt still fetches the bytes; what is being pushed is the trigger.)`
	if !answerRegionHas(region, whole) {
		t.Error("a question wrapped over three bordered lines was not matched")
	}
	// What truncation looks like from this side: the call's own question runs
	// past what the dialog had room to draw, so only its head is on screen.
	if !answerRegionHas(region, whole+" And the tail the CLI had no room for.") {
		t.Error("a question truncated by the CLI was not matched on its prefix")
	}
	if answerRegionHas(region, "Which font should the badge use?") {
		t.Error("a question that is not on screen was matched")
	}
	// Twelve characters is the floor: below it a prefix is not distinctive
	// enough to be evidence of anything.
	if answerRegionHas(region, "Push, then?") {
		t.Error("a fragment shorter than the prefix floor was matched")
	}
}

// The free-text read-back asks whether the region GAINED the text, not whether
// it holds it.
//
// Holding it proves nothing: the region is where the question, every option
// label and every description are drawn. On dialog-multi.txt "Include apples."
// is option one's description, so a reader answering in the question's own
// words confirmed a field the paste never reached — and the Enter that follows
// a confirmed read-back answers the question with an empty field.
func TestAnswerRegionGainedNeedsANewOccurrence(t *testing.T) {
	region := answerRegion(fixture(t, "dialog-multi.txt"))
	for _, text := range []string{"Include apples.", "Pick fruits", "Type something"} {
		if !answerRegionHas(region, text) {
			t.Fatalf("%q is not on this capture, so it proves nothing here", text)
		}
		if answerRegionGained(region, region, text) {
			t.Errorf("%q read back as landed while nothing was typed", text)
		}
	}
	// The same words again, one line further down, is the field filling in.
	typed := append(append([]string{}, region...), "  > Include apples.")
	if !answerRegionGained(region, typed, "Include apples.") {
		t.Error("text typed into the field on top of the same words did not read back")
	}
	// And text the region never had at all.
	if !answerRegionGained(region, append(append([]string{}, region...), "  > quince and damsons"), "quince and damsons") {
		t.Error("a plain answer did not read back")
	}
	if answerRegionGained(region, region, "quince and damsons") {
		t.Error("an answer nothing typed read back as landed")
	}
}

// Position comes from the question the pane is DRAWING, matched against the
// call's own question list.
func TestQuestionOnScreenMatchesTheDrawnQuestion(t *testing.T) {
	for _, tc := range []struct {
		name   string
		pane   string
		known  []DialogQuestion
		want   int
		wantOK bool
	}{
		{"first question", fixture(t, "dialog-multi.txt"), multiKnown, 0, true},
		{"second question", fixture(t, "dialog-multi-second.txt"), multiKnown, 1, true},
		{
			"a single-question call is placed by the header it draws",
			fixture(t, "dialog-single.txt"),
			[]DialogQuestion{{Header: "Font", Question: "Which font should the badge use?"}},
			0, true,
		},
		{
			"a question the call does not have is not placed",
			fixture(t, "dialog-multi.txt"),
			[]DialogQuestion{{Header: "Size", Question: "Which size?"}},
			0, false,
		},
		{"nothing known, nothing placed", fixture(t, "dialog-multi.txt"), nil, 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			at, ok := questionOnScreen(ParseDialog(tc.pane), tc.known)
			if ok != tc.wantOK || (ok && at != tc.want) {
				t.Errorf("questionOnScreen = %d, %v; want %d, %v", at, ok, tc.want, tc.wantOK)
			}
		})
	}
}

// The reason position is not the tab-bar count: a multi-select question fills
// its own box on the first Space, so Answered says "one done" while the pane
// is still drawing question one. Reading Answered as the index here is how a
// choice for question 1 lands in question 2.
func TestQuestionOnScreenIgnoresTheAnsweredCount(t *testing.T) {
	d := ParseDialog(midToggle(t))
	if d == nil {
		t.Fatal("no dialog")
	}
	if d.Answered != 1 {
		t.Fatalf("answered = %d, want the tab bar to be one ahead", d.Answered)
	}
	at, ok := questionOnScreen(d, multiKnown)
	if !ok || at != 0 {
		t.Errorf("questionOnScreen = %d, %v; want question 0, which is what is drawn", at, ok)
	}
}

// What the driver asks before it types: is the pane drawing the question this
// request names? Three answers, because "cannot tell" is not "no" — a
// multi-question dialog draws no per-question header, and which tab is current
// is colour, which a text capture does not carry.
func TestDrawnHeader(t *testing.T) {
	for _, tc := range []struct {
		name   string
		pane   string
		header string
		known  []DialogQuestion
		want   answerDrawn
	}{
		{"the drawn question, named", fixture(t, "dialog-multi.txt"), "Fruit", multiKnown, drawnHere},
		{"a question further on", fixture(t, "dialog-multi.txt"), "Drink", multiKnown, drawnElsewhere},
		{"the tab bar is one ahead, the pane is not", midToggle(t), "Fruit", multiKnown, drawnHere},
		{"a header from another call entirely", fixture(t, "dialog-multi.txt"), "Colour", multiKnown, drawnElsewhere},
		{"not in this call's tab bar, with nothing known", fixture(t, "dialog-multi.txt"), "Colour", nil, drawnElsewhere},
		{"in the tab bar, nothing known: the capture cannot say", fixture(t, "dialog-multi.txt"), "Drink", nil, drawnUnsure},
		{"a single-question call draws its own header", fixture(t, "dialog-single.txt"), "Font", nil, drawnHere},
		{"and refuses another", fixture(t, "dialog-single.txt"), "Colour", nil, drawnElsewhere},
		// Nothing known and the question already answered: the box says so,
		// and a request naming it is a card that has fallen behind.
		{"a question the tab bar has already ticked, nothing known", midToggle(t), "Fruit", nil, drawnElsewhere},
		{"the question still open beside it", midToggle(t), "Drink", nil, drawnUnsure},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := drawnHeader(ParseDialog(tc.pane), answerRegion(tc.pane), tc.header, tc.known)
			if got != tc.want {
				t.Errorf("drawnHeader = %v, want %v", got, tc.want)
			}
		})
	}
}

// THE REFUSAL THE CONTRACT PROMISES (answerapi.go: "a stale client cannot
// answer the wrong question"), in the shape that gets past every other check.
//
// Two questions, both offering Yes and No, and no transcript record yet — two
// of five records measured on 2026-08-28 were not written until the question
// had been answered, one 112 seconds later. The human answered question one at
// the terminal, the card still shows it, and the card's request names it. The
// header is in the tab bar so it cannot be refused for belonging to another
// call, and the drawn question offers "Yes" as well, so the option check
// cannot refuse it either: without this, key "1" answers the WORKER question
// with the API question's choice, which is exactly "the walk can put question
// 1's choice into question 2".
func TestDrawnHeaderRefusesAnAnsweredQuestionWhenLabelsOverlap(t *testing.T) {
	pane := strings.Join([]string{
		"● conversation above",
		"←  ☒ API  ☐ Worker  ✔ Submit  →",
		"",
		"Deploy the worker?",
		"",
		"❯ 1. Yes",
		"  2. No",
		"  3. Type something.",
		"  4. Chat about this",
		"",
		"Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
	}, "\n")
	d, region := ParseDialog(pane), answerRegion(pane)
	if d == nil {
		t.Fatal("the capture must parse for this to prove anything")
	}
	if got := drawnHeader(d, region, "API", nil); got != drawnElsewhere {
		t.Errorf("drawnHeader(API) = %v while the pane draws %q, want drawnElsewhere",
			got, d.Questions[0].Question)
	}
	// And the question that IS open is still answerable, or the refusal above
	// would have cost the reader the call.
	if got := drawnHeader(d, region, "Worker", nil); got == drawnElsewhere {
		t.Error("the open question was refused as well")
	}
}

// tabBoxes pairs the glyph with the header, which is the half dialog.go does
// not report: tabHeaders() drops the glyphs and tabAnswered() only counts them.
func TestTabBoxesPairEachHeaderWithItsBox(t *testing.T) {
	boxes := tabBoxes([]string{"←  ☒ Fruit  ☐ Drink  ✔ Submit  →"})
	if len(boxes) != 2 {
		t.Fatalf("boxes = %v, want the two questions and not the Submit chip", boxes)
	}
	if !boxes["fruit"] || boxes["drink"] {
		t.Errorf("boxes = %v, want fruit ticked and drink open", boxes)
	}
	if len(tabBoxes([]string{"Pick fruits", "❯ 1. Apple"})) != 0 {
		t.Error("a pane with no tab bar reported boxes")
	}
}

// The digit is counted over the list AS THE DIALOG DRAWS IT. The CLI appends
// its own free-text and chat rows, and the parsed Dialog drops them, so a
// count over the parsed options alone would put the free-text digit on the
// chat row.
func TestPlanChoiceUsesTheDigitTheDialogDrew(t *testing.T) {
	for _, tc := range []struct {
		fixture string
		choice  string
		text    string
		want    [][]string
	}{
		{"dialog-multi-second.txt", "Tea", "", [][]string{{"1"}}},
		{"dialog-multi-second.txt", "Coffee", "", [][]string{{"2"}}},
		{"dialog-single.txt", "Serif", "", [][]string{{"2"}}},
		// The CLI's own row, which is 3 here and 4 there. It is FOCUSED by its
		// digit rather than answered by it, so the text and the Enter follow.
		{"dialog-single.txt", "Type something", "my own answer", [][]string{{"3"}}},
		{"dialog-multi-second.txt", "Type something", "my own answer", [][]string{{"3"}}},
		{"dialog-narrow-footer.txt", "Type something", "my own answer", [][]string{{"4"}}},
		// "Other" is what the frontend called that row until 2026-09-10. A
		// client on the old build still means the same row.
		{"dialog-single.txt", "Other", "my own answer", [][]string{{"3"}}},
	} {
		t.Run(tc.fixture+"/"+tc.choice, func(t *testing.T) {
			pane := fixture(t, tc.fixture)
			plan, err := planChoice(ParseDialog(pane), answerRegion(pane), []string{tc.choice}, tc.text)
			if err != nil {
				t.Fatalf("planChoice: %v", err)
			}
			if !sameKeys(plan.Batches, tc.want) {
				t.Errorf("batches = %v, want %v", plan.Batches, tc.want)
			}
			if tc.text == "" {
				if plan.Text != "" || len(plan.After) != 0 {
					t.Errorf("a plain choice typed text: %+v", plan)
				}
				return
			}
			if plan.Text != tc.text {
				t.Errorf("text = %q, want %q", plan.Text, tc.text)
			}
			if !sameKeys([][]string{plan.After}, [][]string{{"Enter"}}) {
				t.Errorf("after = %v, want one Enter", plan.After)
			}
		})
	}
}

// flatToggles is a toggle plan as the batches the driver sends: each walk, and
// then a Space in a batch of its own.
func flatToggles(steps []toggleStep) [][]string {
	var out [][]string
	for _, s := range steps {
		out = append(out, s.walk...)
		out = append(out, []string{"Space"})
	}
	return out
}

// A multi-select toggle walks to each row whose box is not the way the request
// wants it, in list order, and presses Space there. The walk starts from the
// row the cursor is on, read off the pane, rather than assuming it opens on row
// one.
//
// AND NOTHING ELSE: no walk to the commit row and no Enter. Until 2026-09-23
// every multi-select request ended with both, so the first click on an option
// committed the question, and on a one-question call it went straight to the
// review screen. Leaving the question is the commit request's job (planCommit),
// planned from a reading taken after the toggles have landed.
//
// EVERY TOGGLE is a batch of its own, apart from its walk, because a settle
// lands between batches. Two Spaces in one send-keys loses the second:
// measured against CLI 2.1.268 on 2026-09-11 driving a real dialog, where
// [Space Down Down Space] as one run ticked the first row and left the third
// clear with the cursor on it.
func TestPlanTogglesWalksAMultiSelect(t *testing.T) {
	pane := fixture(t, "dialog-multi.txt")
	d, region := ParseDialog(pane), answerRegion(pane)
	for _, tc := range []struct {
		choices []string
		want    [][]string
	}{
		{[]string{"Apple"}, [][]string{{"Space"}}},
		{[]string{"Pear"}, [][]string{{"Down"}, {"Space"}}},
		{[]string{"Apple", "Plum"}, [][]string{{"Space"}, {"Down", "Down"}, {"Space"}}},
		// Out of order in, list order out: the cursor only ever walks one way.
		{[]string{"Plum", "Pear"}, [][]string{{"Down"}, {"Space"}, {"Down"}, {"Space"}}},
		// An empty set on a question with nothing ticked is nothing to do.
		{nil, nil},
	} {
		t.Run(strings.Join(tc.choices, "+"), func(t *testing.T) {
			want, err := wantOf(d.Questions[0], tc.choices, "")
			if err != nil {
				t.Fatalf("wantOf: %v", err)
			}
			got := flatToggles(planToggles(d.Questions[0], answerRows(region), want))
			if !sameKeys(got, tc.want) {
				t.Errorf("batches = %v, want %v", got, tc.want)
			}
		})
	}
}

// A question the reader is coming back to: the cursor is wherever the pane
// says it is, and a pick on screen that the request leaves out is CLEARED,
// because the request is the whole set the question should hold rather than a
// change to it.
func TestPlanTogglesClearsAPickTheSetLeavesOut(t *testing.T) {
	pane := strings.Replace(fixture(t, "dialog-multi.txt"),
		"❯ 1. [ ] Apple", "  1. [✔] Apple", 1)
	pane = strings.Replace(pane, "  2. [ ] Pear", "❯ 2. [ ] Pear", 1)
	if !strings.Contains(pane, "❯ 2. [ ] Pear") {
		t.Fatal("the fixture's option rows have moved; this test edits them by hand")
	}
	d := ParseDialog(pane)
	want, err := wantOf(d.Questions[0], []string{"Plum"}, "")
	if err != nil {
		t.Fatalf("wantOf: %v", err)
	}
	// Up from the cursor's row to Apple to clear it, then down to Plum.
	got := flatToggles(planToggles(d.Questions[0], answerRows(answerRegion(pane)), want))
	if !sameKeys(got, [][]string{{"Up"}, {"Space"}, {"Down", "Down"}, {"Space"}}) {
		t.Errorf("batches = %v, want the old pick cleared and Plum toggled on", got)
	}
}

// A set the question already holds types nothing at all.
//
// Space is a toggle, so a Space on a ticked row CLEARS it. The plan that
// pressed one per named row regardless deleted the pick the reader was keeping.
func TestPlanTogglesLeavesAPickItIsAskedForAgainAlone(t *testing.T) {
	pane := strings.Replace(fixture(t, "dialog-multi.txt"),
		"  2. [ ] Pear", "❯ 2. [✔] Pear", 1)
	pane = strings.Replace(pane, "❯ 1. [ ] Apple", "  1. [ ] Apple", 1)
	if !strings.Contains(pane, "❯ 2. [✔] Pear") {
		t.Fatal("the fixture's option rows have moved; this test edits them by hand")
	}
	d := ParseDialog(pane)
	want, err := wantOf(d.Questions[0], []string{"Pear"}, "")
	if err != nil {
		t.Fatalf("wantOf: %v", err)
	}
	if got := planToggles(d.Questions[0], answerRows(answerRegion(pane)), want); len(got) != 0 {
		t.Errorf("steps = %+v, want none: the question already holds Pear alone", got)
	}
}

// Space is never planned on the CLI's own rows. On a multi-select the
// free-text row is an inline field where Space TYPES a space (measured on
// 2.1.280, 2026-09-23), so a toggle there would edit the reader's text. That
// row is freeTextNext's to change, with Backspace or Enter.
func TestPlanTogglesNeverPressesSpaceOnTheCLIsOwnRows(t *testing.T) {
	pane := fixture(t, "dialog-multiselect-typed.txt")
	d, region := ParseDialog(pane), answerRegion(pane)
	rows := answerRows(region)
	for _, choices := range [][]string{{"Apple", "Pear"}, {"Plum"}, nil} {
		want, err := wantOf(d.Questions[0], choices, "")
		if err != nil {
			t.Fatalf("wantOf: %v", err)
		}
		for _, step := range planToggles(d.Questions[0], rows, want) {
			if r := rows[step.row]; r.free || r.commit || !offers(d.Questions[0], r.label) {
				t.Errorf("%v: a Space was planned on %+v", choices, r)
			}
		}
	}
}

// One batch never exceeds what the keys route accepts. MaxKeys is the cap that
// stops a browser typing a paragraph into somebody's shell, and a long walk is
// no reason to widen it.
func TestPlanTogglesChunksToMaxKeys(t *testing.T) {
	pane := manyOptionDialog(12, true)
	d, region := ParseDialog(pane), answerRegion(pane)
	if d == nil {
		t.Fatalf("the synthetic dialog did not parse:\n%s", pane)
	}
	want, err := wantOf(d.Questions[0], []string{"Option 11"}, "")
	if err != nil {
		t.Fatalf("wantOf: %v", err)
	}
	var keys int
	for _, b := range flatToggles(planToggles(d.Questions[0], answerRows(region), want)) {
		if len(b) > MaxKeys {
			t.Errorf("a batch of %d keys exceeds the %d allowed: %v", len(b), MaxKeys, b)
		}
		keys += len(b)
	}
	// Ten Downs from row one to row eleven, and the Space.
	if keys != 11 {
		t.Errorf("%d keys in total, want 11", keys)
	}
}

// An option the drawn question does not offer is refused before anything is
// typed, and so is the chat row, which abandons the question rather than
// answering it.
func TestPlanChoiceRefusesWhatTheQuestionDoesNotOffer(t *testing.T) {
	pane := fixture(t, "dialog-multi-second.txt")
	d, region := ParseDialog(pane), answerRegion(pane)
	for _, tc := range []struct{ name, choice, text string }{
		{"an option from another question", "Pear", ""},
		{"the chat escape is not an answer", "Chat about this", ""},
		{"nothing at all", "", ""},
		{"free text with nothing to type", "Type something", "   "},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := planChoice(d, region, []string{tc.choice}, tc.text); err == nil {
				t.Errorf("planChoice accepted %q", tc.choice)
			}
		})
	}
}

// The review screen is recognised inside the dialog's own region. A
// conversation that quotes the wording — this document does, and so does any
// session that has discussed the feature — must not turn the question on
// screen into a Submit.
func TestReviewOnScreenIsScopedToTheDialog(t *testing.T) {
	if !reviewOnScreen(answerRegion(fixture(t, "dialog-multi-review.txt"))) {
		t.Error("the review capture was not recognised")
	}
	if reviewOnScreen(answerRegion(fixture(t, "dialog-multi.txt"))) {
		t.Error("a question was read as the review screen")
	}
	quoted := strings.Replace(fixture(t, "dialog-multi.txt"),
		"● You picked Blue for the badge colour.", "Review your answers", 1)
	if !strings.Contains(quoted, "Review your answers") {
		t.Fatal("the fixture has moved; this test edits it by hand")
	}
	if reviewOnScreen(answerRegion(quoted)) {
		t.Error("the review title was matched from the conversation above the dialog")
	}
}

// How far back a chip is. ← only goes backwards; a later question is reached
// by answering the ones before it.
func TestLeftPresses(t *testing.T) {
	headers := []string{"Order", "Done means", "Levers", "Crowdsec"}
	for _, tc := range []struct {
		name   string
		from   int
		to     string
		want   int
		wantOK bool
	}{
		{"three back", 3, "Order", 3, true},
		{"one back", 2, "Done means", 1, true},
		{"already there", 2, "Levers", 0, true},
		{"from the review screen, which sits past the last question", 4, "Crowdsec", 1, true},
		{"forwards is not a ← walk", 1, "Crowdsec", 0, false},
		{"not in this call", 2, "Fruit", 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			n, ok := leftPresses(headers, tc.from, tc.to)
			if n != tc.want || ok != tc.wantOK {
				t.Errorf("leftPresses = %d, %v; want %d, %v", n, ok, tc.want, tc.wantOK)
			}
		})
	}
}

// sameKeys compares two key plans.
func sameKeys(got, want [][]string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if len(got[i]) != len(want[i]) {
			return false
		}
		for j := range got[i] {
			if got[i][j] != want[i][j] {
				return false
			}
		}
	}
	return true
}

// Only 1-9 are keys: answerKeys carries no other digits, because that
// allowlist is the whole security boundary of the keys route. A tenth option
// is reached the only other way the allowlist leaves, which is to walk to it.
func TestPlanChoiceWalksPastTheNinthOption(t *testing.T) {
	pane := manyOptionDialog(12, false)
	d, region := ParseDialog(pane), answerRegion(pane)
	if d == nil {
		t.Fatalf("the synthetic dialog did not parse:\n%s", pane)
	}
	if d.Questions[0].MultiSelect {
		t.Fatal("this case is about a single-select list")
	}
	ninth, err := planChoice(d, region, []string{"Option 9"}, "")
	if err != nil {
		t.Fatalf("planChoice: %v", err)
	}
	if !sameKeys(ninth.Batches, [][]string{{"9"}}) {
		t.Errorf("batches = %v, want the digit", ninth.Batches)
	}
	tenth, err := planChoice(d, region, []string{"Option 10"}, "")
	if err != nil {
		t.Fatalf("planChoice: %v", err)
	}
	var keys []string
	for _, b := range tenth.Batches {
		if len(b) > MaxKeys {
			t.Errorf("a batch of %d keys exceeds the %d allowed", len(b), MaxKeys)
		}
		keys = append(keys, b...)
	}
	if len(keys) != 10 || keys[len(keys)-1] != "Enter" || keys[0] != "Down" {
		t.Errorf("keys = %v, want nine Downs and an Enter", keys)
	}
}

// manyOptionDialog draws a dialog with n options, for the chunking bound. The
// captures next door are all four rows or fewer, because a model writing a
// question rarely offers more; the cap has to hold when one does.
//
// The multi-select variant is drawn the way CLI 2.1.280 draws one: a boxed
// free-text row, the unnumbered commit row under it, and the separator over
// the chat row.
func manyOptionDialog(n int, multi bool) string {
	var b strings.Builder
	b.WriteString("● Some conversation above the dialog.\n\n ☐ Picks\n\nPick one\n\n")
	box := ""
	if multi {
		box = "[ ] "
	}
	for i := 1; i <= n; i++ {
		cursor := " "
		if i == 1 {
			cursor = "❯"
		}
		b.WriteString(cursor + " " + itoa(i) + ". " + box + "Option " + itoa(i) + "\n")
	}
	if multi {
		b.WriteString("  " + itoa(n+1) + ". [ ] Type something\n")
		b.WriteString("     Submit\n")
	} else {
		b.WriteString("  " + itoa(n+1) + ". Type something.\n")
	}
	b.WriteString(strings.Repeat("─", 40) + "\n")
	b.WriteString("  " + itoa(n+2) + ". Chat about this\n\n")
	b.WriteString("Enter to select · ↑/↓ to navigate · Esc to cancel\n")
	return b.String()
}

func itoa(n int) string {
	if n < 10 {
		return string(rune('0' + n))
	}
	return itoa(n/10) + string(rune('0'+n%10))
}

// A row that already carries a pick is still that option. Measured 2026-09-10:
// a question revisited with ← draws its earlier answer as "2. Pear ✔", and
// without trimming that tick the option a reader is most likely to be looking
// at — the one they chose last time — is the one they cannot choose again.
func TestPlanChoiceFindsARowThatAlreadyCarriesATick(t *testing.T) {
	pane := strings.Replace(fixture(t, "dialog-multi-second.txt"), "  2. Coffee", "  2. Coffee ✔", 1)
	if !strings.Contains(pane, "2. Coffee ✔") {
		t.Fatal("the fixture's option rows have moved; this test edits them by hand")
	}
	d, region := ParseDialog(pane), answerRegion(pane)
	if d == nil {
		t.Fatal("the revisited capture did not parse")
	}
	plan, err := planChoice(d, region, []string{"Coffee"}, "")
	if err != nil {
		t.Fatalf("planChoice on a row that is already ticked: %v", err)
	}
	if !sameKeys(plan.Batches, [][]string{{"2"}}) {
		t.Errorf("batches = %v, want the digit of the ticked row", plan.Batches)
	}
}

// Live CLI 2.1.267 draws BOTH wordings on the review screen (measured
// 2026-09-10); the capture in testdata, taken on 2.1.250, carries only the
// second. Either one is the screen, so a restyle that drops one does not take
// Submit with it.
func TestReviewOnScreenTakesEitherWording(t *testing.T) {
	tabs := "←  ☒ Fruit  ☒ Drink  ✔ Submit  →"
	footer := "Enter to select · Tab/Arrow keys to navigate · Esc to cancel"
	for _, title := range []string{"Review your answers", "Ready to submit your answers?"} {
		region := []string{tabs, "", title, "", "❯ 1. Submit answers", "  2. Cancel", "", footer}
		if !reviewOnScreen(region) {
			t.Errorf("%q was not read as the review screen", title)
		}
	}
	// The CLI draws its tab bar over every review screen, a one-question
	// call's included (2.1.280, 2026-09-23), so a title with no tab bar over
	// it is prose rather than a Submit.
	if reviewOnScreen([]string{"Review your answers", "❯ 1. Submit answers", "  2. Cancel"}) {
		t.Error("a review title with no tab bar was read as the review screen")
	}
}

// toggledRows replays toggle batches against the rows the pane drew and
// reports the labels a Space landed on.
//
// A key list that looks right is not the claim worth pinning here. Space
// toggles whatever row the cursor is on at the moment it is pressed, so "this
// plan does not untick Apple" is a fact about the WALK, and the only honest
// way to read it is to walk it.
func toggledRows(t *testing.T, rows []answerRow, batches [][]string) []string {
	t.Helper()
	at := focusedRow(rows)
	var hit []string
	for _, batch := range batches {
		for _, key := range batch {
			switch key {
			case "Down":
				at++
			case "Up":
				at--
			case "Space":
				if at < 0 || at >= len(rows) {
					t.Fatalf("the plan pressed Space on row %d, which the pane does not draw", at)
				}
				hit = append(hit, rows[at].label)
			}
		}
	}
	return hit
}

// TWO PICKS ON ONE QUESTION, which is the whole reason a request carries a SET
// of choices rather than one label.
//
// Measured 2026-09-11 on this exact pane, Apple ticked and the cursor on
// Apple's row, the reader tapping Pear: a request naming Pear alone plans
// [Space Down Space], and that first Space is on Apple. The set {Apple, Pear}
// leaves Apple exactly as it is and toggles Pear alone, which is what a card
// sends when a click adds a pick.
func TestPlanTogglesAddsToAPickAlreadyOnScreen(t *testing.T) {
	pane := strings.Replace(fixture(t, "dialog-multi.txt"),
		"❯ 1. [ ] Apple", "❯ 1. [✔] Apple", 1)
	if !strings.Contains(pane, "❯ 1. [✔] Apple") {
		t.Fatal("the fixture's option rows have moved; this test edits them by hand")
	}
	d, region := ParseDialog(pane), answerRegion(pane)
	if d == nil {
		t.Fatal("a multi-select with a pick on it did not parse")
	}
	rows := answerRows(region)

	add, err := wantOf(d.Questions[0], []string{"Apple", "Pear"}, "")
	if err != nil {
		t.Fatalf("wantOf: %v", err)
	}
	got := flatToggles(planToggles(d.Questions[0], rows, add))
	if !sameKeys(got, [][]string{{"Down"}, {"Space"}}) {
		t.Errorf("batches = %v, want Pear toggled on and Apple left alone", got)
	}
	if hit := strings.Join(toggledRows(t, rows, got), ","); hit != "Pear" {
		t.Errorf("the plan toggled %q, want Pear alone: a Space on Apple's row unticks the pick being added to", hit)
	}

	// The mirror: {Pear} on its own is "Pear and nothing else", so Apple IS
	// cleared on the way past. The difference is the request, not the planner.
	only, err := wantOf(d.Questions[0], []string{"Pear"}, "")
	if err != nil {
		t.Fatalf("wantOf: %v", err)
	}
	if hit := strings.Join(toggledRows(t, rows, flatToggles(planToggles(d.Questions[0], rows, only))), ","); hit != "Apple,Pear" {
		t.Errorf("the plan toggled %q, want Apple cleared and Pear set", hit)
	}
}

// The set the driver plans from, out of a request that may spell it either
// way.
//
// Choice is the shorthand for a one-element set and stays supported: every
// single-select client sends it, and so does this package's own test suite. A
// request that fills in BOTH and means two different things is refused rather
// than resolved — there is no reading of it that is not a guess, and guessing
// here types keys into somebody's session.
func TestRequestChoicesReadsBothSpellings(t *testing.T) {
	for _, tc := range []struct {
		name string
		req  AnswerRequest
		want string
	}{
		{"one label", AnswerRequest{Choice: "Apple"}, "Apple"},
		{"a set", AnswerRequest{Choices: []string{"Apple", "Pear"}}, "Apple,Pear"},
		{"a set of one", AnswerRequest{Choices: []string{"Apple"}}, "Apple"},
		{"both, agreeing", AnswerRequest{Choice: "Apple", Choices: []string{"Apple"}}, "Apple"},
		// The CLI draws the free-text row as "Type something." in a
		// single-question dialog and "Type something" in a multi-select one,
		// so the two spellings of one row must not read as a contradiction.
		{"both, agreeing past the CLI's own decoration",
			AnswerRequest{Choice: "Type something.", Choices: []string{"Type something"}}, "Type something"},
		{"nothing at all", AnswerRequest{}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := requestChoices(tc.req)
			if err != nil {
				t.Fatalf("requestChoices: %v", err)
			}
			if strings.Join(got, ",") != tc.want {
				t.Errorf("choices = %q, want %q", got, tc.want)
			}
		})
	}
	for _, tc := range []struct {
		name string
		req  AnswerRequest
	}{
		{"two different labels", AnswerRequest{Choice: "Apple", Choices: []string{"Pear"}}},
		{"a set the shorthand is only part of", AnswerRequest{Choice: "Apple", Choices: []string{"Apple", "Pear"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := requestChoices(tc.req); err == nil {
				t.Errorf("requestChoices accepted a request that says two things: %+v", tc.req)
			}
		})
	}
}

// The rows a multi-select draws, in the order the cursor walks them: the
// question's options, the free-text row, the unnumbered commit row, and the
// chat row. The commit row goes in the list because walks are counted in rows
// the cursor stops on, and it is one; leaving it out put every walk to the
// chat row one short.
func TestAnswerRowsCarryTheCommitRowWhereTheCursorStops(t *testing.T) {
	rows := answerRows(answerRegion(fixture(t, "dialog-multiselect-on-commit.txt")))
	var labels []string
	for _, r := range rows {
		labels = append(labels, r.label)
	}
	if got := strings.Join(labels, "|"); got != "Apple|Pear|Plum|Type something|Submit|Chat about this" {
		t.Fatalf("rows = %s", got)
	}
	if !rows[3].free || !rows[4].commit || rows[4].digit != 0 {
		t.Errorf("free=%v commit=%v digit=%d, want the free-text row and a commit row with no digit",
			rows[3].free, rows[4].commit, rows[4].digit)
	}
	if at := focusedRow(rows); at != 4 {
		t.Errorf("focusedRow = %d, want 4: the cursor is on the commit row", at)
	}
	// A commit row labelled like an option is still not that option.
	if rowIndex(rows, "Submit") >= 0 {
		t.Error("rowIndex found the commit row as if it were an option")
	}
}

// What the free-text row holds, as the planner reads it. The whitespace case
// is the one the wire cannot say: Space on the row types a space the capture
// trims, so the row reads "[✔]" and Typed comes back empty, and yet a
// Backspace is still what it takes to clear it.
func TestAnswerRowsReadTheFreeTextField(t *testing.T) {
	for _, tc := range []struct {
		fixture   string
		holdsText bool
		text      string
		checked   bool
	}{
		{"dialog-multiselect-one.txt", false, "", false},
		{"dialog-multiselect-typed.txt", true, "Mango", true},
		{"dialog-multiselect-typed-unticked.txt", true, "Mango", false},
		{"dialog-multiselect-empty-ticked.txt", false, "", true},
		{"dialog-multiselect-space-typed.txt", true, "", true},
	} {
		t.Run(tc.fixture, func(t *testing.T) {
			rows := answerRows(answerRegion(fixture(t, tc.fixture)))
			at := freeIndex(rows)
			if at < 0 {
				t.Fatal("no free-text row found")
			}
			r := rows[at]
			if r.holdsText != tc.holdsText || r.text != tc.text || r.checked != tc.checked {
				t.Errorf("holdsText=%v text=%q checked=%v, want %v %q %v",
					r.holdsText, r.text, r.checked, tc.holdsText, tc.text, tc.checked)
			}
		})
	}
}

// Leaving a multi-select is a walk to its commit row. The Enter is not part of
// the plan: the driver presses it in a batch of its own, and only once a
// reading shows the cursor on that row, because Enter anywhere else is a
// toggle, and on the chat row it abandons the question.
func TestPlanCommitWalksToTheCommitRow(t *testing.T) {
	for _, tc := range []struct {
		name string
		pane string
		want [][]string
	}{
		{"from the first option", fixture(t, "dialog-multiselect-one.txt"), [][]string{{"Down", "Down", "Down", "Down"}}},
		{"from the free-text row", fixture(t, "dialog-multiselect-typed.txt"), [][]string{{"Down"}}},
		{"already on it", fixture(t, "dialog-multiselect-on-commit.txt"), nil},
		{"the 2.1.250 Next row", fixture(t, "dialog-multi.txt"), [][]string{{"Down", "Down", "Down", "Down"}}},
		// Thirteen rows down, cut to what the keys route takes in one run.
		{"a long list", manyOptionDialog(12, true), [][]string{
			{"Down", "Down", "Down", "Down", "Down", "Down", "Down", "Down"},
			{"Down", "Down", "Down", "Down", "Down"},
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			walk, err := planCommit(answerRows(answerRegion(tc.pane)))
			if err != nil {
				t.Fatalf("planCommit: %v", err)
			}
			if !sameKeys(walk, tc.want) {
				t.Errorf("walk = %v, want %v", walk, tc.want)
			}
			for _, b := range walk {
				for _, k := range b {
					if k != "Down" && k != "Up" {
						t.Errorf("the walk pressed %q; only the driver presses the Enter", k)
					}
				}
			}
		})
	}
	// A single-select has no commit row to walk to, and guessing where one
	// might be would press Enter on whatever sits there.
	if _, err := planCommit(answerRows(answerRegion(fixture(t, "dialog-single.txt")))); err == nil {
		t.Error("planCommit found a commit row on a single-select")
	}
}

// The next thing the free-text row needs, read off one capture. The row is an
// inline field on a multi-select (measured on 2.1.280, 2026-09-23): typing goes
// in and ticks it, Backspace to empty clears it and its box, and Enter flips
// the box and keeps the text. Space is not in here at all: on that row it
// types a space.
func TestFreeTextNextReadsTheRowAgainstTheRequest(t *testing.T) {
	none := multiWant{}
	mango := multiWant{free: true, text: "Mango"}
	kiwi := multiWant{free: true, text: "Kiwi"}
	for _, tc := range []struct {
		fixture string
		want    multiWant
		act     freeAction
	}{
		{"dialog-multiselect-one.txt", none, freeNone},
		// Ticked with nothing typed, which the CLI drops at commit. Enter
		// clears the box, so the pane shows what the card does.
		{"dialog-multiselect-empty-ticked.txt", none, freeToggle},
		{"dialog-multiselect-typed.txt", none, freeClear},
		{"dialog-multiselect-typed-unticked.txt", none, freeClear},
		{"dialog-multiselect-space-typed.txt", none, freeClear},
		{"dialog-multiselect-one.txt", mango, freeType},
		{"dialog-multiselect-empty-ticked.txt", mango, freeType},
		{"dialog-multiselect-typed.txt", mango, freeNone},
		{"dialog-multiselect-typed-unticked.txt", mango, freeToggle},
		{"dialog-multiselect-typed.txt", kiwi, freeClear},
		{"dialog-multiselect-space-typed.txt", mango, freeClear},
	} {
		t.Run(tc.fixture+"/"+tc.want.text, func(t *testing.T) {
			rows := answerRows(answerRegion(fixture(t, tc.fixture)))
			if got := freeTextNext(rows[freeIndex(rows)], tc.want); got != tc.act {
				t.Errorf("freeTextNext = %v, want %v", got, tc.act)
			}
		})
	}
}

// Whether a reading shows the question the way a request asked. This is the
// whole of the verification for a toggle: the tab bar and the drawn question
// do not change when a second pick is added, so the three signals a commit is
// checked against would all say nothing happened.
func TestRowsHoldTheRequestedState(t *testing.T) {
	for _, tc := range []struct {
		fixture string
		want    multiWant
		holds   bool
	}{
		{"dialog-multiselect-one.txt", multiWant{}, true},
		{"dialog-multiselect-one.txt", multiWant{labels: []string{"Apple"}}, false},
		{"dialog-multiselect-on-commit.txt", multiWant{labels: []string{"Apple", "Pear"}}, true},
		{"dialog-multiselect-on-commit.txt", multiWant{labels: []string{"Pear", "Apple"}}, true},
		{"dialog-multiselect-on-commit.txt", multiWant{labels: []string{"Apple"}}, false},
		{"dialog-multiselect-typed.txt", multiWant{labels: []string{"Apple", "Pear"}, free: true, text: "Mango"}, true},
		// The text on the row is a pick the request left out.
		{"dialog-multiselect-typed.txt", multiWant{labels: []string{"Apple", "Pear"}}, false},
		{"dialog-multiselect-typed.txt", multiWant{labels: []string{"Apple", "Pear"}, free: true, text: "Kiwi"}, false},
		// The words are right and the box is not.
		{"dialog-multiselect-typed-unticked.txt", multiWant{labels: []string{"Apple", "Pear"}, free: true, text: "Mango"}, false},
		{"dialog-multiselect-empty-ticked.txt", multiWant{labels: []string{"Apple"}}, false},
	} {
		t.Run(tc.fixture, func(t *testing.T) {
			pane := fixture(t, tc.fixture)
			d := ParseDialog(pane)
			if got := rowsHold(d.Questions[0], answerRows(answerRegion(pane)), tc.want); got != tc.holds {
				t.Errorf("rowsHold(%+v) = %v, want %v", tc.want, got, tc.holds)
			}
		})
	}
}

// The desired state out of a request, refused before a key is typed when it
// cannot be met.
func TestWantOfReadsTheSetARequestAsksFor(t *testing.T) {
	q := ParseDialog(fixture(t, "dialog-multiselect-one.txt")).Questions[0]
	for _, tc := range []struct {
		name    string
		choices []string
		text    string
		want    multiWant
	}{
		{"options", []string{"Pear", "Apple"}, "", multiWant{labels: []string{"Pear", "Apple"}}},
		{"a label named twice counts once", []string{"Pear", "Pear"}, "", multiWant{labels: []string{"Pear"}}},
		{"nothing, which a toggle may ask for", nil, "", multiWant{}},
		{"free text is one more pick", []string{"Apple", "Type something"}, "  Mango ", multiWant{labels: []string{"Apple"}, free: true, text: "Mango"}},
		{"the legacy label means the same row", []string{"Other"}, "Mango", multiWant{free: true, text: "Mango"}},
		// Text with no free-text pick is not a pick, and types nothing.
		{"text without the row", []string{"Apple"}, "Mango", multiWant{labels: []string{"Apple"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := wantOf(q, tc.choices, tc.text)
			if err != nil {
				t.Fatalf("wantOf: %v", err)
			}
			if strings.Join(got.labels, ",") != strings.Join(tc.want.labels, ",") ||
				got.free != tc.want.free || got.text != tc.want.text {
				t.Errorf("wantOf = %+v, want %+v", got, tc.want)
			}
		})
	}
	for _, tc := range []struct {
		name    string
		choices []string
		text    string
		err     error
	}{
		{"an option from another question", []string{"Tea"}, "", errUnknownOption},
		{"the chat row, which abandons the question", []string{"Chat about this"}, "", errUnknownOption},
		{"an empty label", []string{""}, "", errUnknownOption},
		{"the free-text row with nothing to type", []string{"Type something"}, "   ", errNoText},
		{"text that would submit the field halfway", []string{"Type something"}, "one\ntwo", errBadText},
		{"text longer than any answer", []string{"Type something"}, strings.Repeat("x", MaxAnswerText+1), errBadText},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := wantOf(q, tc.choices, tc.text); err != tc.err {
				t.Errorf("wantOf error = %v, want %v", err, tc.err)
			}
		})
	}
}

// Whether the text a row shows is the text a request asked for. The capture
// trims and collapses whitespace, and a field narrower than the text may wrap
// or cut it, so an exact string compare would call a landed answer missing.
// None of the wrapping is measured yet; the rules are the loosest ones that
// cannot accept different words.
func TestTypedMatchesWhatTheRowShows(t *testing.T) {
	for _, tc := range []struct {
		shown, want string
		match       bool
	}{
		{"Mango", "Mango", true},
		{"Mango", "  Mango ", true},
		{"Kiwi  fruit", "Kiwi fruit", true},
		// A word the terminal broke across two lines, joined back with a space.
		{"passion fru it", "passion fruit", true},
		// Cut short with the CLI's ellipsis: enough of it to be evidence.
		{"a long answer that ran o…", "a long answer that ran off the edge of the pane", true},
		{"Mango", "Mangosteen", false},
		{"mango", "Mango", false},
		{"", "Mango", false},
		{"Ma…", "Mango", false},
	} {
		if got := typedMatches(tc.shown, tc.want); got != tc.match {
			t.Errorf("typedMatches(%q, %q) = %v, want %v", tc.shown, tc.want, got, tc.match)
		}
	}
}
