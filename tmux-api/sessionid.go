package main

// Session names that are opaque ids (ADR-0019).
//
// A session name used to be derived from the title someone typed, so that
// `tmux ls` read like a list of conversations. Prompt-first sessions take the
// typing-a-title moment away — the title arrives from Claude Code's own
// conversation summary — and a derived name would then move on its own, with
// nobody watching. So the name stops being something anyone reads: it is an id
// minted by the browser at creation, and it never changes.
//
// "minted name" rather than "session id" because #{session_id} — tmux's own
// $0, $1 — already goes by that name in this package (Session.ID, sessionIDRe),
// and the two are different things: tmux's id does not survive a server
// restart, which is exactly why it could not be the durable identity.
//
// The browser is the minter. This side exists for the one-time migration
// (migrate_ids.go), which needs to mint names for sessions that predate ids and
// to recognise the ones that already have them. frontend-v2/src/lib/session-id.ts
// is the mirror; the alphabet and the length have to agree.

import (
	"crypto/rand"
	"regexp"
)

const (
	// mintedNameLen is 12 characters, 60 bits. Ample against accidental
	// collision at a few thousand sessions per user, and tmux rename-session
	// refuses a duplicate name, so a collision is a free retry rather than a
	// corruption.
	mintedNameLen = 12

	// mintedNameAlphabet is Crockford's base32, lowercase: the digits plus
	// every letter except i, l, o and u.
	//
	// One case because the URL hash is case-sensitive and nothing lowercases a
	// session name, so an id retyped from a screenshot in the wrong case would
	// select nothing. No i/l/o/u because an id is what someone quotes when
	// reporting a problem.
	mintedNameAlphabet = "0123456789abcdefghjkmnpqrstvwxyz"
)

// mintedNameRe is what mintedNameAlphabet and mintedNameLen produce, as a test.
var mintedNameRe = regexp.MustCompile(`^[0-9a-hjkmnp-tv-z]{12}$`)

// newMintedName returns a fresh session name.
//
// 256 is exactly 8 x 32, so the low five bits of a uniform byte are uniform
// over the alphabet — masking needs no rejection loop and introduces no bias.
//
// crypto/rand should never fail; if it does, a panic is safer than silently
// minting a predictable name that a second caller could mint again and attach
// to somebody else's conversation. Matches newProjectID next door.
func newMintedName() string {
	b := make([]byte, mintedNameLen)
	if _, err := rand.Read(b); err != nil {
		panic("newMintedName: " + err.Error())
	}
	out := make([]byte, mintedNameLen)
	for i, v := range b {
		out[i] = mintedNameAlphabet[v&31]
	}
	return string(out)
}

// isMintedName reports whether a session name is one of ours — which is how the
// migration tells a session it has already done from one still carrying a human
// name. It must not accept anything a person would have typed: excluding i, l,
// o and u rules out most English words, and every session name live on the box
// on 2026-09-04 fails it.
func isMintedName(name string) bool {
	return mintedNameRe.MatchString(name)
}
