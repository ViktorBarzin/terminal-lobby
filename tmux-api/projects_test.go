package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

// swapProjectStore points the package-global projectStoreInstance at a fresh
// temp store for a handler test, restoring it afterwards.
func swapProjectStore(t *testing.T) {
	t.Helper()
	old := projectStoreInstance
	projectStoreInstance = newProjectStore(t.TempDir() + "/projects.json")
	t.Cleanup(func() { projectStoreInstance = old })
}

func projectsReq(method, path, body, authUser string) *http.Request {
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
	}
	if authUser != "" {
		r.Header.Set(authHeader, authUser)
	}
	return r
}

// --- global project store -------------------------------------------------
//
// Unlike layoutStore (one file per OS user), projectStore is a single global
// document: a multi-owner project spans users, so it cannot live in any one
// user's layout (see docs/plans/2026-07-17-shared-multiuser-projects-and-sessions).

func testProjectStore(t *testing.T) *projectStore {
	t.Helper()
	return newProjectStore(t.TempDir() + "/projects.json")
}

// A project with every field set must survive save→load byte-for-byte.
func TestProjectStoreSaveLoadRoundtrip(t *testing.T) {
	st := testProjectStore(t)
	in := ProjectSet{
		Version: 1,
		Projects: []GlobalProject{
			{
				ID:         "p_abc123",
				Name:       "tripit",
				Dir:        "/home/wizard/code/tripit",
				AttachMode: "rw",
				CoOwned:    true,
				CreatedBy:  "wizard",
				Members: []Member{
					{OSUser: "wizard", AddedBy: "wizard"},
					{OSUser: "emo", AddedBy: "wizard"},
				},
				Sessions: []SessionRef{
					{Owner: "wizard", Name: "fix-dates"},
					{Owner: "emo", Name: "demo"},
				},
			},
		},
	}
	if err := st.save(in); err != nil {
		t.Fatalf("save: %v", err)
	}
	out, err := st.load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if !reflect.DeepEqual(in, out) {
		t.Fatalf("roundtrip mismatch:\n in: %+v\nout: %+v", in, out)
	}
}

