package authuser

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// resolveGate builds a Gate over temp files. Passing "" for either path leaves
// that file ABSENT rather than empty — the distinction matters for the user
// map, whose absence is what `auto` reads as "single-user".
func resolveGate(t *testing.T, cfg Config, admins, userMap string) *Gate {
	t.Helper()
	dir := t.TempDir()
	// Fixture accounts (bob, carol) do not exist on the machine running the
	// tests, so the host check passes by default here; the one test that cares
	// about a missing account overrides this.
	g := &Gate{
		AdminsPath: filepath.Join(dir, "ttyd-admins"),
		Config:     cfg,
		LookupUser: func(string) error { return nil },
	}
	if admins != "" {
		if err := os.WriteFile(g.AdminsPath, []byte(admins), 0o644); err != nil {
			t.Fatalf("write admins: %v", err)
		}
	}
	g.MapPath = filepath.Join(dir, "ttyd-user-map")
	if userMap != "" {
		if err := os.WriteFile(g.MapPath, []byte(userMap), 0o644); err != nil {
			t.Fatalf("write user map: %v", err)
		}
	}
	return g
}

func req(header, user string, extra ...string) *http.Request {
	r := httptest.NewRequest("GET", "/whoami", nil)
	if header != "" && user != "" {
		r.Header.Set(header, user)
	}
	for i := 0; i+1 < len(extra); i += 2 {
		r.Header.Set(extra[i], extra[i+1])
	}
	return r
}

// --- the configured header name -------------------------------------------

func TestDefaultHeaderIsXForwardedUser(t *testing.T) {
	g := resolveGate(t, Config{}, "", "")
	if got := g.Config.header(); got != DefaultAuthHeader {
		t.Fatalf("unconfigured header = %q, want %q", got, DefaultAuthHeader)
	}
	if DefaultAuthHeader != "X-Forwarded-User" {
		t.Fatalf("default header is %q; a public project should not ship a vendor name", DefaultAuthHeader)
	}
}

func TestAnyHeaderNameCanCarryTheIdentity(t *testing.T) {
	for _, name := range []string{"X-Forwarded-User", "X-Authentik-Username", "X-Remote-User"} {
		g := resolveGate(t, Config{AuthHeader: name}, "", "")
		got, err := g.Resolve(req(name, "wizard"))
		if err != nil {
			t.Fatalf("%s: unexpected error %v", name, err)
		}
		if got.OSUser != "wizard" {
			t.Fatalf("%s resolved to %q, want wizard", name, got.OSUser)
		}
	}
}

// A value in some OTHER header must not resolve anyone. Without this, adding
// header configurability would widen what counts as identity rather than move it.
func TestOnlyTheConfiguredHeaderIsRead(t *testing.T) {
	g := resolveGate(t, Config{AuthHeader: "X-Forwarded-User"}, "", "")
	_, err := g.Resolve(req("X-Authentik-Username", "wizard"))
	if !errors.Is(err, ErrNoIdentity) {
		t.Fatalf("identity in an unconfigured header: err = %v, want ErrNoIdentity", err)
	}
}

func TestMissingIdentityHeaderIsRefused(t *testing.T) {
	g := resolveGate(t, Config{}, "", "")
	if _, err := g.Resolve(req("", "")); !errors.Is(err, ErrNoIdentity) {
		t.Fatalf("no identity header: err = %v, want ErrNoIdentity", err)
	}
}

// --- the proxy secret ------------------------------------------------------

func TestNoSecretConfiguredMeansNoCheck(t *testing.T) {
	g := resolveGate(t, Config{}, "", "")
	got, err := g.Resolve(req(DefaultAuthHeader, "wizard"))
	if err != nil {
		t.Fatalf("unset secret should not gate: %v", err)
	}
	if got.OSUser != "wizard" {
		t.Fatalf("resolved to %q, want wizard", got.OSUser)
	}
}

func TestConfiguredSecretIsRequired(t *testing.T) {
	g := resolveGate(t, Config{ProxySecret: "s3cret"}, "", "")
	if _, err := g.Resolve(req(DefaultAuthHeader, "wizard")); !errors.Is(err, ErrBadSecret) {
		t.Fatalf("missing secret: err = %v, want ErrBadSecret", err)
	}
	if _, err := g.Resolve(req(DefaultAuthHeader, "wizard", SecretHeader, "wrong")); !errors.Is(err, ErrBadSecret) {
		t.Fatalf("wrong secret: err = %v, want ErrBadSecret", err)
	}
	got, err := g.Resolve(req(DefaultAuthHeader, "wizard", SecretHeader, "s3cret"))
	if err != nil {
		t.Fatalf("correct secret: unexpected error %v", err)
	}
	if got.OSUser != "wizard" {
		t.Fatalf("resolved to %q, want wizard", got.OSUser)
	}
}

