package authuser

import (
	"bytes"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// Fixture tokens — what a caller presents. Both are over the minimum length,
// which is itself a rule the tests below pin: a one-character "token" left by
// a format mix-up must never authenticate anyone.
const (
	museToken = "muse-0000000000000000000000000000000001"
	opsToken  = "ops-00000000000000000000000000000000002"
)

// The fixture credentials, in the file's own format: the DIGEST of each token,
// never the token. bob and alice are the two terminal accounts bearerGate's
// user map declares; alice also administers the box, which is how the act-as
// tests below have someone to be refused as.
var fixtureTokens = "# the agent broker\n" +
	"muse  " + BearerDigest(museToken) + "  bob\n" +
	"\n" +
	"ops   " + BearerDigest(opsToken) + "   alice\n"

// bearerGate builds a gate over an admins list, a user map and a tokens file.
//
// Passing "" for tokens leaves the file ABSENT rather than empty. That is the
// case every box is in today and it must behave differently from a file with
// credentials in it, so the two are never written by the same helper argument.
//
// TokensOwnerUID is moved off its production default here, and only here. A
// test cannot create a root-owned file, and the rule it would otherwise fail
// is the subject of its own tests below rather than a detail every case has to
// carry.
func bearerGate(t *testing.T, tokens string) *Gate {
	t.Helper()
	g := resolveGate(t, Config{MultiUser: "on"}, "alice\n", "alice=alice\nbob.smith=bob\n")
	g.Config.BearerTokensPath = filepath.Join(filepath.Dir(g.AdminsPath), "tokens")
	g.TokensOwnerUID = os.Getuid()
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
	digest := BearerDigest(museToken)
	for _, c := range []struct{ name, line string }{
		{"two fields", "muse  " + digest},
		{"four fields", "muse  " + digest + "  bob  extra"},
		{"user-map format", "muse=" + digest + "=bob"},
		{"equals as the token", "muse = bob"},
		{"a plaintext token where the digest goes", "muse  " + museToken + "  bob"},
		{"a bare digest with no algorithm", "muse  " + strings.TrimPrefix(digest, "sha256:") + "  bob"},
		{"a digest one hex digit short", "muse  sha256:" + strings.Repeat("a", 63) + "  bob"},
		{"a digest that is not hex", "muse  sha256:" + strings.Repeat("g", 64) + "  bob"},
		{"a digest under another algorithm", "muse  md5:" + strings.Repeat("a", 32) + "  bob"},
		{"os user with a leading dash", "muse  " + digest + "  -bob"},
		{"os user with a traversal", "muse  " + digest + "  ../root"},
		{"name with a dot", "mu.se  " + digest + "  bob"},
		{"name too long", strings.Repeat("n", 33) + "  " + digest + "  bob"},
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
	g := bearerGate(t, "broken line\nmuse  "+BearerDigest(museToken)+"  bob\nalso broken\n")
	got, err := g.Resolve(bearerReq("Bearer", museToken))
	if err != nil {
		t.Fatalf("unexpected error %v", err)
	}
	if got.OSUser != "bob" {
		t.Fatalf("resolved to %q, want bob", got.OSUser)
	}
}

// A file every account on a shared box can read is not a credentials file,
// even one that holds only digests: it names which accounts have machine
// callers, and a group-writable one lets a second account issue itself a
// credential.
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

// --- what the file is worth to whoever can read it --------------------------

// The reason the file holds digests. TL_PROXY_SECRET lives in
// /etc/terminal-lobby.local.conf, which is 0640 root:root: systemd reads it as
// root and hands it to the process after dropping to User=wizard, so nothing
// else running as wizard can read it. This file is opened by the service
// itself, at request time, as wizard — so it MUST be readable by that account,
// and everything else running as that account reads it too. A file of tokens
// would therefore be worse than the secret it replaces. A file of digests
// hands a reader nothing it can present.
func TestNothingReadableInTheFileAuthenticatesAnyone(t *testing.T) {
	g := bearerGate(t, fixtureTokens)
	body, err := os.ReadFile(g.Config.BearerTokensPath)
	if err != nil {
		t.Fatalf("read tokens: %v", err)
	}
	for _, field := range strings.Fields(string(body)) {
		// Both the field as written and the digest with its algorithm
		// stripped, which is what a reader would try first.
		for _, candidate := range []string{field, strings.TrimPrefix(field, "sha256:")} {
			if _, err := g.Resolve(bearerReq("Bearer", candidate)); err == nil {
				t.Fatalf("a field copied out of the credentials file authenticated: %q", candidate)
			}
		}
	}
	// And the real tokens still work, so the assertion above is not passing
	// because the fixture authenticates nobody at all.
	if got, err := g.Resolve(bearerReq("Bearer", museToken)); err != nil || got.OSUser != "bob" {
		t.Fatalf("the issued token resolved to (%q, %v), want bob", got.OSUser, err)
	}
}

// The file is the verifier, and the token exists where the caller keeps it.
// Writing the token itself is the mistake this catches, and it costs that line
// rather than authenticating anyone.
func TestAPlaintextTokenInTheFileIsNotACredential(t *testing.T) {
	var buf bytes.Buffer
	old := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(old)

	g := bearerGate(t, "muse  "+museToken+"  bob\n")
	if got := g.bearerCreds(); len(got) != 0 {
		t.Fatalf("a plaintext token parsed into %d credentials, want 0", len(got))
	}
	if _, err := g.Resolve(bearerReq("Bearer", museToken)); !errors.Is(err, ErrNoIdentity) {
		t.Fatalf("err = %v, want the header path's ErrNoIdentity", err)
	}
	// The operator has to be able to find the line, and the line is the one
	// place a token could still be. So: which line, never its contents.
	logged := buf.String()
	if !strings.Contains(logged, "line 1") {
		t.Fatalf("the log does not say which line was skipped: %q", logged)
	}
	if strings.Contains(logged, museToken) || strings.Contains(logged, museToken[:8]) {
		t.Fatalf("the skipped line's token reached the log: %q", logged)
	}
}

// --- who may write the file -------------------------------------------------

// The other half of the same finding. Mode alone accepts 0600 owned by the
// service account, which is the simplest mode that lets User=wizard read it —
// and a file that account owns is a file it can append a line to. A line names
// any terminal account on the box, so appending one is how a process running
// as wizard would hold emo's sessions, files and skills through all six
// services. Root ownership is what makes the file an instruction from the
// operator rather than from whatever else shares the account.
func TestATokensFileTheServiceAccountOwnsIsIgnored(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("running as root: the fixture file is already root-owned")
	}
	g := bearerGate(t, fixtureTokens)
	if err := os.Chmod(g.Config.BearerTokensPath, 0o600); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	// The production rule, which bearerGate relaxed so the rest of the file
	// can test something else.
	g.TokensOwnerUID = 0
	if got := g.bearerCreds(); len(got) != 0 {
		t.Fatalf("a file owned by uid %d yielded %d credentials, want 0", os.Getuid(), len(got))
	}
	if _, err := g.Resolve(bearerReq("Bearer", museToken)); !errors.Is(err, ErrNoIdentity) {
		t.Fatalf("err = %v, want the header path's ErrNoIdentity", err)
	}
	// 0640 does not rescue it either: the mode says who may read, and this
	// rule is about who may write.
	if err := os.Chmod(g.Config.BearerTokensPath, 0o640); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	if got := g.bearerCreds(); len(got) != 0 {
		t.Fatalf("0640 owned by uid %d yielded %d credentials, want 0", os.Getuid(), len(got))
	}
}

// Root is the default rather than something a box opts into, because a rule
// every install has to remember to switch on is a rule no install has on.
func TestRootOwnershipIsTheDefaultAndNoSettingRelaxesIt(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("running as root: the fixture file is already root-owned")
	}
	if got := (&Gate{}).TokensOwnerUID; got != 0 {
		t.Fatalf("an unconfigured gate wants uid %d, want 0 (root)", got)
	}
	g := bearerGate(t, fixtureTokens)
	path := g.Config.BearerTokensPath
	// Everything an operator could reach for to make it read the file anyway.
	t.Setenv("TL_BEARER_TOKENS", path)
	t.Setenv("TL_MULTI_USER", "on")
	t.Setenv("TL_BEARER_TOKENS_OWNER", strconv.Itoa(os.Getuid()))
	t.Setenv("TL_TOKENS_OWNER_UID", strconv.Itoa(os.Getuid()))
	g.Config = Config{}
	g.TokensOwnerUID = 0
	g.Configure("test-service", "127.0.0.1:0")
	if g.TokensOwnerUID != 0 {
		t.Fatalf("the environment moved TokensOwnerUID to %d", g.TokensOwnerUID)
	}
	if got := g.bearerCreds(); len(got) != 0 {
		t.Fatalf("after Configure the gate read %d credentials out of a file it does not trust", len(got))
	}
}

