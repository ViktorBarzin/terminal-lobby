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
