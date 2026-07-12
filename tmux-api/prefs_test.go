package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/user"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// --- prefs store ------------------------------------------------------------

func testPrefsStore(t *testing.T) *prefsStore {
	t.Helper()
	return newPrefsStore(t.TempDir())
}

// A user who never saved prefs gets an empty JSON object — the frontend's
// validate-or-default wrapper turns that into defaults.
func TestPrefsLoadMissingFileReturnsEmptyObject(t *testing.T) {
	st := testPrefsStore(t)
	doc, err := st.load("alice")
	if err != nil {
		t.Fatalf("load on missing file: %v", err)
	}
	if got := strings.TrimSpace(string(doc)); got != "{}" {
		t.Fatalf("default prefs doc: got %q, want {}", got)
	}
}

func TestPrefsStoreRoundtrip(t *testing.T) {
	st := testPrefsStore(t)
	in := []byte(`{"fontSize":18,"cursorStyle":"bar","cursorBlink":false}`)
	if err := st.save("alice", in); err != nil {
		t.Fatalf("save: %v", err)
	}
	out, err := st.load("alice")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	assertSameJSON(t, out, in)
}

func TestPrefsSaveIsPrivate(t *testing.T) {
	st := testPrefsStore(t)
	if err := st.save("alice", []byte(`{}`)); err != nil {
		t.Fatalf("save: %v", err)
	}
	fi, err := os.Stat(filepath.Join(st.dir, "alice.json"))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("prefs file mode: got %o, want 600", fi.Mode().Perm())
	}
}

