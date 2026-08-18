package sessionio

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// jsonString quotes a body for embedding in a transcript fixture.
func jsonString(s string) string { b, _ := json.Marshal(s); return string(b) }

// writeTranscript lays down a transcript and returns a source that has read it.
func writeTranscript(t *testing.T, lines ...string) *FileSource {
	t.Helper()
	p := filepath.Join(t.TempDir(), "s.jsonl")
	if err := os.WriteFile(p, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatalf("write transcript: %v", err)
	}
	fs := NewFileSource("demo", p, time.Millisecond)
	fs.TailOnce()
	return fs
}

// The open window is 20 turns and the largest transcript on this box is 28.9 MB
// over 7,964 records, so a search that only covered what the browser holds would
// answer "no matches" for most of a long session. This searches the whole log.
func TestSearchFindsEveryFieldTheTranscriptHolds(t *testing.T) {
	fs := writeTranscript(t,
		`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"why is it saying permission denied"}]},"uuid":"u1"}`,
		`{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"the permission denied comes from the mount"},{"type":"tool_use","id":"tu_1","name":"Bash","input":{"command":"mkdir /etc/nope"}}]},"uuid":"a1"}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","content":"mkdir: cannot create directory: permission denied"}]},"uuid":"a2"}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"unrelated answer"}]},"uuid":"a3"}`,
	)

	hits := fs.Search("permission denied", 50)
	if len(hits) != 3 {
		t.Fatalf("want 3 hits (message, thinking, result), got %d: %+v", len(hits), hits)
	}

	fields := map[string]bool{}
	for _, h := range hits {
		fields[h.Field] = true
		if h.ID == 0 {
			t.Errorf("hit has no event id, so it cannot be jumped to: %+v", h)
		}
		if !strings.Contains(strings.ToLower(h.Snippet), "permission denied") {
			t.Errorf("snippet does not contain the match: %q", h.Snippet)
		}
	}
	for _, want := range []string{"message", "thinking", "result"} {
		if !fields[want] {
			t.Errorf("no hit for field %q; got %v", want, fields)
		}
	}
}

// A tool's input is how you answer "which command did that" — the question a
// long session actually gets searched for.
func TestSearchFindsToolInputsAndNamesTheTool(t *testing.T) {
	fs := writeTranscript(t,
		`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_9","name":"Bash","input":{"command":"go test ./sessionio/"}}]},"uuid":"a1"}`,
	)
	hits := fs.Search("go test", 50)
	if len(hits) != 1 {
		t.Fatalf("want 1 hit, got %d: %+v", len(hits), hits)
	}
	if hits[0].Field != "input" || hits[0].Tool != "Bash" {
		t.Errorf("hit = %+v, want field=input tool=Bash", hits[0])
	}
}

// Matching is case-insensitive: nobody searching a transcript on a phone is
// going to reproduce the casing of a stderr line.
func TestSearchIsCaseInsensitive(t *testing.T) {
	fs := writeTranscript(t,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"The Normalizer emits three kinds"}]},"uuid":"a1"}`,
	)
	if got := fs.Search("NORMALIZER", 50); len(got) != 1 {
		t.Fatalf("case-insensitive search found %d hits: %+v", len(got), got)
	}
}

// Newest first: a search on a long session is nearly always looking for
// something recent, and the limit must cut the OLD end rather than the new one.
func TestSearchReturnsNewestFirstAndRespectsTheLimit(t *testing.T) {
	var lines []string
	for i := range 10 {
		lines = append(lines, `{"type":"assistant","message":{"content":[{"type":"text","text":"match `+string(rune('a'+i))+`"}]},"uuid":"a`+string(rune('0'+i))+`"}`)
	}
	fs := writeTranscript(t, lines...)

	hits := fs.Search("match", 3)
	if len(hits) != 3 {
		t.Fatalf("limit not applied: got %d", len(hits))
	}
	if hits[0].ID <= hits[1].ID || hits[1].ID <= hits[2].ID {
		t.Errorf("not newest-first: %d %d %d", hits[0].ID, hits[1].ID, hits[2].ID)
	}
	// The newest of ten is "match j".
	if !strings.Contains(hits[0].Snippet, "match j") {
		t.Errorf("newest hit = %q, want the last one written", hits[0].Snippet)
	}
}

// An empty query matches nothing rather than everything — a blank find field
// should not stream a 7,964-record session back at the browser.
func TestSearchIgnoresAnEmptyQuery(t *testing.T) {
	fs := writeTranscript(t,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"anything"}]},"uuid":"a1"}`,
	)
	for _, q := range []string{"", "   ", "\t"} {
		if got := fs.Search(q, 50); len(got) != 0 {
			t.Errorf("query %q returned %d hits", q, len(got))
		}
	}
}

