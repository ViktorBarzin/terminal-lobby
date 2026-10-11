package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// seedProject writes one project straight into the store, the state a member
// reaches through the /projects routes.
func seedProject(t *testing.T, p GlobalProject) {
	t.Helper()
	if err := projectStoreInstance.update(func(ps *ProjectSet) error {
		ps.Projects = append(ps.Projects, p)
		return nil
	}); err != nil {
		t.Fatalf("seed project: %v", err)
	}
}

func stubSessionExists(t *testing.T, v bool) {
	t.Helper()
	old := sessionExists
	sessionExists = func(string, string) bool { return v }
	t.Cleanup(func() { sessionExists = old })
}

func seedShareRow(t *testing.T, sh Share) {
	t.Helper()
	if err := shareStoreInstance.update(func(ss *ShareSet) error {
		ss.Shares = append(ss.Shares, sh)
		return nil
	}); err != nil {
		t.Fatalf("seed share: %v", err)
	}
}

func TestSessionAccess(t *testing.T) {
	type want struct{ mode, via string }
	cases := []struct {
		name    string
		share   *Share
		project *GlobalProject
		admin   bool
		owner   string
		caller  string
		want    want
	}{
		{name: "your own session", owner: "alice", caller: "alice", want: want{"rw", "self"}},
		{name: "nothing grants it", owner: "alice", caller: "bob", want: want{"", ""}},
		{
			name:  "a read-write share",
			share: &Share{Owner: "alice", Name: "main", Guest: "bob", Mode: "rw", SessionID: "$1", SessionCreated: 1000},
			owner: "alice", caller: "bob", want: want{"rw", "share"},
		},
		{
			name:  "a share for someone else",
			share: &Share{Owner: "alice", Name: "main", Guest: "carol", Mode: "rw", SessionID: "$1", SessionCreated: 1000},
			owner: "alice", caller: "bob", want: want{"", ""},
		},
		{
			// The grant was for an earlier session that held this name.
			name:  "a share pinned to another session",
			share: &Share{Owner: "alice", Name: "main", Guest: "bob", Mode: "rw", SessionID: "$9", SessionCreated: 1000},
			owner: "alice", caller: "bob", want: want{"", ""},
		},
		{
			name: "a project member at the project's mode",
			project: &GlobalProject{ID: "p1", Name: "P", AttachMode: "rw",
				Members:  []Member{{OSUser: "alice"}, {OSUser: "bob"}},
				Sessions: []SessionRef{{Owner: "alice", Name: "main"}}},
			owner: "alice", caller: "bob", want: want{"rw", "project"},
		},
		{
			name: "a project with no mode set watches",
			project: &GlobalProject{ID: "p1", Name: "P",
				Members:  []Member{{OSUser: "alice"}, {OSUser: "bob"}},
				Sessions: []SessionRef{{Owner: "alice", Name: "main"}}},
			owner: "alice", caller: "bob", want: want{"ro", "project"},
		},
		{
			name: "not a member of the project",
			project: &GlobalProject{ID: "p1", Name: "P", AttachMode: "rw",
				Members:  []Member{{OSUser: "alice"}, {OSUser: "carol"}},
				Sessions: []SessionRef{{Owner: "alice", Name: "main"}}},
			owner: "alice", caller: "bob", want: want{"", ""},
		},
		{
			name:  "a read-only share loses to a read-write project",
			share: &Share{Owner: "alice", Name: "main", Guest: "bob", Mode: "ro", SessionID: "$1", SessionCreated: 1000},
			project: &GlobalProject{ID: "p1", Name: "P", AttachMode: "rw",
				Members:  []Member{{OSUser: "alice"}, {OSUser: "bob"}},
				Sessions: []SessionRef{{Owner: "alice", Name: "main"}}},
			owner: "alice", caller: "bob", want: want{"rw", "project"},
		},
		{name: "an administrator", admin: true, owner: "alice", caller: "bob", want: want{"rw", "admin"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			swapShareStore(t)
			swapProjectStore(t)
			withUserMap(t, "alice=alice\nbob=bob\ncarol=carol\n")
			if tc.admin {
				withAdmins(t, tc.caller+"\n")
			} else {
				withAdmins(t, "")
			}
			if tc.share != nil {
				seedShareRow(t, *tc.share)
			}
			if tc.project != nil {
				seedProject(t, *tc.project)
			}
			got, err := sessionAccess(tc.owner, "main", tc.caller)
			if err != nil {
				t.Fatalf("sessionAccess: %v", err)
			}
			if got.Mode != tc.want.mode || string(got.Via) != tc.want.via {
				t.Fatalf("got %+v, want mode=%q via=%q", got, tc.want.mode, tc.want.via)
			}
		})
	}
}

func TestSessionAccessRefusesBadNames(t *testing.T) {
	swapShareStore(t)
	swapProjectStore(t)
	for _, args := range [][3]string{
		{"alice", "../x", "bob"},
		{"al ice", "main", "bob"},
		{"alice", "main", ""},
	} {
		if _, err := sessionAccess(args[0], args[1], args[2]); err == nil {
			t.Fatalf("sessionAccess%v: want an error", args)
		}
	}
}

func internalAccessReq(body, token string) *http.Request {
	r := projectsReq(http.MethodPost, "/internal/access", body, "")
	r.RemoteAddr = "127.0.0.1:41000"
	if token != "" {
		r.Header.Set("X-Internal-Token", token)
	}
	return r
}

