package main

// The ninth thing a rename has to move: which sessions are on screen together.
//
// workspaces.go names carryRenameAcrossStores as renameSession's first caller
// and says what a miss costs — "a member that did not follow would strand a
// tile pointing at a name nothing answers to". The method arrived written,
// documented and covered by six tests in workspaces_test.go, every one of which
// calls st.renameSession directly on a store it built itself. None of them can
// see whether anything in the service ever calls it, and until this file
// nothing did.
//
// The timing is what makes it sharp rather than theoretical. ADR-0022 renames a
// session the moment its first title lands, which is 3-5 seconds into the first
// turn (measured 2026-09-06: of four sessions created that evening, two were
// renamed before any poll had listed them). So a session dragged into a
// workspace early in its life is renamed underneath the membership document
// almost immediately. The member then names nothing live, workspaceTilesFor
// filters it out, the group falls below MIN_WORKSPACE_MEMBERS, and the tiles
// collapse to a single session seconds after they were arranged.
//
// Two tests, one shape each: the cascade in isolation, and the whole ADR-0022
// path from an HTTP request to the document on disk.

import (
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"testing"
)

// hermeticRenameStores points every store the cascade writes at a temp dir, so
// a test renaming `824smya2cmz5` cannot touch the real /var/lib/tmux-api of
// whoever runs `go test`.
func hermeticRenameStores(t *testing.T) {
	t.Helper()
	withTempLayoutStore(t)
	withTempAssignmentStore(t)
	withTempWorkspaceStore(t)
	swapTitleStore(t)
	swapProjectStore(t)
	swapShareStore(t)
	swapImageStore(t)
}

// The carry itself: a member renamed in place keeps the slot it had, so the
// tile stays where the user put it rather than reappearing at the end of the
// arrangement.
//
// Driven through carryRenameAcrossStores and not through
// workspaceStoreInstance.renameSession, which is the entire point. Calling the
// store method proves the method works — it did, all along, while the feature
// was broken.
func TestRenameCarriesIntoTheWorkspaceStore(t *testing.T) {
	// actAs, or tmuxCmd shells out to `sudo -n -u wizard` and the stub never
	// runs; the birth-name stamp and the grid repin both go through it.
	actAs(t, "wizard")
	withTmuxStub(t, "exit 0")
	hermeticRenameStores(t)

	if err := workspaceStoreInstance.save("wizard", Workspaces{
		Version: workspacesVersion,
		Workspaces: []Workspace{
			// emo's `auth` sits beside wizard's own session on purpose: a tmux
			// rename lands in ONE user's server, so the carry must move the
			// member it owns and leave the foreign tile pointing where it does.
			{ID: "w1", Members: []WorkspaceMember{
				{Name: "auth", Owner: "emo"},
				{Name: "824smya2cmz5"},
				{Name: "docs"},
			}},
			{ID: "w2", Members: []WorkspaceMember{{Name: "logs"}, {Name: "build"}}},
		},
	}); err != nil {
		t.Fatal(err)
	}

	carryRenameAcrossStores("wizard", "824smya2cmz5", "remove-changed-files-panel")

	ws, err := workspaceStoreInstance.load("wizard")
	if err != nil {
		t.Fatal(err)
	}
	want := []WorkspaceMember{
		{Name: "auth", Owner: "emo"},
		{Name: "remove-changed-files-panel"},
		{Name: "docs"},
	}
	if !reflect.DeepEqual(ws.Workspaces[0].Members, want) {
		t.Fatalf("members after the rename = %+v, want %+v — a tile pointing at a name "+
			"nothing answers to is filtered out, and the workspace collapses",
			ws.Workspaces[0].Members, want)
	}
	renamed := SessionRef{Owner: "wizard", Name: "remove-changed-files-panel"}
	if id, ok := workspaceOfSession(ws, "wizard", renamed); !ok || id != "w1" {
		t.Errorf("the renamed session's workspace = (%q, %v), want (\"w1\", true)", id, ok)
	}
	stale := SessionRef{Owner: "wizard", Name: "824smya2cmz5"}
	if _, ok := workspaceOfSession(ws, "wizard", stale); ok {
		t.Error("the old name is still listed as a member")
	}
	untouched := []WorkspaceMember{{Name: "logs"}, {Name: "build"}}
	if !reflect.DeepEqual(ws.Workspaces[1].Members, untouched) {
		t.Errorf("an unrelated workspace moved: %+v", ws.Workspaces[1].Members)
	}
}

// A user with no workspace at all is the common case by a wide margin, and
// every retitle reaches the cascade. Nothing may be written for them — a
// document conjured here would have to be a valid one, and the empty default is
// what the handler already serves.
func TestRenameOfASessionInNoWorkspaceWritesNothing(t *testing.T) {
	actAs(t, "wizard")
	withTmuxStub(t, "exit 0")
	hermeticRenameStores(t)

	carryRenameAcrossStores("wizard", "824smya2cmz5", "fix-the-parser")

	if _, err := os.Stat(workspaceStoreInstance.path("wizard")); !os.IsNotExist(err) {
		t.Fatalf("a workspaces document was written for a user who has never made one: %v", err)
	}
}

// The whole ADR-0022 path, from the request a lobby actually sends to the
// document on disk: POST /sessions/{id}/title stamps the title, derives a name
// from it, renames the tmux session, and carries that rename into every store
// keyed by the old name. The workspace membership is one of them.
//
// This is the test that would have caught the gap. It goes through the real
// route handler rather than the cascade, so nothing about it assumes which
// function does the carrying — only that a session dragged into a workspace and
// then titled is still in that workspace afterwards.
func TestATitleLandingCarriesWorkspaceMembership(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)           // caller == current user: tmuxCmd skips sudo,
	withUserMap(t, "authself="+osSelf+"\n") // so the stub runs directly
	hermeticRenameStores(t)
	withTmuxStub(t, "exit 0")

	if err := workspaceStoreInstance.save(osSelf, Workspaces{
		Version: workspacesVersion,
		Workspaces: []Workspace{{ID: "w1", Members: []WorkspaceMember{
			{Name: "824smya2cmz5"}, {Name: "auth"},
		}}},
	}); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	handleSessionByName(rec, sessionReq(http.MethodPost, "/sessions/824smya2cmz5/title",
		`{"title":"Fix the parser"}`, "authself"))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("POST title: got %d, want %d (body %q)", rec.Code, http.StatusNoContent, rec.Body)
	}

	ws, err := workspaceStoreInstance.load(osSelf)
	if err != nil {
		t.Fatal(err)
	}
	want := []WorkspaceMember{{Name: "fix-the-parser"}, {Name: "auth"}}
	if !reflect.DeepEqual(ws.Workspaces[0].Members, want) {
		t.Fatalf("members after the first title landed = %+v, want %+v — the workspace has "+
			"one live member left and collapses to a single session", ws.Workspaces[0].Members, want)
	}
}
