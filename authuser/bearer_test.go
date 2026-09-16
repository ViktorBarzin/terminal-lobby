package authuser

import (
	"bytes"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Fixture tokens. Both are over the minimum length, which is itself a rule the
// tests below pin: a one-character "token" left by a format mix-up must never
// authenticate anyone.
const (
	museToken = "muse-0000000000000000000000000000000001"
	opsToken  = "ops-00000000000000000000000000000000002"
)

// The fixture credentials, in the file's own format. bob and alice are the two
// terminal accounts bearerGate's user map declares; alice also administers the
// box, which is how the act-as tests below have someone to be refused as.
const fixtureTokens = "# the agent broker\n" +
	"muse  " + museToken + "  bob\n" +
	"\n" +
	"ops   " + opsToken + "   alice\n"

// bearerGate builds a gate over an admins list, a user map and a tokens file.
//
// Passing "" for tokens leaves the file ABSENT rather than empty. That is the
// case every box is in today and it must behave differently from a file with
// credentials in it, so the two are never written by the same helper argument.
func bearerGate(t *testing.T, tokens string) *Gate {
	t.Helper()
	g := resolveGate(t, Config{MultiUser: "on"}, "alice\n", "alice=alice\nbob.smith=bob\n")
	g.Config.BearerTokensPath = filepath.Join(filepath.Dir(g.AdminsPath), "tokens")
	if tokens != "" {
		writeTokens(t, g, tokens)
	}
	return g
}

func writeTokens(t *testing.T, g *Gate, contents string) {
	t.Helper()
	if err := os.WriteFile(g.Config.BearerTokensPath, []byte(contents), 0o600); err != nil {
		t.Fatalf("write tokens: %v", err)
	}
}

// bearerReq is a request carrying an Authorization header and nothing else: no
// identity header and no proxy secret, which is the whole point of the
// credential.
func bearerReq(scheme, token string) *http.Request {
	r := httptest.NewRequest("GET", "/v1/conversations", nil)
	r.Header.Set("Authorization", scheme+" "+token)
	return r
}

// --- a valid token ---------------------------------------------------------

func TestValidBearerResolvesToItsOwnOSUser(t *testing.T) {
	g := bearerGate(t, fixtureTokens)
	for _, c := range []struct {
		name, token, wantUser, wantHeader string
	}{
		{"first credential", museToken, "bob", "muse"},
		{"second credential", opsToken, "alice", "ops"},
	} {
		got, err := g.Resolve(bearerReq("Bearer", c.token))
		if err != nil {
			t.Fatalf("%s: unexpected error %v", c.name, err)
		}
		if got.OSUser != c.wantUser || got.RealOSUser != c.wantUser {
			t.Fatalf("%s resolved to (%q, real %q), want %q",
				c.name, got.OSUser, got.RealOSUser, c.wantUser)
		}
		// Header is what /whoami echoes and what tmux-api logs, so it carries
		// the credential's NAME. Putting the token there would print it.
		if got.Header != c.wantHeader {
			t.Fatalf("%s: Header = %q, want the credential name %q", c.name, got.Header, c.wantHeader)
		}
		if strings.Contains(got.Header, c.token) {
			t.Fatalf("%s: the token reached Identity.Header", c.name)
		}
	}
}

// The scheme is case-insensitive per RFC 7235, and a caller that writes its own
// HTTP client picks whichever case it likes.
func TestBearerSchemeIsCaseInsensitive(t *testing.T) {
	g := bearerGate(t, fixtureTokens)
	for _, scheme := range []string{"Bearer", "bearer", "BEARER", "BeArEr"} {
		got, err := g.Resolve(bearerReq(scheme, museToken))
		if err != nil {
			t.Fatalf("scheme %q: unexpected error %v", scheme, err)
		}
		if got.OSUser != "bob" {
			t.Fatalf("scheme %q resolved to %q, want bob", scheme, got.OSUser)
		}
	}
}

// The credential authenticates on its own: no identity header, and no proxy
// secret even on a box that requires one of everybody else.
func TestBearerNeedsNeitherTheIdentityHeaderNorTheProxySecret(t *testing.T) {
	g := bearerGate(t, fixtureTokens)
	g.Config.ProxySecret = "s3cret"
	got, err := g.Resolve(bearerReq("Bearer", museToken))
	if err != nil {
		t.Fatalf("bearer with no header and no secret: %v", err)
	}
	if got.OSUser != "bob" {
		t.Fatalf("resolved to %q, want bob", got.OSUser)
	}
	// And the header path is unchanged: the same gate still refuses a request
	// that brings neither.
	if _, err := g.Resolve(req(DefaultAuthHeader, "alice")); !errors.Is(err, ErrBadSecret) {
		t.Fatalf("header path without the secret: err = %v, want ErrBadSecret", err)
	}
}

// --- a token that is not one of ours ---------------------------------------

func TestUnknownBearerIsRefused(t *testing.T) {
	g := bearerGate(t, fixtureTokens)
	for _, c := range []struct{ name, token string }{
		{"unknown token", "nobody-0000000000000000000000000000001"},
		{"empty token", ""},
		{"whitespace token", "   "},
		{"a prefix of a real token", museToken[:20]},
		{"a real token with a byte appended", museToken + "x"},
		{"a real token with its last byte changed", museToken[:len(museToken)-1] + "9"},
		{"a real token with its first byte changed", "M" + museToken[1:]},
		{"the credential's name instead of its token", "muse"},
		{"the OS user instead of the token", "bob"},
	} {
		_, err := g.Resolve(bearerReq("Bearer", c.token))
		if !errors.Is(err, ErrBadBearer) {
			t.Fatalf("%s: err = %v, want ErrBadBearer", c.name, err)
		}
	}
}

// The reason a bad bearer cannot be allowed to fall through: the header path is
// satisfied by a header a caller sets and a secret every caller shares, so
// falling through would make the per-caller credential optional in practice.
func TestABadBearerDoesNotFallThroughToTheHeaderPath(t *testing.T) {
	g := bearerGate(t, fixtureTokens)
	g.Config.ProxySecret = "s3cret"
	r := req(DefaultAuthHeader, "alice", SecretHeader, "s3cret")
	r.Header.Set("Authorization", "Bearer nobody-0000000000000000000000000000001")
	if _, err := g.Resolve(r); !errors.Is(err, ErrBadBearer) {
		t.Fatalf("bad bearer alongside a valid header and secret: err = %v, want ErrBadBearer", err)
	}
}

// The scheme with nothing after it is still a request to authenticate by
// bearer, so it is refused rather than waved through to the header path.
func TestTheBareSchemeIsAnEmptyBearerNotTheAbsenceOfOne(t *testing.T) {
	g := bearerGate(t, fixtureTokens)
	r := req(DefaultAuthHeader, "alice")
	r.Header.Set("Authorization", "Bearer")
	if _, err := g.Resolve(r); !errors.Is(err, ErrBadBearer) {
		t.Fatalf("bare scheme: err = %v, want ErrBadBearer", err)
	}
}

func TestAuthorizeAnswers401ForABadBearer(t *testing.T) {
	g := bearerGate(t, fixtureTokens)
	rec := httptest.NewRecorder()
	if _, ok := g.Authorize(rec, bearerReq("Bearer", "nobody-0000000000000000000000000000001")); ok {
		t.Fatal("Authorize admitted an unknown bearer")
	}
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status %d, want 401", rec.Code)
	}
}

