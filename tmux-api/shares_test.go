package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func swapShareStore(t *testing.T) {
	t.Helper()
	old := shareStoreInstance
	shareStoreInstance = newShareStore(t.TempDir() + "/shares.json")
	t.Cleanup(func() { shareStoreInstance = old })
}

func withInternalToken(t *testing.T, tok string) {
	t.Helper()
	old := internalToken
	internalToken = tok
	t.Cleanup(func() { internalToken = old })
}

func TestValidateShareSet(t *testing.T) {
	base := func() ShareSet {
		return ShareSet{Version: 1, Shares: []Share{{Owner: "wizard", Name: "s1", Guest: "bob", Mode: "ro"}}}
	}
	cases := []struct {
		name    string
		mut     func(*ShareSet)
		wantErr bool
	}{
		{"valid ro", func(ss *ShareSet) {}, false},
		{"valid rw", func(ss *ShareSet) { ss.Shares[0].Mode = "rw" }, false},
		{"valid with tty", func(ss *ShareSet) { ss.Shares[0].ClientTty = "/dev/pts/5" }, false},
		{"bad version", func(ss *ShareSet) { ss.Version = 9 }, true},
		{"self share", func(ss *ShareSet) { ss.Shares[0].Guest = "wizard" }, true},
		{"bad mode", func(ss *ShareSet) { ss.Shares[0].Mode = "sideways" }, true},
		{"bad owner name", func(ss *ShareSet) { ss.Shares[0].Owner = "bad name!" }, true},
		{"bad tty (injection)", func(ss *ShareSet) { ss.Shares[0].ClientTty = "/dev/pts/5; rm -rf" }, true},
		{"duplicate grant", func(ss *ShareSet) { ss.Shares = append(ss.Shares, ss.Shares[0]) }, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ss := base()
			tc.mut(&ss)
			err := validateShareSet(ss)
			if tc.wantErr != (err != nil) {
				t.Fatalf("wantErr=%v got err=%v", tc.wantErr, err)
			}
		})
	}
}

// Owner shares their session; both owner and guest see it in their list; a
// third party does not.
func TestCreateAndListShares(t *testing.T) {
	swapShareStore(t)
	me, other := twoLocalUsers(t)
	withUserMap(t, me+"="+me+"\n"+other+"="+other+"\n")

	rec := httptest.NewRecorder()
	handleShares(rec, projectsReq(http.MethodPost, "/shares", `{"name":"main","guest":"`+other+`","mode":"rw"}`, me))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create share: got %d, body=%s", rec.Code, rec.Body.String())
	}

	for _, u := range []string{me, other} {
		rec = httptest.NewRecorder()
		handleShares(rec, projectsReq(http.MethodGet, "/shares", "", u))
		var got []Share
		_ = json.Unmarshal(rec.Body.Bytes(), &got)
		if len(got) != 1 || got[0].Owner != me || got[0].Guest != other || got[0].Mode != "rw" {
			t.Fatalf("list for %s: %+v", u, got)
		}
	}
}

func TestCreateShareRejects(t *testing.T) {
	swapShareStore(t)
	me, other := twoLocalUsers(t)
	withUserMap(t, me+"="+me+"\n"+other+"="+other+"\n")
	for _, tc := range []struct {
		name, body string
		want       int
	}{
		{"self", `{"name":"main","guest":"` + me + `","mode":"ro"}`, http.StatusBadRequest},
		{"unmapped guest", `{"name":"main","guest":"ghost","mode":"ro"}`, http.StatusBadRequest},
		{"bad mode", `{"name":"main","guest":"` + other + `","mode":"x"}`, http.StatusBadRequest},
		{"bad name", `{"name":"bad name!","guest":"` + other + `","mode":"ro"}`, http.StatusBadRequest},
	} {
		rec := httptest.NewRecorder()
		handleShares(rec, projectsReq(http.MethodPost, "/shares", tc.body, me))
		if rec.Code != tc.want {
			t.Fatalf("%s: got %d, want %d (body=%s)", tc.name, rec.Code, tc.want, rec.Body.String())
		}
	}
}

