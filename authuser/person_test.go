package authuser

import (
	"strings"
	"testing"
)

const uidAlice = "8d2f1c0b9a7e6d5c4b3a29180f7e6d5c4b3a29180f7e6d5c4b3a29180f7e6d5c"

func TestDefaultPersonHeaderIsAuthentiksUid(t *testing.T) {
	if got := (Config{}).PersonHeaderName(); got != "X-Authentik-Uid" {
		t.Fatalf("PersonHeaderName() = %q", got)
	}
	if got := (Config{PersonHeader: "X-Person"}).PersonHeaderName(); got != "X-Person" {
		t.Fatalf("a configured name is not used: %q", got)
	}
}

func TestConfigFromEnvReadsThePersonHeader(t *testing.T) {
	t.Setenv("TL_PERSON_HEADER", "  X-Person  ")
	if got := ConfigFromEnv().PersonHeader; got != "X-Person" {
		t.Fatalf("PersonHeader = %q", got)
	}
}

// The Person is the CALLER, so an admin acting as somebody else is still
// themselves: the id belongs to the account the header names, never to the
// account the request acts as.
func TestThePersonIsTheRealCallerAndIsReported(t *testing.T) {
	g := resolveGate(t, Config{MultiUser: "on"}, "wizard\n", "alice=wizard\nbob.smith=bob\n")
	var gotUser, gotPerson string
	calls := 0
	g.OnPerson = func(osUser, person string) { gotUser, gotPerson = osUser, person; calls++ }
	r := req(DefaultAuthHeader, "alice", DefaultPersonHeader, uidAlice)
	q := r.URL.Query()
	q.Set("as", "bob")
	r.URL.RawQuery = q.Encode()

	id, err := g.Resolve(r)
	if err != nil {
		t.Fatal(err)
	}
	if id.Person != uidAlice {
		t.Fatalf("Person = %q", id.Person)
	}
	if calls != 1 || gotUser != "wizard" || gotPerson != uidAlice {
		t.Fatalf("OnPerson got (%q, %q) x%d, want (wizard, uid) once", gotUser, gotPerson, calls)
	}
}

func TestSingleUserReportsThePersonToo(t *testing.T) {
	g := resolveGate(t, Config{MultiUser: "off"}, "", "")
	var got string
	g.OnPerson = func(_, person string) { got = person }
	id, err := g.Resolve(req(DefaultAuthHeader, "whoever", DefaultPersonHeader, uidAlice))
	if err != nil || id.Person != uidAlice || got != uidAlice {
		t.Fatalf("id = %+v, err = %v, reported %q", id, err, got)
	}
}

// A refused request names nobody, and a header that is not an id shape is
// not passed on as one.
func TestNoPersonFromARefusalOrAMalformedHeader(t *testing.T) {
	g := resolveGate(t, Config{MultiUser: "on"}, "", "alice=wizard\n")
	calls := 0
	g.OnPerson = func(string, string) { calls++ }
	if _, err := g.Resolve(req(DefaultAuthHeader, "stranger", DefaultPersonHeader, uidAlice)); err == nil {
		t.Fatal("an unmapped identity resolved")
	}
	for _, bad := range []string{"a b", "x;y", strings.Repeat("a", 129)} {
		id, err := g.Resolve(req(DefaultAuthHeader, "alice", DefaultPersonHeader, bad))
		if err != nil {
			t.Fatal(err)
		}
		if id.Person != "" {
			t.Errorf("Person = %q from header %q", id.Person, bad)
		}
	}
	id, err := g.Resolve(req(DefaultAuthHeader, "alice"))
	if err != nil || id.Person != "" {
		t.Fatalf("no header: id = %+v, err = %v", id, err)
	}
	if calls != 0 {
		t.Fatalf("OnPerson called %d times", calls)
	}
}

func TestNilOnPersonIsFine(t *testing.T) {
	g := resolveGate(t, Config{MultiUser: "on"}, "", "alice=wizard\n")
	if _, err := g.Resolve(req(DefaultAuthHeader, "alice", DefaultPersonHeader, uidAlice)); err != nil {
		t.Fatal(err)
	}
}