// Migrating one user's per-user layout: each grouping Project becomes a
// single-member GlobalProject owned by that user, with the user as the sole
// member and every session owned by that user. Ungrouped sessions are NOT
// pulled into a project (they stay in the per-user layout). Dir carries over;
// AttachMode stays "" (the RO default).
func TestMigrateUserLayoutImportsProjectsAsSingleMember(t *testing.T) {
	l := Layout{
		Version: 1,
		Projects: []Project{
			{Name: "tripit", Sessions: []string{"fix-dates", "demo"}, Dir: "/home/wizard/code/tripit"},
			{Name: "infra", Sessions: []string{}},
		},
		Ungrouped: []string{"scratch"},
	}
	var n int
	idgen := func() string { n++; return "id" + strconv.Itoa(n) }

	got := migrateUserLayout("wizard", l, idgen)

	want := []GlobalProject{
		{
			ID: "id1", Name: "tripit", Dir: "/home/wizard/code/tripit", CreatedBy: "wizard",
			Members:  []Member{{OSUser: "wizard", AddedBy: "wizard"}},
			Sessions: []SessionRef{{Owner: "wizard", Name: "fix-dates"}, {Owner: "wizard", Name: "demo"}},
		},
		{
			ID: "id2", Name: "infra", CreatedBy: "wizard",
			Members:  []Member{{OSUser: "wizard", AddedBy: "wizard"}},
			Sessions: []SessionRef{},
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("migration mismatch:\n got: %+v\nwant: %+v", got, want)
	}
}

// validateProjectSet enforces the global-document invariants. Names need NOT
// be globally unique (two owners may each have a "work" project), but IDs must
// be unique, every project needs ≥1 member, attach mode is ro/rw/empty, and a
// session (owner,name) belongs to at most one project.
func TestValidateProjectSet(t *testing.T) {
	base := func() ProjectSet {
		return ProjectSet{Version: 1, Projects: []GlobalProject{{
			ID: "p_a", Name: "tripit", Dir: "/home/wizard/code/tripit", AttachMode: "rw",
			CreatedBy: "wizard",
			Members:   []Member{{OSUser: "wizard", AddedBy: "wizard"}},
			Sessions:  []SessionRef{{Owner: "wizard", Name: "s1"}},
		}}}
	}
	cases := []struct {
		name    string
		mut     func(ps *ProjectSet)
		wantErr bool
	}{
		{"valid", func(ps *ProjectSet) {}, false},
		{"empty attach mode is ok", func(ps *ProjectSet) { ps.Projects[0].AttachMode = "" }, false},
		{"ro attach mode is ok", func(ps *ProjectSet) { ps.Projects[0].AttachMode = "ro" }, false},
		{"dir-less is ok", func(ps *ProjectSet) { ps.Projects[0].Dir = "" }, false},
		{"duplicate project name across owners is ok", func(ps *ProjectSet) {
			p2 := base().Projects[0]
			p2.ID = "p_b"
			p2.Members = []Member{{OSUser: "emo"}}
			p2.Sessions = []SessionRef{{Owner: "emo", Name: "s1"}}
			ps.Projects = append(ps.Projects, p2)
		}, false},
		{"bad version", func(ps *ProjectSet) { ps.Version = 2 }, true},
		{"empty id", func(ps *ProjectSet) { ps.Projects[0].ID = "" }, true},
		{"duplicate id", func(ps *ProjectSet) {
			p2 := base().Projects[0]
			p2.Members = []Member{{OSUser: "emo"}}
			p2.Sessions = []SessionRef{{Owner: "emo", Name: "s9"}}
			ps.Projects = append(ps.Projects, p2) // same ID p_a
		}, true},
		{"invalid name", func(ps *ProjectSet) { ps.Projects[0].Name = "bad name!" }, true},
		{"relative dir", func(ps *ProjectSet) { ps.Projects[0].Dir = "rel/path" }, true},
		{"bad attach mode", func(ps *ProjectSet) { ps.Projects[0].AttachMode = "sideways" }, true},
		{"no members", func(ps *ProjectSet) { ps.Projects[0].Members = []Member{} }, true},
		{"invalid member user", func(ps *ProjectSet) { ps.Projects[0].Members[0].OSUser = "bad user!" }, true},
		{"invalid session owner", func(ps *ProjectSet) { ps.Projects[0].Sessions[0].Owner = "" }, true},
		{"invalid session name", func(ps *ProjectSet) { ps.Projects[0].Sessions[0].Name = "no/slash" }, true},
		{"same session in two projects", func(ps *ProjectSet) {
			p2 := base().Projects[0]
			p2.ID = "p_b"
			ps.Projects = append(ps.Projects, p2) // reuses (wizard, s1)
		}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ps := base()
			tc.mut(&ps)
			err := validateProjectSet(ps)
			if tc.wantErr && err == nil {
				t.Fatalf("expected error, got nil")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("expected no error, got %v", err)
			}
		})
	}
}

// --- project HTTP endpoints -------------------------------------------------

// Creating a project makes the caller its sole member; listing returns only
// the caller's member projects (a non-member sees none).
func TestCreateAndListProjects(t *testing.T) {
	swapProjectStore(t)
	me, other := twoLocalUsers(t)
	withUserMap(t, me+"="+me+"\n"+other+"="+other+"\n")

	rec := httptest.NewRecorder()
	handleProjects(rec, projectsReq(http.MethodPost, "/projects", `{"name":"tripit","dir":"/home"}`, me))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: got %d, want 201; body=%s", rec.Code, rec.Body.String())
	}
	var created GlobalProject
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode created: %v", err)
	}
	if created.ID == "" || created.Name != "tripit" || created.Dir != "/home" {
		t.Fatalf("bad created project: %+v", created)
	}
	if len(created.Members) != 1 || created.Members[0].OSUser != me || created.CreatedBy != me {
		t.Fatalf("creator must be sole member + createdBy: %+v", created)
	}

	rec = httptest.NewRecorder()
	handleProjects(rec, projectsReq(http.MethodGet, "/projects", "", me))
	if rec.Code != http.StatusOK {
		t.Fatalf("list me: got %d", rec.Code)
	}
	var mine []GlobalProject
	if err := json.Unmarshal(rec.Body.Bytes(), &mine); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(mine) != 1 || mine[0].ID != created.ID {
		t.Fatalf("list me: want the created project, got %+v", mine)
	}

	rec = httptest.NewRecorder()
	handleProjects(rec, projectsReq(http.MethodGet, "/projects", "", other))
	var theirs []GlobalProject
	if err := json.Unmarshal(rec.Body.Bytes(), &theirs); err != nil {
		t.Fatalf("decode other list: %v", err)
	}
	if len(theirs) != 0 {
		t.Fatalf("non-member must see no projects, got %+v", theirs)
	}
}

