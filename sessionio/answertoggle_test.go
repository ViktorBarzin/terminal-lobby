package sessionio

import "testing"

// Two toggles must never share one send-keys run, and a toggle never carries
// an Enter.
//
// Found in production, not in review. Driving a real four-question dialog on
// CLI 2.1.268 through the deployed route on 2026-09-11, asking for Nuts and
// Cream on a three-row multi-select planned [Space Down Down Space] as a single
// run. The pane came back `1. [✔] Nuts` and `3. [ ] Cream` with the cursor
// sitting on Cream: every key had been delivered, since the cursor moved two
// rows, and the second toggle still did not take. One batch per toggle puts the
// keySettle between the two Spaces, which is where the model picker on this
// same TUI has always put it (setmodel.go:173-183).
//
// The Enter is the second half. Until 2026-09-23 the plan ended with a walk to
// the commit row and an Enter there, so the first click on a multi-select
// option left the question. Viktor, that day: "multi answer questions now move
// on to the next step on the first selection and the user can't select more
// than one answer." A toggle now changes the boxes and nothing else; the commit
// is a request of its own (planCommit).
//
// The unit tests could not catch the first half. Their stand-in TUI read its
// input as a stream and recorded every Space it saw, so a run the real widget
// drops read as a run it accepted.
func TestMultiSelectPutsEachToggleInItsOwnBatch(t *testing.T) {
	pane := "←  ☒ Fruit  ☐ Picks  ☐ Drink  ☐ Size  ✔ Submit  →\n" +
		"\nPick any toppings\n\n" +
		"❯ 1. [ ] Nuts\n  2. [ ] Syrup\n  3. [ ] Cream\n" +
		"  4. [ ] Type something\n     Next\n" +
		"────────────────────────────────────────\n" +
		"  5. Chat about this\n\n" +
		"Enter to select · Tab/Arrow keys to navigate · Esc to cancel\n"
	d := ParseDialog(pane)
	if d == nil {
		t.Fatal("fixture did not parse as a dialog")
	}
	want, err := wantOf(d.Questions[0], []string{"Nuts", "Cream"}, "")
	if err != nil {
		t.Fatalf("wantOf: %v", err)
	}
	batches := flatToggles(planToggles(d.Questions[0], answerRows(answerRegion(pane)), want))
	spaces := 0
	for i, b := range batches {
		for _, k := range b {
			switch k {
			case "Space":
				spaces++
				if len(b) != 1 {
					t.Errorf("batch %d sends its Space alongside other keys: %v", i, b)
				}
			case "Enter":
				t.Errorf("batch %d presses Enter, which on a multi-select toggles a row or leaves the question: %v", i, b)
			}
		}
	}
	// Both picks still have to be in there; separating them must not drop one.
	if spaces != 2 {
		t.Errorf("want one Space per pick, got %d across %v", spaces, batches)
	}
}
