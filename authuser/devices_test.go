package authuser

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Fixture device tokens, in the shape NewDeviceToken mints: the prefix and 43
// characters of base64url. Fixed bytes rather than random ones so a failure
// names the same token every run.
var (
	phoneToken  = DeviceTokenPrefix + base64.RawURLEncoding.EncodeToString([]byte(strings.Repeat("p", 32)))
	laptopToken = DeviceTokenPrefix + base64.RawURLEncoding.EncodeToString([]byte(strings.Repeat("l", 32)))
	strayToken  = DeviceTokenPrefix + base64.RawURLEncoding.EncodeToString([]byte(strings.Repeat("s", 32)))
)

// deviceNow is the clock every device test reads. The fixture devices were
// created a day before it, so they are well inside the idle limit unless a
// test moves one.
var deviceNow = time.Unix(1_900_000_000, 0)

func fixtureDevices() []Device {
	created := deviceNow.Add(-24 * time.Hour).Unix()
	return []Device{
		{ID: "a1b2c3d4e5f60718", User: "bob", Label: "Bob's phone", DeviceType: "mobile", OS: "ios",
			Digest: BearerDigest(phoneToken), Created: created},
		{ID: "0f1e2d3c4b5a6978", User: "alice", Label: "T3 desktop", DeviceType: "desktop", OS: "linux",
			Digest: BearerDigest(laptopToken), Created: created},
	}
}

// deviceGate is bearerGate with a device registry beside it. The user map gives
// bob the identity "bob.smith", so a test can tell the user's own name from
// the OS account and from the client's label. No tokens file is written: the
// two kinds of bearer must not depend on each other, and a box with devices and
// no machine credentials is the ordinary case.
func deviceGate(t *testing.T, devices []Device) *Gate {
	t.Helper()
	g := bearerGate(t, "")
	dir := filepath.Dir(g.AdminsPath)
	g.Config.DevicesPath = filepath.Join(dir, "devices.json")
	g.Config.DevicesSeenPath = filepath.Join(dir, "devices-seen.json")
	g.now = func() time.Time { return deviceNow }
	if devices != nil {
		writeDevices(t, g, devices)
	}
	return g
}

func writeDevices(t *testing.T, g *Gate, devices []Device) {
	t.Helper()
	raw, err := json.Marshal(DeviceRegistry{Devices: devices})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(g.Config.DevicesPath, raw, 0o600); err != nil {
		t.Fatalf("write devices: %v", err)
	}
}

func writeSeen(t *testing.T, g *Gate, seen map[string]int64) {
	t.Helper()
	raw, err := json.Marshal(seen)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(g.Config.DevicesSeenPath, raw, 0o600); err != nil {
		t.Fatalf("write seen: %v", err)
	}
}

// --- the token format -------------------------------------------------------

// The prefix is what routes a token to the registry, and tokenRe is the floor
// every bearer is held to before anything compares it. A minted token that
// tokenRe refused would be a device that can never authenticate.
func TestNewDeviceTokenHasThePrefixAndPassesTheBearerCharset(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 64; i++ {
		tok, err := NewDeviceToken()
		if err != nil {
			t.Fatalf("NewDeviceToken: %v", err)
		}
		if !strings.HasPrefix(tok, DeviceTokenPrefix) {
			t.Fatalf("token %q lacks the %s prefix", tok, DeviceTokenPrefix)
		}
		if len(tok) != len(DeviceTokenPrefix)+43 {
			t.Fatalf("token is %d characters, want %d", len(tok), len(DeviceTokenPrefix)+43)
		}
		if !tokenRe.MatchString(tok) {
			t.Fatalf("token %q fails the bearer charset", tok)
		}
		raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(tok, DeviceTokenPrefix))
		if err != nil || len(raw) != 32 {
			t.Fatalf("token body does not decode to 32 bytes: %v (%d)", err, len(raw))
		}
		if seen[tok] {
			t.Fatalf("token repeated after %d draws", i)
		}
		seen[tok] = true
	}
}

