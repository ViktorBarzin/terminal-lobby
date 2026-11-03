package sessionio

import (
	"encoding/json"
	"testing"
)

// A person's prompt is one typed in the terminal, which carries no origin, or
// one sent from the lobby, a slash command included. A background task's
// notification is the harness talking to itself.
func TestPersonOrigin(t *testing.T) {
	for origin, want := range map[string]bool{
		``: true,
		`{"kind":"plugin","name":"terminal-lobby","asUser":true}`: true,
		`{"kind":"plugin","name":"terminal-lobby"}`:               true,
		`{"kind":"task-notification","producer":"session-task"}`:  false,
		`{"kind":"plugin","name":"someone-else"}`:                 false,
		`{"kind":"auto-continuation"}`:                            false,
		`not json`:                                                false,
	} {
		if got := PersonOrigin(json.RawMessage(origin)); got != want {
			t.Errorf("PersonOrigin(%s) = %v, want %v", origin, got, want)
		}
	}
}

// The newest main-thread prompt with a time, which is what a rebuilt log can
// say about when the person last wrote.
func TestLastPromptAt(t *testing.T) {
	p := writeModTranscript(t,
		tPrompt("u1", "first"), tReply("a1", "m1", "one", "end_turn"),
		tPrompt("u2", "second"), tReply("a2", "m2", "two", "end_turn"),
	)
	fs := NewModSource("s", p, nil)
	if got := fs.LastPromptAt(); got != 0 {
		t.Fatalf("an empty log says %d", got)
	}
	if err := fs.ReplayTranscript("a2", false, 0); err != nil {
		t.Fatal(err)
	}
	if got, want := fs.LastPromptAt(), parseAt("2026-10-05T10:00:00Z"); got != want || got == 0 {
		t.Fatalf("LastPromptAt = %d, want %d", got, want)
	}
	// A log rebuilt from the mod's history has no times, so it says nothing.
	h := NewModSource("s", "", nil)
	h.FeedHistory([]ModHistoryMessage{{Role: "user", Text: "hi"}, {Role: "assistant", Text: "hello"}}, false)
	if got := h.LastPromptAt(); got != 0 {
		t.Fatalf("an untimed history says %d", got)
	}
}
