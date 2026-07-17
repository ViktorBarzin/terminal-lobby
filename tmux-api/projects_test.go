package main

import (
	"reflect"
	"strconv"
	"testing"
)

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