// --- a valid device ---------------------------------------------------------

func TestADeviceTokenResolvesToItsUser(t *testing.T) {
	g := deviceGate(t, fixtureDevices())
	for _, c := range []struct {
		name, token, wantUser, wantID, wantHeader string
	}{
		// bob's identity is bob.smith in the user map. The header is what
		// session-events shows other people as this person's name, so it is
		// the person's own identity, never the device label "Bob's phone".
		{"phone", phoneToken, "bob", "a1b2c3d4e5f60718", "bob.smith"},
		{"laptop", laptopToken, "alice", "0f1e2d3c4b5a6978", "alice"},
	} {
		got, err := g.Resolve(bearerReq("Bearer", c.token))
		if err != nil {
			t.Fatalf("%s: unexpected error %v", c.name, err)
		}
		if got.OSUser != c.wantUser || got.RealOSUser != c.wantUser {
			t.Fatalf("%s resolved to (%q, real %q), want %q", c.name, got.OSUser, got.RealOSUser, c.wantUser)
		}
		if got.Method != MethodDevice {
			t.Fatalf("%s: Method = %q, want %q", c.name, got.Method, MethodDevice)
		}
		if got.DeviceID != c.wantID {
			t.Fatalf("%s: DeviceID = %q, want %q", c.name, got.DeviceID, c.wantID)
		}
		if got.Header != c.wantHeader {
			t.Fatalf("%s: Header = %q, want the user's own name %q", c.name, got.Header, c.wantHeader)
		}
		if got.Admin {
			t.Fatalf("%s: a device was reported as an administrator", c.name)
		}
		if !got.MultiUser {
			t.Fatalf("%s: MultiUser = false on a multi-user gate", c.name)
		}
	}
}

