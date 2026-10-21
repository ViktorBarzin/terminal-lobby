package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"terminal-lobby/authuser"
)

// deviceWorld is one hermetic box for the pairing tests: a user map naming the
// test's own account as "viktor" (an administrator) and a second account, a
// registry under a fresh state directory, and a clock the test moves.
//
// The clock starts at the real time rather than a fixed one. tmux-api stamps a
// new device with deviceNow, and the gate judges the 90-day idle limit by its
// own real clock, so a fixed date years away would make every fresh device
// idle on arrival.
type deviceWorld struct {
	t         *testing.T
	me, other string
	now       time.Time
	stateDir  string
}

func newDeviceWorld(t *testing.T) *deviceWorld {
	t.Helper()
	me, other := twoLocalUsers(t)
	withUserMap(t, fmt.Sprintf("viktor=%s\notherauth=%s\n", me, other))
	withAdmins(t, me+"\n")
	w := &deviceWorld{t: t, me: me, other: other, now: time.Now()}
	// A directory that does not exist yet: the writer must create it, 0700.
	w.stateDir = filepath.Join(t.TempDir(), "terminal-lobby")

	old := actAsGate
	next := *actAsGate
	next.Config.DevicesPath = filepath.Join(w.stateDir, "devices.json")
	next.Config.DevicesSeenPath = filepath.Join(w.stateDir, "devices-seen.json")
	wireDeviceGate(&next)
	actAsGate = &next

	oldNow, oldCodes, oldSeen := deviceNow, pairCodes, deviceSeen
	deviceNow = func() time.Time { return w.now }
	pairCodes = newPairBook()
	deviceSeen = newSeenRecorder()
	t.Cleanup(func() {
		actAsGate = old
		deviceNow, pairCodes, deviceSeen = oldNow, oldCodes, oldSeen
	})
	return w
}

func (w *deviceWorld) browser(method, path, body string) *http.Request {
	return projectsReq(method, path, body, "viktor")
}

func deviceReq(method, path, token string) *http.Request {
	r := httptest.NewRequest(method, path, nil)
	r.Header.Set("Authorization", "Bearer "+token)
	return r
}

// serve runs one request through the mux registerRoutes builds, so every test
// here also proves the route is reachable.
func serve(r *http.Request) *httptest.ResponseRecorder {
	mux := http.NewServeMux()
	registerRoutes(mux)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, r)
	return rec
}

