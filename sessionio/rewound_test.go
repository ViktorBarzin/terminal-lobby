package sessionio

import "testing"

// A Stop that lands before Claude has written anything for the turn takes the
// prompt OUT of the conversation: Claude Code puts it back on its input line
// and its own view shows no trace of it. The transcript keeps the prompt's
// record, so read naively the prompt stays in the chat as sent, and whatever
// starts the next turn (a task notification, the next prompt) reads as its
// answer. Found in the live check of the T3 pass on 2026-09-28.

func promptLine(text, ts string) []byte {
	return []byte(`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"` + text + `"}]},"timestamp":"` + ts + `"}`)
}

func rewoundOf(evs []Event) []Event {
	var out []Event
	for _, e := range evs {
		if e.Kind == KindMeta && e.Meta == MetaRewound {
			out = append(out, e)
		}
	}
	return out
}

// The next prompt arriving with nothing from Claude in between says the one
// before it was taken back. Measured on CLI 2.1.283: no assistant record and
// no interrupt notice separate the two.
func TestNormalizerPromptFollowedByAPromptWasRewound(t *testing.T) {
	n := NewNormalizer("demo")
	first := n.Line(promptLine("Write a long story, take 1500.", "2026-09-28T02:29:22Z"))
	next := n.Line(promptLine("Write a long story, take 2500.", "2026-09-28T02:29:29Z"))
	got := rewoundOf(next)
	if len(got) != 1 {
		t.Fatalf("next prompt produced %v, want one rewound marker before it", kinds(next))
	}
	if got[0].TurnID != first[0].TurnID {
		t.Fatalf("rewound names turn %q, want the taken-back prompt's %q", got[0].TurnID, first[0].TurnID)
	}
	if got[0].Body != "Write a long story, take 1500." {
		t.Fatalf("rewound body = %q, want the taken-back prompt's text", got[0].Body)
	}
	if next[0].Kind != KindMeta || next[len(next)-1].Kind != KindUser {
		t.Fatalf("order = %v, want the marker (and the old turn's end) before the new prompt", kinds(next))
	}
	if next[len(next)-1].TurnID == first[0].TurnID {
		t.Fatal("the new prompt landed in the taken-back prompt's turn")
	}
}

// The turn the taken-back prompt opened is closed with it, or a replay that
// never saw the interrupt leaves it open.
func TestNormalizerRewoundPromptClosesItsTurn(t *testing.T) {
	n := NewNormalizer("demo")
	first := n.Line(promptLine("Write a 300 word essay about kiwis.", "2026-09-28T02:20:37Z"))
	next := n.Line([]byte(`{"type":"user","message":{"role":"user","content":"<task-notification>\n<summary>Background command \"sleep 5\" completed (exit code 0)</summary>\n</task-notification>"},"timestamp":"2026-09-28T02:20:43Z"}`))
	if len(rewoundOf(next)) != 1 {
		t.Fatalf("a task notification after an unanswered prompt produced %v, want a rewound marker", kinds(next))
	}
	ended := false
	for _, e := range next {
		if e.Kind == KindTurnEnd && e.TurnID == first[0].TurnID {
			ended = true
		}
	}
	if !ended {
		t.Fatalf("events %v leave the taken-back prompt's turn open", kinds(next))
	}
}

// A prompt Claude answered, even with thinking alone, is part of the
// conversation, and so is one stopped with the CLI's own notice.
func TestNormalizerAnsweredPromptIsNotRewound(t *testing.T) {
	cases := map[string][]string{
		"answered": {
			`{"type":"assistant","message":{"id":"m1","role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"ok"}]},"timestamp":"2026-09-28T02:00:01Z"}`,
		},
		"thinking only": {
			`{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"thinking","thinking":"","signature":"x"}]},"timestamp":"2026-09-28T02:00:01Z"}`,
		},
		"interrupt notice": {
			`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]},"timestamp":"2026-09-28T02:00:01Z"}`,
		},
	}
	for name, between := range cases {
		t.Run(name, func(t *testing.T) {
			n := NewNormalizer("demo")
			var all []Event
			all = append(all, n.Line(promptLine("first", "2026-09-28T02:00:00Z"))...)
			for _, l := range between {
				all = append(all, n.Line([]byte(l))...)
			}
			all = append(all, n.Line(promptLine("second", "2026-09-28T02:00:05Z"))...)
			if got := rewoundOf(all); len(got) != 0 {
				t.Fatalf("got %+v, want no rewound marker", got)
			}
		})
	}
}

