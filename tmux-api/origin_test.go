package main

import "testing"

// The predicate is the whole feature in one line, so the table covers each of
// the four ways a session can reach it: stamped by the lobby, stamped by a
// harness, stamped by nobody, and carrying a name another service reserves.
//
// The unstamped case is the one worth staring at. Measured on the box on
// 2026-09-06, three of the four machine-made sessions in the list matched no
// harness convention at all (`shell`, `shell-2`, `kbfix-probe`), so a predicate
// that only caught `test` would have caught one of them. Everything below is a
// consequence of asking "did the lobby make this" rather than "did a harness".
func TestIsSystemSession(t *testing.T) {
	cases := []struct {
		name    string
		session Session
		want    bool
	}{
		{
			name:    "stamped by the lobby's own create path",
			session: Session{Name: "work", Origin: originUser},
			want:    false,
		},
		{
			name:    "stamped by a harness",
			session: Session{Name: "work", Origin: originTest},
			want:    true,
		},
		{
			// Every session alive before the stamp existed, plus anything
			// created by a script that is not in this repo.
			name:    "nobody stamped it",
			session: Session{Name: "kbfix-probe"},
			want:    true,
		},
		{
			// A qa-harness session driving the lobby's own create path gets
			// stamped `user` on the way in, and is overwritten to `test`
			// afterwards. reservedName() is what covers the window between the
			// two, and the run that forgets to overwrite at all.
			name:    "a reserved prefix beats a user stamp",
			session: Session{Name: "qa-slug", Origin: originUser},
			want:    true,
		},
		{
			name:    "t3-bridge's e2e prefix",
			session: Session{Name: "t3e2e-42", Origin: originUser},
			want:    true,
		},
		{
			name:    "the lobby's own e2e prefix",
			session: Session{Name: "tlp-t1", Origin: originUser},
			want:    true,
		},
		{
			// Pool slots never reach the list (their names are over the 32-char
			// limit parseSessions enforces), but the predicate answers for them
			// anyway rather than resting on that.
			name:    "a pre-warmed pool slot",
			session: Session{Name: poolSlotPrefix + "home_wizard", Origin: originUser},
			want:    true,
		},
		{
			// A value nothing in this repo writes. Anything that is not
			// exactly `user` is system, so a typo in a stamper fails closed:
			// the session goes quiet rather than pushing to a phone.
			name:    "an origin nobody recognises",
			session: Session{Name: "work", Origin: "User"},
			want:    true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isSystemSession(tc.session); got != tc.want {
				t.Errorf("isSystemSession(%+v) = %v, want %v", tc.session, got, tc.want)
			}
		})
	}
}

// The option half, against a REAL tmux server. Everything above proves the
// predicate and the parser agree with each other; only tmux can say whether
// `#{@tl_origin}` in the list format comes back as the value someone set, and
// whether an UNSET option really renders as an empty field rather than as the
// literal `#{@tl_origin}` or a dropped column. The whole grandfathering plan
// rests on that second answer.
//
// Skipped when tmux is missing, the way title_live_test.go is.
func TestOriginRoundTripsThroughRealTmux(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	tmux := withRealTmux(t)

	for _, name := range []string{"stamped", "bare"} {
		if out, err := tmux("new-session", "-d", "-s", name); err != nil {
			t.Fatalf("creating %s: %v: %s", name, err, out)
		}
	}
	// "=name:" rather than a bare name, for the reason the title path found:
	// tmux resolves a bare -t by PREFIX match, and "bare" would be ambiguous
	// against nothing here but is the habit that keeps the next session safe.
	if out, err := tmux("set-option", "-t", "=stamped:", originOption, originUser); err != nil {
		t.Fatalf("stamping: %v: %s", err, out)
	}

	sessions := liveSessions(t, osSelf)
	if got := findSession(t, sessions, "stamped").Origin; got != originUser {
		t.Errorf("a stamped session came back with origin %q, want %q", got, originUser)
	}
	bare := findSession(t, sessions, "bare")
	if bare.Origin != "" {
		t.Errorf("an unstamped session came back with origin %q, want empty — "+
			"every session alive on the deploy reports this one", bare.Origin)
	}
	if !isSystemSession(bare) {
		t.Error("an unstamped live session is not being read as a system session")
	}
	if isSystemSession(findSession(t, sessions, "stamped")) {
		t.Error("a session stamped by the lobby's own path is being read as a system session")
	}
}
