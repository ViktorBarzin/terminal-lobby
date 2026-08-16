package slug

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"unicode/utf8"
)

// vectors.json is shared with frontend-v2/test/slug.test.ts. Both suites read
// it, so a Go/TypeScript divergence fails here or there rather than in
// production, where it would create or rename the wrong session.
type vectorFile struct {
	Cases []struct {
		Title string `json:"title"`
		Want  string `json:"want"`
	} `json:"cases"`
}

func loadVectors(t *testing.T) vectorFile {
	t.Helper()
	raw, err := os.ReadFile("vectors.json")
	if err != nil {
		t.Fatalf("reading the shared vectors: %v", err)
	}
	var v vectorFile
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("parsing the shared vectors: %v", err)
	}
	if len(v.Cases) == 0 {
		t.Fatal("the shared vectors are empty")
	}
	return v
}

func TestFromTitleMatchesSharedVectors(t *testing.T) {
	for _, c := range loadVectors(t).Cases {
		got := FromTitle(c.Title)
		if got != c.Want {
			t.Errorf("FromTitle(%q) = %q, want %q", c.Title, got, c.Want)
		}
	}
}

// Whatever a title contains, the result has to be something tmux-api will
// accept back through sessionNameRe — the name is about to be used as a tmux
// target, a URL segment and a directory component.
func TestFromTitleAlwaysFitsTheNameCharset(t *testing.T) {
	for _, c := range loadVectors(t).Cases {
		got := FromTitle(c.Title)
		if got == "" {
			continue // the caller supplies a fallback
		}
		if utf8.RuneCountInString(got) > MaxNameLen {
			t.Errorf("FromTitle(%q) = %q, %d runes over the %d budget",
				c.Title, got, utf8.RuneCountInString(got), MaxNameLen)
		}
		for _, r := range got {
			ok := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '-'
			if !ok {
				t.Errorf("FromTitle(%q) = %q, which contains %q — outside [a-z0-9_-]", c.Title, got, r)
			}
		}
		if strings.HasPrefix(got, "-") || strings.HasSuffix(got, "-") {
			t.Errorf("FromTitle(%q) = %q, which is dash-padded", c.Title, got)
		}
	}
}

// Retitling compares the derived name against the current one to decide whether
// a rename is needed at all, so deriving twice must not drift.
func TestFromTitleIsIdempotentOverItsOwnOutput(t *testing.T) {
	for _, c := range loadVectors(t).Cases {
		once := FromTitle(c.Title)
		if once == "" {
			continue
		}
		if twice := FromTitle(once); twice != once {
			t.Errorf("FromTitle(%q) = %q, but FromTitle(%q) = %q", c.Title, once, once, twice)
		}
	}
}

func TestCleanTitle(t *testing.T) {
	cases := []struct{ in, want string }{
		{"Deploy the thing", "Deploy the thing"},
		{"  padded  ", "padded"},
		{"collapses   inner   runs", "collapses inner runs"},
		{"tab\tand\nnewline", "tab and newline"},
		{"bell\aand\x1bescape", "bell and escape"},
		{"c1\u0085control", "c1 control"}, // NEL - a C1 control
		{"", ""},
		{"   ", ""},
		{"кирилица остава", "кирилица остава"},
		{"emoji 🚀 stays", "emoji 🚀 stays"},
		{"pipe | stays", "pipe | stays"},
	}
	for _, c := range cases {
		if got := CleanTitle(c.in); got != c.want {
			t.Errorf("CleanTitle(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestCleanTitleCapsRunesNotBytes(t *testing.T) {
	// 70 emoji: well under the cap in runes' worth of intent, far over it in
	// bytes. Cutting on bytes would also split a rune and produce U+FFFD.
	long := strings.Repeat("🚀", 70)
	got := CleanTitle(long)
	if n := utf8.RuneCountInString(got); n != MaxTitleRunes {
		t.Errorf("CleanTitle(70 emoji) kept %d runes, want %d", n, MaxTitleRunes)
	}
	if strings.ContainsRune(got, utf8.RuneError) {
		t.Error("CleanTitle cut through a rune")
	}
}

func TestCleanTitleIsIdempotent(t *testing.T) {
	for _, in := range []string{"  a  b  ", strings.Repeat("é", 100), "tab\there", ""} {
		once := CleanTitle(in)
		if twice := CleanTitle(once); twice != once {
			t.Errorf("CleanTitle(%q) = %q, but cleaning that gives %q", in, once, twice)
		}
	}
}

func TestFallbackSkipsTakenNames(t *testing.T) {
	cases := []struct {
		taken []string
		want  string
	}{
		{nil, "session-1"},
		{[]string{"session-1"}, "session-2"},
		{[]string{"session-1", "session-2", "session-4"}, "session-3"},
		{[]string{"unrelated"}, "session-1"},
	}
	for _, c := range cases {
		taken := map[string]bool{}
		for _, n := range c.taken {
			taken[n] = true
		}
		if got := Fallback(taken); got != c.want {
			t.Errorf("Fallback(%v) = %q, want %q", c.taken, got, c.want)
		}
	}
}

// Free is the suffix walk t3-bridge uses when it resurrects a session under a
// name something else already holds. Moved here so Go has one implementation.
func TestFree(t *testing.T) {
	cases := []struct {
		base  string
		taken []string
		want  string
	}{
		{"work", nil, "work"},
		{"work", []string{"work"}, "work-2"},
		{"work", []string{"work", "work-2"}, "work-3"},
		{strings.Repeat("a", 32), []string{strings.Repeat("a", 32)}, strings.Repeat("a", 30) + "-2"},
	}
	for _, c := range cases {
		taken := map[string]bool{}
		for _, n := range c.taken {
			taken[n] = true
		}
		got := Free(c.base, taken)
		if got != c.want {
			t.Errorf("Free(%q, %v) = %q, want %q", c.base, c.taken, got, c.want)
		}
		if utf8.RuneCountInString(got) > MaxNameLen {
			t.Errorf("Free(%q) = %q, over the %d budget", c.base, got, MaxNameLen)
		}
	}
}