// --- both credentials present ----------------------------------------------

// A request carrying both answers by the bearer, whatever the header claims.
// Anything else would let a caller that holds a token pick the identity it
// prefers by also sending a header.
func TestBearerWinsWhenTheHeaderIsAlsoPresent(t *testing.T) {
	g := bearerGate(t, fixtureTokens)
	r := req(DefaultAuthHeader, "alice") // alice maps to the alice account
	r.Header.Set("Authorization", "Bearer "+museToken)
	got, err := g.Resolve(r)
	if err != nil {
		t.Fatalf("unexpected error %v", err)
	}
	if got.OSUser != "bob" {
		t.Fatalf("resolved to %q; the bearer names bob and must win over the header", got.OSUser)
	}
	if got.Header != "muse" {
		t.Fatalf("Header = %q, want the credential name muse", got.Header)
	}
}

// An Authorization header that is not a bearer belongs to whatever the proxy is
// doing upstream — the reason the proxy secret has its own header rather than
// this one — so it must pass through without changing the answer.
func TestANonBearerAuthorizationHeaderIsLeftAlone(t *testing.T) {
	g := bearerGate(t, fixtureTokens)
	for _, auth := range []string{"Basic dXNlcjpwYXNz", "Negotiate abcdef", "BearerNoSpace", "Bearer-ish tok"} {
		r := req(DefaultAuthHeader, "alice")
		r.Header.Set("Authorization", auth)
		got, err := g.Resolve(r)
		if err != nil {
			t.Fatalf("Authorization %q: unexpected error %v", auth, err)
		}
		if got.OSUser != "alice" {
			t.Fatalf("Authorization %q resolved to %q, want the header's alice", auth, got.OSUser)
		}
	}
}

