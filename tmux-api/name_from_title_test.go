package main

import "testing"

// Deriving a name from a title again (ADR-0022). The pure half: given what a
// session is called now, what it is titled, and what else is running, what
// should it be called?

func TestDerivedNameFor(t *testing.T) {
	cases := []struct {
		what    string
		name    string
		title   string
		taken   []string
		want    string
		wantAny bool // whether a rename is called for at all
	}{
		{
			what:    "a minted id gets the title it just grew",
			name:    "6j0wjvxxf7e5",
			title:   "Restore feature session naming",
			want:    "restore-feature-session-naming",
			wantAny: true,
		},
		{
			what:  "a name already derived from this title stays put",
			name:  "restore-feature-session-naming",
			title: "Restore feature session naming",
		},
		// The rename must be a fixed point, or every poll walks the suffix one
		// higher: -2 becomes -3 becomes -4, renaming a live session forever.
		{
			what:  "a suffixed name already derived from this title stays put",
			name:  "deploy-2",
			title: "Deploy",
			taken: []string{"deploy"},
		},
		{
			what:    "a taken base takes the next free suffix",
			name:    "0qwwchjmxv9c",
			title:   "Deploy",
			taken:   []string{"deploy", "deploy-2"},
			want:    "deploy-3",
			wantAny: true,
		},
		// The session's OWN name is not a collision with itself.
		{
			what:  "the session does not collide with itself",
			name:  "deploy",
			title: "Deploy",
			taken: []string{"deploy"},
		},
		{
			what:  "a title with nothing usable in it leaves the name alone",
			name:  "4txnmy85ftja",
			title: "日本語 🎉",
		},
		{
			what:  "an empty title leaves the name alone",
			name:  "4txnmy85ftja",
			title: "",
		},
		// Renaming these changes behaviour elsewhere: t3-sync recognises
		// machine-made sessions by prefix, and the pool's slots are deliberately
		// unaddressable.
		{
			what:  "a reserved name is never derived over",
			name:  "qa-harness-run",
			title: "Some title",
		},
		{
			what:  "a pool slot is never derived over",
			name:  poolSlotPrefix + "code",
			title: "Some title",
		},
	}

	for _, c := range cases {
		t.Run(c.what, func(t *testing.T) {
			taken := map[string]bool{}
			for _, n := range c.taken {
				taken[n] = true
			}
			got, ok := derivedNameFor(c.name, c.title, taken)
			if ok != c.wantAny {
				t.Fatalf("rename wanted = %v, want %v (got name %q)", ok, c.wantAny, got)
			}
			if ok && got != c.want {
				t.Errorf("derived name = %q, want %q", got, c.want)
			}
		})
	}
}

// Idempotence, stated as its own property: feeding a derived name back in must
// ask for nothing. This is what stops the auto-title poll renaming on every tick.
func TestDerivedNameForIsAFixedPoint(t *testing.T) {
	titles := []string{
		"Restore feature session naming",
		"Deploy",
		"A title with  odd   spacing",
		"Ünïcödé tïtlé",
		"a/b/c: punctuation!",
	}
	for _, title := range titles {
		name, ok := derivedNameFor("6j0wjvxxf7e5", title, map[string]bool{})
		if !ok {
			t.Fatalf("%q derived nothing", title)
		}
		if again, ok := derivedNameFor(name, title, map[string]bool{}); ok {
			t.Errorf("%q: %q renamed again to %q", title, name, again)
		}
	}
}
