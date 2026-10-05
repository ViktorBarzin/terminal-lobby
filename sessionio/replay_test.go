package sessionio

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Transcript lines for the replay tests, in the shape Claude Code writes them.

func tPrompt(uuid, text string) string {
	return `{"type":"user","uuid":"` + uuid + `","timestamp":"2026-10-05T10:00:00Z","message":{"role":"user","content":` + jsonString(text) + `}}`
}

func tReply(uuid, msgID, text, stop string) string {
	return `{"type":"assistant","uuid":"` + uuid + `","timestamp":"2026-10-05T10:00:01Z","message":{"id":"` + msgID +
		`","role":"assistant","model":"claude-opus-5-5","stop_reason":"` + stop + `","content":[{"type":"text","text":` + jsonString(text) + `}]}}`
}

func tToolCall(uuid, msgID, toolID string) string {
	return `{"type":"assistant","uuid":"` + uuid + `","timestamp":"2026-10-05T10:00:02Z","message":{"id":"` + msgID +
		`","role":"assistant","model":"claude-opus-5-5","stop_reason":"tool_use","content":[{"type":"tool_use","id":"` + toolID + `","name":"Bash","input":{"command":"ls"}}]}}`
}

func tCompact(uuid string) string {
	return `{"type":"user","uuid":"` + uuid + `","isCompactSummary":true,"timestamp":"2026-10-05T10:00:03Z","message":{"role":"user","content":"This session is being continued from a previous conversation."}}`
}

func tEnqueue(text string) string {
	return `{"type":"queue-operation","operation":"enqueue","timestamp":"2026-10-05T10:00:04Z","content":` + jsonString(text) + `}`
}

func writeModTranscript(t *testing.T, lines ...string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "t.jsonl")
	if err := os.WriteFile(p, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func appendTranscript(t *testing.T, p string, lines ...string) {
	t.Helper()
	f, err := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Error(err)
		return
	}
	defer f.Close()
	if _, err := f.WriteString(strings.Join(lines, "\n") + "\n"); err != nil {
		t.Error(err)
	}
}

func prompts(evs []Event) []string {
	var out []string
	for _, e := range evs {
		if e.Kind == KindUser {
			out = append(out, e.Body)
		}
	}
	return out
}

// The mod's history starts at the last /compact and holds the newest 4096
// entries. Measured 2026-10-05: a session with three compactions showed 9 of
// its 19 prompts after a restart, led by the compaction summary drawn as a
// prompt. The transcript holds the whole conversation.
func TestModReplayKeepsEveryPromptAcrossCompaction(t *testing.T) {
	p := writeModTranscript(t,
		tPrompt("u1", "first"), tReply("a1", "m1", "one", "end_turn"),
		tCompact("c1"),
		tPrompt("u2", "second"), tReply("a2", "m2", "two", "end_turn"),
		tCompact("c2"),
		tPrompt("u3", "third"), tReply("a3", "m3", "three", "end_turn"),
	)
	fs := NewModSource("s", p, nil)
	if err := fs.ReplayTranscript("a3", false, 0); err != nil {
		t.Fatal(err)
	}
	got := fs.Replay(0)
	if g := strings.Join(prompts(got), ","); g != "first,second,third" {
		t.Fatalf("prompts = %s", g)
	}
	compacts := 0
	for _, e := range got {
		if e.Kind == KindMeta && e.Meta == MetaCompact {
			compacts++
		}
	}
	if compacts != 2 {
		t.Errorf("%d compaction markers, want 2", compacts)
	}
	if n := countKind(got, KindTurnEnd); n != 3 {
		t.Errorf("%d turn_end, want 3", n)
	}
	if fs.TurnOpen() {
		t.Error("an idle session's last turn is open")
	}
}

// Rows after the barrier were stored after the mod's snapshot, so they reach
// the log live, once, in order; rows up to it are in the replay and a live copy
// of one is dropped.
func TestModReplayStopsAtTheBarrierAndDedupesLiveRows(t *testing.T) {
	p := writeModTranscript(t,
		tPrompt("u1", "first"), tReply("a1", "m1", "one", "end_turn"),
		tPrompt("u2", "second"),
	)
	fs := NewModSource("s", p, nil)
	if err := fs.ReplayTranscript("a1", false, 0); err != nil {
		t.Fatal(err)
	}
	if g := strings.Join(prompts(fs.Replay(0)), ","); g != "first" {
		t.Fatalf("prompts after replay = %s, want first", g)
	}
	fs.Feed(ModEvent{Type: ModRowEvent, UUID: "a1", Door: "response", Message: &ModMessage{
		Type: "assistant", Role: "assistant", Content: json.RawMessage(`[{"type":"text","text":"one"}]`)}})
	fs.Feed(ModEvent{Type: ModRowEvent, UUID: "u2", Door: "prompt", Message: &ModMessage{
		Type: "user", Role: "user", Content: json.RawMessage(`"second"`)}})
	got := fs.Replay(0)
	if g := strings.Join(prompts(got), ","); g != "first,second" {
		t.Fatalf("prompts = %s, want first,second", g)
	}
	if n := countKind(got, KindText); n != 1 {
		t.Errorf("%d text rows, want 1: the live copy of a1 was drawn again", n)
	}
}

