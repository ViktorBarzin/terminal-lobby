package main

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
)

// --- the memory itself ----------------------------------------------------

func withTempAssignmentStore(t *testing.T) {
	t.Helper()
	old := assignmentStoreInstance
	assignmentStoreInstance = newAssignmentStore(t.TempDir())
	t.Cleanup(func() { assignmentStoreInstance = old })
}

func TestAssignmentMissingFileReadsEmpty(t *testing.T) {
	st := newAssignmentStore(t.TempDir())
	set, err := st.load("alice")
	if err != nil {
		t.Fatalf("load on missing file: %v", err)
	}
	if set.Version != assignmentsVersion || len(set.Entries) != 0 {
		t.Fatalf("default set: %+v", set)
	}
	if p, ok := assignmentProjectOf(set, "anything"); ok {
		t.Fatalf("empty memory answered %q", p)
	}
}

func TestAssignmentRoundtrip(t *testing.T) {
	st := newAssignmentStore(t.TempDir())
	if err := st.remember("alice", "repowise", "code"); err != nil {
		t.Fatalf("remember: %v", err)
	}
	set, err := st.load("alice")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	p, ok := assignmentProjectOf(set, "repowise")
	if !ok || p != "code" {
		t.Fatalf("projectOf(repowise): got (%q, %v), want (\"code\", true)", p, ok)
	}
	if set.Entries[0].At == 0 {
		t.Fatalf("entry not stamped: %+v", set.Entries[0])
	}
	// One user's memory must not answer for another's — the file is per user.
	other, err := st.load("bob")
	if err != nil {
		t.Fatalf("load bob: %v", err)
	}
	if _, ok := assignmentProjectOf(other, "repowise"); ok {
		t.Fatal("bob's memory answered for alice's session")
	}
}

// A name killed twice keeps ONE entry, carrying the latest project: a session
// moved between projects before its second kill must not be placed by the first.
func TestAssignmentUpsertsByName(t *testing.T) {
	st := newAssignmentStore(t.TempDir())
	if err := st.remember("alice", "repowise", "code"); err != nil {
		t.Fatal(err)
	}
	if err := st.remember("alice", "repowise", "tripit"); err != nil {
		t.Fatal(err)
	}
	set, _ := st.load("alice")
	if len(set.Entries) != 1 {
		t.Fatalf("want one entry per name, got %+v", set.Entries)
	}
	if p, _ := assignmentProjectOf(set, "repowise"); p != "tripit" {
		t.Fatalf("latest project: got %q, want tripit", p)
	}
}

// Retention is by count and drops the OLDEST first, so a long-running box keeps
// the kills a restore might still care about.
func TestAssignmentPrunesOldestFirst(t *testing.T) {
	st := newAssignmentStore(t.TempDir())
	for i := 0; i < assignmentsKeep+10; i++ {
		if err := st.remember("alice", "s"+strconv.Itoa(i), "code"); err != nil {
			t.Fatalf("remember %d: %v", i, err)
		}
	}
	set, _ := st.load("alice")
	if len(set.Entries) != assignmentsKeep {
		t.Fatalf("retention: got %d entries, want %d", len(set.Entries), assignmentsKeep)
	}
	if _, ok := assignmentProjectOf(set, "s0"); ok {
		t.Fatal("oldest entry survived the prune")
	}
	if _, ok := assignmentProjectOf(set, "s"+strconv.Itoa(assignmentsKeep+9)); !ok {
		t.Fatal("newest entry was pruned")
	}
}

// --- resolving where a restored session belongs ----------------------------