// --- the file is absent, empty or malformed --------------------------------

// Every box is in this state until someone issues a credential, so it is the
// case that has to stay exactly as it was: no file, no bearer path, and an
// Authorization header is once again somebody else's business.
func TestMissingTokensFileLeavesTheHeaderPathUntouched(t *testing.T) {
	g := bearerGate(t, "")
	r := req(DefaultAuthHeader, "alice")
	r.Header.Set("Authorization", "Bearer "+museToken)
	got, err := g.Resolve(r)
	if err != nil {
		t.Fatalf("bearer with no tokens file: unexpected error %v", err)
	}
	if got.OSUser != "alice" {
		t.Fatalf("resolved to %q, want the header's alice", got.OSUser)
	}
	// And with no header either, the refusal is still the old one.
	if _, err := g.Resolve(bearerReq("Bearer", museToken)); !errors.Is(err, ErrNoIdentity) {
		t.Fatalf("bearer alone with no tokens file: err = %v, want ErrNoIdentity", err)
	}
}

func TestEmptyTokensFileAuthenticatesNobody(t *testing.T) {
	g := bearerGate(t, "\n# nothing here yet\n\n")
	if got := g.bearerCreds(); len(got) != 0 {
		t.Fatalf("empty tokens file yielded %d credentials", len(got))
	}
	if _, err := g.Resolve(bearerReq("Bearer", museToken)); !errors.Is(err, ErrNoIdentity) {
		t.Fatalf("err = %v, want the header path's ErrNoIdentity", err)
	}
}

// A line the parser cannot read is skipped, exactly as the user map skips one,
// and never half-accepted. The '=' rows matter most: they are what a reader who
// assumed this file used the user map's format would write, and a naive split
// would turn "muse=x=bob" into a one-character token.
func TestMalformedTokenLinesAreSkipped(t *testing.T) {
	for _, c := range []struct{ name, line string }{
		{"two fields", "muse  " + museToken},
		{"four fields", "muse  " + museToken + "  bob  extra"},
		{"user-map format", "muse=" + museToken + "=bob"},
		{"equals as the token", "muse = bob"},
		{"short token", "muse  tooshort  bob"},
		{"token one byte under the minimum", "muse  " + strings.Repeat("a", 31) + "  bob"},
		{"token with a shell metacharacter", "muse  " + strings.Repeat("a", 31) + ";id  bob"},
		{"os user with a leading dash", "muse  " + museToken + "  -bob"},
		{"os user with a traversal", "muse  " + museToken + "  ../root"},
		{"name with a dot", "mu.se  " + museToken + "  bob"},
		{"name too long", strings.Repeat("n", 33) + "  " + museToken + "  bob"},
	} {
		g := bearerGate(t, c.line+"\n")
		if got := g.bearerCreds(); len(got) != 0 {
			t.Fatalf("%s: line %q parsed into %d credentials, want 0", c.name, c.line, len(got))
		}
		if _, err := g.Resolve(bearerReq("Bearer", museToken)); err == nil {
			t.Fatalf("%s: a malformed line authenticated a request", c.name)
		}
	}
}

