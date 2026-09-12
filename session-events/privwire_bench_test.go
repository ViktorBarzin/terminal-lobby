package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"terminal-lobby/sessionio"
)

// transcriptBlob builds a blob shaped like a real transcript: JSONL, one record
// per line, with the escaping a Claude transcript actually carries (quotes and
// newlines inside message text).
func transcriptBlob(mb int) []byte {
	line := `{"type":"assistant","message":{"role":"assistant","id":"m1","content":[{"type":"text","text":` +
		`"a reply with \"quotes\" and a\nnewline, long enough to look like real prose rather than a token"}]}}` + "\n"
	var b bytes.Buffer
	b.Grow(mb << 20)
	for b.Len() < mb<<20 {
		b.WriteString(line)
	}
	return b.Bytes()
}

// BenchmarkPrivWireBlob is the cost of shipping a transcript across the privop
// boundary as one value: the child encodes it, the parent decodes and splits.
func BenchmarkPrivWireBlob(b *testing.B) {
	blob := transcriptBlob(8)
	b.SetBytes(int64(len(blob)))
	b.ResetTimer()
	for range b.N {
		enc, err := json.Marshal(privResponse{OK: true, Blob: blob, Next: int64(len(blob))})
		if err != nil {
			b.Fatal(err)
		}
		var out privResponse
		if err := json.Unmarshal(enc, &out); err != nil {
			b.Fatal(err)
		}
		if n := len(sessionio.SplitLines(out.Blob)); n == 0 {
			b.Fatal("no lines")
		}
	}
}

// BenchmarkPrivWireLines is the same transcript in the per-line form this
// replaced: the child splits and encodes one JSON string per line, the parent
// decodes them back into a []string.
func BenchmarkPrivWireLines(b *testing.B) {
	blob := transcriptBlob(8)
	lines := sessionio.SplitLines(blob)
	b.SetBytes(int64(len(blob)))
	b.ResetTimer()
	for range b.N {
		enc, err := json.Marshal(privResponse{OK: true, Lines: lines, Next: int64(len(blob))})
		if err != nil {
			b.Fatal(err)
		}
		var out privResponse
		if err := json.Unmarshal(enc, &out); err != nil {
			b.Fatal(err)
		}
		if len(out.Lines) == 0 {
			b.Fatal("no lines")
		}
	}
}

// The two forms must carry the same lines. A benchmark that compared different
// work would say nothing.
func TestPrivWireFormsAgree(t *testing.T) {
	blob := transcriptBlob(1)
	viaBlob := sessionio.SplitLines(blob)
	viaLines := strings.Split(strings.TrimSuffix(string(blob), "\n"), "\n")
	if len(viaBlob) != len(viaLines) {
		t.Fatalf("blob split %d lines, string split %d", len(viaBlob), len(viaLines))
	}
	for i := range viaLines {
		if viaBlob[i] != viaLines[i] {
			t.Fatalf("line %d differs:\n blob: %s\nlines: %s", i, viaBlob[i], viaLines[i])
		}
	}
}