func TestResolveRestoreProjectPrecedence(t *testing.T) {
	layout := Layout{
		Version:   1,
		Projects:  []Project{{Name: "code", Sessions: []string{"repowise", "moved"}}},
		Ungrouped: []string{"scratch"},
	}
	mem := AssignmentSet{Version: 1, Entries: []Assignment{
		{Name: "killed", Project: "tripit"},
		{Name: "moved", Project: "tripit"},  // stale: the layout still has it
		{Name: "unpinned", Project: ""},     // deliberately ungrouped before the kill
		{Name: "shared", Project: "tripit"}, // fresher than the global store below
	}}
	ps := ProjectSet{Version: 1, Projects: []GlobalProject{
		{ID: "p1", Name: "t3-code", Members: []Member{{OSUser: "alice"}},
			Sessions: []SessionRef{{Owner: "alice", Name: "shared"}, {Owner: "alice", Name: "global-only"}}},
	}}

	cases := []struct {
		name, want, why string
	}{
		{"repowise", "code", "the layout is the arrangement the user can see"},
		{"scratch", "", "the layout placed it in Ungrouped — that is an opinion"},
		{"moved", "code", "a live layout reference beats an older kill"},
		{"killed", "tripit", "the memory holds what the layout was asked to forget"},
		{"unpinned", "", "remembered as ungrouped, and that must stick"},
		{"shared", "tripit", "the kill memory is stamped later than the shared ref"},
		{"global-only", "t3-code", "the shared store answers when nothing else does"},
		{"never-seen", "", "nobody has an opinion"},
	}
	for _, c := range cases {
		if got := resolveRestoreProject(layout, mem, ps, "alice", c.name); got != c.want {
			t.Errorf("resolveRestoreProject(%q) = %q, want %q — %s", c.name, got, c.want, c.why)
		}
	}
}

// A ref belonging to ANOTHER owner must not place this user's session.
func TestResolveRestoreProjectIgnoresOtherOwners(t *testing.T) {
	ps := ProjectSet{Version: 1, Projects: []GlobalProject{
		{ID: "p1", Name: "t3-code", Members: []Member{{OSUser: "bob"}},
			Sessions: []SessionRef{{Owner: "bob", Name: "rewrite"}}},
	}}
	if got := resolveRestoreProject(emptyLayout(), AssignmentSet{}, ps, "alice", "rewrite"); got != "" {
		t.Fatalf("got %q, want \"\" — bob's ref must not place alice's session", got)
	}
}

// --- placing the restored name in the layout -------------------------------

func TestPlaceRestoredAppendsForgottenSession(t *testing.T) {
	in := Layout{Version: 1, Projects: []Project{{Name: "code", Sessions: []string{"health"}}}, Ungrouped: []string{}}
	out, changed := placeRestored(in, "repowise", "repowise", "code")
	if !changed {
		t.Fatal("placement reported no change")
	}
	if got := out.Projects[0].Sessions; len(got) != 2 || got[1] != "repowise" {
		t.Fatalf("project sessions: got %v, want [health repowise]", got)
	}
	if err := validateLayout(out); err != nil {
		t.Fatalf("placement produced a layout the PUT validator rejects: %v", err)
	}
}