func TestCreateProjectRejectsBadName(t *testing.T) {
	swapProjectStore(t)
	me, _ := twoLocalUsers(t)
	withUserMap(t, me+"="+me+"\n")
	rec := httptest.NewRecorder()
	handleProjects(rec, projectsReq(http.MethodPost, "/projects", `{"name":"bad name!"}`, me))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad name: got %d, want 400", rec.Code)
	}
}

func TestHandleUsersListsMapped(t *testing.T) {
	me, other := twoLocalUsers(t)
	withUserMap(t, me+"="+me+"\n"+other+"="+other+"\n")
	rec := httptest.NewRecorder()
	handleUsers(rec, projectsReq(http.MethodGet, "/users", "", me))
	if rec.Code != http.StatusOK {
		t.Fatalf("users: got %d", rec.Code)
	}
	var users []string
	_ = json.Unmarshal(rec.Body.Bytes(), &users)
	if len(users) != 2 {
		t.Fatalf("want 2 mapped users, got %+v", users)
	}
}

func TestHandleProjectsRequiresAuth(t *testing.T) {
	swapProjectStore(t)
	rec := httptest.NewRecorder()
	handleProjects(rec, projectsReq(http.MethodGet, "/projects", "", ""))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("no auth: got %d, want 401", rec.Code)
	}
}

func createProjectVia(t *testing.T, authUser, body string) GlobalProject {
	t.Helper()
	rec := httptest.NewRecorder()
	handleProjects(rec, projectsReq(http.MethodPost, "/projects", body, authUser))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create helper: got %d, body=%s", rec.Code, rec.Body.String())
	}
	var p GlobalProject
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
		t.Fatalf("create helper decode: %v", err)
	}
	return p
}

// A member can edit name/dir/attach-mode via PATCH (the settings dialog).
func TestPatchProjectUpdatesFields(t *testing.T) {
	swapProjectStore(t)
	me, _ := twoLocalUsers(t)
	withUserMap(t, me+"="+me+"\n")
	p := createProjectVia(t, me, `{"name":"tripit"}`)

	rec := httptest.NewRecorder()
	handleProjectByID(rec, projectsReq(http.MethodPatch, "/projects/"+p.ID,
		`{"name":"trip","dir":"/home/wizard/code/tripit","attachMode":"rw"}`, me))
	if rec.Code != http.StatusOK {
		t.Fatalf("patch: got %d, body=%s", rec.Code, rec.Body.String())
	}
	var up GlobalProject
	if err := json.Unmarshal(rec.Body.Bytes(), &up); err != nil {
		t.Fatal(err)
	}
	if up.Name != "trip" || up.Dir != "/home/wizard/code/tripit" || up.AttachMode != "rw" {
		t.Fatalf("patch result: %+v", up)
	}
}

func TestPatchProjectForbiddenForNonMember(t *testing.T) {
	swapProjectStore(t)
	me, other := twoLocalUsers(t)
	withUserMap(t, me+"="+me+"\n"+other+"="+other+"\n")
	p := createProjectVia(t, me, `{"name":"tripit"}`)
	rec := httptest.NewRecorder()
	handleProjectByID(rec, projectsReq(http.MethodPatch, "/projects/"+p.ID, `{"name":"trip"}`, other))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("patch by non-member: got %d, want 403", rec.Code)
	}
}

