package sessionio

import "testing"

// Two toggles must never share one send-keys run.
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
// The unit tests could not catch this. Their stand-in TUI reads its input as a
// stream and records every Space it sees, so a run the real widget drops reads
// as a run it accepted.
func TestMultiSelectPutsEachToggleInItsOwnBatch(t *testing.T) {
	pane := "←  ☒ Fruit  ☐ Picks  ☐ Drink  ☐ Size  ✔ Submit  →\n" +
		"\nPick any toppings\n\n" +
		"❯ 1. [ ] Nuts\n  2. [ ] Syrup\n  3. [ ] Cream\n" +
		"  4. [ ] Type something\n  5. Chat about this\n\n" +
		"Enter to select · Tab/Arrow keys to navigate · Esc to cancel\n"
	d := ParseDialog(pane)
	if d == nil {
		t.Fatal("fixture did not parse as a dialog")
	}
	plan, err := planChoice(d, answerRegion(pane), []string{"Nuts", "Cream"}, "")
	if err != nil {
		t.Fatalf("planChoice: %v", err)
	}
	for i, b := range plan.Batches {
		spaces := 0
		for _, k := range b {
			if k == "Space" {
				spaces++
			}
		}
		if spaces > 1 {
			t.Errorf("batch %d packs %d toggles into one send-keys: %v", i, spaces, b)
		}
	}
	last := plan.Batches[len(plan.Batches)-1]
	if len(last) != 1 || last[0] != "Enter" {
		t.Errorf("the commit should be a batch of its own, got %v", last)
	}
	// Both picks still have to be in there; separating them must not drop one.
	spaces := 0
	for _, b := range plan.Batches {
		for _, k := range b {
			if k == "Space" {
				spaces++
			}
		}
	}
	if spaces != 2 {
		t.Errorf("want one Space per pick, got %d across %v", spaces, plan.Batches)
	}
}