// The whole point of the secret is that an unauthenticated caller cannot reach
// identity resolution at all. A request with a bad secret and NO identity header
// must fail on the secret, not on the missing identity.
func TestSecretIsCheckedBeforeIdentity(t *testing.T) {
	g := resolveGate(t, Config{ProxySecret: "s3cret"}, "", "")
	if _, err := g.Resolve(req("", "")); !errors.Is(err, ErrBadSecret) {
		t.Fatalf("no secret and no identity: err = %v, want ErrBadSecret", err)
	}
}

// --- the mode --------------------------------------------------------------

func TestAutoIsMultiUserExactlyWhenAMapExists(t *testing.T) {
	withMap := resolveGate(t, Config{MultiUser: "auto"}, "", "wizard=wizard\nbob=bob\n")
	if !withMap.MultiUser() {
		t.Fatal("auto with a user map present: want multi-user")
	}
	withoutMap := resolveGate(t, Config{MultiUser: "auto"}, "", "")
	if withoutMap.MultiUser() {
		t.Fatal("auto with no user map: want single-user")
	}
}

func TestAutoIsTheDefault(t *testing.T) {
	g := resolveGate(t, Config{}, "", "wizard=wizard\n")
	if !g.MultiUser() {
		t.Fatal("unset TL_MULTI_USER with a map present: want multi-user")
	}
}

func TestModeCanBeForcedEitherWay(t *testing.T) {
	off := resolveGate(t, Config{MultiUser: "off"}, "", "wizard=wizard\nbob=bob\n")
	if off.MultiUser() {
		t.Fatal("off with a map present: want single-user")
	}
	on := resolveGate(t, Config{MultiUser: "on"}, "", "")
	if !on.MultiUser() {
		t.Fatal("on with no map: want multi-user")
	}
}

// --- single-user resolution ------------------------------------------------

// In single-user mode the caller is whoever the service runs as, whatever the
// proxy says the username is. The header still has to be present, because its
// presence is what proves the request came through the proxy.
func TestSingleUserResolvesToTheInvokingUserWhateverTheHeaderSays(t *testing.T) {
	g := resolveGate(t, Config{MultiUser: "off"}, "", "")
	g.SelfUser = "wizard"
	got, err := g.Resolve(req(DefaultAuthHeader, "someone.else"))
	if err != nil {
		t.Fatalf("unexpected error %v", err)
	}
	if got.OSUser != "wizard" {
		t.Fatalf("single-user resolved to %q, want the invoking user wizard", got.OSUser)
	}
	if got.MultiUser {
		t.Fatal("single-user resolution reported MultiUser true")
	}
}

// The map is the multi-user mechanism. Single-user must not consult it, so that
// a stale map left on disk cannot influence a box running single-user.
func TestSingleUserDoesNotConsultTheMap(t *testing.T) {
	g := resolveGate(t, Config{MultiUser: "off"}, "", "someone.else=bob\n")
	g.SelfUser = "wizard"
	got, err := g.Resolve(req(DefaultAuthHeader, "someone.else"))
	if err != nil {
		t.Fatalf("unexpected error %v", err)
	}
	if got.OSUser != "wizard" {
		t.Fatalf("resolved to %q via the map; single-user should ignore it", got.OSUser)
	}
}

// --- multi-user resolution -------------------------------------------------

func TestMultiUserMapsTheHeaderThroughTheUserMap(t *testing.T) {
	g := resolveGate(t, Config{MultiUser: "on"}, "", "alice=wizard\nbob.smith=bob\n")
	got, err := g.Resolve(req(DefaultAuthHeader, "bob.smith"))
	if err != nil {
		t.Fatalf("unexpected error %v", err)
	}
	if got.OSUser != "bob" {
		t.Fatalf("resolved to %q, want bob", got.OSUser)
	}
	if !got.MultiUser {
		t.Fatal("multi-user resolution reported MultiUser false")
	}
}

