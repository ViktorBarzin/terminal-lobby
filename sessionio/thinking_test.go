package sessionio

import "testing"

// A thinking block whose text is empty renders as a bare "Thought" label with
// nothing behind it — a column of them, floating in the transcript (Viktor,
// 2026-08-18, with a screenshot of six in a row).
//
// They are not an edge case: across 60 transcripts on this box, 4,602 of 4,602
// thinking blocks carry an empty `thinking` and only a `signature`. The
// reasoning itself is never written to the transcript, so every one of those
// rows had nothing to show and never would.
func TestEmptyThinkingIsNotARow(t *testing.T) {
	// The real shape, signature and all.
	line := `{"type":"assistant","message":{"role":"assistant","content":[` +
		`{"type":"thinking","thinking":"","signature":"EsorCokBCBAYAipAkz5a2NhehNZOYAy8"},` +
		`{"type":"text","text":"on it"}]},"timestamp":"2026-08-18T09:00:00.000Z"}`
	evs := (&Normalizer{}).Line([]byte(line))
	for _, e := range evs {
		if e.Kind == KindThinking {
			t.Fatalf("an empty thought became a row: %+v", evs)
		}
	}
	// The assistant's actual answer still comes through.
	if len(evs) != 1 || evs[0].Kind != KindText || evs[0].Body != "on it" {
		t.Fatalf("got %+v", evs)
	}
}

// Whitespace is not content either.
func TestWhitespaceOnlyThinkingIsNotARow(t *testing.T) {
	line := `{"type":"assistant","message":{"role":"assistant","content":[` +
		`{"type":"thinking","thinking":"   \n  "}]},"timestamp":"2026-08-18T09:00:00.000Z"}`
	if evs := (&Normalizer{}).Line([]byte(line)); len(evs) != 0 {
		t.Fatalf("got %+v, want none", evs)
	}
}

// If a future CLI does persist the reasoning, it renders — the test is on the
// TEXT, not on the block being absent.
func TestThinkingWithTextStillRenders(t *testing.T) {
	line := `{"type":"assistant","message":{"role":"assistant","content":[` +
		`{"type":"thinking","thinking":"weighing two options"}]},"timestamp":"2026-08-18T09:00:00.000Z"}`
	evs := (&Normalizer{}).Line([]byte(line))
	if len(evs) != 1 || evs[0].Kind != KindThinking || evs[0].Body != "weighing two options" {
		t.Fatalf("got %+v", evs)
	}
}