// A corrupt file must error (500 at the handler) rather than silently serve
// garbage or wipe the user's roamed settings on the next PUT.
func TestPrefsLoadCorruptFileErrors(t *testing.T) {
	st := testPrefsStore(t)
	if err := os.MkdirAll(st.dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(st.dir, "alice.json"), []byte("{nope"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := st.load("alice"); err == nil {
		t.Fatal("load of corrupt file: want error, got nil")
	}
}

// --- validation -------------------------------------------------------------

// The server deliberately does NOT know the pref fields — values are
// validated-or-defaulted client-side — so unknown keys must roam untouched
// (a newer frontend's fields survive a PUT from an older one reading them).
func TestValidatePrefsAcceptsObjectAndKeepsUnknownKeys(t *testing.T) {
	in := []byte(`{"fontSize": 18, "futureKnob": {"nested": true}}`)
	doc, err := validatePrefs(in)
	if err != nil {
		t.Fatalf("valid prefs rejected: %v", err)
	}
	assertSameJSON(t, doc, in)
}

func TestValidatePrefsRejects(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"truncated", `{"fontSize":`},
		{"not json", `nope`},
		{"array", `[1,2]`},
		{"string", `"fontSize"`},
		{"number", `42`},
		{"bool", `true`},
		{"null", `null`},
		{"trailing garbage", `{"a":1} {"b":2}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := validatePrefs([]byte(c.body)); err == nil {
				t.Fatalf("%s: want error, got nil", c.name)
			}
		})
	}
}

// --- handler ----------------------------------------------------------------

// swapPrefsStore points the handler at a temp-dir store for the test's life.
func swapPrefsStore(t *testing.T) *prefsStore {
	t.Helper()
	old := prefsStoreInstance
	prefsStoreInstance = newPrefsStore(t.TempDir())
	t.Cleanup(func() { prefsStoreInstance = old })
	return prefsStoreInstance
}

// withUserMap points resolveOSUser's map file (mapPath — a var precisely for
// this seam) at a fixture, so handler tests exercise the REAL
// X-Authentik-Username → OS-user path hermetically.
func withUserMap(t *testing.T, content string) {
	t.Helper()
	f := filepath.Join(t.TempDir(), "user-map")
	if err := os.WriteFile(f, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	old := mapPath
	mapPath = f
	t.Cleanup(func() { mapPath = old })
}

// twoLocalUsers returns two DISTINCT OS users that exist on this host, so
// resolveOSUser's user.Lookup gate passes without depending on deploy state.
func twoLocalUsers(t *testing.T) (string, string) {
	t.Helper()
	me, err := user.Current()
	if err != nil {
		t.Fatalf("user.Current: %v", err)
	}
	other := "root"
	if me.Username == "root" {
		other = "nobody"
	}
	if _, err := user.Lookup(other); err != nil {
		t.Skipf("no second local user %q: %v", other, err)
	}
	return me.Username, other
}

func prefsReq(method, body, authUser string) *http.Request {
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, "/prefs", nil)
	} else {
		r = httptest.NewRequest(method, "/prefs", strings.NewReader(body))
	}
	if authUser != "" {
		r.Header.Set(authHeader, authUser)
	}
	return r
}

func TestHandlePrefsRejectsOtherMethods(t *testing.T) {
	for _, m := range []string{http.MethodPost, http.MethodDelete} {
		rec := httptest.NewRecorder()
		handlePrefs(rec, prefsReq(m, "", ""))
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s /prefs: got %d, want %d", m, rec.Code, http.StatusMethodNotAllowed)
		}
	}
}

func TestHandlePrefsRequiresAuth(t *testing.T) {
	for _, m := range []string{http.MethodGet, http.MethodPut} {
		rec := httptest.NewRecorder()
		handlePrefs(rec, prefsReq(m, "", ""))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s /prefs without %s: got %d, want %d", m, authHeader, rec.Code, http.StatusUnauthorized)
		}
	}
}

func TestHandlePrefsUnmappedUserForbidden(t *testing.T) {
	swapPrefsStore(t)
	withUserMap(t, "# empty map\n")
	rec := httptest.NewRecorder()
	handlePrefs(rec, prefsReq(http.MethodGet, "", "stranger"))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("GET /prefs as unmapped user: got %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestHandlePrefsGetEmptyReturnsEmptyObject(t *testing.T) {
	swapPrefsStore(t)
	osA, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osA+"\n")
	rec := httptest.NewRecorder()
	handlePrefs(rec, prefsReq(http.MethodGet, "", "alice"))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /prefs: got %d, want 200 (body %q)", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content-type: got %q", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("cache-control: got %q", cc)
	}
	if got := strings.TrimSpace(rec.Body.String()); got != "{}" {
		t.Fatalf("empty prefs body: got %q, want {}", got)
	}
}

// PUT → 204, GET echoes the document back; a second PUT replaces the whole
// document (last-writer-wins — no server-side merging).
func TestHandlePrefsPutGetRoundtrip(t *testing.T) {
	swapPrefsStore(t)
	osA, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osA+"\n")

	first := `{"fontSize":18,"lineHeight":1.2,"cursorStyle":"bar"}`
	rec := httptest.NewRecorder()
	handlePrefs(rec, prefsReq(http.MethodPut, first, "alice"))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("PUT /prefs: got %d, want 204 (body %q)", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	handlePrefs(rec, prefsReq(http.MethodGet, "", "alice"))
	assertSameJSON(t, rec.Body.Bytes(), []byte(first))

	second := `{"cursorBlink":false}`
	rec = httptest.NewRecorder()
	handlePrefs(rec, prefsReq(http.MethodPut, second, "alice"))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("second PUT /prefs: got %d, want 204", rec.Code)
	}
	rec = httptest.NewRecorder()
	handlePrefs(rec, prefsReq(http.MethodGet, "", "alice"))
	assertSameJSON(t, rec.Body.Bytes(), []byte(second))
}

// Two identities → two documents, keyed by the MAPPED OS user (one file per
// user under the store dir), never bleeding into each other.
func TestHandlePrefsPerUserIsolation(t *testing.T) {
	st := swapPrefsStore(t)
	osA, osB := twoLocalUsers(t)
	withUserMap(t, "alice="+osA+"\nbob="+osB+"\n")

	docA := `{"fontSize":12}`
	docB := `{"fontSize":22}`
	for _, c := range []struct{ auth, doc string }{{"alice", docA}, {"bob", docB}} {
		rec := httptest.NewRecorder()
		handlePrefs(rec, prefsReq(http.MethodPut, c.doc, c.auth))
		if rec.Code != http.StatusNoContent {
			t.Fatalf("PUT as %s: got %d, want 204", c.auth, rec.Code)
		}
	}
	for _, c := range []struct{ auth, want string }{{"alice", docA}, {"bob", docB}} {
		rec := httptest.NewRecorder()
		handlePrefs(rec, prefsReq(http.MethodGet, "", c.auth))
		assertSameJSON(t, rec.Body.Bytes(), []byte(c.want))
	}
	for _, osUser := range []string{osA, osB} {
		if _, err := os.Stat(filepath.Join(st.dir, osUser+".json")); err != nil {
			t.Fatalf("per-user file for %s: %v", osUser, err)
		}
	}
}

func TestHandlePrefsInvalidBodyBadRequest(t *testing.T) {
	swapPrefsStore(t)
	osA, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osA+"\n")
	for _, body := range []string{`{nope`, `[1,2]`, `null`, string(make([]byte, maxPrefsBody+1))} {
		rec := httptest.NewRecorder()
		handlePrefs(rec, prefsReq(http.MethodPut, body, "alice"))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("PUT invalid body %.20q: got %d, want %d", body, rec.Code, http.StatusBadRequest)
		}
	}
}

// --- notify prefs (Notifications: done + awaiting gating) -------------------

// The push sender reads notify.{onDone,onAwaiting} out of a user's roamed
// prefs doc to gate which transitions get a background push. Both default
// TRUE (opt-out) whenever the doc, the notify object, or an individual key is
// absent or malformed — a user who never opened settings, or an older
// frontend that never wrote the namespace, still gets both notifications.
func TestParseNotifyPrefsDefaultsTrueWhenAbsent(t *testing.T) {
	cases := []struct {
		name string
		doc  string
	}{
		{"empty object", `{}`},
		{"no notify key", `{"fontSize":18}`},
		{"notify not an object", `{"notify":42}`},
		{"notify null", `{"notify":null}`},
		{"notify empty object", `{"notify":{}}`},
		{"keys wrong type", `{"notify":{"onDone":"yes","onAwaiting":1}}`},
		{"corrupt doc", `{nope`},
		{"empty bytes", ``},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			np := parseNotifyPrefs([]byte(c.doc))
			if !np.onDone || !np.onAwaiting {
				t.Fatalf("%s: got %+v, want both true (opt-out default)", c.name, np)
			}
		})
	}
}

// A present boolean wins over the default in either direction, independently
// per key (onDone:false must not drag onAwaiting down, and vice versa).
func TestParseNotifyPrefsRoundtrip(t *testing.T) {
	cases := []struct {
		doc              string
		wantDone, wantAw bool
	}{
		{`{"notify":{"onDone":false,"onAwaiting":true}}`, false, true},
		{`{"notify":{"onDone":true,"onAwaiting":false}}`, true, false},
		{`{"notify":{"onDone":false,"onAwaiting":false}}`, false, false},
		{`{"notify":{"onDone":true,"onAwaiting":true}}`, true, true},
		{`{"notify":{"onDone":false}}`, false, true},  // absent onAwaiting keeps default true
		{`{"notify":{"onAwaiting":false}}`, true, false},
		{`{"fontSize":15,"notify":{"onDone":false},"cursorStyle":"bar"}`, false, true}, // siblings ignored
	}
	for _, c := range cases {
		np := parseNotifyPrefs([]byte(c.doc))
		if np.onDone != c.wantDone || np.onAwaiting != c.wantAw {
			t.Fatalf("parseNotifyPrefs(%s) = %+v, want {onDone:%v onAwaiting:%v}",
				c.doc, np, c.wantDone, c.wantAw)
		}
	}
}

// assertSameJSON compares two JSON documents semantically (key order and
// whitespace independent).
func assertSameJSON(t *testing.T, got, want []byte) {
	t.Helper()
	var g, w any
	if err := json.Unmarshal(got, &g); err != nil {
		t.Fatalf("got is not JSON (%v): %q", err, got)
	}
	if err := json.Unmarshal(want, &w); err != nil {
		t.Fatalf("want is not JSON (%v): %q", err, want)
	}
	if !reflect.DeepEqual(g, w) {
		t.Fatalf("JSON mismatch:\n got %s\nwant %s", got, want)
	}
}