// --- the length floor -------------------------------------------------------

// The floor used to be enforced on what the file held. A digest is 64 hex
// characters whatever it digests, so the floor moved to what the caller
// presents — otherwise it would have quietly stopped existing, and a digest of
// "1234" would be a working credential.
func TestAShortOrMalformedTokenIsRefusedEvenWhenItsDigestIsIssued(t *testing.T) {
	for _, token := range []string{
		"x",
		"1234",
		"=",
		"muse",
		strings.Repeat("a", 31),
		strings.Repeat("a", 29) + ";id",
		strings.Repeat("a", 513),
	} {
		g := bearerGate(t, "muse  "+BearerDigest(token)+"  bob\n")
		if _, err := g.Resolve(bearerReq("Bearer", token)); !errors.Is(err, ErrBadBearer) {
			t.Fatalf("a %d-character token %q authenticated: err = %v", len(token), token, err)
		}
	}
}

// --- the account a credential names ----------------------------------------

// The token file is root-owned, so this is defence in depth rather than a
// boundary — the same argument the act-as charset check makes. It is what stops
// a typo'd line handing out an account the lobby does not serve.
func TestACredentialMustNameATerminalAccount(t *testing.T) {
	for _, osUser := range []string{"root", "nobody", "carol"} {
		g := bearerGate(t, "muse  "+BearerDigest(museToken)+"  "+osUser+"\n")
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
		"== cred.token", "cred.token ==", "== c.digest", "c.digest ==",
		"== cred.digest", "cred.digest ==", "== want", "want ==",
	} {
		if strings.Contains(string(src), bad) {
			t.Fatalf("bearer.go compares a credential with %q; use subtle.ConstantTimeCompare", bad)
		}
	}
	// And the file holds a verifier rather than the token, so the comparison
	// has to be against a digest of what was presented.
	if !strings.Contains(string(src), "sha256.Sum256(") {
		t.Fatal("bearer.go does not hash the presented token; the file would have to hold tokens")
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
