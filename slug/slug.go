// Package slug derives a tmux session NAME from a display TITLE, and
// normalizes the TITLE itself.
//
// The two halves have different consumers, and after ADR-0019 they no longer
// belong to the same story:
//
//   - CleanTitle / MaxTitleRunes normalize the arbitrary text a person typed —
//     spaces, punctuation, emoji, any script — before it is stored and shown.
//     tmux-api runs this on every title that reaches it. Its mirror is
//     frontend-v2/src/lib/title.ts.
//
//   - FromTitle / Free / MaxNameLen derive a tmux session name. The LOBBY
//     stopped using these: a lobby session's name is a minted 12-character id
//     that never changes, so nothing is derived from a title any more.
//     t3-bridge still names a bridged session after its working directory
//     (main.go's Slug, resurrect.go's free-name walk), which is what keeps this
//     half alive.
//
// vectors.json pins the derivation. It used to be read by both this package's
// tests and the frontend's; the TypeScript side lost its copy of FromTitle with
// the lobby's use of it, so the file is a Go-only fixture now.
package slug

import (
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

// MaxNameLen is the tmux session-name budget, matching tmux-api's
// sessionNameRe (^[a-zA-Z0-9_-]{1,32}$).
const MaxNameLen = 32

// MaxTitleRunes caps a stored title. Runes, not bytes: an emoji is one
// character to the person who typed it, and cutting on bytes would split one.
// A 260px sidebar card ellipsises long before this, so the cap is about keeping
// the poll response small rather than about fit.
const MaxTitleRunes = 64

// CleanTitle normalizes a title for storage and display.
//
// Control characters become a space rather than vanishing: a title pasted out
// of a terminal or an editor arrives with tabs and newlines in it, and "tab and
// newline" is what the person meant where "tabandnewline" is not. Whitespace
// runs then collapse, so the result is stable no matter which control character
// produced the gap.
//
// Idempotent — retitling compares against the stored value, and a clean that
// kept changing its own output would rename on every poll.
func CleanTitle(title string) string {
	var b strings.Builder
	space := true // leading whitespace is dropped by starting "in" a run
	for _, r := range title {
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			if !space {
				b.WriteByte(' ')
				space = true
			}
			continue
		}
		b.WriteRune(r)
		space = false
	}
	out := strings.TrimSuffix(b.String(), " ")
	if utf8.RuneCountInString(out) > MaxTitleRunes {
		out = strings.TrimSuffix(string([]rune(out)[:MaxTitleRunes]), " ")
	}
	return out
}

// FromTitle derives the tmux session name for a title.
//
// Returns "" when nothing usable survives — a CJK or emoji-only title, or no
// title at all. The caller supplies its own fallback; t3-bridge, the one
// consumer left, uses its own placeholder.
func FromTitle(title string) string {
	clean := strings.ToLower(CleanTitle(title))

	var ascii strings.Builder
	for _, r := range clean {
		if r < utf8.RuneSelf {
			ascii.WriteRune(r)
			continue
		}
		if s, ok := translit[r]; ok {
			ascii.WriteString(s)
			continue
		}
		// Untransliterable (CJK, emoji, symbols). Emit a rune that is not in
		// the keep set so the collapse below turns it into a single dash,
		// rather than silently joining the words on either side.
		ascii.WriteByte(' ')
	}

	var b strings.Builder
	dash := false // collapses a run of unusable characters into one dash
	for _, r := range ascii.String() {
		if nameRune(r) {
			b.WriteRune(r)
			dash = false
			continue
		}
		if !dash && b.Len() > 0 {
			b.WriteByte('-')
			dash = true
		}
	}

	name := strings.Trim(b.String(), "-")
	if len(name) > MaxNameLen {
		name = strings.TrimRight(name[:MaxNameLen], "-")
	}
	return name
}

// nameRune reports whether a character may appear in a tmux session name. The
// set is tmux-api's sessionNameRe minus uppercase, since FromTitle lowercases.
func nameRune(r rune) bool {
	switch {
	case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
		return true
	}
	return r == '_' || r == '-'
}

// Free returns base, or the first free base-N variant.
//
// This is the suffix walk t3-bridge uses when a resurrection finds its name
// taken. The lobby has no use for it: its names are minted ids, and a collision
// there is answered by minting another rather than by suffixing.
//
// The suffix has to fit the same budget, so a base at the limit is cut to make
// room. Ten variants is the ceiling before it gives up and returns the last
// try: at that point the collision is not a coincidence, and the caller's own
// duplicate check is the backstop.
func Free(base string, taken map[string]bool) string {
	if !taken[base] {
		return base
	}
	name := base
	for n := 2; n < 12; n++ {
		suffix := fmt.Sprintf("-%d", n)
		trimmed := base
		if len(trimmed)+len(suffix) > MaxNameLen {
			trimmed = strings.TrimRight(base[:MaxNameLen-len(suffix)], "-")
		}
		name = trimmed + suffix
		if !taken[name] {
			return name
		}
	}
	return name
}