// One bad line must not take the good ones with it: the file is edited by hand
// and a half-written entry should cost that entry, not every credential on the
// box. The user map has behaved this way since before the gate existed.
func TestAGoodLineSurvivesABadOne(t *testing.T) {
	g := bearerGate(t, "broken line\nmuse  "+museToken+"  bob\nalso broken\n")
	got, err := g.Resolve(bearerReq("Bearer", museToken))
	if err != nil {
		t.Fatalf("unexpected error %v", err)
	}
	if got.OSUser != "bob" {
		t.Fatalf("resolved to %q, want bob", got.OSUser)
	}
}

// A secret every account on a shared box can read is not a credential. The
// services run as an ordinary user, so the file cannot be 0600 root-owned —
// which makes the mode worth checking rather than assuming.
func TestAWorldReadableTokensFileIsIgnored(t *testing.T) {
	g := bearerGate(t, fixtureTokens)
	if err := os.Chmod(g.Config.BearerTokensPath, 0o644); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	if got := g.bearerCreds(); len(got) != 0 {
		t.Fatalf("world-readable tokens file yielded %d credentials", len(got))
	}
	// Group-WRITABLE is refused for the same reason: a second account that can
	// append a line issues itself a credential.
	if err := os.Chmod(g.Config.BearerTokensPath, 0o660); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	if got := g.bearerCreds(); len(got) != 0 {
		t.Fatalf("group-writable tokens file yielded %d credentials", len(got))
	}
	// Group-readable is how a root-owned file reaches a service that runs as an
	// ordinary user, so it has to be allowed.
	if err := os.Chmod(g.Config.BearerTokensPath, 0o640); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	if got := g.bearerCreds(); len(got) != 2 {
		t.Fatalf("group-readable tokens file yielded %d credentials, want 2", len(got))
	}
}

// --- the account a credential names ----------------------------------------

// The token file is root-owned, so this is defence in depth rather than a
// boundary — the same argument the act-as charset check makes. It is what stops
// a typo'd line handing out an account the lobby does not serve.
func TestACredentialMustNameATerminalAccount(t *testing.T) {
	for _, osUser := range []string{"root", "nobody", "carol"} {
		g := bearerGate(t, "muse  "+museToken+"  "+osUser+"\n")
		if _, err := g.Resolve(bearerReq("Bearer", museToken)); !errors.Is(err, ErrNoAccount) {
			t.Fatalf("credential naming %q: err = %v, want ErrNoAccount", osUser, err)
		}
	}
}

// Same answer the header path gives for the same misconfiguration: 500, because
// the box is wrong rather than the caller.
func TestACredentialNamingAnAbsentAccountIsAConfigError(t *testing.T) {
	g := bearerGate(t, fixtureTokens)
	g.LookupUser = func(string) error { return errors.New("no such user") }
	if _, err := g.Resolve(bearerReq("Bearer", museToken)); !errors.Is(err, ErrNoSuchAccount) {
		t.Fatalf("err = %v, want ErrNoSuchAccount", err)
	}
	rec := httptest.NewRecorder()
	g.Authorize(rec, bearerReq("Bearer", museToken))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status %d, want 500", rec.Code)
	}
}

// clipboard-upload only needs a directory name and never execs as the account,
// so it opts out of the host check. The opt-out must reach this path too, or
// that service would refuse a credential the others accept.
func TestBearerHonoursSkipAccountCheck(t *testing.T) {
	g := bearerGate(t, fixtureTokens)
	g.LookupUser = func(string) error { return errors.New("absent") }
	g.SkipAccountCheck = true
	got, err := g.Resolve(bearerReq("Bearer", museToken))
	if err != nil {
		t.Fatalf("SkipAccountCheck: unexpected error %v", err)
	}
	if got.OSUser != "bob" {
		t.Fatalf("resolved to %q, want bob", got.OSUser)
	}
}

// --- what a bearer may not do ----------------------------------------------

