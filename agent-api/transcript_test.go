package main

import "testing"

func lines(ss ...string) [][]byte {
	out := make([][]byte, 0, len(ss))
	for _, s := range ss {
		out = append(out, []byte(s))
	}
	return out
}

func TestDecodeTranscript(t *testing.T) {
	cases := []struct {
		name string
		in   [][]byte
		want []TranscriptMessage
	}{
		{
			name: "a plain exchange",
			in: lines(
				userLine("what runs here?", "2026-09-16T11:00:00Z"),
				assistantLine("two services", "2026-09-16T11:00:04Z"),
			),
			want: []TranscriptMessage{
				{Role: "user", Text: "what runs here?", At: "2026-09-16T11:00:00Z"},
				{Role: "assistant", Text: "two services", At: "2026-09-16T11:00:04Z"},
			},
		},
		{
			name: "content as a bare string, which older lines use",
			in:   lines(`{"type":"user","message":{"role":"user","content":"a string"}}`),
			want: []TranscriptMessage{{Role: "user", Text: "a string"}},
		},
		{
			name: "a tool_result the harness fed back is not the human's words",
			in: lines(
				`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"x","content":"ok"}]}}`,
			),
			want: nil,
		},
		{
			name: "an assistant record that only called a tool",
			in: lines(
				`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"x","name":"Bash"}]}}`,
			),
			want: nil,
		},
		{
			name: "thinking is not the answer",
			in: lines(
				`{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"}]}}`,
			),
			want: nil,
		},
		{
			name: "harness-injected context",
			in:   lines(`{"type":"user","isMeta":true,"message":{"role":"user","content":"<system-reminder>"}}`),
			want: nil,
		},
		{
			name: "a subagent's own thread",
			in: lines(
				`{"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"sub"}]}}`,
			),
			want: nil,
		},
		{
			name: "lifecycle records",
			in: lines(
				`{"type":"mode","mode":"plan"}`,
				`{"type":"permission-mode","permissionMode":"acceptEdits"}`,
				`{"type":"queue-operation","operation":"add","content":"queued"}`,
				`{"type":"system","subtype":"hook"}`,
				`{"type":"attachment"}`,
			),
			want: nil,
		},
		{
			name: "a partial write at the end of the file",
			in: lines(
				assistantLine("complete", "2026-09-16T11:00:00Z"),
				`{"type":"assistant","message":{"role":"assi`,
			),
			want: []TranscriptMessage{{Role: "assistant", Text: "complete", At: "2026-09-16T11:00:00Z"}},
		},
		{
			name: "blank lines",
			in:   lines("", "   ", assistantLine("here", "2026-09-16T11:00:00Z")),
			want: []TranscriptMessage{{Role: "assistant", Text: "here", At: "2026-09-16T11:00:00Z"}},
		},
		{
			name: "whitespace around the text is trimmed",
			in:   lines(assistantLine("\n\n  an answer  \n", "2026-09-16T11:00:00Z")),
			want: []TranscriptMessage{{Role: "assistant", Text: "an answer", At: "2026-09-16T11:00:00Z"}},
		},
		{
			name: "an empty transcript",
			in:   nil,
			want: nil,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := decodeTranscript(c.in)
			if len(got) != len(c.want) {
				t.Fatalf("got %d messages, want %d: %+v", len(got), len(c.want), got)
			}
			for i := range c.want {
				if got[i] != c.want[i] {
					t.Errorf("message %d:\n got %+v\nwant %+v", i, got[i], c.want[i])
				}
			}
		})
	}
}

func TestLastAssistantText(t *testing.T) {
	cases := []struct {
		name string
		in   [][]byte
		want string
	}{
		{"nothing", nil, ""},
		{
			name: "the answer, with the tool results the turn wrote after it",
			in: lines(
				userLine("do the thing", "2026-09-16T11:00:00Z"),
				`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"x","name":"Bash"}]}}`,
				`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"x","content":"output"}]}}`,
				assistantLine("the final message", "2026-09-16T11:00:20Z"),
				// A tool_result recorded after the answer. Searching forward
				// would return this; searching backward for an ASSISTANT with
				// text is what gets the answer.
				`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"y","content":"late"}]}}`,
			),
			want: "the final message",
		},
		{
			name: "a subagent's last word is not the turn's answer",
			in: lines(
				assistantLine("the real answer", "2026-09-16T11:00:00Z"),
				`{"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"subagent"}]}}`,
			),
			want: "the real answer",
		},
		{
			name: "a turn that only called tools",
			in: lines(
				`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"x","name":"Bash"}]}}`,
			),
			want: "",
		},
		{
			name: "the user spoke last",
			in:   lines(assistantLine("answered", "2026-09-16T11:00:00Z"), userLine("thanks", "2026-09-16T11:00:30Z")),
			want: "answered",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := lastAssistantText(c.in); got != c.want {
				t.Fatalf("lastAssistantText = %q, want %q", got, c.want)
			}
		})
	}
}

func TestStateName(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"running", "running"},
		{"awaiting", "awaiting"},
		{"done", "done"},
		{"", "no_agent"},
		{"  done  ", "done"},
		// An unknown value is not silently treated as finished: sessionio is
		// firm that "not stamped with a state we know" is its own answer.
		{"something-upstream-added", "no_agent"},
	} {
		if got := stateName(c.in); got != c.want {
			t.Errorf("stateName(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
