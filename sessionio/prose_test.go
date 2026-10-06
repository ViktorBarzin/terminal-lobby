package sessionio

import (
	"strings"
	"testing"
)

// Claude Code 2.1.290 refuses a prompt a mod submits when its first non-space
// character is a slash ("a text beginning with / would run a command as the
// user"). A prompt opening with a pasted image starts with the image's path,
// so it went nowhere (Viktor, 2026-10-06). The lobby puts a zero-width space
// in front, and takes it off again wherever it reads the prompt back.
func TestMarkProse(t *testing.T) {
	const img = "/var/lib/clipboard-store/wizard/s/pasted-1.png"
	for _, tc := range []struct{ name, in, want string }{
		{"a pasted image first", img + " what is this?", ProseMark + img + " what is this?"},
		{"leading whitespace goes", "\n  " + img, ProseMark + img},
		{"a path on its own", "/usr/bin/jq is missing", ProseMark + "/usr/bin/jq is missing"},
		{"a command stays a command", "/unslop", "/unslop"},
		{"a command with args stays", "/doc-tone docs/a.md", "/doc-tone docs/a.md"},
		{"a plugin command stays", "/frontend-design:frontend-design x", "/frontend-design:frontend-design x"},
		{"prose is untouched", "see " + img, "see " + img},
		{"already marked is untouched", ProseMark + img, ProseMark + img},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := MarkProse(tc.in)
			if got != tc.want {
				t.Fatalf("MarkProse(%q) = %q, want %q", tc.in, got, tc.want)
			}
			if Unmark(got) != strings.TrimLeft(tc.in, " \n") && got != tc.in {
				t.Fatalf("Unmark(%q) = %q, want the text as written", got, Unmark(got))
			}
		})
	}
}

func TestUnmarkLeavesOtherTextAlone(t *testing.T) {
	for _, s := range []string{"hello", ProseMark + "hello", "/unslop", ""} {
		if Unmark(s) != s {
			t.Fatalf("Unmark(%q) = %q", s, Unmark(s))
		}
	}
}

// The Text view shows the prompt as written, not with the mark in front.
func TestMarkedPromptReadsAsWritten(t *testing.T) {
	line := `{"type":"user","message":{"role":"user","content":"​/tmp/a.png what is this?"},"timestamp":"2026-10-06T15:40:44.029Z","sessionId":"x","uuid":"u1"}`
	evs := (&Normalizer{}).Line([]byte(line))
	if len(evs) != 1 || evs[0].Kind != KindUser || evs[0].Body != "/tmp/a.png what is this?" {
		t.Fatalf("got %+v", evs)
	}
}

// A prompt held behind the turn is queued as written and arrives marked; its
// row still takes it off the queue.
func TestModQueuedPathFirstPromptLeavesTheQueue(t *testing.T) {
	fs := NewModSource("s", "", nil)
	fs.Feed(modRow(t, "user", "user", "prompt", []map[string]any{{"type": "text", "text": "first"}}))
	fs.Queue("/tmp/a.png what is this?", 1790900000400)
	fs.Feed(ModEvent{Type: ModTurnEndEvent})
	fs.Feed(modRow(t, "user", "user", "prompt", []map[string]any{{"type": "text", "text": ProseMark + "/tmp/a.png what is this?"}}))
	if st := fs.State(0); len(st.Queue) != 0 {
		t.Fatalf("queue after its row = %q", st.Queue)
	}
}
