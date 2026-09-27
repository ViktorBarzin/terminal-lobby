package sessionio

import "testing"

// Every way a prompt LEAVES Claude's queue has to reach the client.
//
// Measured across 141 transcripts on this box: enqueue 1261, remove 841,
// dequeue 393, popAll 13. Only enqueue was carried, so a client could see
// prompts join the queue and never leave it — a session with an empty queue
// showed three waiting, two of them background task notifications that had
// been consumed minutes earlier (Viktor, 2026-08-18).
func TestQueueOperationsAreAllCarried(t *testing.T) {
	for _, tc := range []struct {
		name string
		line string
		want Meta
		body string
	}{
		{
			name: "enqueue carries the prompt",
			line: `{"type":"queue-operation","operation":"enqueue","content":"do the thing","timestamp":"2026-08-18T09:00:00.000Z"}`,
			want: MetaQueued, body: "do the thing",
		},
		{
			// The pairing the CLI actually writes: same content, seconds later.
			name: "remove names the prompt that left",
			line: `{"type":"queue-operation","operation":"remove","content":"do the thing","timestamp":"2026-08-18T09:00:02.000Z"}`,
			want: MetaUnqueued, body: "do the thing",
		},
		{
			// Real dequeue records carry no content at all.
			name: "dequeue takes the head, unnamed",
			line: `{"type":"queue-operation","operation":"dequeue","timestamp":"2026-08-18T09:00:03.000Z"}`,
			want: MetaDequeued, body: "",
		},
		{
			name: "popAll drains the queue",
			line: `{"type":"queue-operation","operation":"popAll","content":"the one it took","timestamp":"2026-08-18T09:00:04.000Z"}`,
			want: MetaQueueCleared, body: "the one it took",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			evs := (&Normalizer{}).Line([]byte(tc.line))
			if len(evs) != 1 {
				t.Fatalf("got %d events, want 1: %+v", len(evs), evs)
			}
			if evs[0].Kind != KindMeta || evs[0].Meta != tc.want {
				t.Errorf("kind/meta = %q/%q, want %q/%q", evs[0].Kind, evs[0].Meta, KindMeta, tc.want)
			}
			if evs[0].Body != tc.body {
				t.Errorf("body = %q, want %q", evs[0].Body, tc.body)
			}
		})
	}
}

// An enqueue with nothing in it names no prompt, so there is nothing to show.
func TestEmptyEnqueueIsNotAQueuedPrompt(t *testing.T) {
	evs := (&Normalizer{}).Line([]byte(
		`{"type":"queue-operation","operation":"enqueue","content":"","timestamp":"2026-08-18T09:00:00.000Z"}`))
	if len(evs) != 0 {
		t.Errorf("got %+v, want none", evs)
	}
}

// A prompt Claude takes into the turn it is already running leaves the queue
// with reason absorbed_mid_turn and is never written as a user record. Its only
// account in the transcript is a queued_command attachment, so that is what
// becomes the prompt's row, as a turn of its own after the work it arrived
// during. Measured 2026-09-27 over this box's transcripts: 87 absorbed human
// prompts, none with a user record of their own.
func TestAbsorbedPromptIsSpoken(t *testing.T) {
	n := &Normalizer{}
	lines := []string{
		`{"type":"user","message":{"role":"user","content":"What is the date?"},"timestamp":"2026-09-27T01:20:00.000Z"}`,
		`{"type":"assistant","message":{"id":"m1","role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"date"}}]},"timestamp":"2026-09-27T01:20:01.000Z"}`,
		`{"type":"queue-operation","operation":"enqueue","timestamp":"2026-09-27T01:20:45.162Z","content":"Then also tell me the weekday."}`,
		`{"type":"queue-operation","operation":"remove","timestamp":"2026-09-27T01:21:28.944Z","content":"Then also tell me the weekday.","reason":"absorbed_mid_turn"}`,
		`{"type":"user","message":{"role":"user","content":[{"tool_use_id":"tu1","type":"tool_result","content":"Sun Sep 27"}]},"timestamp":"2026-09-27T01:21:28.889Z"}`,
		`{"isSidechain":false,"attachment":{"type":"queued_command","prompt":"Then also tell me the weekday.","commandMode":"prompt","origin":{"kind":"human"},"timestamp":"2026-09-27T01:20:45.162Z","humanTurn":true},"type":"attachment","timestamp":"2026-09-27T01:20:45.162Z"}`,
		`{"type":"assistant","message":{"id":"m2","role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"Sunday, 27 September."}]},"timestamp":"2026-09-27T01:21:40.000Z"}`,
	}
	var evs []Event
	for _, l := range lines {
		evs = append(evs, n.Line([]byte(l))...)
	}
	var users []Event
	for _, e := range evs {
		if e.Kind == KindUser {
			users = append(users, e)
		}
	}
	if len(users) != 2 || users[1].Body != "Then also tell me the weekday." {
		t.Fatalf("user events = %+v, want the typed prompt then the absorbed one", users)
	}
	if users[0].TurnID == users[1].TurnID {
		t.Errorf("absorbed prompt shares turn %q with the prompt before it; the renderer draws one user row per turn", users[1].TurnID)
	}
	last := evs[len(evs)-1]
	if last.Kind != KindTurnEnd || last.TurnID != users[1].TurnID {
		t.Errorf("last event = %+v, want the answer to close the absorbed prompt's turn", last)
	}
}

// Only a person's prompt earns a row. The same attachment carries every
// background task's notification (756 of them on this box) and messages from
// other sessions (origin peer), and neither is something the reader typed.
func TestQueuedCommandThatIsNotAHumanPromptIsNotSpoken(t *testing.T) {
	for _, line := range []string{
		`{"attachment":{"type":"queued_command","prompt":"<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>","commandMode":"task-notification"},"type":"attachment","timestamp":"2026-09-27T01:20:45.162Z"}`,
		`{"attachment":{"type":"queued_command","prompt":"hello from another session","commandMode":"prompt","origin":{"kind":"peer"}},"type":"attachment","timestamp":"2026-09-27T01:20:45.162Z"}`,
		`{"attachment":{"type":"queued_command","prompt":"","commandMode":"prompt","origin":{"kind":"human"}},"type":"attachment","timestamp":"2026-09-27T01:20:45.162Z"}`,
		`{"isSidechain":true,"attachment":{"type":"queued_command","prompt":"x","commandMode":"prompt","origin":{"kind":"human"}},"type":"attachment","timestamp":"2026-09-27T01:20:45.162Z"}`,
	} {
		if evs := (&Normalizer{}).Line([]byte(line)); len(evs) != 0 {
			t.Errorf("%s\n  got %+v, want none", line, evs)
		}
	}
}

// A prompt with a pasted picture is written as content blocks rather than a
// string. Its words still make the row.
func TestAbsorbedPromptWithBlocksKeepsItsText(t *testing.T) {
	line := `{"attachment":{"type":"queued_command","prompt":[{"type":"text","text":"[Image #1] what is this?"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}],"commandMode":"prompt","origin":{"kind":"human"}},"type":"attachment","timestamp":"2026-09-27T01:20:45.162Z"}`
	evs := (&Normalizer{}).Line([]byte(line))
	if len(evs) != 1 || evs[0].Kind != KindUser || evs[0].Body != "[Image #1] what is this?" {
		t.Fatalf("got %+v, want one user event with the prompt's text", evs)
	}
}