// A slash command the CLI answers itself never reaches Claude, and a `!`
// command's output follows its input as another user record. Neither was
// taken back.
func TestNormalizerCommandsAreNotRewound(t *testing.T) {
	n := NewNormalizer("demo")
	var all []Event
	all = append(all, n.Line([]byte(`{"type":"user","message":{"role":"user","content":"<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>"},"timestamp":"2026-09-28T02:00:00Z"}`))...)
	all = append(all, n.Line([]byte(`{"type":"user","message":{"role":"user","content":"<local-command-stdout>Set model to opus</local-command-stdout>"},"timestamp":"2026-09-28T02:00:01Z"}`))...)
	all = append(all, n.Line([]byte(`{"type":"user","message":{"role":"user","content":"<bash-input>ls</bash-input>"},"timestamp":"2026-09-28T02:00:02Z"}`))...)
	all = append(all, n.Line([]byte(`{"type":"user","message":{"role":"user","content":"<bash-stdout>a.txt</bash-stdout><bash-stderr></bash-stderr>"},"timestamp":"2026-09-28T02:00:03Z"}`))...)
	all = append(all, n.Line(promptLine("hello", "2026-09-28T02:00:04Z"))...)
	if got := rewoundOf(all); len(got) != 0 {
		t.Fatalf("got %+v, want no rewound marker", got)
	}
}

// The live path: the cancel route saw the prompt land back on the input line
// and says so, and the marker goes out now rather than when the next turn
// starts.
func TestNormalizerRewindMarksTheOpenPrompt(t *testing.T) {
	n := NewNormalizer("demo")
	first := n.Line(promptLine("Write a long story about a lighthouse keeper.", "2026-09-28T02:29:22Z"))
	n.Interrupt(mustAt(t, "2026-09-28T02:29:24Z"))
	out := n.Rewind("  Write a long story about a lighthouse keeper.\n", mustAt(t, "2026-09-28T02:29:24Z"))
	got := rewoundOf(out)
	if len(got) != 1 || got[0].TurnID != first[0].TurnID {
		t.Fatalf("Rewind produced %+v, want one marker for turn %q", out, first[0].TurnID)
	}
	if countKind(out, KindTurnEnd) != 0 {
		t.Fatalf("the interrupt already closed the turn; Rewind closed it again: %v", kinds(out))
	}
	// The next prompt does not take back the same one twice.
	if again := rewoundOf(n.Line(promptLine("next", "2026-09-28T02:29:30Z"))); len(again) != 0 {
		t.Fatalf("next prompt marked the same prompt again: %+v", again)
	}
}

// A different text is not the prompt that went back, and nothing is marked.
func TestNormalizerRewindIgnoresAnotherText(t *testing.T) {
	n := NewNormalizer("demo")
	n.Line(promptLine("one thing", "2026-09-28T02:29:22Z"))
	if out := n.Rewind("another thing", mustAt(t, "2026-09-28T02:29:24Z")); len(rewoundOf(out)) != 0 {
		t.Fatalf("Rewind marked a prompt with other words: %+v", out)
	}
}

// The tail reads the transcript on a tick, so the prompt's record can arrive
// after the cancel said it went back. It is marked as it lands.
func TestNormalizerRewindBeforeTheRecordMarksItOnArrival(t *testing.T) {
	n := NewNormalizer("demo")
	at := mustAt(t, "2026-09-28T02:29:24Z")
	n.Interrupt(at)
	if out := n.Rewind("say KIWI", at); len(out) != 0 {
		t.Fatalf("nothing recorded yet, Rewind produced %v", kinds(out))
	}
	out := n.Line(promptLine("say KIWI", "2026-09-28T02:29:23Z"))
	got := rewoundOf(out)
	if len(got) != 1 || got[0].TurnID != out[0].TurnID {
		t.Fatalf("late record produced %v, want its user event and a marker for its turn", kinds(out))
	}
	// A prompt sent after that is not caught by it.
	if later := rewoundOf(n.Line(promptLine("say KIWI", "2026-09-28T02:29:40Z"))); len(later) != 0 {
		t.Fatalf("a later prompt with the same words was marked: %+v", later)
	}
}