func TestPatchProjectNotFound(t *testing.T) {
	swapProjectStore(t)
	me, _ := twoLocalUsers(t)
	withUserMap(t, me+"="+me+"\n")
	rec := httptest.NewRecorder()
	handleProjectByID(rec, projectsReq(http.MethodPatch, "/projects/p_nope", `{"name":"x"}`, me))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("patch missing: got %d, want 404", rec.Code)
	}
}

func TestPatchProjectRejectsBadAttachMode(t *testing.T) {
	swapProjectStore(t)
	me, _ := twoLocalUsers(t)
	withUserMap(t, me+"="+me+"\n")
	p := createProjectVia(t, me, `{"name":"tripit"}`)
	rec := httptest.NewRecorder()
	handleProjectByID(rec, projectsReq(http.MethodPatch, "/projects/"+p.ID, `{"attachMode":"sideways"}`, me))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad attachMode: got %d, want 400", rec.Code)
	}
}

// Any member can delete (co-equal governance); a non-member cannot. Delete
// removes the project but never touches sessions.
func TestDeleteProject(t *testing.T) {
	swapProjectStore(t)
	me, other := twoLocalUsers(t)
	withUserMap(t, me+"="+me+"\n"+other+"="+other+"\n")
	p := createProjectVia(t, me, `{"name":"tripit"}`)

	rec := httptest.NewRecorder()
	handleProjectByID(rec, projectsReq(http.MethodDelete, "/projects/"+p.ID, "", other))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("delete by non-member: got %d, want 403", rec.Code)
	}

	rec = httptest.NewRecorder()
	handleProjectByID(rec, projectsReq(http.MethodDelete, "/projects/"+p.ID, "", me))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete: got %d, want 204", rec.Code)
	}

	rec = httptest.NewRecorder()
	handleProjects(rec, projectsReq(http.MethodGet, "/projects", "", me))
	var mine []GlobalProject
	_ = json.Unmarshal(rec.Body.Bytes(), &mine)
	if len(mine) != 0 {
		t.Fatalf("project still listed after delete: %+v", mine)
	}
}

// A member can add another mapped user; adding an unmapped user is 400; a
// non-member cannot add anyone.
func TestAddMember(t *testing.T) {
	swapProjectStore(t)
	me, other := twoLocalUsers(t)
	withUserMap(t, me+"="+me+"\n"+other+"="+other+"\n")
	p := createProjectVia(t, me, `{"name":"tripit"}`)

	rec := httptest.NewRecorder()
	handleProjectByID(rec, projectsReq(http.MethodPost, "/projects/"+p.ID+"/members", `{"osUser":"`+other+`"}`, me))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("add member: got %d, body=%s", rec.Code, rec.Body.String())
	}
	// other now sees the project
	rec = httptest.NewRecorder()
	handleProjects(rec, projectsReq(http.MethodGet, "/projects", "", other))
	var theirs []GlobalProject
	_ = json.Unmarshal(rec.Body.Bytes(), &theirs)
	if len(theirs) != 1 {
		t.Fatalf("added member should see the project, got %+v", theirs)
	}
	// adding an unmapped user → 400
	rec = httptest.NewRecorder()
	handleProjectByID(rec, projectsReq(http.MethodPost, "/projects/"+p.ID+"/members", `{"osUser":"ghost"}`, me))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("add unmapped: got %d, want 400", rec.Code)
	}
}