func TestInternalAccess(t *testing.T) {
	swapShareStore(t)
	swapProjectStore(t)
	withUserMap(t, "alice=alice\nbob=bob\n")
	withAdmins(t, "")
	withInternalToken(t, "tok")
	seedShareRow(t, Share{Owner: "alice", Name: "main", Guest: "bob", Mode: "rw", SessionID: "$1", SessionCreated: 1000})
	body := `{"owner":"alice","name":"main","caller":"bob"}`

	rec := httptest.NewRecorder()
	handleInternalAccess(rec, internalAccessReq(body, ""))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("no token: %d, want 403", rec.Code)
	}

	remote := internalAccessReq(body, "tok")
	remote.RemoteAddr = "10.0.0.5:41000"
	rec = httptest.NewRecorder()
	handleInternalAccess(rec, remote)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("off the box: %d, want 403", rec.Code)
	}

	rec = httptest.NewRecorder()
	handleInternalAccess(rec, internalAccessReq(body, "tok"))
	if rec.Code != http.StatusOK {
		t.Fatalf("granted: %d %s", rec.Code, rec.Body.String())
	}
	var got struct{ Mode, Via string }
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if got.Mode != "rw" || got.Via != "share" {
		t.Fatalf("answer %+v", got)
	}

	rec = httptest.NewRecorder()
	handleInternalAccess(rec, internalAccessReq(`{"owner":"alice","name":"other","caller":"bob"}`, "tok"))
	if rec.Code != http.StatusOK {
		t.Fatalf("refused: %d", rec.Code)
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if got.Mode != "" {
		t.Fatalf("no grant answered mode %q", got.Mode)
	}
}

// A project member reaches the terminal at the project's attach mode, with no
// share row. Before 2026-10-11 the attach read only the share store and
// answered 403 "not shared".
func TestInternalAttachProjectMember(t *testing.T) {
	swapShareStore(t)
	swapProjectStore(t)
	withUserMap(t, "alice=alice\nbob=bob\n")
	withAdmins(t, "")
	withInternalToken(t, "tok")
	stubSessionExists(t, true)
	seedProject(t, GlobalProject{ID: "p1", Name: "P", AttachMode: "rw",
		Members:  []Member{{OSUser: "alice"}, {OSUser: "bob"}},
		Sessions: []SessionRef{{Owner: "alice", Name: "main"}}})

	rec := httptest.NewRecorder()
	handleInternalAttach(rec, internalAttachReq(`{"owner":"alice","name":"main","guest":"bob","tty":"/dev/pts/3"}`, "tok"))
	if rec.Code != http.StatusOK {
		t.Fatalf("project attach: %d %s", rec.Code, rec.Body.String())
	}
	var got struct{ Mode string }
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if got.Mode != "rw" {
		t.Fatalf("mode %q, want rw", got.Mode)
	}
}

func TestGuestTarget(t *testing.T) {
	swapShareStore(t)
	swapProjectStore(t)
	withUserMap(t, "alice=alice\nbob=bob\ncarol=carol\n")
	withAdmins(t, "")
	seedShareRow(t, Share{Owner: "alice", Name: "main", Guest: "bob", Mode: "rw", SessionID: "$1", SessionCreated: 1000})
	seedShareRow(t, Share{Owner: "alice", Name: "main", Guest: "carol", Mode: "ro", SessionID: "$1", SessionCreated: 1000})

	cases := []struct {
		name, method, url, caller string
		wantTarget, wantGuest     string
		wantStatus                int
	}{
		{"no owner is your own", http.MethodDelete, "/sessions/main", "bob", "bob", "", 0},
		{"owner is you", http.MethodDelete, "/sessions/main?owner=bob", "bob", "bob", "", 0},
		{"a driving guest kills", http.MethodDelete, "/sessions/main?owner=alice", "bob", "alice", "bob", 0},
		{"a watching guest cannot kill", http.MethodDelete, "/sessions/main?owner=alice", "carol", "", "", http.StatusForbidden},
		{"a watching guest reads", http.MethodGet, "/sessions/main/capture?owner=alice", "carol", "alice", "carol", 0},
		{"no grant at all", http.MethodGet, "/sessions/other/capture?owner=alice", "bob", "", "", http.StatusForbidden},
		{"a bad owner", http.MethodGet, "/sessions/main/capture?owner=a%20b", "bob", "", "", http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, tc.url, nil)
			sessionName := "main"
			if tc.name == "no grant at all" {
				sessionName = "other"
			}
			target, guest, status := guestTarget(r, tc.caller, sessionName)
			if status != tc.wantStatus || target != tc.wantTarget || guest != tc.wantGuest {
				t.Fatalf("got (%q, %q, %d), want (%q, %q, %d)", target, guest, status, tc.wantTarget, tc.wantGuest, tc.wantStatus)
			}
		})
	}
}

func TestSharePushPayloads(t *testing.T) {
	var p pushPayload
	if err := json.Unmarshal(buildSharedWithYouPayload("vbarzin", "alice", "fix-auth", "Fix auth", "https://t.example"), &p); err != nil {
		t.Fatal(err)
	}
	if p.Title != "vbarzin shared Fix auth with you" || p.Badge != nil {
		t.Fatalf("invite payload %+v", p)
	}
	if p.Notification == nil || p.Notification.Navigate != "https://t.example/#fix-auth@alice" {
		t.Fatalf("invite navigate %+v", p.Notification)
	}
	p = pushPayload{}
	if err := json.Unmarshal(buildGuestKilledPayload("emo", "fix-auth", "Fix auth", ""), &p); err != nil {
		t.Fatal(err)
	}
	if p.Title != "emo killed Fix auth" || p.Badge != nil || p.Notification != nil {
		t.Fatalf("kill payload %+v", p)
	}
}
