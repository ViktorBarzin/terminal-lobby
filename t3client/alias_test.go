package t3client

import (
	"fmt"
	"regexp"
	"testing"
	"testing/quick"
)

var lobbyName = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,32}$`)

func TestAliasShape(t *testing.T) {
	cases := []string{
		"mcp:3f0c1a52-8a55-4d0e-9a7e-4b3b7f6e6c11",
		"import:claudeAgent:5c1f6b8e-2d7b-4b55-8a0f-1a9d2c3e4f50",
		"mcp:launch:d5dd8bc41d7a8c4ce69a8d349c3fdd46f526bb0d7deca7e397910c4b317c51df",
		"5c1f6b8e-2d7b-4b55-8a0f-1a9d2c3e4f50",
		"",
	}
	for _, id := range cases {
		a := Alias(id)
		if !lobbyName.MatchString(a) {
			t.Errorf("Alias(%q) = %q, not a valid lobby session name", id, a)
		}
		if len(a) != 15 || a[:3] != "t3_" {
			t.Errorf("Alias(%q) = %q, want t3_ + 12 chars", id, a)
		}
		if !IsAlias(a) {
			t.Errorf("IsAlias(%q) = false", a)
		}
	}
}

// A known vector pins the derivation so tmux-api and agent-api, which both
// compute it, can never drift apart.
func TestAliasVector(t *testing.T) {
	// sha256("mcp:abc"), base32 lowercased without padding, first 12
	// characters. Computed independently with Python's hashlib and base64.
	if got := Alias("mcp:abc"); got != "t3_4r2oicnmvmrr" {
		t.Fatalf("Alias(mcp:abc) = %q; the derivation changed", got)
	}
}

func TestAliasProperties(t *testing.T) {
	prop := func(id string) bool {
		a := Alias(id)
		return a == Alias(id) && lobbyName.MatchString(a) && IsAlias(a)
	}
	if err := quick.Check(prop, &quick.Config{MaxCount: 2000}); err != nil {
		t.Fatal(err)
	}
}

func TestAliasDistinct(t *testing.T) {
	seen := map[string]string{}
	for i := 0; i < 200000; i++ {
		id := fmt.Sprintf("mcp:%08x-0000-4000-8000-%012x", i, i*7919)
		a := Alias(id)
		if prev, ok := seen[a]; ok {
			t.Fatalf("Alias collision: %q and %q both map to %q", prev, id, a)
		}
		seen[a] = id
	}
}

func TestIsAliasRejects(t *testing.T) {
	for _, s := range []string{"", "t3_", "t3_ABCDEFGHIJKL", "t3_abcdefghijk", "t3_abcdefghijklm", "x3_abcdefghijkl", "main", "t3_abcdefghij18"} {
		if IsAlias(s) {
			t.Errorf("IsAlias(%q) = true", s)
		}
	}
}