// Removing a member drops their session refs; removing the last member
// dissolves the project.
func TestRemoveMemberAndLastMemberDissolves(t *testing.T) {
	swapProjectStore(t)
	me, other := twoLocalUsers(t)
	withUserMap(t, me+"="+me+"\n"+other+"="+other+"\n")
	p := createProjectVia(t, me, `{"name":"tripit"}`)
	// add other + one of their sessions
	rec := httptest.NewRecorder()
	handleProjectByID(rec, projectsReq(http.MethodPost, "/projects/"+p.ID+"/members", `{"osUser":"`+other+`"}`, me))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("add member: %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	handleProjectByID(rec, projectsReq(http.MethodPost, "/projects/"+p.ID+"/sessions", `{"owner":"`+other+`","name":"work"}`, other))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("other adds own session: %d body=%s", rec.Code, rec.Body.String())
	}
	// other leaves → their session ref dropped, project still exists (me remains)
	rec = httptest.NewRecorder()
	handleProjectByID(rec, projectsReq(http.MethodDelete, "/projects/"+p.ID+"/members/"+other, "", other))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("leave: %d", rec.Code)
	}
	set, _ := projectStoreInstance.load()
	if len(set.Projects) != 1 || len(set.Projects[0].Members) != 1 || len(set.Projects[0].Sessions) != 0 {
		t.Fatalf("after leave: %+v", set.Projects)
	}
	// me leaves too → last member gone → project dissolves
	rec = httptest.NewRecorder()
	handleProjectByID(rec, projectsReq(http.MethodDelete, "/projects/"+p.ID+"/members/"+me, "", me))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("last leave: %d", rec.Code)
	}
	set, _ = projectStoreInstance.load()
	if len(set.Projects) != 0 {
		t.Fatalf("last member leaving should dissolve the project, got %+v", set.Projects)
	}
}

// A member assigns their OWN session; a session already in another project is
// 409; assigning someone else's session is refused.
func TestAssignSession(t *testing.T) {
	swapProjectStore(t)
	me, other := twoLocalUsers(t)
	withUserMap(t, me+"="+me+"\n"+other+"="+other+"\n")
	p := createProjectVia(t, me, `{"name":"tripit"}`)

	rec := httptest.NewRecorder()
	handleProjectByID(rec, projectsReq(http.MethodPost, "/projects/"+p.ID+"/sessions", `{"owner":"`+me+`","name":"s1"}`, me))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("assign own session: got %d, body=%s", rec.Code, rec.Body.String())
	}
	// assigning someone else's session → 403
	rec = httptest.NewRecorder()
	handleProjectByID(rec, projectsReq(http.MethodPost, "/projects/"+p.ID+"/sessions", `{"owner":"`+other+`","name":"s2"}`, me))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("assign other's session: got %d, want 403", rec.Code)
	}
	// same session into a second project → 409
	p2 := createProjectVia(t, me, `{"name":"other"}`)
	rec = httptest.NewRecorder()
	handleProjectByID(rec, projectsReq(http.MethodPost, "/projects/"+p2.ID+"/sessions", `{"owner":"`+me+`","name":"s1"}`, me))
	if rec.Code != http.StatusConflict {
		t.Fatalf("session in two projects: got %d, want 409", rec.Code)
	}
	// remove it from p1
	rec = httptest.NewRecorder()
	handleProjectByID(rec, projectsReq(http.MethodDelete, "/projects/"+p.ID+"/sessions/"+me+"/s1", "", me))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("remove session: %d", rec.Code)
	}
	set, _ := projectStoreInstance.load()
	for _, pr := range set.Projects {
		if pr.ID == p.ID && len(pr.Sessions) != 0 {
			t.Fatalf("session not removed: %+v", pr.Sessions)
		}
	}
}

func TestHandleProjectsRejectsOtherMethods(t *testing.T) {
	swapProjectStore(t)
	me, _ := twoLocalUsers(t)
	withUserMap(t, me+"="+me+"\n")
	rec := httptest.NewRecorder()
	handleProjects(rec, projectsReq(http.MethodDelete, "/projects", "", me))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("DELETE /projects: got %d, want 405", rec.Code)
	}
}

func TestProjectNameOf(t *testing.T) {
	ps := ProjectSet{Version: 1, Projects: []GlobalProject{
		{ID: "p1", Name: "tripit", Members: []Member{{OSUser: "wizard"}}, Sessions: []SessionRef{{Owner: "wizard", Name: "s1"}}},
	}}
	if got := projectNameOf(ps, "wizard", "s1"); got != "tripit" {
		t.Fatalf("member session: got %q", got)
	}
	if got := projectNameOf(ps, "wizard", "nope"); got != "" {
		t.Fatalf("ungrouped: got %q", got)
	}
	if got := projectNameOf(ps, "emo", "s1"); got != "" {
		t.Fatalf("wrong owner same name: got %q", got)
	}
}

