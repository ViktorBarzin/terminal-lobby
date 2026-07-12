package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// --- push subscription store ------------------------------------------------

func testPushStore(t *testing.T) *pushStore {
	t.Helper()
	st := newPushStore(t.TempDir())
	// Deterministic added_at so preservation-on-reupsert is assertable.
	st.now = func() time.Time { return time.Unix(1_700_000_000, 0).UTC() }
	return st
}

func sampleSub(endpoint, p256dh, auth string) pushSubscription {
	return pushSubscription{
		Endpoint: endpoint,
		Keys:     pushKeys{P256dh: p256dh, Auth: auth},
	}
}

// A user who never subscribed gets an empty list, not an error.
func TestPushStoreListMissingReturnsEmpty(t *testing.T) {
	st := testPushStore(t)
	subs, err := st.list("alice")
	if err != nil {
		t.Fatalf("list on missing file: %v", err)
	}
	if len(subs) != 0 {
		t.Fatalf("missing-file list: got %d subs, want 0", len(subs))
	}
}

func TestPushStoreUpsertRoundtrip(t *testing.T) {
	st := testPushStore(t)
	in := sampleSub("https://push.example/aaa", "p256-a", "auth-a")
	if err := st.upsert("alice", in); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	subs, err := st.list("alice")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(subs) != 1 {
		t.Fatalf("after one upsert: got %d subs, want 1", len(subs))
	}
	got := subs[0]
	if got.Endpoint != in.Endpoint || got.Keys != in.Keys {
		t.Fatalf("roundtrip mismatch: got %+v, want %+v", got, in)
	}
	if got.AddedAt == "" {
		t.Fatal("added_at was not stamped on upsert")
	}
}

// UPSERT by endpoint: re-PUTting the SAME endpoint replaces its keys in place
// (never a second row) and PRESERVES the original added_at.
func TestPushStoreUpsertByEndpointNoDuplicate(t *testing.T) {
	st := testPushStore(t)
	first := sampleSub("https://push.example/aaa", "p256-old", "auth-old")
	if err := st.upsert("alice", first); err != nil {
		t.Fatalf("first upsert: %v", err)
	}
	subs, _ := st.list("alice")
	origAddedAt := subs[0].AddedAt

	// Later re-subscribe with rotated keys at the same endpoint.
	st.now = func() time.Time { return time.Unix(1_700_009_999, 0).UTC() }
	second := sampleSub("https://push.example/aaa", "p256-new", "auth-new")
	if err := st.upsert("alice", second); err != nil {
		t.Fatalf("second upsert: %v", err)
	}
	subs, _ = st.list("alice")
	if len(subs) != 1 {
		t.Fatalf("re-upsert same endpoint: got %d subs, want 1 (no duplicate)", len(subs))
	}
	if subs[0].Keys != second.Keys {
		t.Fatalf("keys not updated on re-upsert: got %+v, want %+v", subs[0].Keys, second.Keys)
	}
	if subs[0].AddedAt != origAddedAt {
		t.Fatalf("added_at not preserved on re-upsert: got %q, want %q", subs[0].AddedAt, origAddedAt)
	}
}

// Multi-device: distinct endpoints coexist in one user's document.
func TestPushStoreMultiDevice(t *testing.T) {
	st := testPushStore(t)
	for _, e := range []string{"https://push.example/aaa", "https://push.example/bbb"} {
		if err := st.upsert("alice", sampleSub(e, "p", "a")); err != nil {
			t.Fatalf("upsert %s: %v", e, err)
		}
	}
	subs, _ := st.list("alice")
	if len(subs) != 2 {
		t.Fatalf("multi-device: got %d subs, want 2", len(subs))
	}
}

func TestPushStoreRemove(t *testing.T) {
	st := testPushStore(t)
	_ = st.upsert("alice", sampleSub("https://push.example/aaa", "p", "a"))
	_ = st.upsert("alice", sampleSub("https://push.example/bbb", "p", "a"))

	removed, err := st.remove("alice", "https://push.example/aaa")
	if err != nil {
		t.Fatalf("remove: %v", err)
	}
	if !removed {
		t.Fatal("remove existing endpoint: got removed=false, want true")
	}
	subs, _ := st.list("alice")
	if len(subs) != 1 || subs[0].Endpoint != "https://push.example/bbb" {
		t.Fatalf("after remove: got %+v, want only bbb", subs)
	}

	// Removing an endpoint that isn't there is a no-op, not an error.
	removed, err = st.remove("alice", "https://push.example/zzz")
	if err != nil {
		t.Fatalf("remove absent: %v", err)
	}
	if removed {
		t.Fatal("remove absent endpoint: got removed=true, want false")
	}
}

