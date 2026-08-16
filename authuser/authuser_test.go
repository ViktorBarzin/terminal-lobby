package authuser

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// mapped stands in for each service's isMappedOSUser: the population of real
// terminal accounts. Deliberately excludes "root" and "nobody" so the tests can
// prove an unmapped OS user is refused even though it exists on every box.
func mapped(u string) bool {
	switch u {
	case "wizard", "emo", "ancamilea":
		return true
	}
	return false
}

// gateWith writes an admins file with the given contents and returns a Gate
// pointed at it. An empty string writes an EMPTY file (not a missing one) —
// the missing-file case has its own test, because the two must behave the same
// and only one of them is exercised by ordinary operation.
func gateWith(t *testing.T, contents string) *Gate {
	t.Helper()
	p := filepath.Join(t.TempDir(), "ttyd-admins")
	if err := os.WriteFile(p, []byte(contents), 0o644); err != nil {
		t.Fatalf("write admins file: %v", err)
	}
	return &Gate{AdminsPath: p}
}

func TestNoActAsParamResolvesToTheCaller(t *testing.T) {
	g := gateWith(t, "wizard\n")
	for _, caller := range []string{"wizard", "emo"} {
		got, err := g.Effective(caller, "", mapped)
		if err != nil {
			t.Fatalf("%s with no ?as=: unexpected error %v", caller, err)
		}
		if got != caller {
			t.Fatalf("%s with no ?as= resolved to %q, want %q", caller, got, caller)
		}
	}
}

// The absent parameter and the parameter naming yourself must be
// indistinguishable, so that a client which always sends ?as= (the SPA does,
// once switched, and a bookmark can too) is not a special case anywhere
// downstream.
func TestActingAsYourselfIsAlwaysAllowed(t *testing.T) {
	g := gateWith(t, "wizard\n")
	for _, caller := range []string{"wizard", "emo"} {
		got, err := g.Effective(caller, caller, mapped)
		if err != nil {
			t.Fatalf("%s acting as self: unexpected error %v", caller, err)
		}
		if got != caller {
			t.Fatalf("%s acting as self resolved to %q", caller, got)
		}
	}
}

func TestAdminMayActAsAnotherMappedUser(t *testing.T) {
	g := gateWith(t, "wizard\n")
	got, err := g.Effective("wizard", "emo", mapped)
	if err != nil {
		t.Fatalf("admin acting as emo: unexpected error %v", err)
	}
	if got != "emo" {
		t.Fatalf("admin acting as emo resolved to %q, want emo", got)
	}
}

// The whole point of the gate.
func TestNonAdminMayNotActAsAnyoneElse(t *testing.T) {
	g := gateWith(t, "wizard\n")
	_, err := g.Effective("emo", "wizard", mapped)
	if !errors.Is(err, ErrNotAdmin) {
		t.Fatalf("emo acting as wizard: got %v, want ErrNotAdmin", err)
	}
	// ...including toward a third party, not just toward the admin.
	if _, err := g.Effective("emo", "ancamilea", mapped); !errors.Is(err, ErrNotAdmin) {
		t.Fatalf("emo acting as ancamilea: got %v, want ErrNotAdmin", err)
	}
}

func TestAdminMayNotActAsAnUnmappedUser(t *testing.T) {
	g := gateWith(t, "wizard\n")
	for _, target := range []string{"root", "nobody", "nosuchuser"} {
		if _, err := g.Effective("wizard", target, mapped); !errors.Is(err, ErrUnknownTarget) {
			t.Fatalf("admin acting as %q: got %v, want ErrUnknownTarget", target, err)
		}
	}
}

// A target that could never be a username must be refused before it reaches
// any caller's isMapped — which in production reads a file and could otherwise
// be handed a path traversal or an argv fragment.
func TestMalformedTargetIsRefusedWithoutConsultingTheMap(t *testing.T) {
	g := gateWith(t, "wizard\n")
	consulted := false
	spy := func(string) bool { consulted = true; return true }
	// "" is deliberately absent: an empty parameter is "no request", not a
	// malformed one — see TestEmptyActAsIsNotARequest.
	for _, target := range []string{
		"../wizard", "emo emo", "emo;id", "emo\n", "-emo", "emo/../wizard",
		"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", // 33 chars, one over
	} {
		if _, err := g.Effective("wizard", target, spy); !errors.Is(err, ErrUnknownTarget) {
			t.Fatalf("admin acting as %q: got %v, want ErrUnknownTarget", target, err)
		}
	}
	if consulted {
		t.Fatal("malformed target reached isMapped; it must be rejected on charset first")
	}
}

// "-emo" above is refused by the charset, but the empty string is the one that
// matters most: an empty ?as= must read as "no request", not as a request to
// become a user with no name.
func TestEmptyActAsIsNotARequest(t *testing.T) {
	g := gateWith(t, "wizard\n")
	got, err := g.Effective("emo", "", mapped)
	if err != nil {
		t.Fatalf("empty ?as= for a non-admin: unexpected error %v", err)
	}
	if got != "emo" {
		t.Fatalf("empty ?as= resolved to %q, want emo", got)
	}
}

func TestMissingAdminsFileFailsClosed(t *testing.T) {
	g := &Gate{AdminsPath: filepath.Join(t.TempDir(), "does-not-exist")}
	if g.IsAdmin("wizard") {
		t.Fatal("wizard is an admin with no admins file; the gate must fail closed")
	}
	if _, err := g.Effective("wizard", "emo", mapped); !errors.Is(err, ErrNotAdmin) {
		t.Fatalf("act-as with no admins file: got %v, want ErrNotAdmin", err)
	}
}

func TestEmptyAdminsFileFailsClosed(t *testing.T) {
	g := gateWith(t, "")
	if g.IsAdmin("wizard") {
		t.Fatal("wizard is an admin with an empty admins file")
	}
}

func TestAdminsFileParsing(t *testing.T) {
	g := gateWith(t, "# Generated from roster.yaml — DO NOT EDIT\n\n  wizard  \n\n# emo\nancamilea\n")
	for _, u := range []string{"wizard", "ancamilea"} {
		if !g.IsAdmin(u) {
			t.Fatalf("%s should be an admin", u)
		}
	}
	// A commented-out line is not a grant.
	if g.IsAdmin("emo") {
		t.Fatal("emo is commented out and must not be an admin")
	}
	if g.IsAdmin("") {
		t.Fatal("the empty user must never be an admin")
	}
}

// A non-admin's own requests must be completely unaffected by this gate — the
// no-?as= path is every request the lobby has ever made.
func TestGateIsInertWithoutTheParameter(t *testing.T) {
	for _, contents := range []string{"", "wizard\n", "emo\n"} {
		g := gateWith(t, contents)
		for _, caller := range []string{"wizard", "emo", "ancamilea"} {
			got, err := g.Effective(caller, "", mapped)
			if err != nil || got != caller {
				t.Fatalf("admins=%q caller=%s: got (%q, %v), want (%s, nil)",
					contents, caller, got, err, caller)
			}
		}
	}
}