// The header for a device is the reverse of the user map. With no key naming
// the account (single-user, or an account the map lists under no identity),
// the OS user is the name.
func TestADeviceHeaderFallsBackToTheOSUser(t *testing.T) {
	g := deviceGate(t, nil)
	// carol is a terminal account only through a key that is her own name.
	if err := os.WriteFile(g.MapPath, []byte("alice=alice\nbob.smith=bob\nzed=carol\ncarol=carol\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := g.identityNameFor("carol"); got != "carol" {
		t.Fatalf("identityNameFor(carol) = %q, want the key that is her own name", got)
	}
	if got := g.identityNameFor("bob"); got != "bob.smith" {
		t.Fatalf("identityNameFor(bob) = %q, want bob.smith", got)
	}
	if got := g.identityNameFor("nobody"); got != "nobody" {
		t.Fatalf("identityNameFor(nobody) = %q, want the OS user", got)
	}
	single := *g
	single.Config.MultiUser = "off"
	if got := single.identityNameFor("wizard"); got != "wizard" {
		t.Fatalf("single-user identityNameFor = %q, want the OS user", got)
	}
}

// --- what a device token is refused for ------------------------------------

func TestAnUnknownDeviceTokenIsRefused(t *testing.T) {
	g := deviceGate(t, fixtureDevices())
	for _, c := range []struct{ name, token string }{
		{"a token no device holds", strayToken},
		{"the bare prefix", DeviceTokenPrefix},
		{"a real token with its last byte changed", phoneToken[:len(phoneToken)-1] + "Q"},
		{"a real token with a byte appended", phoneToken + "A"},
		{"a real token cut short", phoneToken[:30]},
		{"the device id after the prefix", DeviceTokenPrefix + "a1b2c3d4e5f60718"},
		{"the stored digest after the prefix", DeviceTokenPrefix + strings.TrimPrefix(BearerDigest(phoneToken), "sha256:")},
	} {
		if _, err := g.Resolve(bearerReq("Bearer", c.token)); !errors.Is(err, ErrBadBearer) {
			t.Fatalf("%s: err = %v, want ErrBadBearer", c.name, err)
		}
	}
}

// The reason a device miss cannot fall through, the same reason bearer.go
// gives: the header path is satisfied by a header the caller sets and a secret
// that is not private to one caller. Unlike the file bearer there is no "the
// feature is off" exception: the prefix is this repo's own, so an absent or
// empty registry still answers a tld1_ token with 401.
func TestADeviceMissNeverFallsThroughToTheHeaderPath(t *testing.T) {
	for _, c := range []struct {
		name    string
		devices []Device
	}{
		{"registry with devices", fixtureDevices()},
		{"empty registry", []Device{}},
		{"no registry at all", nil},
	} {
		g := deviceGate(t, c.devices)
		g.Config.ProxySecret = "s3cret"
		r := req(DefaultAuthHeader, "alice", SecretHeader, "s3cret")
		r.Header.Set("Authorization", "Bearer "+strayToken)
		if _, err := g.Resolve(r); !errors.Is(err, ErrBadBearer) {
			t.Fatalf("%s: unknown device token beside a valid header and secret: err = %v, want ErrBadBearer", c.name, err)
		}
	}
}

// A tld1_ token is answered by the device registry alone. A file credential
// whose digest happens to match it must not authenticate it, and the tokens
// file is not even read.
func TestADeviceTokenNeverConsultsTheTokensFile(t *testing.T) {
	g := deviceGate(t, nil)
	writeTokens(t, g, "muse  "+BearerDigest(strayToken)+"  bob\n")
	reads := 0
	g.countTokenReads = func() { reads++ }
	if _, err := g.Resolve(bearerReq("Bearer", strayToken)); !errors.Is(err, ErrBadBearer) {
		t.Fatalf("a tld1_ token listed only in the tokens file: err = %v, want ErrBadBearer", err)
	}
	if reads != 0 {
		t.Fatalf("a tld1_ token read the tokens file %d times", reads)
	}
}

func TestADeviceMustNameATerminalAccount(t *testing.T) {
	devices := fixtureDevices()
	devices[0].User = "mallory" // not in the user map
	g := deviceGate(t, devices)
	if _, err := g.Resolve(bearerReq("Bearer", phoneToken)); !errors.Is(err, ErrNoAccount) {
		t.Fatalf("device naming an unmapped account: err = %v, want ErrNoAccount", err)
	}
	g.LookupUser = func(string) error { return errors.New("no such user") }
	if _, err := g.Resolve(bearerReq("Bearer", laptopToken)); !errors.Is(err, ErrNoSuchAccount) {
		t.Fatalf("device naming an absent account: err = %v, want ErrNoSuchAccount", err)
	}
}

func TestADeviceCannotActAsAnotherUser(t *testing.T) {
	g := deviceGate(t, fixtureDevices())
	var refused []string
	g.OnActAsRefused = func(real, target, _ string) { refused = append(refused, real+">"+target) }
	r := bearerReq("Bearer", laptopToken) // alice administers the box
	r.URL.RawQuery = "as=bob"
	if _, err := g.Resolve(r); !errors.Is(err, ErrNotAdmin) {
		t.Fatalf("device with ?as=bob: err = %v, want ErrNotAdmin", err)
	}
	if len(refused) != 1 || refused[0] != "alice>bob" {
		t.Fatalf("refusal reported as %v, want [alice>bob]", refused)
	}
	r = bearerReq("Bearer", laptopToken)
	r.URL.RawQuery = "as=alice"
	if got, err := g.Resolve(r); err != nil || got.OSUser != "alice" {
		t.Fatalf("device naming its own user in ?as=: (%q, %v)", got.OSUser, err)
	}
}

// --- the registry file's owner and mode ------------------------------------

// The registry has one writer, tmux-api, running as the service account, so
// the file must belong to the account this process runs as and be readable by
// nobody else. Anything else is no devices, not an error.
func TestARegistryWithTheWrongOwnerOrModeHoldsNoDevices(t *testing.T) {
	for _, c := range []struct {
		name  string
		mode  os.FileMode
		owner func() int
	}{
		{"group-readable", 0o640, nil},
		{"world-readable", 0o644, nil},
		{"group-writable", 0o620, nil},
		{"owned by another uid", 0o600, func() int { return os.Getuid() + 1 }},
	} {
		g := deviceGate(t, fixtureDevices())
		if err := os.Chmod(g.Config.DevicesPath, c.mode); err != nil {
			t.Fatal(err)
		}
		g.devicesOwnerUID = c.owner
		if got := g.devices(); len(got) != 0 {
			t.Fatalf("%s: registry yielded %d devices, want 0", c.name, len(got))
		}
		if _, err := g.Resolve(bearerReq("Bearer", phoneToken)); !errors.Is(err, ErrBadBearer) {
			t.Fatalf("%s: err = %v, want ErrBadBearer", c.name, err)
		}
	}
	// 0400 is tighter than 0600 and is accepted.
	g := deviceGate(t, fixtureDevices())
	if err := os.Chmod(g.Config.DevicesPath, 0o400); err != nil {
		t.Fatal(err)
	}
	if got := g.devices(); len(got) != 2 {
		t.Fatalf("0400 registry yielded %d devices, want 2", len(got))
	}
}

// The owner rule is the uid of this process, with no setting that moves it.
func TestTheRegistryOwnerIsThisProcessAndNoSettingMovesIt(t *testing.T) {
	g := deviceGate(t, fixtureDevices())
	if g.devicesOwnerUID != nil {
		t.Fatal("deviceGate installed an owner seam; the production rule is untested")
	}
	if got := g.devicesOwner(); got != os.Getuid() {
		t.Fatalf("devicesOwner = %d, want this process's uid %d", got, os.Getuid())
	}
	if got := len(g.devices()); got != 2 {
		t.Fatalf("a registry this process owns yielded %d devices, want 2", got)
	}
}

// A malformed record costs that record, the way a bad tokens line does.
func TestAMalformedDeviceRecordIsSkipped(t *testing.T) {
	devices := fixtureDevices()
	bad := []Device{
		{ID: "not-hex!", User: "bob", Digest: BearerDigest(strayToken), Created: devices[0].Created},
		{ID: "1111111111111111", User: "-rf", Digest: BearerDigest(strayToken), Created: devices[0].Created},
		{ID: "2222222222222222", User: "bob", Digest: strayToken, Created: devices[0].Created},
	}
	g := deviceGate(t, append(bad, devices...))
	if got := len(g.devices()); got != 2 {
		t.Fatalf("registry with three bad records yielded %d devices, want the 2 good ones", got)
	}
	if _, err := g.Resolve(bearerReq("Bearer", strayToken)); !errors.Is(err, ErrBadBearer) {
		t.Fatalf("token of a malformed record: err = %v, want ErrBadBearer", err)
	}
	if _, err := g.Resolve(bearerReq("Bearer", phoneToken)); err != nil {
		t.Fatalf("a good record beside bad ones: %v", err)
	}
	// And a file that is not JSON at all is no devices.
	if err := os.WriteFile(g.Config.DevicesPath, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := len(g.devices()); got != 0 {
		t.Fatalf("corrupt registry yielded %d devices", got)
	}
}

// --- the idle limit ---------------------------------------------------------

// T3 clients never refresh a token, so a device has no fixed expiry. One that
// has not been used for DeviceIdleLimit stops working. Last use is the seen
// file's entry, else the day the device was paired.
func TestAnIdleDeviceIsRefused(t *testing.T) {
	day := 24 * time.Hour
	for _, c := range []struct {
		name    string
		created time.Duration // before deviceNow
		seen    time.Duration // before deviceNow; 0 means no entry
		ok      bool
	}{
		{"paired yesterday, never seen", day, 0, true},
		{"paired 89 days ago, never seen", 89 * day, 0, true},
		{"paired 91 days ago, never seen", 91 * day, 0, false},
		{"paired 200 days ago, seen yesterday", 200 * day, day, true},
		{"paired 200 days ago, seen 91 days ago", 200 * day, 91 * day, false},
		{"paired a year ago, seen exactly at the limit", 365 * day, DeviceIdleLimit, true},
		{"paired a year ago, seen a second past the limit", 365 * day, DeviceIdleLimit + time.Second, false},
	} {
		devices := fixtureDevices()
		devices[0].Created = deviceNow.Add(-c.created).Unix()
		g := deviceGate(t, devices)
		if c.seen != 0 {
			writeSeen(t, g, map[string]int64{devices[0].ID: deviceNow.Add(-c.seen).Unix()})
		}
		_, err := g.Resolve(bearerReq("Bearer", phoneToken))
		if c.ok && err != nil {
			t.Fatalf("%s: unexpected error %v", c.name, err)
		}
		if !c.ok && !errors.Is(err, ErrBadBearer) {
			t.Fatalf("%s: err = %v, want ErrBadBearer", c.name, err)
		}
	}
}

// The seen file is what keeps a device in use alive. Refreshing it brings an
// idle device back, which is the same thing as it never having gone idle.
func TestTheSeenFileRefreshesADevice(t *testing.T) {
	devices := fixtureDevices()
	devices[0].Created = deviceNow.Add(-120 * 24 * time.Hour).Unix()
	g := deviceGate(t, devices)
	if _, err := g.Resolve(bearerReq("Bearer", phoneToken)); !errors.Is(err, ErrBadBearer) {
		t.Fatalf("idle device with no seen entry: err = %v, want ErrBadBearer", err)
	}
	writeSeen(t, g, map[string]int64{devices[0].ID: deviceNow.Add(-time.Hour).Unix()})
	if _, err := g.Resolve(bearerReq("Bearer", phoneToken)); err != nil {
		t.Fatalf("after a seen entry an hour old: %v", err)
	}
	// A seen file this process does not trust is no entries, which leaves the
	// device as idle as its creation date says.
	if err := os.Chmod(g.Config.DevicesSeenPath, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Resolve(bearerReq("Bearer", phoneToken)); !errors.Is(err, ErrBadBearer) {
		t.Fatalf("world-readable seen file: err = %v, want ErrBadBearer", err)
	}
}

// --- the hook and the hot path ---------------------------------------------

// tmux-api records last use from this hook. It fires on a successful device
// resolve and on nothing else.
func TestOnDeviceUsedFiresForADeviceOnly(t *testing.T) {
	g := deviceGate(t, fixtureDevices())
	writeTokens(t, g, fixtureTokens)
	var used []string
	g.OnDeviceUsed = func(id string) { used = append(used, id) }

	if _, err := g.Resolve(bearerReq("Bearer", phoneToken)); err != nil {
		t.Fatal(err)
	}
	_, _ = g.Resolve(bearerReq("Bearer", strayToken))
	if _, err := g.Resolve(bearerReq("Bearer", museToken)); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Resolve(req(DefaultAuthHeader, "alice")); err != nil {
		t.Fatal(err)
	}
	if len(used) != 1 || used[0] != "a1b2c3d4e5f60718" {
		t.Fatalf("OnDeviceUsed fired with %v, want just the phone", used)
	}
}

// Every browser request carries no Authorization header, and a file bearer has
// no prefix. Neither may gain a read of the registry.
func TestOnlyADeviceTokenReadsTheRegistry(t *testing.T) {
	g := deviceGate(t, fixtureDevices())
	writeTokens(t, g, fixtureTokens)
	reads := 0
	g.countDeviceReads = func() { reads++ }

	if _, err := g.Resolve(req(DefaultAuthHeader, "alice")); err != nil {
		t.Fatal(err)
	}
	r := req(DefaultAuthHeader, "alice")
	r.Header.Set("Authorization", "Basic dXNlcjpwYXNz")
	if _, err := g.Resolve(r); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Resolve(bearerReq("Bearer", museToken)); err != nil {
		t.Fatal(err)
	}
	if reads != 0 {
		t.Fatalf("requests with no device token read the registry %d times", reads)
	}
	if _, err := g.Resolve(bearerReq("Bearer", phoneToken)); err != nil {
		t.Fatal(err)
	}
	if reads != 1 {
		t.Fatalf("a device request read the registry %d times, want 1", reads)
	}
}

// Every device is compared whichever one matches, for matchBearer's reason.
func TestEveryDeviceIsComparedWhicheverMatches(t *testing.T) {
	for _, token := range []string{phoneToken, laptopToken, strayToken} {
		g := deviceGate(t, fixtureDevices())
		compares := 0
		g.countTokenCompares = func() { compares++ }
		_, _ = g.Resolve(bearerReq("Bearer", token))
		if compares != 2 {
			t.Fatalf("token %s…: %d comparisons, want 2", token[:8], compares)
		}
	}
}

// --- Method on every path ---------------------------------------------------

func TestMethodNamesTheCredentialThatAnswered(t *testing.T) {
	g := deviceGate(t, fixtureDevices())
	writeTokens(t, g, fixtureTokens)
	single := resolveGate(t, Config{MultiUser: "off"}, "", "")

	for _, c := range []struct {
		name string
		gate *Gate
		r    *http.Request
		want string
	}{
		{"identity header, multi-user", g, req(DefaultAuthHeader, "alice"), MethodBrowser},
		{"identity header, single-user", single, req(DefaultAuthHeader, "anyone"), MethodBrowser},
		{"file bearer", g, bearerReq("Bearer", museToken), MethodToken},
		{"device", g, bearerReq("Bearer", phoneToken), MethodDevice},
	} {
		got, err := c.gate.Resolve(c.r)
		if err != nil {
			t.Fatalf("%s: unexpected error %v", c.name, err)
		}
		if got.Method != c.want {
			t.Fatalf("%s: Method = %q, want %q", c.name, got.Method, c.want)
		}
		if c.want != MethodDevice && got.DeviceID != "" {
			t.Fatalf("%s: DeviceID = %q on a non-device identity", c.name, got.DeviceID)
		}
	}
}

func TestAuthorizeAnswers401ForAnUnknownDevice(t *testing.T) {
	g := deviceGate(t, fixtureDevices())
	rec := httptest.NewRecorder()
	if _, ok := g.Authorize(rec, bearerReq("Bearer", strayToken)); ok {
		t.Fatal("Authorize admitted an unknown device")
	}
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status %d, want 401", rec.Code)
	}
	if strings.Contains(rec.Body.String(), strayToken) {
		t.Fatal("the token reached the response body")
	}
}

// --- configuration ----------------------------------------------------------

func TestDevicePathsComeFromTheEnvironment(t *testing.T) {
	t.Setenv("TL_DEVICES", " /srv/devices.json ")
	t.Setenv("TL_DEVICES_SEEN", "/srv/seen.json")
	cfg := ConfigFromEnv()
	if cfg.DevicesPath != "/srv/devices.json" || cfg.DevicesSeenPath != "/srv/seen.json" {
		t.Fatalf("config = (%q, %q)", cfg.DevicesPath, cfg.DevicesSeenPath)
	}
	g := &Gate{}
	if g.DevicesPath() != DefaultDevicesPath || g.DevicesSeenPath() != DefaultDevicesSeenPath {
		t.Fatalf("unconfigured gate reads (%q, %q)", g.DevicesPath(), g.DevicesSeenPath())
	}
	if filepath.Dir(DefaultDevicesPath) != filepath.Dir(DefaultDevicesSeenPath) {
		t.Fatal("the registry and the seen file belong in one state directory")
	}
}

func TestValidDeviceID(t *testing.T) {
	for id, want := range map[string]bool{
		"a1b2c3d4e5f60718": true, "A1B2C3D4E5F60718": false, "a1b2": false,
		"a1b2c3d4e5f6071g": false, "": false, "../../etc/passwd": false,
	} {
		if got := ValidDeviceID(id); got != want {
			t.Errorf("ValidDeviceID(%q) = %v, want %v", id, got, want)
		}
	}
}
