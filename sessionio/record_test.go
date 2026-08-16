package sessionio

import (
	"encoding/json"
	"testing"
)

// The record-type triage is a WHITELIST: only assistant and user carry
// conversation, and everything else — including record types Claude Code has
// not invented yet — is dropped. Blacklisting would mean each new type leaks
// into a T3 thread as a malformed message until somebody notices.
//
// The inputs are the types measured in wizard's own transcripts on 2026-08-15
// (40 most recent files, 33,000 records): assistant, user, attachment,
// last-prompt, mode, permission-mode, ai-title, custom-title, agent-name,
// system, queue-operation, file-history-delta, file-history-snapshot,
// relocated, worktree-state, frame-link.
func TestRecordConversationalIsAWhitelist(t *testing.T) {
	for _, tc := range []struct {
		line string
		want bool
	}{
		{`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}`, true},
		{`{"type":"user","message":{"role":"user","content":"hello"}}`, true},
		{`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","content":"ok"}]}}`, true},
		{`{"type":"attachment","attachment":{"type":"deferred_tools_delta"}}`, false},
		{`{"type":"last-prompt","lastPrompt":"do the thing"}`, false},
		{`{"type":"queue-operation","operation":"enqueue","content":"queued"}`, false},
		{`{"type":"system","subtype":"stop_hook_summary"}`, false},
		{`{"type":"mode","mode":"default"}`, false},
		{`{"type":"permission-mode","permissionMode":"bypassPermissions"}`, false},
		{`{"type":"ai-title","aiTitle":"Fix the thing"}`, false},
		{`{"type":"file-history-snapshot","messageId":"m1"}`, false},
		{`{"type":"relocated","relocatedCwd":"/home/wizard/x"}`, false},
		{`{"type":"frame-link","path":"/tmp/x.html"}`, false},
		{`{"type":"a-type-nobody-has-invented-yet"}`, false},
	} {
		rec, ok := DecodeRecord([]byte(tc.line))
		if !ok {
			t.Fatalf("DecodeRecord refused a well-formed line: %s", tc.line)
		}
		if got := rec.Conversational(); got != tc.want {
			t.Errorf("Conversational(%s) = %v, want %v", rec.Type, got, tc.want)
		}
	}
}

func TestDecodeRecordRejectsNonJSON(t *testing.T) {
	for _, bad := range []string{"", "   ", "not json", "[1,2,3]", `{"type":`} {
		if _, ok := DecodeRecord([]byte(bad)); ok {
			t.Errorf("DecodeRecord(%q) accepted a line that is not a JSON object", bad)
		}
	}
}

// The bridge forwards a transcript assistant record to T3 by re-emitting its
// `message` object under a stream-json envelope (design: "translation is a thin
// key mapping, not a rewrite"). That only holds if the message survives
// decoding BYTE FOR BYTE — usage, model, stop_sequence, whatever a future
// Claude adds — so Raw must be the original bytes, not a re-encoding of the
// fields this package happens to know about.
func TestRecordKeepsTheMessageObjectVerbatim(t *testing.T) {
	const line = `{"type":"assistant","uuid":"u1","parentUuid":"u0","sessionId":"sess-1","cwd":"/home/wizard/x",` +
		`"timestamp":"2026-08-15T10:00:00Z","message":{"model":"claude-opus-5","id":"msg_1","type":"message",` +
		`"role":"assistant","content":[{"type":"text","text":"hi"}],"stop_reason":"end_turn","stop_sequence":null,` +
		`"usage":{"input_tokens":2,"output_tokens":6,"service_tier":"standard"}}}`

	rec, ok := DecodeRecord([]byte(line))
	if !ok {
		t.Fatal("DecodeRecord refused a real assistant record")
	}
	if rec.Type != RecordAssistant || rec.UUID != "u1" || rec.ParentUUID != "u0" ||
		rec.CWD != "/home/wizard/x" || rec.Timestamp != "2026-08-15T10:00:00Z" {
		t.Fatalf("envelope decoded wrong: %+v", rec)
	}
	if rec.Message.ID != "msg_1" || rec.Message.Role != "assistant" || rec.Message.StopReason != "end_turn" {
		t.Fatalf("message fields decoded wrong: %+v", rec.Message)
	}

	// Verbatim: every key of the original message object is still there, with
	// the same values, including ones this package never names.
	var want, got map[string]json.RawMessage
	if err := json.Unmarshal([]byte(line), &struct {
		Message *map[string]json.RawMessage `json:"message"`
	}{Message: &want}); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(rec.Message.Raw, &got); err != nil {
		t.Fatalf("Raw is not a JSON object: %v (%s)", err, rec.Message.Raw)
	}
	for k, v := range want {
		if string(got[k]) != string(v) {
			t.Errorf("message[%q] = %s, want %s — the round trip is lossy", k, got[k], v)
		}
	}
	if len(got) != len(want) {
		t.Errorf("Raw has %d keys, the original had %d", len(got), len(want))
	}
}