// Act-as is the affordance the lobby offers an administrator at a keyboard. A
// machine credential names one account, so ?as= is refused rather than quietly
// ignored — the same answer, and the same reported refusal, that single-user
// mode gives.
func TestABearerCannotActAsAnotherUser(t *testing.T) {
	g := bearerGate(t, fixtureTokens)
	var refusals int
	g.OnActAsRefused = func(real, target, reason string) {
		refusals++
		if real != "alice" || target != "bob" {
			t.Fatalf("hook got (%q, %q, %q)", real, target, reason)
		}
	}
	// The ops credential resolves to alice, who DOES administer this box, so
	// this pins the credential rather than the account.
	r := bearerReq("Bearer", opsToken)
	r.URL.RawQuery = "as=bob"
	if _, err := g.Resolve(r); !errors.Is(err, ErrNotAdmin) {
		t.Fatalf("bearer act-as: err = %v, want ErrNotAdmin", err)
	}
	if refusals != 1 {
		t.Fatalf("refusal hook fired %d times, want 1", refusals)
	}
}

// Naming yourself is not a request, here as everywhere else, so a client that
// always sends the parameter is not a special case.
func TestABearerMayNameItsOwnUserInActAs(t *testing.T) {
	g := bearerGate(t, fixtureTokens)
	r := bearerReq("Bearer", museToken)
	r.URL.RawQuery = "as=bob"
	got, err := g.Resolve(r)
	if err != nil {
		t.Fatalf("unexpected error %v", err)
	}
	if got.OSUser != "bob" {
		t.Fatalf("resolved to %q, want bob", got.OSUser)
	}
}

// Admin is what /whoami hands the SPA to decide whether to offer the act-as
// picker. A bearer cannot act as anyone, so reporting it as an administrator
// would advertise a control that could only fail.
func TestABearerIsNeverReportedAsAnAdmin(t *testing.T) {
	g := bearerGate(t, fixtureTokens)
	got, err := g.Resolve(bearerReq("Bearer", opsToken)) // resolves to alice, an admin
	if err != nil {
		t.Fatalf("unexpected error %v", err)
	}
	if got.Admin {
		t.Fatal("a bearer request reported Admin true")
	}
}

// --- the comparison ---------------------------------------------------------

// Constant-time comparison is only half of it: stopping at the first match
// makes the number of comparisons report WHICH credential matched. Every
// credential is compared on every request, whichever one is presented.
func TestEveryCredentialIsComparedWhicheverMatches(t *testing.T) {
	g := bearerGate(t, fixtureTokens)
	for _, c := range []struct {
		name  string
		token string
	}{
		{"the first credential", museToken},
		{"the last credential", opsToken},
		{"no credential at all", "nobody-0000000000000000000000000000001"},
	} {
		var compares int
		g.countTokenCompares = func() { compares++ }
		g.Resolve(bearerReq("Bearer", c.token))
		if compares != 2 {
			t.Fatalf("%s: %d comparisons against 2 credentials, want 2", c.name, compares)
		}
	}
}

// The comparison itself, pinned at the source. A future edit to a plain ==
// would pass every behavioural test in this file and lose the property.
func TestTokensAreComparedWithCryptoSubtle(t *testing.T) {
	src, err := os.ReadFile("bearer.go")
	if err != nil {
		t.Fatalf("read bearer.go: %v", err)
	}
	if !strings.Contains(string(src), "subtle.ConstantTimeCompare(") {
		t.Fatal("bearer.go does not call subtle.ConstantTimeCompare")
	}
	for _, bad := range []string{
		"== presented", "presented ==", "== c.token", "c.token ==",
		"== cred.token", "cred.token ==",
	} {
		if strings.Contains(string(src), bad) {
			t.Fatalf("bearer.go compares a token with %q; use subtle.ConstantTimeCompare", bad)
		}
	}
}

// --- the token never escapes ------------------------------------------------