func TestPushStorePerUserIsolation(t *testing.T) {
	st := testPushStore(t)
	_ = st.upsert("alice", sampleSub("https://push.example/alice", "p", "a"))
	_ = st.upsert("bob", sampleSub("https://push.example/bob", "p", "a"))

	a, _ := st.list("alice")
	b, _ := st.list("bob")
	if len(a) != 1 || a[0].Endpoint != "https://push.example/alice" {
		t.Fatalf("alice list bled: %+v", a)
	}
	if len(b) != 1 || b[0].Endpoint != "https://push.example/bob" {
		t.Fatalf("bob list bled: %+v", b)
	}
	for _, u := range []string{"alice", "bob"} {
		if _, err := os.Stat(filepath.Join(st.dir, u+".json")); err != nil {
			t.Fatalf("per-user file for %s: %v", u, err)
		}
	}
}

func TestPushStoreFileIsPrivate(t *testing.T) {
	st := testPushStore(t)
	if err := st.upsert("alice", sampleSub("https://push.example/aaa", "p", "a")); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	fi, err := os.Stat(filepath.Join(st.dir, "alice.json"))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("push subs file mode: got %o, want 600", fi.Mode().Perm())
	}
}

// users() enumerates the OS users who currently hold a subscription document —
// the exact set the background sender must poll (and nobody else).
func TestPushStoreUsers(t *testing.T) {
	st := testPushStore(t)
	_ = st.upsert("alice", sampleSub("https://push.example/a", "p", "a"))
	_ = st.upsert("bob", sampleSub("https://push.example/b", "p", "a"))
	users, err := st.users()
	if err != nil {
		t.Fatalf("users: %v", err)
	}
	got := map[string]bool{}
	for _, u := range users {
		got[u] = true
	}
	if !got["alice"] || !got["bob"] || len(got) != 2 {
		t.Fatalf("users: got %v, want {alice,bob}", users)
	}
}

// --- validation -------------------------------------------------------------

func TestValidatePushSubscription(t *testing.T) {
	good := `{"endpoint":"https://push.example/x","keys":{"p256dh":"BPk","auth":"c2Vj"}}`
	sub, err := validatePushSubscription([]byte(good))
	if err != nil {
		t.Fatalf("valid subscription rejected: %v", err)
	}
	if sub.Endpoint != "https://push.example/x" || sub.Keys.P256dh != "BPk" || sub.Keys.Auth != "c2Vj" {
		t.Fatalf("parsed wrong: %+v", sub)
	}

	// The browser's PushSubscription.toJSON() carries expirationTime; unknown
	// fields must be ignored, never rejected.
	withExtra := `{"endpoint":"https://push.example/x","expirationTime":null,"keys":{"p256dh":"BPk","auth":"c2Vj"}}`
	if _, err := validatePushSubscription([]byte(withExtra)); err != nil {
		t.Fatalf("subscription with expirationTime rejected: %v", err)
	}

	for _, c := range []struct{ name, body string }{
		{"truncated", `{"endpoint":`},
		{"not json", `nope`},
		{"array", `[1,2]`},
		{"missing endpoint", `{"keys":{"p256dh":"BPk","auth":"c2Vj"}}`},
		{"non-http endpoint", `{"endpoint":"ftp://x/y","keys":{"p256dh":"BPk","auth":"c2Vj"}}`},
		{"missing p256dh", `{"endpoint":"https://push.example/x","keys":{"auth":"c2Vj"}}`},
		{"missing auth", `{"endpoint":"https://push.example/x","keys":{"p256dh":"BPk"}}`},
	} {
		t.Run(c.name, func(t *testing.T) {
			if _, err := validatePushSubscription([]byte(c.body)); err == nil {
				t.Fatalf("%s: want error, got nil", c.name)
			}
		})
	}
}

// --- /push-subscriptions handler --------------------------------------------

func swapPushStore(t *testing.T) *pushStore {
	t.Helper()
	old := pushStoreInstance
	pushStoreInstance = newPushStore(t.TempDir())
	t.Cleanup(func() { pushStoreInstance = old })
	return pushStoreInstance
}

func pushReq(method, body, authUser string) *http.Request {
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, "/push-subscriptions", nil)
	} else {
		r = httptest.NewRequest(method, "/push-subscriptions", strings.NewReader(body))
	}
	if authUser != "" {
		r.Header.Set(authHeader, authUser)
	}
	return r
}

func TestHandlePushSubsRejectsOtherMethods(t *testing.T) {
	rec := httptest.NewRecorder()
	handlePushSubscriptions(rec, pushReq(http.MethodPost, "", ""))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /push-subscriptions: got %d, want %d", rec.Code, http.StatusMethodNotAllowed)
	}
}

func TestHandlePushSubsRequiresAuth(t *testing.T) {
	for _, m := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
		rec := httptest.NewRecorder()
		handlePushSubscriptions(rec, pushReq(m, "", ""))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s /push-subscriptions without %s: got %d, want %d", m, authHeader, rec.Code, http.StatusUnauthorized)
		}
	}
}

