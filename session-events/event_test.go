package main

import "testing"

func TestEventJSONWireShape(t *testing.T) {
	e := Event{ID: 42, Kind: KindText, Session: "demo", TurnID: "t1", Body: "hello"}
	got := string(e.JSON())
	want := `{"id":42,"kind":"text","session":"demo","turnId":"t1","body":"hello"}`
	if got != want {
		t.Fatalf("wire shape mismatch:\n got=%s\nwant=%s", got, want)
	}
}

func TestEventKindsAreStable(t *testing.T) {
	for k, s := range map[Kind]string{
		KindSession: "session", KindUser: "user", KindText: "text",
		KindToolUse: "tool_use", KindToolResult: "tool_result", KindResult: "result",
		KindState: "state", KindPermissionRequest: "permission_request",
		KindPermissionResolved: "permission_resolved", KindError: "error", KindTurnEnd: "turn_end",
	} {
		if string(k) != s {
			t.Fatalf("kind %q != %q", k, s)
		}
	}
}
