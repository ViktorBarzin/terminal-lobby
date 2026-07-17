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