// The renamed session sits with the one that took its name, not at the end of
// the project — that is what makes the recovered conversation findable.
func TestPlaceRestoredInsertsRenamedAfterOrigin(t *testing.T) {
	in := Layout{
		Version:   1,
		Projects:  []Project{{Name: "code", Sessions: []string{"health", "repowise", "matrix"}}},
		Ungrouped: []string{},
	}
	out, changed := placeRestored(in, "repowise", "repowise-1250", "code")
	if !changed {
		t.Fatal("placement reported no change")
	}
	want := []string{"health", "repowise", "repowise-1250", "matrix"}
	got := out.Projects[0].Sessions
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

// An origin sitting in Ungrouped keeps its renamed restore beside it there,
// rather than being pulled into a project it never belonged to.
func TestPlaceRestoredFollowsOriginIntoUngrouped(t *testing.T) {
	in := Layout{Version: 1, Projects: []Project{{Name: "code", Sessions: []string{}}}, Ungrouped: []string{"a", "scratch", "b"}}
	out, changed := placeRestored(in, "scratch", "scratch-1250", "")
	if !changed {
		t.Fatal("placement reported no change")
	}
	want := []string{"a", "scratch", "scratch-1250", "b"}
	for i := range want {
		if out.Ungrouped[i] != want[i] {
			t.Fatalf("got %v, want %v", out.Ungrouped, want)
		}
	}
}

func TestPlaceRestoredLeavesSurvivingReferenceAlone(t *testing.T) {
	in := Layout{Version: 1, Projects: []Project{{Name: "code", Sessions: []string{"repowise"}}}, Ungrouped: []string{}}
	out, changed := placeRestored(in, "repowise", "repowise", "code")
	if changed {
		t.Fatalf("an OOM death keeps its reference — placement must be a no-op, got %+v", out)
	}
}

// Nothing to place it by, or a project this layout does not render: leave it in
// Ungrouped rather than inventing a group the sidebar has never shown.
func TestPlaceRestoredWithoutAProjectIsANoOp(t *testing.T) {
	in := Layout{Version: 1, Projects: []Project{{Name: "code", Sessions: []string{}}}, Ungrouped: []string{}}
	if _, changed := placeRestored(in, "orphan", "orphan", ""); changed {
		t.Fatal("an unplaceable session must not change the layout")
	}
	if _, changed := placeRestored(in, "orphan", "orphan", "gone-project"); changed {
		t.Fatal("a project the layout does not have must not be created")
	}
}

// --- a UI kill writes the memory ------------------------------------------

func killReq(t *testing.T, name string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	handleSessionByName(rec, sessionReq(http.MethodDelete, "/sessions/"+name, "", "alice"))
	return rec
}

func TestKillRemembersProjectBeforeDroppingIt(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osSelf+"\n")
	withTempLayoutStore(t)
	withTempAssignmentStore(t)
	withTmuxStub(t, "exit 0")
	withSudoStub(t, "exit 0")

	if err := layoutStoreInstance.save(osSelf, Layout{
		Version:   1,
		Projects:  []Project{{Name: "code", Sessions: []string{"repowise"}}},
		Ungrouped: []string{},
	}); err != nil {
		t.Fatal(err)
	}

	if rec := killReq(t, "repowise"); rec.Code != http.StatusNoContent {
		t.Fatalf("DELETE: got %d, want %d", rec.Code, http.StatusNoContent)
	}

	l, _ := layoutStoreInstance.load(osSelf)
	if len(l.Projects[0].Sessions) != 0 {
		t.Fatalf("kill must still drop the layout reference: %+v", l.Projects[0])
	}
	set, _ := assignmentStoreInstance.load(osSelf)
	if p, ok := assignmentProjectOf(set, "repowise"); !ok || p != "code" {
		t.Fatalf("memory after kill: got (%q, %v), want (\"code\", true)", p, ok)
	}
}

// Ungrouped is an opinion worth remembering: pulling a session out of a project
// and then killing it must not be undone by a later restore.
func TestKillRemembersUngroupedAsEmpty(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osSelf+"\n")
	withTempLayoutStore(t)
	withTempAssignmentStore(t)
	withTmuxStub(t, "exit 0")
	withSudoStub(t, "exit 0")

	if err := layoutStoreInstance.save(osSelf, Layout{
		Version: 1, Projects: []Project{}, Ungrouped: []string{"scratch"},
	}); err != nil {
		t.Fatal(err)
	}
	killReq(t, "scratch")

	set, _ := assignmentStoreInstance.load(osSelf)
	p, ok := assignmentProjectOf(set, "scratch")
	if !ok || p != "" {
		t.Fatalf("memory after killing an ungrouped session: got (%q, %v), want (\"\", true)", p, ok)
	}
}

// Nothing for the layout to forget means nothing to remember — writing "" here
// would override the shared project store, which may well know better.
func TestKillWithoutALayoutOpinionRemembersNothing(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osSelf+"\n")
	withTempLayoutStore(t)
	withTempAssignmentStore(t)
	withTmuxStub(t, "exit 0")
	withSudoStub(t, "exit 0")

	killReq(t, "never-placed")

	set, _ := assignmentStoreInstance.load(osSelf)
	if len(set.Entries) != 0 {
		t.Fatalf("wrote a memory for a session the layout never placed: %+v", set.Entries)
	}
}

// --- restore puts them back ------------------------------------------------

// The wrapper stub answers `show` with a resolved snapshot and accepts
// `select`, so restoreFromSelection runs its real path.
func withSnapshotWrapper(t *testing.T, rows string) string {
	t.Helper()
	return withSudoStub(t, `case "$4" in show) printf '`+rows+`' ;; esac
exit 0`)
}