// The mod never sends queue-operation rows, so a prompt the file leaves
// enqueued would sit in the queue for the life of the session. Measured over
// 150 transcripts on 2026-10-05: 3 end with a human prompt still queued.
func TestModReplayClearsAQueueTheFileLeftOpen(t *testing.T) {
	p := writeModTranscript(t,
		tPrompt("u1", "first"), tEnqueue("waiting prompt"), tReply("a1", "m1", "one", "end_turn"),
	)
	fs := NewModSource("s", p, nil)
	if err := fs.ReplayTranscript("a1", false, 0); err != nil {
		t.Fatal(err)
	}
	if q := fs.State(10).Queue; len(q) != 0 {
		t.Fatalf("queue after replay = %q", q)
	}
}

func TestModReplayTurnFollowsTheMod(t *testing.T) {
	lines := []string{tPrompt("u1", "go"), tToolCall("a1", "m1", "toolu_1")}
	for _, tc := range []struct {
		running bool
		open    bool
		ends    int
	}{{running: true, open: true, ends: 0}, {running: false, open: false, ends: 1}} {
		fs := NewModSource("s", writeModTranscript(t, lines...), nil)
		if err := fs.ReplayTranscript("a1", tc.running, 0); err != nil {
			t.Fatal(err)
		}
		if fs.TurnOpen() != tc.open {
			t.Errorf("running=%v: TurnOpen = %v", tc.running, fs.TurnOpen())
		}
		if n := countKind(fs.Replay(0), KindTurnEnd); n != tc.ends {
			t.Errorf("running=%v: %d turn_end, want %d", tc.running, n, tc.ends)
		}
	}
}

// Claude writes the transcript in batches every 100 ms, so the row the mod
// named can reach the file a moment after the history does.
func TestModReplayWaitsForTheBarrierRow(t *testing.T) {
	p := writeModTranscript(t, tPrompt("u1", "first"))
	fs := NewModSource("s", p, nil)
	go func() {
		time.Sleep(200 * time.Millisecond)
		appendTranscript(t, p, tReply("a1", "m1", "one", "end_turn"))
	}()
	if err := fs.ReplayTranscript("a1", false, 2*time.Second); err != nil {
		t.Fatal(err)
	}
	if n := countKind(fs.Replay(0), KindText); n != 1 {
		t.Fatalf("%d text rows, want 1", n)
	}
}

func TestModReplayWithoutTheBarrierRowLeavesTheLogAlone(t *testing.T) {
	fs := NewModSource("s", writeModTranscript(t, tPrompt("u1", "first")), nil)
	if err := fs.ReplayTranscript("a9", false, 300*time.Millisecond); err == nil {
		t.Fatal("replay succeeded without the barrier row")
	}
	if got := fs.Replay(0); len(got) != 0 {
		t.Fatalf("a failed replay left %d events; the fallback would draw them twice", len(got))
	}
	if err := NewModSource("s", "", nil).ReplayTranscript("a1", false, 0); err == nil {
		t.Fatal("replay with no transcript path succeeded")
	}
}

// A reader attached while the log is rebuilt would get the whole conversation
// as live frames, past its 512-slot buffer. Its stream ends instead, and it
// reopens with the usual window.
func TestModReplayEndsStreamsInsteadOfFloodingThem(t *testing.T) {
	fs := NewModSource("s", writeModTranscript(t, tPrompt("u1", "first"), tReply("a1", "m1", "one", "end_turn")), nil)
	ch, cancel := fs.Subscribe()
	defer cancel()
	if err := fs.ReplayTranscript("a1", false, 0); err != nil {
		t.Fatal(err)
	}
	n := 0
	for range ch {
		n++
	}
	if n != 0 {
		t.Fatalf("subscriber received %d live frames of the replay", n)
	}
}

// A slash command the lobby sends is stored twice in the transcript: the
// prompt the mod submitted, then Claude's own command record. The mod
// forwards only the first, so the live log showed one bubble and a replay
// showed two (measured 2026-10-05 on a /compact).
func TestACommandRecordAfterItsOwnPromptIsNotASecondPrompt(t *testing.T) {
	caveat := `{"type":"user","uuid":"k1","isMeta":true,"timestamp":"2026-10-05T10:00:05Z","message":{"role":"user","content":"<local-command-caveat>Caveat: the messages below were generated by the user while running local commands.</local-command-caveat>"}}`
	command := func(uuid string) string {
		return `{"type":"user","uuid":"` + uuid + `","timestamp":"2026-10-05T10:00:05Z","message":{"role":"user","content":"<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>"}}`
	}
	p := writeModTranscript(t,
		tPrompt("u1", "first"), tReply("a1", "m1", "one", "end_turn"),
		tPrompt("u2", "/compact"), caveat, command("x1"),
		tReply("a2", "m2", "two", "end_turn"),
		command("x2"), // typed in the terminal after a reply: a command of its own
	)
	fs := NewModSource("s", p, nil)
	if err := fs.ReplayTranscript("x2", false, 0); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(prompts(fs.Replay(0)), ","); got != "first,/compact,/compact" {
		t.Fatalf("prompts = %s, want first,/compact,/compact (the lobby's one once, the typed one once)", got)
	}
}
