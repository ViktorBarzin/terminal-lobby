package sessionio

import "testing"

// Refreshing the context reading means running `/context` in somebody's pane,
// and Prompt clears the input line before it types. If the operator had a draft
// sitting there — the first pane sampled on this box did, an unsent
// "yes, check on the 26th and chase if it's not there" — a refresh nobody asked
// for would have eaten it.
//
// So the refresh asks first, and this is the question. It fails CLOSED: anything
// it does not positively recognise as an empty composer means "do not touch the
// pane", which costs a reading and never costs a draft.
func TestPaneComposerEmpty(t *testing.T) {
	const rule = "──────────────────────────────────────── x ──"

	for _, tc := range []struct {
		name string
		pane string
		want bool
	}{
		{
			// The REAL pane puts a non-breaking space after the marker, not an
			// ordinary one — read off a live session on 2026-08-18. A check that
			// only knew about U+0020 would read every idle composer as a draft and
			// quietly turn the refresh off for good.
			name: "an idle composer uses a non-breaking space",
			pane: rule + "\n\u276f\u00a0\n" + rule + "\n",
			want: true,
		},
		{
			name: "an idle composer is empty",
			pane: rule + "\n❯ \n" + rule + "\n  /home/wizard/code/infra | opus-5\n" +
				"  ⏵⏵ bypass permissions on (shift+tab to cycle)\n",
			want: true,
		},
		{
			name: "a draft is not empty",
			pane: rule + "\n❯ yes, check on the 26th and chase if it's not there\n" + rule + "\n",
			want: false,
		},
		{
			name: "a single typed character is not empty",
			pane: rule + "\n❯ y\n" + rule + "\n",
			want: false,
		},
		{
			// The conversation above the composer is full of lines; only the
			// LAST marker is the input line.
			name: "an earlier marker in the scrollback is not the composer",
			pane: "❯ an older prompt that was already sent\n" + rule + "\n❯ \n" + rule + "\n",
			want: true,
		},
		{
			name: "an earlier marker does not rescue a drafted composer",
			pane: "❯ \n" + rule + "\n❯ half a thought\n" + rule + "\n",
			want: false,
		},
		{
			// Fail closed: no marker at all means we do not understand this
			// screen, so we leave it alone.
			name: "no composer found",
			pane: "just some output\nand more of it\n",
			want: false,
		},
		{name: "empty capture", pane: "", want: false},
		{
			// A dialog is up — the composer is not even on screen. Injecting
			// here would answer somebody's question with "/context".
			name: "a blocking dialog is not an empty composer",
			pane: "Do you want to proceed?\n  1. Yes\n  2. No\n",
			want: false,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := PaneComposerEmpty(tc.pane); got != tc.want {
				t.Errorf("PaneComposerEmpty = %v, want %v", got, tc.want)
			}
		})
	}
}