func TestMultiUserRefusesAnUnmappedIdentity(t *testing.T) {
	g := resolveGate(t, Config{MultiUser: "on"}, "", "alice=wizard\n")
	if _, err := g.Resolve(req(DefaultAuthHeader, "stranger")); !errors.Is(err, ErrNoAccount) {
		t.Fatalf("unmapped identity: err = %v, want ErrNoAccount", err)
	}
}

// --- act-as, through the new entry point -----------------------------------

func TestActAsStillWorksThroughResolve(t *testing.T) {
	g := resolveGate(t, Config{MultiUser: "on"}, "wizard\n", "alice=wizard\nbob.smith=bob\n")
	r := req(DefaultAuthHeader, "alice")
	q := r.URL.Query()
	q.Set("as", "bob")
	r.URL.RawQuery = q.Encode()
	got, err := g.Resolve(r)
	if err != nil {
		t.Fatalf("admin acting as a mapped user: %v", err)
	}
	if got.OSUser != "bob" {
		t.Fatalf("resolved to %q, want bob", got.OSUser)
	}
	if got.RealOSUser != "wizard" {
		t.Fatalf("RealOSUser = %q, want wizard", got.RealOSUser)
	}
}

func TestActAsIsRefusedInSingleUserMode(t *testing.T) {
	g := resolveGate(t, Config{MultiUser: "off"}, "wizard\n", "")
	g.SelfUser = "wizard"
	r := req(DefaultAuthHeader, "alice")
	q := r.URL.Query()
	q.Set("as", "bob")
	r.URL.RawQuery = q.Encode()
	if _, err := g.Resolve(r); !errors.Is(err, ErrNotAdmin) {
		t.Fatalf("act-as in single-user mode: err = %v, want ErrNotAdmin", err)
	}
}

func TestActAsByANonAdminIsRefused(t *testing.T) {
	g := resolveGate(t, Config{MultiUser: "on"}, "wizard\n", "alice=wizard\nbob.smith=bob\n")
	r := req(DefaultAuthHeader, "bob.smith")
	q := r.URL.Query()
	q.Set("as", "wizard")
	r.URL.RawQuery = q.Encode()
	if _, err := g.Resolve(r); !errors.Is(err, ErrNotAdmin) {
		t.Fatalf("non-admin act-as: err = %v, want ErrNotAdmin", err)
	}
}

// --- behaviour carried over from the five per-service copies ---------------

// The map's left-hand side is the identity's LOCAL part: every service stripped
// "@domain" before the lookup, because Authentik emits both forms depending on
// the flow. Losing this would refuse anyone whose proxy sends a full address.
func TestIdentityLocalPartIsUsedForTheMapLookup(t *testing.T) {
	g := resolveGate(t, Config{MultiUser: "on"}, "", "alice=wizard\n")
	for _, sent := range []string{"alice", "alice@example.com"} {
		got, err := g.Resolve(req(DefaultAuthHeader, sent))
		if err != nil {
			t.Fatalf("%q: unexpected error %v", sent, err)
		}
		if got.OSUser != "wizard" {
			t.Fatalf("%q resolved to %q, want wizard", sent, got.OSUser)
		}
	}
}

// A map entry naming an account that does not exist on this host is a
// misconfiguration, not a refusal of the caller. Every service answered 500 for
// it and said so, rather than 403, so an operator could tell the two apart.
func TestMappedAccountMissingOnTheHostIsAConfigError(t *testing.T) {
	g := resolveGate(t, Config{MultiUser: "on"}, "", "alice=ghost\n")
	g.LookupUser = func(string) error { return errors.New("no such user") }
	if _, err := g.Resolve(req(DefaultAuthHeader, "alice")); !errors.Is(err, ErrNoSuchAccount) {
		t.Fatalf("mapped account missing: err = %v, want ErrNoSuchAccount", err)
	}
}

// Single-user does not consult the map, so it must not consult the host either:
// the account is the one the process is already running as.
func TestSingleUserDoesNotLookUpTheAccount(t *testing.T) {
	g := resolveGate(t, Config{MultiUser: "off"}, "", "")
	g.SelfUser = "wizard"
	g.LookupUser = func(string) error { t.Fatal("single-user looked the account up"); return nil }
	if _, err := g.Resolve(req(DefaultAuthHeader, "anyone")); err != nil {
		t.Fatalf("unexpected error %v", err)
	}
}