// Both spellings of the session id appear in the wild. Measured 2026-08-15 over
// 19,938 assistant/user records: "sessionId" on all of them, "session_id" on
// 17,759, and identical wherever both were present. The camelCase one is
// therefore the authority and the snake_case one is the fallback for whichever
// record types only carry it.
func TestRecordClaudeIDPrefersCamelCaseAndFallsBack(t *testing.T) {
	for _, tc := range []struct{ line, want string }{
		{`{"type":"assistant","sessionId":"camel","session_id":"camel"}`, "camel"},
		{`{"type":"assistant","sessionId":"camel"}`, "camel"},
		{`{"type":"system","session_id":"snake"}`, "snake"},
		{`{"type":"assistant"}`, ""},
	} {
		rec, ok := DecodeRecord([]byte(tc.line))
		if !ok {
			t.Fatalf("DecodeRecord refused %s", tc.line)
		}
		if got := rec.ClaudeID(); got != tc.want {
			t.Errorf("ClaudeID(%s) = %q, want %q", tc.line, got, tc.want)
		}
	}
}

// Content arrives as either a plain string or an array of blocks, and the role
// is sometimes only on the record type (older lines omit message.role).
func TestRecordBlocksAndRole(t *testing.T) {
	for _, tc := range []struct {
		name     string
		line     string
		wantRole string
		wantKind []string
		wantText string
	}{
		{
			name:     "string content wraps into one text block",
			line:     `{"type":"user","message":{"role":"user","content":"plain words"}}`,
			wantRole: "user", wantKind: []string{"text"}, wantText: "plain words",
		},
		{
			name: "block array keeps its order",
			line: `{"type":"assistant","message":{"role":"assistant","content":[` +
				`{"type":"thinking","thinking":"hmm"},{"type":"text","text":"answer"},` +
				`{"type":"tool_use","id":"tu_1","name":"Bash","input":{"command":"ls"}}]}}`,
			wantRole: "assistant", wantKind: []string{"thinking", "text", "tool_use"}, wantText: "answer",
		},
		{
			name:     "role falls back to the record type",
			line:     `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","content":"ok"}]}}`,
			wantRole: "user", wantKind: []string{"tool_result"}, wantText: "",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec, ok := DecodeRecord([]byte(tc.line))
			if !ok {
				t.Fatal("DecodeRecord refused the line")
			}
			if got := rec.Role(); got != tc.wantRole {
				t.Errorf("Role() = %q, want %q", got, tc.wantRole)
			}
			blocks := rec.Blocks()
			if len(blocks) != len(tc.wantKind) {
				t.Fatalf("Blocks() = %d blocks, want %d: %+v", len(blocks), len(tc.wantKind), blocks)
			}
			for i, want := range tc.wantKind {
				if blocks[i].Type != want {
					t.Errorf("block %d type = %q, want %q", i, blocks[i].Type, want)
				}
			}
			if got := rec.Text(); got != tc.wantText {
				t.Errorf("Text() = %q, want %q", got, tc.wantText)
			}
		})
	}
}

// EndsTurn whitelists the CONTINUATIONS, so an unrecognised future stop_reason
// settles the turn rather than wedging the bridge on an open turn forever.
func TestEndsTurn(t *testing.T) {
	for _, tc := range []struct {
		reason string
		want   bool
	}{
		{"", false}, {"tool_use", false}, {"pause_turn", false},
		{"end_turn", true}, {"stop_sequence", true}, {"max_tokens", true},
		{"refusal", true}, {"something_new_in_2027", true},
	} {
		if got := EndsTurn(tc.reason); got != tc.want {
			t.Errorf("EndsTurn(%q) = %v, want %v", tc.reason, got, tc.want)
		}
	}
}

// The interrupt notice is a user-ROLE text line with no isMeta key, so the
// ordinary "the human spoke" test claims it unless it is recognised first.
func TestInterruptNotice(t *testing.T) {
	for _, tc := range []struct {
		name, line string
		want       bool
	}{
		{"plain interrupt", `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}`, true},
		{"interrupt for tool use", `{"type":"user","message":{"role":"user","content":"[Request interrupted by user for tool use]"}}`, true},
		{"an ordinary prompt", `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"carry on"}]}}`, false},
		{"meta text is not the operator", `{"type":"user","isMeta":true,"message":{"role":"user","content":"[Request interrupted by user]"}}`, false},
		{"assistant quoting it", `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"[Request interrupted by user]"}]}}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec, ok := DecodeRecord([]byte(tc.line))
			if !ok {
				t.Fatal("DecodeRecord refused the line")
			}
			if _, got := InterruptNotice(rec); got != tc.want {
				t.Errorf("InterruptNotice = %v, want %v", got, tc.want)
			}
		})
	}
}

// A record keeps the line it came from, so a caller that wants to forward the
// original bytes never has to re-encode and risk changing them.
func TestRecordKeepsItsSourceLine(t *testing.T) {
	const line = `{"type":"assistant","message":{"role":"assistant","content":[]}}`
	rec, _ := DecodeRecord([]byte(line))
	if string(rec.Line) != line {
		t.Fatalf("Line = %s, want %s", rec.Line, line)
	}
}
