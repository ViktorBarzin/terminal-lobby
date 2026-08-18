package sessionio

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// fakeReader answers without touching the filesystem, so a source built on it
// proves the reads really do go through the seam rather than around it.
type fakeReader struct {
	lines  []string
	result string
	asked  []string // paths it was asked for
}

func (f *fakeReader) ReadFrom(path string, off int64) ([]string, int64, error) {
	f.asked = append(f.asked, path)
	if off > 0 {
		return nil, off, nil
	}
	return f.lines, int64(len(f.lines)), nil
}

func (f *fakeReader) FullResult(path, toolID string) (string, json.RawMessage, error) {
	f.asked = append(f.asked, path)
	return f.result, nil, nil
}

func (f *fakeReader) SearchResults(path, q string, limit int) ([]ResultMatch, error) {
	f.asked = append(f.asked, path)
	return nil, nil
}

// The point of the seam: session-events runs as one OS user but serves several,
// and other homes are 0750. A source for another user must read through their
// reader, never through this process's own file access.
func TestFileSourceReadsThroughItsReader(t *testing.T) {
	fr := &fakeReader{
		lines: []string{`{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}`},
	}
	// A path this process genuinely cannot open — the local path would fail.
	fs := NewFileSourceWith("demo", "/home/someone-else/.claude/projects/x/y.jsonl", time.Millisecond, fr)
	fs.TailOnce()

	got := fs.Replay(0)
	if len(got) != 1 || got[0].Body != "hello" {
		t.Fatalf("expected the reader's line to become an event, got %+v", got)
	}
	if len(fr.asked) == 0 {
		t.Fatal("the reader was never asked — FileSource read around the seam")
	}
}

func TestFileSourceFullResultGoesThroughItsReader(t *testing.T) {
	fr := &fakeReader{result: "the full output"}
	fs := NewFileSourceWith("demo", "/home/someone-else/.claude/projects/x/y.jsonl", time.Millisecond, fr)

	body, _, err := fs.FullResult("tool-1")
	if err != nil {
		t.Fatalf("FullResult: %v", err)
	}
	if body != "the full output" {
		t.Fatalf("expected the reader's answer, got %q", body)
	}
}

// The default stays exactly what it was: a source built the old way reads the
// local filesystem, so every existing caller is unaffected.
func TestNewFileSourceStillReadsLocally(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	os.WriteFile(p, []byte(`{"type":"assistant","message":{"content":[{"type":"text","text":"local"}]}}`+"\n"), 0o644)

	fs := NewFileSource("demo", p, time.Millisecond)
	fs.TailOnce()
	if got := fs.Replay(0); len(got) != 1 || got[0].Body != "local" {
		t.Fatalf("local read broke: %+v", got)
	}
}

func TestLocalReaderFullResultFindsTheToolResult(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	os.WriteFile(p, []byte(
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t-9","content":"big output"}]}}`+"\n",
	), 0o644)

	body, _, err := LocalReader{}.FullResult(p, "t-9")
	if err != nil {
		t.Fatalf("FullResult: %v", err)
	}
	if body != "big output" {
		t.Fatalf("got %q", body)
	}
}