// The owner or the guest may revoke; a third party cannot.
func TestRevokeShare(t *testing.T) {
	swapShareStore(t)
	me, other := twoLocalUsers(t)
	withUserMap(t, me+"="+me+"\n"+other+"="+other+"\n")
	mk := func() {
		rec := httptest.NewRecorder()
		handleShares(rec, projectsReq(http.MethodPost, "/shares", `{"name":"main","guest":"`+other+`","mode":"ro"}`, me))
		if rec.Code != http.StatusCreated {
			t.Fatalf("seed share: %d", rec.Code)
		}
	}
	path := "/shares/" + me + "/main/" + other

	// A caller who is neither owner nor guest is forbidden. Seed such a share
	// directly (guest "ghost" need not be a real OS user for this check).
	if err := shareStoreInstance.update(func(ss *ShareSet) error {
		ss.Shares = append(ss.Shares, Share{Owner: other, Name: "x", Guest: "ghost", Mode: "ro"})
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	handleShareByPath(rec, projectsReq(http.MethodDelete, "/shares/"+other+"/x/ghost", "", me))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("third-party revoke: got %d, want 403", rec.Code)
	}

	// owner revoke removes the row
	mk()
	rec = httptest.NewRecorder()
	handleShareByPath(rec, projectsReq(http.MethodDelete, path, "", me))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("owner revoke: got %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	handleShares(rec, projectsReq(http.MethodGet, "/shares", "", me))
	var got []Share
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	for _, sh := range got {
		if sh.Owner == me && sh.Name == "main" && sh.Guest == other {
			t.Fatalf("share still present after owner revoke: %+v", got)
		}
	}

	// guest leave
	mk()
	rec = httptest.NewRecorder()
	handleShareByPath(rec, projectsReq(http.MethodDelete, path, "", other))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("guest leave: got %d", rec.Code)
	}
}

// The internal attach endpoint: token-gated, returns the mode, records the tty,
// and denies (403) when there is no share.
func TestInternalAttach(t *testing.T) {
	swapShareStore(t)
	me, other := twoLocalUsers(t)
	withUserMap(t, me+"="+me+"\n"+other+"="+other+"\n")
	withInternalToken(t, "secret-tok")

	// seed a share (owner=me, guest=other, ro)
	rec := httptest.NewRecorder()
	handleShares(rec, projectsReq(http.MethodPost, "/shares", `{"name":"main","guest":"`+other+`","mode":"ro"}`, me))
	if rec.Code != http.StatusCreated {
		t.Fatalf("seed: %d", rec.Code)
	}

	body := `{"owner":"` + me + `","name":"main","guest":"` + other + `","tty":"/dev/pts/7"}`

	// missing token → 403
	rec = httptest.NewRecorder()
	handleInternalAttach(rec, projectsReq(http.MethodPost, "/internal/attach", body, ""))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("no token: got %d, want 403", rec.Code)
	}

	// with token → 200 + mode, tty recorded
	req := projectsReq(http.MethodPost, "/internal/attach", body, "")
	req.Header.Set("X-Internal-Token", "secret-tok")
	rec = httptest.NewRecorder()
	handleInternalAttach(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("record: got %d, body=%s", rec.Code, rec.Body.String())
	}
	var resp struct{ Mode string }
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp.Mode != "ro" {
		t.Fatalf("mode: got %q, want ro", resp.Mode)
	}
	ss, _ := shareStoreInstance.load()
	if len(ss.Shares) != 1 || ss.Shares[0].ClientTty != "/dev/pts/7" {
		t.Fatalf("tty not recorded: %+v", ss.Shares)
	}

	// no matching share → 403 (deny attach)
	req = projectsReq(http.MethodPost, "/internal/attach", `{"owner":"`+me+`","name":"nope","guest":"`+other+`","tty":"/dev/pts/7"}`, "")
	req.Header.Set("X-Internal-Token", "secret-tok")
	rec = httptest.NewRecorder()
	handleInternalAttach(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("unshared attach: got %d, want 403", rec.Code)
	}
}
