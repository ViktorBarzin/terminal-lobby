package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadUserMapParsesFormat(t *testing.T) {
	p := filepath.Join(t.TempDir(), "map")
	os.WriteFile(p, []byte("# comment\n\nalice=wizard\nbob.smith=bob:/home/bob/work\n  spaced = user2 \nbad-line-no-eq\n=nouser\nnoos=\n"), 0o644)
	m := loadUserMap(p)
	if m["alice"] != "wizard" {
		t.Fatalf("alice -> %q", m["alice"])
	}
	if m["bob.smith"] != "bob" { // :cwd stripped
		t.Fatalf("bob.smith -> %q (want bob, cwd stripped)", m["bob.smith"])
	}
	if m["spaced"] != "user2" { // trimmed
		t.Fatalf("spaced -> %q", m["spaced"])
	}
	for _, bad := range []string{"bad-line-no-eq", "", "noos"} {
		if _, ok := m[bad]; ok {
			t.Fatalf("bad entry %q should be absent", bad)
		}
	}
}

func TestMapAuthToOS(t *testing.T) {
	m := map[string]string{"alice": "wizard"}
	cases := map[string]string{
		"alice":          "wizard",
		"alice@meta.com": "wizard", // strip at @
		"unknown":          "",
		"":                 "",
	}
	for in, want := range cases {
		if got := mapAuthToOS(m, in); got != want {
			t.Fatalf("mapAuthToOS(%q) = %q, want %q", in, got, want)
		}
	}
}