// The caller sees foreign sessions via projects they belong to (blanket mode)
// and via direct shares; own sessions, non-member projects, and shares to others
// are excluded; rw beats ro when both apply.
func TestForeignRefsFor(t *testing.T) {
	ps := ProjectSet{Version: 1, Projects: []GlobalProject{
		{ID: "p1", Name: "shared", AttachMode: "rw",
			Members:  []Member{{OSUser: "wizard"}, {OSUser: "emo"}},
			Sessions: []SessionRef{{Owner: "wizard", Name: "mine"}, {Owner: "emo", Name: "theirs"}}},
		{ID: "p2", Name: "secret", AttachMode: "rw",
			Members:  []Member{{OSUser: "emo"}},
			Sessions: []SessionRef{{Owner: "emo", Name: "hidden"}}},
	}}
	ss := ShareSet{Version: 1, Shares: []Share{
		{Owner: "ancamilea", Name: "direct", Guest: "wizard", Mode: "ro"},
		{Owner: "emo", Name: "theirs", Guest: "wizard", Mode: "ro"},   // also project(rw) -> rw wins
		{Owner: "emo", Name: "other", Guest: "ancamilea", Mode: "rw"}, // not for caller
	}}
	got := foreignRefsFor("wizard", ps, ss)
	want := []visibleRef{
		{Owner: "ancamilea", Name: "direct", Access: "ro", Project: ""},
		{Owner: "emo", Name: "theirs", Access: "rw", Project: "shared"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("foreign refs:\n got %+v\nwant %+v", got, want)
	}
}

// One-shot bootstrap: with no global store yet, migrateAllLayouts imports every
// mapped user's per-user layout as single-member projects; run again it is a
// no-op (does not double-import).
func TestMigrateAllLayoutsOneShot(t *testing.T) {
	dir := t.TempDir()
	ls := newLayoutStore(dir + "/layout")
	ps := newProjectStore(dir + "/projects.json")
	if err := ls.save("wizard", Layout{Version: 1, Projects: []Project{{Name: "tripit", Sessions: []string{"s1"}}}, Ungrouped: []string{}}); err != nil {
		t.Fatal(err)
	}
	if err := ls.save("emo", Layout{Version: 1, Projects: []Project{{Name: "work", Sessions: []string{}}}, Ungrouped: []string{}}); err != nil {
		t.Fatal(err)
	}

	migrated, err := migrateAllLayouts(ls, ps, []string{"wizard", "emo"})
	if err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if !migrated {
		t.Fatal("first run should report it migrated")
	}
	set, err := ps.load()
	if err != nil {
		t.Fatal(err)
	}
	if len(set.Projects) != 2 {
		t.Fatalf("want 2 migrated projects, got %d: %+v", len(set.Projects), set.Projects)
	}
	owners := map[string]string{} // project name -> sole member
	ids := map[string]bool{}
	for _, p := range set.Projects {
		if len(p.Members) != 1 {
			t.Fatalf("project %q should be single-member, got %+v", p.Name, p.Members)
		}
		if p.ID == "" || ids[p.ID] {
			t.Fatalf("project %q id empty or duplicate: %q", p.Name, p.ID)
		}
		ids[p.ID] = true
		owners[p.Name] = p.Members[0].OSUser
	}
	if owners["tripit"] != "wizard" || owners["work"] != "emo" {
		t.Fatalf("wrong ownership after migration: %+v", owners)
	}

	// Second run must not double-import.
	migrated2, err := migrateAllLayouts(ls, ps, []string{"wizard", "emo"})
	if err != nil {
		t.Fatal(err)
	}
	if migrated2 {
		t.Fatal("second run should be a no-op (store already exists)")
	}
	set2, _ := ps.load()
	if len(set2.Projects) != 2 {
		t.Fatalf("second run changed the set: got %d projects", len(set2.Projects))
	}
}

// A generated project ID is non-empty and unique across calls (the real
// generator, not the test stub).
func TestNewProjectIDUnique(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 100; i++ {
		id := newProjectID()
		if id == "" {
			t.Fatal("newProjectID returned empty")
		}
		if seen[id] {
			t.Fatalf("duplicate project ID %q", id)
		}
		seen[id] = true
	}
}