// pair mints a code as the signed-in browser and returns it.
func (w *deviceWorld) pair() string {
	w.t.Helper()
	rec := serve(w.browser(http.MethodPost, "/devices/pair", ""))
	if rec.Code != http.StatusOK {
		w.t.Fatalf("pair: %d %s", rec.Code, rec.Body.String())
	}
	var got struct {
		Code      string `json:"code"`
		ExpiresAt int64  `json:"expiresAt"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		w.t.Fatalf("pair body: %v", err)
	}
	return got.Code
}

// exchange posts a code from loopback, the way the sidecar does.
func exchange(body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, "/devices/exchange", strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:41234"
	return serve(r)
}

type exchanged struct {
	Token     string `json:"token"`
	ID        string `json:"id"`
	User      string `json:"user"`
	ExpiresIn *int64 `json:"expiresIn"`
	Error     string `json:"error"`
}

func decodeExchange(t *testing.T, rec *httptest.ResponseRecorder) exchanged {
	t.Helper()
	var got exchanged
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("exchange body %q: %v", rec.Body.String(), err)
	}
	return got
}

// paired runs the whole flow and returns the new device's token and id.
func (w *deviceWorld) paired(label string) (string, string) {
	w.t.Helper()
	code := w.pair()
	rec := exchange(fmt.Sprintf(`{"code":%q,"label":%q,"deviceType":"mobile","os":"android"}`, code, label))
	if rec.Code != http.StatusOK {
		w.t.Fatalf("exchange: %d %s", rec.Code, rec.Body.String())
	}
	got := decodeExchange(w.t, rec)
	return got.Token, got.ID
}

func (w *deviceWorld) registry() authuser.DeviceRegistry {
	w.t.Helper()
	reg, err := loadDeviceRegistry(actAsGate.DevicesPath())
	if err != nil {
		w.t.Fatalf("load registry: %v", err)
	}
	return reg
}

func (w *deviceWorld) seen() map[string]int64 {
	w.t.Helper()
	seen, err := loadDeviceSeen(actAsGate.DevicesSeenPath())
	if err != nil {
		w.t.Fatalf("load seen: %v", err)
	}
	return seen
}

// --- pairing codes -----------------------------------------------------------

func TestPairMintsACodeForTheSignedInBrowser(t *testing.T) {
	w := newDeviceWorld(t)
	rec := serve(w.browser(http.MethodPost, "/devices/pair", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("pair: %d %s", rec.Code, rec.Body.String())
	}
	var got struct {
		Code      string `json:"code"`
		ExpiresAt int64  `json:"expiresAt"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Code) != pairCodeLen {
		t.Fatalf("code %q is %d characters, want %d", got.Code, len(got.Code), pairCodeLen)
	}
	for _, c := range got.Code {
		if !strings.ContainsRune(pairCodeAlphabet, c) {
			t.Fatalf("code %q has %q, outside the alphabet", got.Code, c)
		}
	}
	if want := w.now.Add(pairCodeTTL).Unix(); got.ExpiresAt != want {
		t.Fatalf("expiresAt %d, want %d", got.ExpiresAt, want)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control %q, want no-store on a response carrying a code", cc)
	}
	if rec := serve(w.browser(http.MethodGet, "/devices/pair", "")); rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET /devices/pair: %d, want 405", rec.Code)
	}
}

// Every character of the alphabet turns up, and none outside it. The alphabet
// has 32 characters, so the draw from a random byte is unbiased; this is the
// cheap half of checking that, the half that catches an off-by-one.
func TestPairCodesCoverTheWholeAlphabet(t *testing.T) {
	seen := map[rune]bool{}
	for i := 0; i < 400; i++ {
		code, err := newPairCode()
		if err != nil {
			t.Fatal(err)
		}
		for _, c := range code {
			seen[c] = true
		}
	}
	if len(seen) != len(pairCodeAlphabet) {
		t.Fatalf("400 codes used %d distinct characters, want all %d", len(seen), len(pairCodeAlphabet))
	}
	for c := range seen {
		if !strings.ContainsRune(pairCodeAlphabet, c) {
			t.Fatalf("character %q is outside the alphabet", c)
		}
	}
}

