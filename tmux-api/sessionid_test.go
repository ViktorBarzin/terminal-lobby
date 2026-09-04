package main

import (
	"strings"
	"testing"
)

// The shape is a contract with frontend-v2/src/lib/session-id.ts, which mints
// the ids that arrive here as session names. The two must agree: the one-time
// migration decides a session has already been migrated by testing its name
// against isMintedName, so an alphabet that drifts either re-migrates every
// session on every restart or refuses to migrate at all.

func TestNewMintedNameShape(t *testing.T) {
	seen := make(map[string]bool, 2000)
	for i := 0; i < 2000; i++ {
		n := newMintedName()
		if len(n) != mintedNameLen {
			t.Fatalf("newMintedName() = %q, want %d characters", n, mintedNameLen)
		}
		if !isMintedName(n) {
			t.Fatalf("newMintedName() = %q, which isMintedName rejects", n)
		}
		// Every service that takes a session name validates against this.
		if !sessionNameRe.MatchString(n) {
			t.Fatalf("newMintedName() = %q, which sessionNameRe rejects", n)
		}
		if seen[n] {
			t.Fatalf("newMintedName() repeated %q within 2000 mints", n)
		}
		seen[n] = true
	}
}

func TestMintedNameAlphabetMatchesTheBrowser(t *testing.T) {
	const want = "0123456789abcdefghjkmnpqrstvwxyz" // lowercase Crockford base32
	if mintedNameAlphabet != want {
		t.Fatalf("mintedNameAlphabet = %q, want %q (frontend-v2/src/lib/session-id.ts)", mintedNameAlphabet, want)
	}
	if mintedNameLen != 12 {
		t.Fatalf("mintedNameLen = %d, want 12", mintedNameLen)
	}
	// i/1, l/1, o/0 and u/v: an id is what someone quotes when reporting a
	// problem, and the URL hash is case-sensitive with no fuzzy match.
	for _, ch := range "ilouILOU" {
		if strings.ContainsRune(mintedNameAlphabet, ch) {
			t.Errorf("mintedNameAlphabet contains %q, which people confuse when retyping an id", ch)
		}
	}
}

func TestIsMintedName(t *testing.T) {
	cases := []struct {
		name string
		want bool
	}{
		{"k7m2q9x4tpz3", true},
		{"000000000000", true},
		{"zzzzzzzzzzzz", true},
		// Real session names off the box on 2026-09-04. A false positive here
		// leaves one of these unmigrated, still carrying a human name.
		{"authentik", false},
		{"ca-asia", false},
		{"hyperoptic", false},
		{"ny-reibursment", false},
		{"notifications-when-running", false},
		{"new-session", false},
		{"shell", false},
		{"session-1", false},
		{"", false},
		{"K7M2Q9X4TPZ3", false},  // uppercase
		{"k7m2q9x4tp", false},    // ten characters
		{"k7m2q9x4tpz3v", false}, // thirteen
		{"k7m2q9x4tpzi", false},  // i is not in the alphabet
		{"k7m2q9x4tp-3", false},  // nor is a dash
		{"__terminal_lobby_prewarmed_pool_slot__home_wizard_code", false},
	}
	for _, tc := range cases {
		if got := isMintedName(tc.name); got != tc.want {
			t.Errorf("isMintedName(%q) = %v, want %v", tc.name, got, tc.want)
		}
	}
}