// A tool result is capped at MaxInlineResult (8 KB) on the way to the browser,
// and the in-memory log holds the capped form. The error you are hunting is
// routinely further in than that — Bash results here run to 3,309 records with
// stdout and stderr — so a match past the cut has to be found on disk, and it
// has to come back with the id of the event it belongs to so it can be jumped
// to like any other hit.
func TestSearchFindsAMatchPastTheResultCap(t *testing.T) {
	deep := strings.Repeat("noise line\n", 1200) + "FATAL: the thing that broke"
	if len(deep) <= MaxInlineResult {
		t.Fatalf("fixture is only %d bytes; it must exceed the %d-byte cap", len(deep), MaxInlineResult)
	}
	fs := writeTranscript(t,
		`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_deep","name":"Bash","input":{"command":"./run.sh"}}]},"uuid":"a1"}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_deep","content":`+jsonString(deep)+`}]},"uuid":"a2"}`,
	)

	// Confirm the premise: the event the browser holds does NOT contain it.
	for _, e := range fs.Replay(0) {
		if e.Kind == KindToolResult && strings.Contains(e.Body, "FATAL") {
			t.Fatal("fixture did not exceed the cap; the test proves nothing")
		}
	}

	hits := fs.Search("FATAL: the thing that broke", 50)
	if len(hits) != 1 {
		t.Fatalf("want 1 hit from beyond the cap, got %d: %+v", len(hits), hits)
	}
	if hits[0].Field != "result" || hits[0].Tool != "Bash" {
		t.Errorf("hit = %+v, want field=result tool=Bash", hits[0])
	}
	if hits[0].ID == 0 {
		t.Error("hit carries no event id, so it cannot be jumped to")
	}
	if !strings.Contains(hits[0].Snippet, "FATAL") {
		t.Errorf("snippet lost the match: %q", hits[0].Snippet)
	}
}

// A result whose visible head already matched must not be reported twice — once
// from memory and once from the disk pass.
func TestSearchDoesNotReportAResultTwice(t *testing.T) {
	body := "permission denied at the top\n" + strings.Repeat("filler\n", 1500)
	fs := writeTranscript(t,
		`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_dup","name":"Bash","input":{"command":"x"}}]},"uuid":"a1"}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_dup","content":`+jsonString(body)+`}]},"uuid":"a2"}`,
	)
	hits := fs.Search("permission denied", 50)
	if len(hits) != 1 {
		t.Fatalf("want 1 hit, got %d: %+v", len(hits), hits)
	}
}

// The snippet is what the hit list shows, so it has to be bounded and it has to
// contain the match — including when the match sits deep inside a long body.
func TestSearchSnippetIsBoundedAndCentredOnTheMatch(t *testing.T) {
	long := strings.Repeat("x", 4000) + "NEEDLE" + strings.Repeat("y", 4000)
	fs := writeTranscript(t,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"`+long+`"}]},"uuid":"a1"}`,
	)
	hits := fs.Search("needle", 50)
	if len(hits) != 1 {
		t.Fatalf("got %d hits", len(hits))
	}
	if n := len(hits[0].Snippet); n > MaxSnippet+8 {
		t.Errorf("snippet is %d bytes, want at most about %d", n, MaxSnippet)
	}
	if !strings.Contains(hits[0].Snippet, "NEEDLE") {
		t.Errorf("snippet lost the match: %q", hits[0].Snippet)
	}
}
