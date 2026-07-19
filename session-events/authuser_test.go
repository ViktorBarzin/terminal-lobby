package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadUserMapParsesFormat(t *testing.T) {
	p := filepath.Join(t.TempDir(), "map")
	os.WriteFile(p, []byte("# comment\n\nvbarzin=wizard\nemil.barzin=emo:/home/emo/work\n  spaced = user2 \nbad-line-no-eq\n=nouser\nnoos=\n"), 0o644)
	m := loadUserMap(p)
	if m["vbarzin"] != "wizard" {
		t.Fatalf("vbarzin -> %q", m["vbarzin"])
	}
	if m["emil.barzin"] != "emo" { // :cwd stripped
		t.Fatalf("emil.barzin -> %q (want emo, cwd stripped)", m["emil.barzin"])
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
	m := map[string]string{"vbarzin": "wizard"}
	cases := map[string]string{
		"vbarzin":          "wizard",
		"vbarzin@meta.com": "wizard", // strip at @
		"unknown":          "",
		"":                 "",
	}
	for in, want := range cases {
		if got := mapAuthToOS(m, in); got != want {
			t.Fatalf("mapAuthToOS(%q) = %q, want %q", in, got, want)
		}
	}
}