// PUT one subscription → 204; GET lists it; DELETE {endpoint} removes it.
func TestHandlePushSubsPutGetDeleteRoundtrip(t *testing.T) {
	swapPushStore(t)
	osA, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osA+"\n")

	sub := `{"endpoint":"https://push.example/aaa","keys":{"p256dh":"BPk","auth":"c2Vj"}}`
	rec := httptest.NewRecorder()
	handlePushSubscriptions(rec, pushReq(http.MethodPut, sub, "alice"))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("PUT: got %d, want 204 (body %q)", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	handlePushSubscriptions(rec, pushReq(http.MethodGet, "", "alice"))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET: got %d, want 200", rec.Code)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("cache-control: got %q, want no-store", cc)
	}
	var list []pushSubscription
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("GET body not a JSON array: %v (%q)", err, rec.Body.String())
	}
	if len(list) != 1 || list[0].Endpoint != "https://push.example/aaa" {
		t.Fatalf("GET list: got %+v, want single aaa", list)
	}

	del := `{"endpoint":"https://push.example/aaa"}`
	rec = httptest.NewRecorder()
	handlePushSubscriptions(rec, pushReq(http.MethodDelete, del, "alice"))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("DELETE: got %d, want 204", rec.Code)
	}
	rec = httptest.NewRecorder()
	handlePushSubscriptions(rec, pushReq(http.MethodGet, "", "alice"))
	json.Unmarshal(rec.Body.Bytes(), &list)
	if len(list) != 0 {
		t.Fatalf("after DELETE: got %+v, want empty", list)
	}
}

func TestHandlePushSubsInvalidBody(t *testing.T) {
	swapPushStore(t)
	osA, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osA+"\n")
	for _, body := range []string{
		`{nope`,
		`[1,2]`,
		`{"keys":{"p256dh":"BPk","auth":"c2Vj"}}`, // missing endpoint
		string(make([]byte, maxPushBody+1)),
	} {
		rec := httptest.NewRecorder()
		handlePushSubscriptions(rec, pushReq(http.MethodPut, body, "alice"))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("PUT invalid body %.20q: got %d, want %d", body, rec.Code, http.StatusBadRequest)
		}
	}
}

func TestHandlePushSubsPerUserIsolation(t *testing.T) {
	swapPushStore(t)
	osA, osB := twoLocalUsers(t)
	withUserMap(t, "alice="+osA+"\nbob="+osB+"\n")

	subA := `{"endpoint":"https://push.example/alice","keys":{"p256dh":"p","auth":"a"}}`
	subB := `{"endpoint":"https://push.example/bob","keys":{"p256dh":"p","auth":"a"}}`
	for _, c := range []struct{ auth, sub string }{{"alice", subA}, {"bob", subB}} {
		rec := httptest.NewRecorder()
		handlePushSubscriptions(rec, pushReq(http.MethodPut, c.sub, c.auth))
		if rec.Code != http.StatusNoContent {
			t.Fatalf("PUT as %s: got %d, want 204", c.auth, rec.Code)
		}
	}
	for _, c := range []struct{ auth, endpoint string }{
		{"alice", "https://push.example/alice"},
		{"bob", "https://push.example/bob"},
	} {
		rec := httptest.NewRecorder()
		handlePushSubscriptions(rec, pushReq(http.MethodGet, "", c.auth))
		var list []pushSubscription
		json.Unmarshal(rec.Body.Bytes(), &list)
		if len(list) != 1 || list[0].Endpoint != c.endpoint {
			t.Fatalf("%s list: got %+v, want single %s", c.auth, list, c.endpoint)
		}
	}
}

// --- GET /push/vapid-public -------------------------------------------------

func TestHandleVAPIDPublicReturnsKeyWhenSet(t *testing.T) {
	t.Setenv("VAPID_PUBLIC_KEY", "BPublicKeyMaterial")
	rec := httptest.NewRecorder()
	handlePushVAPIDPublic(rec, httptest.NewRequest(http.MethodGet, "/push/vapid-public", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET vapid-public with key set: got %d, want 200", rec.Code)
	}
	if got := strings.TrimSpace(rec.Body.String()); got != "BPublicKeyMaterial" {
		t.Fatalf("vapid-public body: got %q, want key", got)
	}
}

// Feature dark (no key configured) → 404, so the frontend leaves push off.
func TestHandleVAPIDPublicNotFoundWhenUnset(t *testing.T) {
	t.Setenv("VAPID_PUBLIC_KEY", "")
	rec := httptest.NewRecorder()
	handlePushVAPIDPublic(rec, httptest.NewRequest(http.MethodGet, "/push/vapid-public", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("GET vapid-public with key unset: got %d, want 404", rec.Code)
	}
}

func TestHandleVAPIDPublicRejectsOtherMethods(t *testing.T) {
	t.Setenv("VAPID_PUBLIC_KEY", "BPublicKeyMaterial")
	rec := httptest.NewRecorder()
	handlePushVAPIDPublic(rec, httptest.NewRequest(http.MethodPost, "/push/vapid-public", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST vapid-public: got %d, want %d", rec.Code, http.StatusMethodNotAllowed)
	}
}
