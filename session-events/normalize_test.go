package main

import "testing"

func TestNormalizeAssistantTextAndToolPairing(t *testing.T) {
	n := NewNormalizer("demo")
	var out []Event
	out = append(out, n.Line([]byte(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"},{"type":"tool_use","id":"tu_1","name":"Bash","input":{"command":"ls"}}]},"uuid":"a1","timestamp":"2026-07-19T00:00:00Z"}`))...)
	out = append(out, n.Line([]byte(`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","content":"file.txt","is_error":false}]},"uuid":"a2"}`))...)

	if len(out) != 3 {
		t.Fatalf("want 3 events (text, tool_use, tool_result), got %d: %+v", len(out), out)
	}
	if out[0].Kind != KindText || out[0].Body != "hi" {
		t.Fatalf("event0 = %+v", out[0])
	}
	if out[1].Kind != KindToolUse || out[1].Tool != "Bash" || out[1].ToolID != "tu_1" {
		t.Fatalf("event1 = %+v", out[1])
	}
	if out[2].Kind != KindToolResult || out[2].ToolID != "tu_1" || out[2].Body != "file.txt" || out[2].IsError {
		t.Fatalf("event2 = %+v", out[2])
	}
	// IDs are monotonic within a normalizer.
	if out[0].ID != 1 || out[1].ID != 2 || out[2].ID != 3 {
		t.Fatalf("ids not monotonic: %d %d %d", out[0].ID, out[1].ID, out[2].ID)
	}
}

func TestNormalizeToolResultAsBlockArray(t *testing.T) {
	n := NewNormalizer("demo")
	out := n.Line([]byte(`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_9","content":[{"type":"text","text":"blockbody"}],"is_error":true}]}}`))
	if len(out) != 1 || out[0].Body != "blockbody" || !out[0].IsError {
		t.Fatalf("block-array tool_result = %+v", out)
	}
}

func TestNormalizeSkipsMetaLines(t *testing.T) {
	n := NewNormalizer("demo")
	for _, meta := range []string{
		`{"type":"mode","mode":"default","sessionId":"x"}`,
		`{"type":"permission-mode","permissionMode":"default","sessionId":"x"}`,
		`{"type":"last-prompt","leafUuid":"u","sessionId":"x"}`,
	} {
		if got := n.Line([]byte(meta)); len(got) != 0 {
			t.Fatalf("meta %q should yield no events, got %+v", meta, got)
		}
	}
}

func TestNormalizeIgnentsGarbage(t *testing.T) {
	n := NewNormalizer("demo")
	if got := n.Line([]byte(`not json`)); got != nil {
		t.Fatalf("garbage should yield nil, got %+v", got)
	}
}
