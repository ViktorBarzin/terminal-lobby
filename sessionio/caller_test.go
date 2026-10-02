package sessionio

import "testing"

// CallerOf is the one place a value in @tl_origin is read as a Caller's name.
// tmux-api files sessions, mutes pushes and tags telemetry by it, and
// session-events tags its own events by it, so the table covers every value
// those readers can meet: the two words the lobby reserves, the absence of
// any word, what agent-api actually writes, and values no writer produces.
func TestCallerOf(t *testing.T) {
	cases := []struct {
		name   string
		origin string
		want   string
	}{
		{"the lobby's own create path", OriginUser, ""},
		{"a harness", OriginTest, ""},
		{"nobody stamped it", "", ""},
		// agent-api stamps the bearer credential's name (CreateSpec.Origin).
		{"a Caller's credential name", "muse", "muse"},
		{"a credential name with a digit, dash and underscore", "ci_bot-2", "ci_bot-2"},
		// agent-api's own fallback when a request reached it with no
		// credential name. It is still a program asking, not a person.
		{"agent-api's fallback", "agent-api", "agent-api"},
		// The reserved words in another case are a typo in a stamper, not a
		// Caller called "User": treating them as one would give a stray its
		// own sidebar group and its turns a Caller tag.
		{"a reserved word in another case", "User", ""},
		{"a reserved word shouted", "TEST", ""},
		// Values outside the credential-name charset cannot have come from
		// agent-api, since authuser skips a credential line whose name is not
		// a plain account name.
		{"whitespace", "mu se", ""},
		{"a leading dash", "-muse", ""},
		{"too long for a credential name", "a234567890123456789012345678901234", ""},
		{"a path", "../muse", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := CallerOf(tc.origin); got != tc.want {
				t.Errorf("CallerOf(%q) = %q, want %q", tc.origin, got, tc.want)
			}
		})
	}
}
