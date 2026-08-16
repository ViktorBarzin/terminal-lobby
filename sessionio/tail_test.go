package sessionio

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadFromResumesByOffset(t *testing.T) {
	p := filepath.Join(t.TempDir(), "t.jsonl")
	os.WriteFile(p, []byte("line1\nline2\n"), 0o644)

	lines, off, err := ReadFrom(p, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 2 || lines[0] != "line1" || lines[1] != "line2" {
		t.Fatalf("got %v", lines)
	}

	// Append, then resume from the returned offset — only the new full line returns.
	f, _ := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0o644)
	f.WriteString("line3\n")
	f.Close()

	lines2, off2, _ := ReadFrom(p, off)
	if len(lines2) != 1 || lines2[0] != "line3" {
		t.Fatalf("resume got %v", lines2)
	}
	if off2 <= off {
		t.Fatalf("offset did not advance: %d -> %d", off, off2)
	}
}

func TestReadFromIgnoresPartialTrailingLine(t *testing.T) {
	p := filepath.Join(t.TempDir(), "t.jsonl")
	os.WriteFile(p, []byte("full\npartial-no-newline"), 0o644)
	lines, off, _ := ReadFrom(p, 0)
	if len(lines) != 1 || lines[0] != "full" {
		t.Fatalf("want only the complete line, got %v", lines)
	}
	// Completing the partial line then resuming yields it.
	f, _ := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0o644)
	f.WriteString("-done\n")
	f.Close()
	lines2, _, _ := ReadFrom(p, off)
	if len(lines2) != 1 || lines2[0] != "partial-no-newline-done" {
		t.Fatalf("want completed line, got %v", lines2)
	}
}

// The bridge replays a whole transcript, then keeps tailing it. The cursor has
// to carry across both phases, and a record must never be delivered twice: T3
// stores whatever it is handed, so a duplicate is a duplicate in the thread.
func TestTailReplaysThenFollowsWithoutRedelivering(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	os.WriteFile(p, []byte(
		`{"type":"user","message":{"role":"user","content":"first"}}`+"\n"+
			`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"reply"}]}}`+"\n"), 0o644)

	tl := NewTail(p)
	recs, err := tl.Next()
	if err != nil {
		t.Fatalf("Next: %v", err)
	}
	if len(recs) != 2 || recs[0].Type != RecordUser || recs[1].Type != RecordAssistant {
		t.Fatalf("replay = %d records: %+v", len(recs), recs)
	}
	replayed := tl.Offset()

	// Nothing new: an empty batch, and the cursor holds still.
	if recs, err := tl.Next(); err != nil || len(recs) != 0 {
		t.Fatalf("idle Next = %d records, %v; want none", len(recs), err)
	}
	if tl.Offset() != replayed {
		t.Fatalf("cursor moved on an idle read: %d -> %d", replayed, tl.Offset())
	}

	f, _ := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0o644)
	f.WriteString(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"more"}]}}` + "\n")
	f.Close()

	recs, err = tl.Next()
	if err != nil {
		t.Fatalf("Next after append: %v", err)
	}
	if len(recs) != 1 || recs[0].Text() != "more" {
		t.Fatalf("follow = %+v, want only the appended record", recs)
	}

	// A second reader resuming from the saved cursor sees exactly the same
	// thing — that is what makes the offset safe to persist across a re-attach.
	if resumed, err := NewTailAt(p, replayed).Next(); err != nil || len(resumed) != 1 || resumed[0].Text() != "more" {
		t.Fatalf("resume from %d = %+v (%v), want just the appended record", replayed, resumed, err)
	}
}

// One unreadable line must not stop the stream: the transcript is written by
// another process, and the alternative to skipping is a thread that silently
// stops updating.
func TestTailSkipsUnparseableLines(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	os.WriteFile(p, []byte(
		"not json at all\n"+
			`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"survived"}]}}`+"\n"), 0o644)

	recs, err := NewTail(p).Next()
	if err != nil {
		t.Fatalf("Next: %v", err)
	}
	if len(recs) != 1 || recs[0].Text() != "survived" {
		t.Fatalf("got %+v, want the one good record", recs)
	}
}

// A session whose Claude has not written anything yet is the ordinary state at
// attach time, so the caller has to be able to tell "not there yet, retry" from
// a real failure.
func TestTailReportsAMissingTranscript(t *testing.T) {
	tl := NewTail(filepath.Join(t.TempDir(), "never-written.jsonl"))
	if _, err := tl.Next(); !os.IsNotExist(err) {
		t.Fatalf("Next on a missing transcript = %v, want a not-exist error", err)
	}
	if tl.Offset() != 0 {
		t.Fatalf("cursor moved on a failed read: %d", tl.Offset())
	}
}