// A token in a log line is a token in Loki for 30 days, and one in a response
// body is a token in whatever recorded the response. Not even a prefix: a
// prefix of a shared-format token narrows the search for the rest.
func TestTheTokenNeverReachesALogLineOrAResponse(t *testing.T) {
	g := bearerGate(t, fixtureTokens)
	g.LookupUser = func(string) error { return errors.New("absent") } // the 500 path too

	var buf bytes.Buffer
	old := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(old)

	for _, token := range []string{
		museToken,
		"nobody-0000000000000000000000000000001",
		"",
	} {
		rec := httptest.NewRecorder()
		g.Authorize(rec, bearerReq("Bearer", token))
		if token != "" && strings.Contains(rec.Body.String(), token) {
			t.Fatalf("the response body carried the token: %q", rec.Body.String())
		}
	}
	// Once more on the path that succeeds, and through Configure, which reports
	// what it loaded at startup.
	g.LookupUser = func(string) error { return nil }
	g.Authorize(httptest.NewRecorder(), bearerReq("Bearer", museToken))
	g.Configure("test-service", "127.0.0.1:0")

	logged := buf.String()
	for _, secret := range []string{museToken, opsToken} {
		if strings.Contains(logged, secret) {
			t.Fatalf("a token reached the log: %q", logged)
		}
		for n := 6; n <= 16 && n < len(secret); n += 2 {
			if strings.Contains(logged, secret[:n]) {
				t.Fatalf("a %d-character token prefix reached the log: %q", n, logged)
			}
		}
	}
}

// --- the hot path stays inert ----------------------------------------------

// Every browser request the lobby has ever made carries no Authorization
// header, and tmux-api's /sessions poll runs every five seconds per open tab.
// Those requests must not gain a file read.
func TestNoAuthorizationHeaderReadsNoTokensFile(t *testing.T) {
	g := bearerGate(t, fixtureTokens)
	reads := 0
	g.countTokenReads = func() { reads++ }

	if _, err := g.Resolve(req(DefaultAuthHeader, "alice")); err != nil {
		t.Fatalf("unexpected error %v", err)
	}
	r := req(DefaultAuthHeader, "alice")
	r.Header.Set("Authorization", "Basic dXNlcjpwYXNz")
	if _, err := g.Resolve(r); err != nil {
		t.Fatalf("unexpected error %v", err)
	}
	if reads != 0 {
		t.Fatalf("a request with no bearer read the tokens file %d times", reads)
	}

	if _, err := g.Resolve(bearerReq("Bearer", museToken)); err != nil {
		t.Fatalf("unexpected error %v", err)
	}
	if reads != 1 {
		t.Fatalf("a bearer request read the tokens file %d times, want 1", reads)
	}
}

// --- configuration ----------------------------------------------------------

func TestTokensPathComesFromTheEnvironmentLikeEveryOtherSetting(t *testing.T) {
	t.Setenv("TL_BEARER_TOKENS", "/etc/somewhere/tokens")
	if got := ConfigFromEnv().BearerTokensPath; got != "/etc/somewhere/tokens" {
		t.Fatalf("BearerTokensPath = %q, want the configured path", got)
	}
	t.Setenv("TL_BEARER_TOKENS", "  /etc/trimmed  ")
	if got := ConfigFromEnv().BearerTokensPath; got != "/etc/trimmed" {
		t.Fatalf("BearerTokensPath = %q, want it trimmed", got)
	}
	t.Setenv("TL_BEARER_TOKENS", "")
	if got := ConfigFromEnv().BearerTokensPath; got != "" {
		t.Fatalf("unset TL_BEARER_TOKENS = %q, want empty so the default applies", got)
	}
	if got := (&Gate{}).bearerTokensPath(); got != DefaultBearerTokensPath {
		t.Fatalf("unconfigured gate reads %q, want %q", got, DefaultBearerTokensPath)
	}
}

// The credential is a file path in the same EnvironmentFile as everything else,
// and Configure is what every service calls at startup. A service that calls it
// gains the bearer path without a line of its own.
func TestConfigureWiresTheBearerPathFromTheEnvironment(t *testing.T) {
	g := bearerGate(t, fixtureTokens)
	path := g.Config.BearerTokensPath
	t.Setenv("TL_BEARER_TOKENS", path)
	t.Setenv("TL_MULTI_USER", "on")
	g.Config = Config{}
	g.Configure("test-service", "127.0.0.1:0")
	if g.Config.BearerTokensPath != path {
		t.Fatalf("Configure read %q, want %q", g.Config.BearerTokensPath, path)
	}
	got, err := g.Resolve(bearerReq("Bearer", museToken))
	if err != nil {
		t.Fatalf("after Configure: unexpected error %v", err)
	}
	if got.OSUser != "bob" {
		t.Fatalf("resolved to %q, want bob", got.OSUser)
	}
}
