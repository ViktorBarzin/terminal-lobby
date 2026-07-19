package main

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
