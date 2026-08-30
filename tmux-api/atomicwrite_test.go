package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteAtomicLeavesNoTempBehind(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "doc.json")
	if err := writeAtomic(dir, "doc.*.tmp", path, []byte(`{"a":1}`)); err != nil {
		t.Fatalf("writeAtomic: %v", err)
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(ents) != 1 || ents[0].Name() != "doc.json" {
		var got []string
		for _, e := range ents {
			got = append(got, e.Name())
		}
		t.Fatalf("want only doc.json, got %v", got)
	}
}

func TestWriteAtomicTerminatesTheDocumentWithANewline(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "doc.json")
	if err := writeAtomic(dir, "doc.*.tmp", path, []byte(`{"a":1}`)); err != nil {
		t.Fatalf("writeAtomic: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != "{\"a\":1}\n" {
		t.Fatalf("got %q", raw)
	}
}

func TestWriteAtomicKeepsTheDocumentPrivate(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "doc.json")
	if err := writeAtomic(dir, "doc.*.tmp", path, []byte(`{}`)); err != nil {
		t.Fatalf("writeAtomic: %v", err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v, want 0600", fi.Mode().Perm())
	}
}

func TestWriteAtomicCreatesTheDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "store")
	path := filepath.Join(dir, "doc.json")
	if err := writeAtomic(dir, "doc.*.tmp", path, []byte(`{}`)); err != nil {
		t.Fatalf("writeAtomic: %v", err)
	}
	fi, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o700 {
		t.Fatalf("dir mode = %v, want 0700", fi.Mode().Perm())
	}
}

func TestWriteAtomicReplacesAnExistingDocument(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "doc.json")
	if err := os.WriteFile(path, []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := writeAtomic(dir, "doc.*.tmp", path, []byte(`{"a":2}`)); err != nil {
		t.Fatalf("writeAtomic: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "stale") {
		t.Fatalf("old document survived: %q", raw)
	}
}

func TestWriteAtomicJSONMarshalsTheValue(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "doc.json")
	type doc struct {
		Name string `json:"name"`
	}
	if err := writeAtomicJSON(dir, "doc.*.tmp", path, doc{Name: "lobby"}); err != nil {
		t.Fatalf("writeAtomicJSON: %v", err)
	}
	var back doc
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("unmarshal %q: %v", raw, err)
	}
	if back.Name != "lobby" {
		t.Fatalf("got %+v", back)
	}
}

func TestWriteAtomicJSONReportsAMarshalFailureWithoutTouchingDisk(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "doc.json")
	if err := writeAtomicJSON(dir, "doc.*.tmp", path, make(chan int)); err == nil {
		t.Fatal("want an error for an unmarshalable value")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("document was written anyway: %v", err)
	}
}