// Only a signed-in person can pair. A paired device must never mint another,
// and a machine credential has no person behind it.
func TestDeviceRoutesRefuseEveryBearer(t *testing.T) {
	w := newDeviceWorld(t)
	token, id := w.paired("Pixel")

	// A tokens-file credential. A test cannot write a root-owned file, so the
	// gate's owner rule moves to this uid for this test only.
	machine := "machine-00000000000000000000000000000001"
	tokens := filepath.Join(t.TempDir(), "tokens")
	if err := os.WriteFile(tokens, []byte("muse "+authuser.BearerDigest(machine)+" "+w.me+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	next := *actAsGate
	next.Config.BearerTokensPath = tokens
	next.TokensOwnerUID = os.Getuid()
	old := actAsGate
	actAsGate = &next
	t.Cleanup(func() { actAsGate = old })

	for _, bearer := range []struct{ name, token string }{{"device", token}, {"file credential", machine}} {
		for _, c := range []struct{ method, path string }{
			{http.MethodPost, "/devices/pair"},
			{http.MethodGet, "/devices"},
			{http.MethodDelete, "/devices/" + id},
		} {
			rec := serve(deviceReq(c.method, c.path, bearer.token))
			if rec.Code != http.StatusForbidden {
				t.Fatalf("%s on %s %s: %d, want 403", bearer.name, c.method, c.path, rec.Code)
			}
		}
	}
	if len(w.registry().Devices) != 1 {
		t.Fatal("a refused bearer changed the registry")
	}
}

// Pairing hands out a credential for the account that holds it, so a lens tab
// (an administrator acting as someone else) is refused rather than pairing an
// app to the other person's account or quietly to the admin's own.
func TestPairIsRefusedUnderActAs(t *testing.T) {
	w := newDeviceWorld(t)
	for _, path := range []string{"/devices/pair?as=" + w.other, "/devices?as=" + w.other} {
		method := http.MethodPost
		if !strings.HasPrefix(path, "/devices/pair") {
			method = http.MethodGet
		}
		rec := serve(w.browser(method, path, ""))
		if rec.Code != http.StatusForbidden {
			t.Fatalf("%s %s: %d, want 403", method, path, rec.Code)
		}
	}
	// Naming yourself is not acting as anyone.
	if rec := serve(w.browser(http.MethodPost, "/devices/pair?as="+w.me, "")); rec.Code != http.StatusOK {
		t.Fatalf("pair with ?as= naming yourself: %d", rec.Code)
	}
}

func TestOutstandingCodesAreCappedPerUser(t *testing.T) {
	w := newDeviceWorld(t)
	for i := 0; i < maxPairCodesPerUser; i++ {
		w.pair()
	}
	if rec := serve(w.browser(http.MethodPost, "/devices/pair", "")); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("code %d past the cap: %d, want 429", maxPairCodesPerUser+1, rec.Code)
	}
	// Expired codes stop counting.
	w.now = w.now.Add(pairCodeTTL + time.Second)
	w.pair()
}

// --- the exchange ------------------------------------------------------------

func TestExchangeCreatesADeviceAndItsTokenWorks(t *testing.T) {
	w := newDeviceWorld(t)
	code := w.pair()
	rec := exchange(`{"code":"` + code + `","label":"Pixel 8","deviceType":"mobile","os":"android"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("exchange: %d %s", rec.Code, rec.Body.String())
	}
	got := decodeExchange(t, rec)
	if !strings.HasPrefix(got.Token, authuser.DeviceTokenPrefix) || !authuser.ValidDeviceID(got.ID) {
		t.Fatalf("exchange answered %+v", got)
	}
	if got.User != w.me {
		t.Fatalf("device user %q, want %q", got.User, w.me)
	}
	if got.ExpiresIn == nil || *got.ExpiresIn != 0 {
		t.Fatalf("expiresIn %v, want 0", got.ExpiresIn)
	}

	reg := w.registry()
	if len(reg.Devices) != 1 {
		t.Fatalf("registry holds %d devices, want 1", len(reg.Devices))
	}
	d := reg.Devices[0]
	if d.ID != got.ID || d.User != w.me || d.Label != "Pixel 8" || d.DeviceType != "mobile" || d.OS != "android" {
		t.Fatalf("stored %+v", d)
	}
	if d.Digest != authuser.BearerDigest(got.Token) || d.Created != w.now.Unix() {
		t.Fatalf("stored digest/created %q/%d", d.Digest, d.Created)
	}
	raw, _ := os.ReadFile(actAsGate.DevicesPath())
	if strings.Contains(string(raw), got.Token) || strings.Contains(string(raw), code) {
		t.Fatal("the token or the code was written to the registry")
	}
	for path, want := range map[string]os.FileMode{w.stateDir: 0o700, actAsGate.DevicesPath(): 0o600} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != want {
			t.Fatalf("%s is %04o, want %04o", path, info.Mode().Perm(), want)
		}
	}

	// The token authenticates through the gate every service shares.
	id, err := actAsGate.Resolve(deviceReq(http.MethodGet, "/whoami", got.Token))
	if err != nil || id.OSUser != w.me || id.Method != authuser.MethodDevice {
		t.Fatalf("resolving the new token: (%+v, %v)", id, err)
	}
}

func TestExchangeIsLoopbackOnly(t *testing.T) {
	w := newDeviceWorld(t)
	code := w.pair()
	for _, addr := range []string{"192.0.2.7:5000", "10.0.0.5:5000", "[2001:db8::1]:5000", "garbage"} {
		r := httptest.NewRequest(http.MethodPost, "/devices/exchange", strings.NewReader(`{"code":"`+code+`"}`))
		r.RemoteAddr = addr
		rec := serve(r)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("exchange from %s: %d, want 403", addr, rec.Code)
		}
	}
	// Loopback is not enough on the container install, where nginx reaches
	// this service from 127.0.0.1 on behalf of anyone. A request a proxy
	// forwarded says so in a header, and tl-t3-view sends none of them.
	for _, h := range []string{"X-Real-IP", "X-Forwarded-For", "Forwarded"} {
		r := httptest.NewRequest(http.MethodPost, "/devices/exchange", strings.NewReader(`{"code":"`+code+`"}`))
		r.RemoteAddr = "127.0.0.1:5000"
		r.Header.Set(h, "203.0.113.9")
		if rec := serve(r); rec.Code != http.StatusForbidden {
			t.Fatalf("loopback exchange carrying %s: %d, want 403", h, rec.Code)
		}
	}
	// None of those consumed the code.
	if rec := exchange(`{"code":"` + code + `"}`); rec.Code != http.StatusOK {
		t.Fatalf("exchange from loopback after refused remote attempts: %d", rec.Code)
	}
	r := httptest.NewRequest(http.MethodPost, "/devices/exchange", nil)
	r.RemoteAddr = "[::1]:5000"
	if rec := serve(r); rec.Code == http.StatusForbidden {
		t.Fatal("IPv6 loopback was refused as remote")
	}
}

func TestACodeIsSingleUse(t *testing.T) {
	w := newDeviceWorld(t)
	code := w.pair()
	if rec := exchange(`{"code":"` + code + `"}`); rec.Code != http.StatusOK {
		t.Fatalf("first exchange: %d", rec.Code)
	}
	rec := exchange(`{"code":"` + code + `"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("second exchange: %d, want 401", rec.Code)
	}
	if got := decodeExchange(t, rec); got.Error == "" || got.Token != "" {
		t.Fatalf("second exchange answered %+v, want a JSON error and no token", got)
	}
	if rec.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("401 Content-Type %q, want JSON", rec.Header().Get("Content-Type"))
	}
	if n := len(w.registry().Devices); n != 1 {
		t.Fatalf("registry holds %d devices after a replayed code, want 1", n)
	}
}

func TestACodeExpiresAfterFiveMinutes(t *testing.T) {
	w := newDeviceWorld(t)
	fresh, stale := w.pair(), w.pair()
	w.now = w.now.Add(pairCodeTTL - time.Second)
	if rec := exchange(`{"code":"` + fresh + `"}`); rec.Code != http.StatusOK {
		t.Fatalf("a code one second from expiry: %d", rec.Code)
	}
	w.now = w.now.Add(time.Second)
	if rec := exchange(`{"code":"` + stale + `"}`); rec.Code != http.StatusUnauthorized {
		t.Fatalf("a code at its expiry: %d, want 401", rec.Code)
	}
}

func TestExchangeRefusesWhatIsNotAnIssuedCode(t *testing.T) {
	w := newDeviceWorld(t)
	w.pair()
	for _, body := range []string{
		`{"code":"ABCDEFGHJKLM"}`, // the right shape, never issued
		`{"code":""}`,
		`{}`,
		`{"code":"0O1I0O1I0O1I"}`, // outside the alphabet
	} {
		if rec := exchange(body); rec.Code != http.StatusUnauthorized {
			t.Fatalf("exchange %s: %d, want 401", body, rec.Code)
		}
	}
	if rec := exchange(`not json`); rec.Code != http.StatusBadRequest {
		t.Fatalf("exchange with a body that is not JSON: %d, want 400", rec.Code)
	}
	if len(w.registry().Devices) != 0 {
		t.Fatal("a refused exchange created a device")
	}
}

// People read a code off one screen and type it on another. Case and the
// separators a display might add are forgiven.
func TestExchangeForgivesCaseAndSeparators(t *testing.T) {
	w := newDeviceWorld(t)
	code := w.pair()
	typed := strings.ToLower(code[:4]) + "-" + code[4:8] + " " + code[8:]
	if rec := exchange(`{"code":"` + typed + `"}`); rec.Code != http.StatusOK {
		t.Fatalf("exchange %q for %q: %d", typed, code, rec.Code)
	}
}

// The label is the client's own words, shown in the owner's Settings.
func TestExchangeCleansTheLabel(t *testing.T) {
	w := newDeviceWorld(t)
	long := strings.Repeat("é", maxDeviceLabelRunes+20)
	for _, c := range []struct{ label, want string }{
		{"  Pixel\n8\t ", "Pixel8"},
		{"Phone‮evil", "Phoneevil"},
		{long, strings.Repeat("é", maxDeviceLabelRunes)},
		{"", "T3 app"},
		{"\x00\x01", "T3 app"},
	} {
		code := w.pair()
		body, _ := json.Marshal(map[string]string{"code": code, "label": c.label, "deviceType": strings.Repeat("d", 100), "os": "ios\n"})
		rec := exchange(string(body))
		if rec.Code != http.StatusOK {
			t.Fatalf("label %q: %d", c.label, rec.Code)
		}
		id := decodeExchange(t, rec).ID
		for _, d := range w.registry().Devices {
			if d.ID != id {
				continue
			}
			if d.Label != c.want {
				t.Fatalf("label %q stored as %q, want %q", c.label, d.Label, c.want)
			}
			if utf8.RuneCountInString(d.DeviceType) != maxDeviceFieldRunes || d.OS != "ios" {
				t.Fatalf("deviceType/os stored as %q/%q", d.DeviceType, d.OS)
			}
		}
	}
}

// --- list and revoke ---------------------------------------------------------

func TestListShowsOnlyYourOwnDevicesAndNoDigests(t *testing.T) {
	w := newDeviceWorld(t)
	_, mine := w.paired("Pixel")
	if err := updateDevices(func(reg *authuser.DeviceRegistry) error {
		reg.Devices = append(reg.Devices, authuser.Device{
			ID: "ffffffffffffffff", User: w.other, Label: "theirs",
			Digest: authuser.BearerDigest("tld1_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"), Created: w.now.Unix(),
		})
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	rec := serve(w.browser(http.MethodGet, "/devices", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("list: %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "sha256") || strings.Contains(rec.Body.String(), "digest") {
		t.Fatalf("list exposed a digest: %s", rec.Body.String())
	}
	var got []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0]["id"] != mine || got[0]["label"] != "Pixel" {
		t.Fatalf("list = %v, want only %s", got, mine)
	}
	for _, k := range []string{"id", "label", "deviceType", "os", "created", "lastSeen"} {
		if _, ok := got[0][k]; !ok {
			t.Fatalf("list entry lacks %q: %v", k, got[0])
		}
	}
	if len(got[0]) != 6 {
		t.Fatalf("list entry has fields beyond the six: %v", got[0])
	}
}

func TestDeleteRevokesYourOwnDeviceOnly(t *testing.T) {
	w := newDeviceWorld(t)
	token, mine := w.paired("Pixel")
	theirs := "eeeeeeeeeeeeeeee"
	if err := updateDevices(func(reg *authuser.DeviceRegistry) error {
		reg.Devices = append(reg.Devices, authuser.Device{
			ID: theirs, User: w.other, Label: "theirs",
			Digest: authuser.BearerDigest("tld1_yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"), Created: w.now.Unix(),
		})
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	if rec := serve(w.browser(http.MethodDelete, "/devices/"+theirs, "")); rec.Code != http.StatusNotFound {
		t.Fatalf("deleting another user's device: %d, want 404", rec.Code)
	}
	for _, bad := range []string{"/devices/nothex", "/devices/", "/devices/" + mine + "/x"} {
		if rec := serve(w.browser(http.MethodDelete, bad, "")); rec.Code != http.StatusNotFound {
			t.Fatalf("DELETE %s: %d, want 404", bad, rec.Code)
		}
	}
	if len(w.registry().Devices) != 2 {
		t.Fatal("a refused delete changed the registry")
	}

	// The token works, the owner revokes it, and it stops.
	if rec := serve(deviceReq(http.MethodGet, "/whoami", token)); rec.Code != http.StatusOK {
		t.Fatalf("whoami before revoke: %d", rec.Code)
	}
	if rec := serve(w.browser(http.MethodDelete, "/devices/"+mine, "")); rec.Code != http.StatusNoContent {
		t.Fatalf("deleting your own device: %d, want 204", rec.Code)
	}
	if rec := serve(deviceReq(http.MethodGet, "/whoami", token)); rec.Code != http.StatusUnauthorized {
		t.Fatalf("whoami after revoke: %d, want 401", rec.Code)
	}
	reg := w.registry()
	if len(reg.Devices) != 1 || reg.Devices[0].ID != theirs {
		t.Fatalf("registry after revoke: %+v", reg.Devices)
	}
	if _, ok := w.seen()[mine]; ok {
		t.Fatal("the revoked device kept its last-use entry")
	}
	if rec := serve(w.browser(http.MethodDelete, "/devices/"+mine, "")); rec.Code != http.StatusNotFound {
		t.Fatalf("deleting it twice: %d, want 404", rec.Code)
	}
	if rec := serve(w.browser(http.MethodGet, "/devices/"+mine, "")); rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET /devices/{id}: %d, want 405", rec.Code)
	}
}

// --- the single writer -------------------------------------------------------

// Every write re-reads the file under the lock, so an entry another writer
// added since this process last looked survives.
func TestTheWriterReReadsBeforeItModifies(t *testing.T) {
	w := newDeviceWorld(t)
	w.paired("first")
	reg := w.registry()
	reg.Devices = append(reg.Devices, authuser.Device{
		ID: "dddddddddddddddd", User: w.me, Label: "added elsewhere",
		Digest: authuser.BearerDigest("tld1_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"), Created: w.now.Unix(),
	})
	if err := writeAtomicJSON(w.stateDir, "test.*.tmp", actAsGate.DevicesPath(), reg); err != nil {
		t.Fatal(err)
	}
	w.paired("second")
	if n := len(w.registry().Devices); n != 3 {
		t.Fatalf("registry holds %d devices, want 3 (the outside write survived)", n)
	}
}

// Pairs and a revoke racing each other: every pair lands, and the revoked
// device stays gone. Run under -race.
func TestConcurrentWritesDoNotResurrectADeletedDevice(t *testing.T) {
	w := newDeviceWorld(t)
	token, victim := w.paired("victim")

	const n = 16
	// The per-user cap on outstanding codes is not what this test is about.
	pairCodes.perUser = n
	codes := make([]string, 0, n)
	for i := 0; i < n; i++ {
		codes = append(codes, w.pair())
	}
	var wg sync.WaitGroup
	errs := make(chan string, n+2)
	for _, code := range codes {
		wg.Add(1)
		go func(code string) {
			defer wg.Done()
			if rec := exchange(`{"code":"` + code + `"}`); rec.Code != http.StatusOK {
				errs <- fmt.Sprintf("exchange: %d %s", rec.Code, rec.Body.String())
			}
		}(code)
	}
	wg.Add(2)
	go func() {
		defer wg.Done()
		if rec := serve(w.browser(http.MethodDelete, "/devices/"+victim, "")); rec.Code != http.StatusNoContent {
			errs <- fmt.Sprintf("delete: %d", rec.Code)
		}
	}()
	go func() {
		defer wg.Done()
		// The victim's own last-use write, racing its revoke.
		if err := recordDeviceSeen(victim, w.now.Unix()); err != nil {
			errs <- fmt.Sprintf("record seen: %v", err)
		}
	}()
	wg.Wait()
	close(errs)
	for e := range errs {
		t.Fatal(e)
	}

	reg := w.registry()
	if len(reg.Devices) != n {
		t.Fatalf("registry holds %d devices, want %d", len(reg.Devices), n)
	}
	for _, d := range reg.Devices {
		if d.ID == victim {
			t.Fatal("the deleted device came back")
		}
	}
	if _, ok := w.seen()[victim]; ok {
		t.Fatal("the deleted device has a last-use entry")
	}
	if rec := serve(deviceReq(http.MethodGet, "/whoami", token)); rec.Code != http.StatusUnauthorized {
		t.Fatalf("the deleted device's token: %d, want 401", rec.Code)
	}
}

// --- last use ------------------------------------------------------------------

// The sidecar re-checks each device on /whoami every 60 s. Last use is recorded
// from that, at most once per deviceSeenInterval per device, so the seen file
// is not rewritten every minute for every app.
func TestADeviceRequestRecordsLastUseThrottled(t *testing.T) {
	w := newDeviceWorld(t)
	token, id := w.paired("Pixel")
	if _, ok := w.seen()[id]; ok {
		t.Fatal("pairing alone recorded a use")
	}
	if rec := serve(deviceReq(http.MethodGet, "/whoami", token)); rec.Code != http.StatusOK {
		t.Fatalf("whoami: %d", rec.Code)
	}
	if got := w.seen()[id]; got != w.now.Unix() {
		t.Fatalf("seen[%s] = %d, want %d", id, got, w.now.Unix())
	}
	first := w.now.Unix()

	w.now = w.now.Add(deviceSeenInterval - time.Second)
	serve(deviceReq(http.MethodGet, "/whoami", token))
	if got := w.seen()[id]; got != first {
		t.Fatalf("a use inside the interval rewrote seen to %d", got)
	}

	w.now = w.now.Add(time.Second)
	serve(deviceReq(http.MethodGet, "/whoami", token))
	if got := w.seen()[id]; got != w.now.Unix() {
		t.Fatalf("a use after the interval: seen = %d, want %d", got, w.now.Unix())
	}
	// And the list shows it.
	rec := serve(w.browser(http.MethodGet, "/devices", ""))
	var list []struct {
		LastSeen int64 `json:"lastSeen"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &list)
	if len(list) != 1 || list[0].LastSeen != w.now.Unix() {
		t.Fatalf("list lastSeen = %+v, want %d", list, w.now.Unix())
	}
	info, err := os.Stat(actAsGate.DevicesSeenPath())
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("seen file mode: %v %v", info, err)
	}
}

// --- /whoami for a device ------------------------------------------------------

// A paired app asks /whoami the same question a browser does and gets the same
// shape back. authentik is the person's own identity name: session-events and
// the sidecar show it to other people.
func TestWhoamiAnswersADeviceLikeABrowser(t *testing.T) {
	w := newDeviceWorld(t)
	token, _ := w.paired("Somebody's iPad")

	decode := func(rec *httptest.ResponseRecorder) map[string]any {
		t.Helper()
		if rec.Code != http.StatusOK {
			t.Fatalf("whoami: %d %s", rec.Code, rec.Body.String())
		}
		var got map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		return got
	}
	browser := decode(serve(w.browser(http.MethodGet, "/whoami", "")))
	device := decode(serve(deviceReq(http.MethodGet, "/whoami", token)))

	if len(device) != len(browser) {
		t.Fatalf("device answer %v and browser answer %v have different keys", device, browser)
	}
	for k := range browser {
		if _, ok := device[k]; !ok {
			t.Fatalf("device answer lacks %q: %v", k, device)
		}
	}
	if device["authentik"] != "viktor" || device["osUser"] != w.me || device["multiUser"] != true {
		t.Fatalf("device whoami = %v", device)
	}
	if device["admin"] != false {
		t.Fatalf("a device was reported as an administrator: %v", device)
	}
}