func TestRestoreSelectionPlacesForgottenSession(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withTempLayoutStore(t)
	withTempAssignmentStore(t)
	swapProjectStore(t)
	withSnapshotWrapper(t, `repowise\t/home/x/code\tu1\tmissing\tnew\trepowise\ton\t-\n`)

	if err := layoutStoreInstance.save(osSelf, Layout{
		Version: 1, Projects: []Project{{Name: "code", Sessions: []string{"health"}}}, Ungrouped: []string{},
	}); err != nil {
		t.Fatal(err)
	}
	if err := assignmentStoreInstance.remember(osSelf, "repowise", "code"); err != nil {
		t.Fatal(err)
	}

	status, msg := restoreFromSelection(osSelf, restoreSelection{
		Snapshot: "20260814T125000", Sessions: []string{"repowise"},
	})
	if status != http.StatusOK {
		t.Fatalf("restore: got %d (%s), want 200", status, msg)
	}

	l, _ := layoutStoreInstance.load(osSelf)
	got := l.Projects[0].Sessions
	if len(got) != 2 || got[1] != "repowise" {
		t.Fatalf("restored session not placed: %v", got)
	}
}

func TestRestoreSelectionPlacesRenamedBesideOrigin(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withTempLayoutStore(t)
	withTempAssignmentStore(t)
	swapProjectStore(t)
	withSnapshotWrapper(t,
		`repowise\t/home/x/code\tu1\tlive_other_conv\tsuffixed\trepowise-1250\ton\t-\n`)

	if err := layoutStoreInstance.save(osSelf, Layout{
		Version:   1,
		Projects:  []Project{{Name: "code", Sessions: []string{"repowise", "matrix"}}},
		Ungrouped: []string{},
	}); err != nil {
		t.Fatal(err)
	}

	status, msg := restoreFromSelection(osSelf, restoreSelection{
		Snapshot: "20260814T125000", Sessions: []string{"repowise"},
	})
	if status != http.StatusOK {
		t.Fatalf("restore: got %d (%s), want 200", status, msg)
	}

	l, _ := layoutStoreInstance.load(osSelf)
	want := []string{"repowise", "repowise-1250", "matrix"}
	got := l.Projects[0].Sessions
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

// A renamed restore of a session that other members can see must stay visible
// to them, so the shared store gains the new name alongside the original.
func TestRestoreSelectionMirrorsRenamedIntoSharedProject(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withTempLayoutStore(t)
	withTempAssignmentStore(t)
	swapProjectStore(t)
	withSnapshotWrapper(t,
		`rewrite\t/home/x/code\tu1\tlive_other_conv\tsuffixed\trewrite-1250\ton\t-\n`)

	if err := projectStoreInstance.save(ProjectSet{Version: 1, Projects: []GlobalProject{{
		ID: "p1", Name: "t3-code",
		Members:  []Member{{OSUser: osSelf}, {OSUser: "bob"}},
		Sessions: []SessionRef{{Owner: osSelf, Name: "rewrite"}},
	}}}); err != nil {
		t.Fatal(err)
	}

	if status, msg := restoreFromSelection(osSelf, restoreSelection{
		Snapshot: "20260814T125000", Sessions: []string{"rewrite"},
	}); status != http.StatusOK {
		t.Fatalf("restore: got %d (%s), want 200", status, msg)
	}

	ps, _ := projectStoreInstance.load()
	if got := projectNameOf(ps, osSelf, "rewrite-1250"); got != "t3-code" {
		t.Fatalf("renamed session in the shared store: got %q, want t3-code", got)
	}
}

// Placement is a convenience layered on top of a restore that already
// succeeded: a store that cannot be written must not turn a recovered session
// into a failed request.
func TestRestoreSelectionSucceedsWhenPlacementCannot(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withTempAssignmentStore(t)
	swapProjectStore(t)
	withSnapshotWrapper(t, `repowise\t/home/x/code\tu1\tmissing\tnew\trepowise\ton\t-\n`)

	old := layoutStoreInstance
	layoutStoreInstance = newLayoutStore("/proc/nonexistent-dir") // unwritable
	t.Cleanup(func() { layoutStoreInstance = old })

	if status, msg := restoreFromSelection(osSelf, restoreSelection{
		Snapshot: "20260814T125000", Sessions: []string{"repowise"},
	}); status != http.StatusOK {
		t.Fatalf("restore: got %d (%s), want 200 — the sessions are already back", status, msg)
	}
}
