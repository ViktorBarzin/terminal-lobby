package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// --- workspace store -------------------------------------------------------

func testWorkspaceStore(t *testing.T) *workspaceStore {
	t.Helper()
	return newWorkspaceStore(t.TempDir())
}

// withTempWorkspaceStore points the handler (and the kill path) at a temp-dir
// store for the test's life, mirroring withTempLayoutStore.
func withTempWorkspaceStore(t *testing.T) {
	t.Helper()
	old := workspaceStoreInstance
	workspaceStoreInstance = newWorkspaceStore(t.TempDir())
	t.Cleanup(func() { workspaceStoreInstance = old })
}

// ownMembers builds the ordinary member list: sessions of the caller's own, so
// no owner is spelled out. A foreign member is written as a literal at the few
// places that are about one, which keeps the owner visible exactly where it is
// the point of the test.
func ownMembers(names ...string) []WorkspaceMember {
	out := make([]WorkspaceMember, 0, len(names))
	for _, n := range names {
		out = append(out, WorkspaceMember{Name: n})
	}
	return out
}

func TestWorkspacesLoadMissingFileReturnsEmptyDefault(t *testing.T) {
	st := testWorkspaceStore(t)
	ws, err := st.load("alice")
	if err != nil {
		t.Fatalf("load on missing file: %v", err)
	}
	if ws.Version != workspacesVersion {
		t.Fatalf("default version: got %d, want %d", ws.Version, workspacesVersion)
	}
	if ws.Workspaces == nil {
		t.Fatalf("default slice must be non-nil (JSON [] not null): %+v", ws)
	}
	if len(ws.Workspaces) != 0 {
		t.Fatalf("default document not empty: %+v", ws)
	}
}

func TestWorkspacesSaveLoadRoundtrip(t *testing.T) {
	st := testWorkspaceStore(t)
	in := Workspaces{
		Version: workspacesVersion,
		Workspaces: []Workspace{
			{ID: "w1", Members: ownMembers("auth", "deploy")},
			{ID: "w2", Members: ownMembers("docs", "logs", "scratch")},
		},
	}
	if err := st.save("alice", in); err != nil {
		t.Fatalf("save: %v", err)
	}
	out, err := st.load("alice")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if !reflect.DeepEqual(in, out) {
		t.Fatalf("roundtrip mismatch:\n in: %+v\nout: %+v", in, out)
	}
}

// Member ORDER is the document's whole answer to "how does a fresh device
// arrange this workspace" (ADR-0027: a device with no geometry auto-arranges
// evenly in the server-side member order), so a reordering save has to land
// as a reordering and not as a no-op.
func TestWorkspacesMemberOrderIsPreserved(t *testing.T) {
	st := testWorkspaceStore(t)
	if err := st.save("alice", Workspaces{
		Version:    workspacesVersion,
		Workspaces: []Workspace{{ID: "w1", Members: ownMembers("auth", "deploy", "docs")}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.save("alice", Workspaces{
		Version:    workspacesVersion,
		Workspaces: []Workspace{{ID: "w1", Members: ownMembers("docs", "auth", "deploy")}},
	}); err != nil {
		t.Fatal(err)
	}
	ws, err := st.load("alice")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	want := ownMembers("docs", "auth", "deploy")
	if !reflect.DeepEqual(ws.Workspaces[0].Members, want) {
		t.Fatalf("member order: got %v, want %v", ws.Workspaces[0].Members, want)
	}
}

// One document per OS user, so one person's workspaces are invisible to the
// next. The store is keyed by name alone, which is easy to get wrong by
// sharing a file and filtering on read.
func TestWorkspacesArePerUser(t *testing.T) {
	st := testWorkspaceStore(t)
	if err := st.save("alice", Workspaces{
		Version:    workspacesVersion,
		Workspaces: []Workspace{{ID: "w1", Members: ownMembers("auth", "deploy")}},
	}); err != nil {
		t.Fatal(err)
	}
	ws, err := st.load("bob")
	if err != nil {
		t.Fatalf("load for a user who never saved: %v", err)
	}
	if len(ws.Workspaces) != 0 {
		t.Fatalf("bob sees alice's workspaces: %+v", ws)
	}
}

// A corrupt file is an error rather than an empty document, for the reason
// layoutStore gives: better a 500 than silently wiping the user's arrangement
// on the next whole-document PUT.
func TestWorkspacesCorruptFileIsAnError(t *testing.T) {
	st := testWorkspaceStore(t)
	if err := os.MkdirAll(st.dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(st.dir, "alice.json"), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := st.load("alice"); err == nil {
		t.Fatal("a corrupt document must be an error, not an empty one")
	}
}

// --- the atomic write ------------------------------------------------------

// The document lands 0600 inside a 0700 directory (every store here is private
// to one OS user), with a trailing newline so the files stay readable with cat,
// and no temp file left behind.
func TestWorkspacesSaveIsPrivateAndLeavesNoTemp(t *testing.T) {
	// A directory the STORE has to create, not t.TempDir() itself — MkdirAll
	// leaves an existing directory's mode alone, so /var/lib/tmux-api/workspaces
	// appearing on first write is the case worth pinning.
	st := newWorkspaceStore(filepath.Join(t.TempDir(), "workspaces"))
	if err := st.save("alice", Workspaces{
		Version:    workspacesVersion,
		Workspaces: []Workspace{{ID: "w1", Members: ownMembers("auth", "deploy")}},
	}); err != nil {
		t.Fatalf("save: %v", err)
	}

	di, err := os.Stat(st.dir)
	if err != nil {
		t.Fatal(err)
	}
	if got := di.Mode().Perm(); got != 0o700 {
		t.Fatalf("store dir mode: got %o, want 700", got)
	}
	fi, err := os.Stat(st.path("alice"))
	if err != nil {
		t.Fatal(err)
	}
	if got := fi.Mode().Perm(); got != 0o600 {
		t.Fatalf("document mode: got %o, want 600", got)
	}

	raw, err := os.ReadFile(st.path("alice"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(string(raw), "\n") {
		t.Fatalf("document must end in a newline, got %q", raw)
	}

	entries, err := os.ReadDir(st.dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Fatalf("save left a temp file behind: %s", e.Name())
		}
	}
}

// Two stores over one directory model what the mutex cannot: two writers that
// do not share a lock. writeAtomic's tmp+rename is what has to hold here, and
// a reader must never see a half-written document — which for a whole-document
// PUT store means never see a user's arrangement as a parse error.
//
// Each writer's document is self-identifying (workspace id "w<n>", the member
// names derived from the same n), so a torn write shows up as a document that
// belongs to nobody rather than as a lucky parse.
func TestWorkspacesConcurrentWritersNeverTearTheDocument(t *testing.T) {
	dir := t.TempDir()
	writers := []*workspaceStore{newWorkspaceStore(dir), newWorkspaceStore(dir)}
	const rounds = 40

	docFor := func(n int) Workspaces {
		return Workspaces{
			Version: workspacesVersion,
			Workspaces: []Workspace{{
				ID:      "w" + strconv.Itoa(n),
				Members: ownMembers("a"+strconv.Itoa(n), "b"+strconv.Itoa(n)),
			}},
		}
	}

	var wg sync.WaitGroup
	errs := make(chan error, len(writers)*rounds+rounds)
	for w, st := range writers {
		wg.Add(1)
		go func(base int, st *workspaceStore) {
			defer wg.Done()
			for i := 0; i < rounds; i++ {
				if err := st.save("alice", docFor(base*rounds+i)); err != nil {
					errs <- fmt.Errorf("save: %w", err)
					return
				}
			}
		}(w, st)
	}
	// A reader on its own store, i.e. holding neither writer's mutex.
	reader := newWorkspaceStore(dir)
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < rounds; i++ {
			got, err := reader.load("alice")
			if err != nil {
				errs <- fmt.Errorf("load saw a torn document: %w", err)
				return
			}
			if len(got.Workspaces) == 0 {
				continue // the first write has not landed yet
			}
			ws := got.Workspaces[0]
			n := strings.TrimPrefix(ws.ID, "w")
			if want := ownMembers("a"+n, "b"+n); !reflect.DeepEqual(ws.Members, want) {
				errs <- fmt.Errorf("document %q carries members %v, want %v — a write was interleaved",
					ws.ID, ws.Members, want)
				return
			}
		}
	}()
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}

	// Whoever wrote last, the surviving document is one whole document.
	final, err := reader.load("alice")
	if err != nil {
		t.Fatalf("final load: %v", err)
	}
	if err := validateWorkspaces(final, "alice"); err != nil {
		t.Fatalf("the surviving document is not valid: %v (%+v)", err, final)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Fatalf("concurrent saves left a temp file behind: %s", e.Name())
		}
	}
}

// --- healing a stored document ---------------------------------------------

// The exclusivity rule is enforced on write, so a document on disk that breaks
// it blocks EVERY later write rather than just the one that made it: the client
// PUTs the whole document back on each change, so one bad file means every drag
// afterwards reports a failure the user cannot act on. layoutStore learned this
// the expensive way on 2026-09-06 (dropDuplicateSessions) and the fix was to
// heal on read. First mention wins, and the workspace left holding one tile
// goes, because one tile is not a workspace.
func TestWorkspacesLoadHealsASessionInTwoWorkspaces(t *testing.T) {
	st := testWorkspaceStore(t)
	writeRawWorkspaces(t, st, "alice",
		`{"version":1,"workspaces":[{"id":"w1","members":[{"name":"auth"},{"name":"deploy"}]},{"id":"w2","members":[{"name":"auth"},{"name":"docs"}]}]}`)

	ws, err := st.load("alice")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if err := validateWorkspaces(ws, "alice"); err != nil {
		t.Fatalf("a healed document must validate: %v (%+v)", err, ws)
	}
	if len(ws.Workspaces) != 1 || ws.Workspaces[0].ID != "w1" {
		t.Fatalf("first mention must win: %+v", ws.Workspaces)
	}
	if !reflect.DeepEqual(ws.Workspaces[0].Members, ownMembers("auth", "deploy")) {
		t.Fatalf("w1 must be untouched: %+v", ws.Workspaces[0])
	}
}

func TestWorkspacesLoadHealsARepeatedMemberInOneWorkspace(t *testing.T) {
	st := testWorkspaceStore(t)
	writeRawWorkspaces(t, st, "alice",
		`{"version":1,"workspaces":[{"id":"w1","members":[{"name":"auth"},{"name":"deploy"},{"name":"auth"}]}]}`)

	ws, err := st.load("alice")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if !reflect.DeepEqual(ws.Workspaces[0].Members, ownMembers("auth", "deploy")) {
		t.Fatalf("repeated member must be dropped: %+v", ws.Workspaces[0])
	}
}

// The heal decides "the same session" on the resolved (owner, name) pair, so
// one NAME under two owners is two members and both stay. emo's `auth` and
// alice's are different terminals; dropping one of them would quietly take a
// tile away from a workspace that was describing a perfectly ordinary screen.
func TestWorkspacesLoadKeepsOneNameUnderTwoOwners(t *testing.T) {
	st := testWorkspaceStore(t)
	writeRawWorkspaces(t, st, "alice",
		`{"version":1,"workspaces":[{"id":"w1","members":[{"name":"auth","owner":"emo"},{"name":"auth"},{"name":"deploy"}]}]}`)

	ws, err := st.load("alice")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	want := []WorkspaceMember{{Name: "auth", Owner: "emo"}, {Name: "auth"}, {Name: "deploy"}}
	if !reflect.DeepEqual(ws.Workspaces[0].Members, want) {
		t.Fatalf("two owners, one name:\n got %+v\nwant %+v", ws.Workspaces[0].Members, want)
	}
}

// The pair is also what makes a repeat a repeat. A document naming emo's `auth`
// in two workspaces is the same failure as naming your own twice — one session,
// two tiles, contending for one Grid — and first mention wins here as everywhere
// else. The own `auth` in w2 is untouched by that: different session.
func TestWorkspacesLoadHealsAForeignSessionInTwoWorkspaces(t *testing.T) {
	st := testWorkspaceStore(t)
	writeRawWorkspaces(t, st, "alice",
		`{"version":1,"workspaces":[{"id":"w1","members":[{"name":"auth","owner":"emo"},{"name":"deploy"}]},{"id":"w2","members":[{"name":"auth","owner":"emo"},{"name":"auth"},{"name":"docs"}]}]}`)

	ws, err := st.load("alice")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if err := validateWorkspaces(ws, "alice"); err != nil {
		t.Fatalf("a healed document must validate: %v (%+v)", err, ws)
	}
	if len(ws.Workspaces) != 2 {
		t.Fatalf("both workspaces keep two members: %+v", ws.Workspaces)
	}
	if !reflect.DeepEqual(ws.Workspaces[1].Members, ownMembers("auth", "docs")) {
		t.Fatalf("only the repeated PAIR goes: %+v", ws.Workspaces[1].Members)
	}
}

// Spelling your own name into a member is the other way to write the same
// session, and the heal resolves it rather than storing two tiles of one
// terminal. Nothing in the client mints this shape — it builds members from tile
// keys, which carry no owner for your own sessions — so this covers a
// hand-edited document and a future client that spells owners out.
func TestWorkspacesLoadHealsTheCallersOwnSessionSpelledTwoWays(t *testing.T) {
	st := testWorkspaceStore(t)
	writeRawWorkspaces(t, st, "alice",
		`{"version":1,"workspaces":[{"id":"w1","members":[{"name":"auth","owner":"alice"},{"name":"auth"},{"name":"deploy"}]}]}`)

	ws, err := st.load("alice")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	want := []WorkspaceMember{{Name: "auth", Owner: "alice"}, {Name: "deploy"}}
	if !reflect.DeepEqual(ws.Workspaces[0].Members, want) {
		t.Fatalf("one session, first spelling wins:\n got %+v\nwant %+v", ws.Workspaces[0].Members, want)
	}
}

func TestWorkspacesLoadDropsAnUndersizedWorkspace(t *testing.T) {
	st := testWorkspaceStore(t)
	writeRawWorkspaces(t, st, "alice",
		`{"version":1,"workspaces":[{"id":"w1","members":[{"name":"auth"}]},{"id":"w2","members":[]},{"id":"w3"},{"id":"w4","members":[{"name":"docs"},{"name":"logs"}]}]}`)

	ws, err := st.load("alice")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(ws.Workspaces) != 1 || ws.Workspaces[0].ID != "w4" {
		t.Fatalf("only the two-member workspace survives: %+v", ws.Workspaces)
	}
}

func TestWorkspacesLoadHealsADuplicateID(t *testing.T) {
	st := testWorkspaceStore(t)
	writeRawWorkspaces(t, st, "alice",
		`{"version":1,"workspaces":[{"id":"w1","members":[{"name":"auth"},{"name":"deploy"}]},{"id":"w1","members":[{"name":"docs"},{"name":"logs"}]}]}`)

	ws, err := st.load("alice")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(ws.Workspaces) != 1 || !reflect.DeepEqual(ws.Workspaces[0].Members, ownMembers("auth", "deploy")) {
		t.Fatalf("first id wins: %+v", ws.Workspaces)
	}
}

// A document written before this store existed, or by a client that knows more
// fields than this server does, must not be an error. It reads as whatever the
// struct can hold — see TestHandleWorkspacesDropsFieldsTheStructDoesNotHave for
// the other half of that bargain.
func TestWorkspacesLoadTolerantOfUnknownFields(t *testing.T) {
	st := testWorkspaceStore(t)
	writeRawWorkspaces(t, st, "alice",
		`{"version":1,"workspaces":[{"id":"w1","members":[{"name":"auth"},{"name":"deploy"}],"name":"left screen"}],"focused":"w1"}`)

	ws, err := st.load("alice")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(ws.Workspaces) != 1 || ws.Workspaces[0].ID != "w1" {
		t.Fatalf("unknown fields must not disturb the rest: %+v", ws)
	}
}

func writeRawWorkspaces(t *testing.T, st *workspaceStore, osUser, doc string) {
	t.Helper()
	if err := os.MkdirAll(st.dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(st.path(osUser), []byte(doc), 0o600); err != nil {
		t.Fatal(err)
	}
}

// --- rename follows a member ------------------------------------------------

// A rename in place, position preserved, so the tile comes back where it was
// rather than at the end of the arrangement.
func TestWorkspaceRenameSessionFollowsAMember(t *testing.T) {
	st := testWorkspaceStore(t)
	if err := st.save("alice", Workspaces{
		Version:    workspacesVersion,
		Workspaces: []Workspace{{ID: "w1", Members: ownMembers("auth", "deploy", "docs")}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.renameSession("alice", "deploy", "deploy-1430"); err != nil {
		t.Fatalf("renameSession: %v", err)
	}
	ws, _ := st.load("alice")
	want := ownMembers("auth", "deploy-1430", "docs")
	if !reflect.DeepEqual(ws.Workspaces[0].Members, want) {
		t.Fatalf("rename in place: got %v, want %v", ws.Workspaces[0].Members, want)
	}
}

// Renaming onto a name a workspace already lists must not leave the document
// holding it twice. tmux refuses to rename a session onto a live one, so a
// collision here always means the sitting entry belongs to a session that is
// already dead — and a workspace keeps a dead session's membership on purpose.
// The renamed session is the live one, so the stale entry goes. Keeping both
// would write a document validateWorkspaces rejects, which is the failure mode
// that stopped every later layout write on 2026-09-06.
func TestWorkspaceRenameOntoAnExistingMemberDropsTheStaleEntry(t *testing.T) {
	st := testWorkspaceStore(t)
	if err := st.save("alice", Workspaces{
		Version: workspacesVersion,
		Workspaces: []Workspace{
			{ID: "w1", Members: ownMembers("auth", "deploy", "docs")},
			{ID: "w2", Members: ownMembers("logs", "scratch", "notes")},
		},
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.renameSession("alice", "auth", "logs"); err != nil {
		t.Fatalf("renameSession: %v", err)
	}
	ws, _ := st.load("alice")
	if err := validateWorkspaces(ws, "alice"); err != nil {
		t.Fatalf("a collision must leave a valid document: %v (%+v)", err, ws)
	}
	// The renamed session is the live one, so it keeps its own slot in w1.
	if !reflect.DeepEqual(ws.Workspaces[0].Members, ownMembers("logs", "deploy", "docs")) {
		t.Fatalf("the live session keeps its slot: %+v", ws.Workspaces[0])
	}
	// w2's "logs" named a session that is already dead, or tmux would have
	// refused the rename. It goes.
	if !reflect.DeepEqual(ws.Workspaces[1].Members, ownMembers("scratch", "notes")) {
		t.Fatalf("stale entry must go: %+v", ws.Workspaces[1])
	}
}

// Dropping the stale entry can leave one tile, and one tile is not a
// workspace — the same rule the close control follows in the browser.
func TestWorkspaceRenameCollisionEndsAWorkspaceLeftWithOneTile(t *testing.T) {
	st := testWorkspaceStore(t)
	if err := st.save("alice", Workspaces{
		Version: workspacesVersion,
		Workspaces: []Workspace{
			{ID: "w1", Members: ownMembers("auth", "deploy")},
			{ID: "w2", Members: ownMembers("logs", "scratch")},
		},
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.renameSession("alice", "auth", "logs"); err != nil {
		t.Fatalf("renameSession: %v", err)
	}
	ws, _ := st.load("alice")
	if len(ws.Workspaces) != 1 || ws.Workspaces[0].ID != "w1" {
		t.Fatalf("a workspace down to one tile must end: %+v", ws.Workspaces)
	}
	if !reflect.DeepEqual(ws.Workspaces[0].Members, ownMembers("logs", "deploy")) {
		t.Fatalf("the surviving workspace: %+v", ws.Workspaces[0])
	}
}

// A tmux rename lands in ONE user's server, so a member naming somebody else's
// session keeps its name. alice retitling her `auth` — which ADR-0022 does
// seconds into the first turn, on its own, with nobody asking — must not rewrite
// the tile showing emo's `auth` to a name emo has never heard of. That tile
// would then point at nothing, and the workspace would collapse the next time
// its live members were counted.
func TestWorkspaceRenameLeavesAForeignMemberOfTheSameNameAlone(t *testing.T) {
	st := testWorkspaceStore(t)
	if err := st.save("alice", Workspaces{
		Version: workspacesVersion,
		Workspaces: []Workspace{{ID: "w1", Members: []WorkspaceMember{
			{Name: "auth", Owner: "emo"},
			{Name: "auth"},
			{Name: "deploy"},
		}}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.renameSession("alice", "auth", "auth-1430"); err != nil {
		t.Fatalf("renameSession: %v", err)
	}

	ws, _ := st.load("alice")
	want := []WorkspaceMember{{Name: "auth", Owner: "emo"}, {Name: "auth-1430"}, {Name: "deploy"}}
	if !reflect.DeepEqual(ws.Workspaces[0].Members, want) {
		t.Fatalf("only the caller's own member follows the rename:\n got %+v\nwant %+v",
			ws.Workspaces[0].Members, want)
	}
	// And the lookup behind the early return reads the same way: the pair, not
	// the name. emo's `auth` is in w1, alice's `auth` is in nothing now.
	if id, ok := workspaceOfSession(ws, "alice", SessionRef{Owner: "emo", Name: "auth"}); !ok || id != "w1" {
		t.Fatalf("emo's auth is still w1's member: got (%q, %v)", id, ok)
	}
	if _, ok := workspaceOfSession(ws, "alice", SessionRef{Owner: "alice", Name: "auth"}); ok {
		t.Fatal("alice's auth was renamed away and must not be found under the old name")
	}
}

// Every rename in this service calls the store, and almost none of them name a
// workspace member. Writing a file for those would churn the store on every
// retitle, and would create a document for a user who has never made a
// workspace.
func TestWorkspaceRenameOfANonMemberWritesNothing(t *testing.T) {
	st := testWorkspaceStore(t)
	if err := st.renameSession("alice", "never-a-member", "still-not"); err != nil {
		t.Fatalf("renameSession: %v", err)
	}
	if _, err := os.Stat(st.path("alice")); !os.IsNotExist(err) {
		t.Fatalf("a rename touching nothing must not create a document (stat err %v)", err)
	}
}

func TestWorkspaceRenameToTheSameNameIsANoOp(t *testing.T) {
	st := testWorkspaceStore(t)
	in := Workspaces{
		Version:    workspacesVersion,
		Workspaces: []Workspace{{ID: "w1", Members: ownMembers("auth", "deploy")}},
	}
	if err := st.save("alice", in); err != nil {
		t.Fatal(err)
	}
	if err := st.renameSession("alice", "auth", "auth"); err != nil {
		t.Fatalf("renameSession: %v", err)
	}
	out, _ := st.load("alice")
	if !reflect.DeepEqual(in, out) {
		t.Fatalf("no-op rename changed the document:\n in: %+v\nout: %+v", in, out)
	}
}

// --- validation -------------------------------------------------------------

func validWorkspaces() Workspaces {
	return Workspaces{
		Version: workspacesVersion,
		Workspaces: []Workspace{
			{ID: "w1", Members: ownMembers("auth", "deploy")},
			{ID: "w2", Members: ownMembers("docs", "logs", "scratch")},
		},
	}
}

func TestValidateWorkspacesAccepts(t *testing.T) {
	if err := validateWorkspaces(validWorkspaces(), "alice"); err != nil {
		t.Fatalf("valid document rejected: %v", err)
	}
}

// No workspaces at all is the ordinary state: every user has this document
// until their first split, and closing back to one tile returns them to it.
func TestValidateWorkspacesAcceptsNone(t *testing.T) {
	if err := validateWorkspaces(emptyWorkspaces(), "alice"); err != nil {
		t.Fatalf("an empty document rejected: %v", err)
	}
}

// A workspace of two people's sessions is the case the owner exists for: a
// session emo shared with alice, tiled beside two of her own, and one of them
// called `auth` as well. Exclusivity is about a SESSION, and these are three.
func TestValidateWorkspacesAcceptsOneNameUnderTwoOwners(t *testing.T) {
	ws := Workspaces{
		Version: workspacesVersion,
		Workspaces: []Workspace{{ID: "w1", Members: []WorkspaceMember{
			{Name: "auth", Owner: "emo"},
			{Name: "auth"},
			{Name: "deploy"},
		}}},
	}
	if err := validateWorkspaces(ws, "alice"); err != nil {
		t.Fatalf("two owners of one name rejected: %v", err)
	}
}

// The design declines a cap on tiles ("no cap on the number of tiles; a bigger
// screen holds more"), so a wide arrangement must validate. The 64KB body cap
// is what bounds the document.
func TestValidateWorkspacesAcceptsAManyMemberWorkspace(t *testing.T) {
	ws := emptyWorkspaces()
	big := Workspace{ID: "w1"}
	for i := 0; i < 64; i++ {
		big.Members = append(big.Members, WorkspaceMember{Name: "s" + strconv.Itoa(i)})
	}
	ws.Workspaces = append(ws.Workspaces, big)
	if err := validateWorkspaces(ws, "alice"); err != nil {
		t.Fatalf("a 64-tile workspace rejected: %v", err)
	}
}

func TestValidateWorkspacesRejects(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*Workspaces)
	}{
		{"wrong version", func(w *Workspaces) { w.Version = 2 }},
		{"zero version", func(w *Workspaces) { w.Version = 0 }},
		{"bad id", func(w *Workspaces) { w.Workspaces[0].ID = "has space" }},
		{"empty id", func(w *Workspaces) { w.Workspaces[0].ID = "" }},
		{"overlong id", func(w *Workspaces) { w.Workspaces[0].ID = strings.Repeat("w", 33) }},
		{"duplicate id", func(w *Workspaces) { w.Workspaces[1].ID = "w1" }},
		{"bad member name", func(w *Workspaces) { w.Workspaces[0].Members[0].Name = "bad!name" }},
		{"empty member name", func(w *Workspaces) { w.Workspaces[0].Members[0].Name = "" }},
		// An owner names an OS user, so it lives in the same charset as a
		// session name — the check projects.go applies to both halves of a
		// SessionRef. Absent is the ordinary case and is not this.
		{"bad member owner", func(w *Workspaces) { w.Workspaces[0].Members[0].Owner = "not an os user" }},
		// The exclusivity rule, which the whole design rests on: one workspace
		// per session, because keepalive mounts one live view per session and
		// two tiles of one session would contend for its grid.
		{"session in two workspaces", func(w *Workspaces) { w.Workspaces[1].Members[0] = WorkspaceMember{Name: "auth"} }},
		{"session twice in one workspace", func(w *Workspaces) { w.Workspaces[0].Members[1] = WorkspaceMember{Name: "auth"} }},
		// A session is the (owner, name) pair, so the rule holds for a foreign
		// one the same way: one tile of emo's `auth`, not two.
		{"foreign session in two workspaces", func(w *Workspaces) {
			w.Workspaces[0].Members[0] = WorkspaceMember{Name: "auth", Owner: "emo"}
			w.Workspaces[1].Members[0] = WorkspaceMember{Name: "auth", Owner: "emo"}
		}},
		// The two spellings of the caller's own session are one session. Caught
		// here rather than stored, because what it describes is two tiles of one
		// terminal contending for one Grid.
		{"the caller's own session named bare and in full", func(w *Workspaces) {
			w.Workspaces[0].Members[1] = WorkspaceMember{Name: "auth", Owner: "alice"}
		}},
		// One tile is not a workspace: closing back to one ends it, so a
		// document that stores one is a client that failed to.
		{"single member", func(w *Workspaces) { w.Workspaces[0].Members = ownMembers("auth") }},
		{"no members", func(w *Workspaces) { w.Workspaces[0].Members = ownMembers() }},
		{"nil members", func(w *Workspaces) { w.Workspaces[0].Members = nil }},
		{"too many workspaces", func(w *Workspaces) {
			for i := 0; i <= maxWorkspaces; i++ {
				w.Workspaces = append(w.Workspaces, Workspace{
					ID:      "x" + strconv.Itoa(i),
					Members: ownMembers("p"+strconv.Itoa(i), "q"+strconv.Itoa(i)),
				})
			}
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ws := validWorkspaces()
			c.mutate(&ws)
			if err := validateWorkspaces(ws, "alice"); err == nil {
				t.Fatalf("%s: want error, got nil", c.name)
			}
		})
	}
}

// --- handler ----------------------------------------------------------------

func workspacesReq(method, body, authUser string) *http.Request {
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, "/workspaces", nil)
	} else {
		r = httptest.NewRequest(method, "/workspaces", strings.NewReader(body))
	}
	if authUser != "" {
		r.Header.Set(authHeader, authUser)
	}
	return r
}

func TestHandleWorkspacesRejectsOtherMethods(t *testing.T) {
	for _, m := range []string{http.MethodPost, http.MethodDelete, http.MethodPatch} {
		rec := httptest.NewRecorder()
		handleWorkspaces(rec, workspacesReq(m, "", ""))
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s /workspaces: got %d, want %d", m, rec.Code, http.StatusMethodNotAllowed)
		}
	}
}

func TestHandleWorkspacesRequiresAuth(t *testing.T) {
	for _, m := range []string{http.MethodGet, http.MethodPut} {
		rec := httptest.NewRecorder()
		handleWorkspaces(rec, workspacesReq(m, "", ""))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s /workspaces without %s: got %d, want %d", m, authHeader, rec.Code, http.StatusUnauthorized)
		}
	}
}

func TestHandleWorkspacesUnmappedUserForbidden(t *testing.T) {
	withTempWorkspaceStore(t)
	withUserMap(t, "# empty map\n")
	rec := httptest.NewRecorder()
	handleWorkspaces(rec, workspacesReq(http.MethodGet, "", "stranger"))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("GET /workspaces as an unmapped user: got %d, want %d", rec.Code, http.StatusForbidden)
	}
}

// A user who has never split gets the empty document rather than a 404, so the
// client has one shape to read.
func TestHandleWorkspacesGetEmptyReturnsEmptyDocument(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osSelf+"\n")
	withTempWorkspaceStore(t)

	rec := httptest.NewRecorder()
	handleWorkspaces(rec, workspacesReq(http.MethodGet, "", "alice"))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET: got %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control: got %q, want no-store — the browser must not cache what it just changed", got)
	}
	if got := strings.TrimSpace(rec.Body.String()); got != `{"version":1,"workspaces":[]}` {
		t.Fatalf("empty document: got %s", got)
	}
}

func TestHandleWorkspacesPutThenGetRoundtrip(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osSelf+"\n")
	withTempWorkspaceStore(t)

	body := `{"version":1,"workspaces":[{"id":"w1","members":[{"name":"auth"},{"name":"deploy"}]}]}`
	rec := httptest.NewRecorder()
	handleWorkspaces(rec, workspacesReq(http.MethodPut, body, "alice"))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("PUT: got %d (%s), want %d", rec.Code, rec.Body.String(), http.StatusNoContent)
	}

	rec = httptest.NewRecorder()
	handleWorkspaces(rec, workspacesReq(http.MethodGet, "", "alice"))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET: got %d, want 200", rec.Code)
	}
	var got Workspaces
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("GET body: %v (%s)", err, rec.Body.String())
	}
	want := Workspaces{
		Version:    workspacesVersion,
		Workspaces: []Workspace{{ID: "w1", Members: ownMembers("auth", "deploy")}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("roundtrip:\n got %+v\nwant %+v", got, want)
	}
}

// A WORKSPACE MAY HOLD A FOREIGN SESSION, and the owner has to survive the round
// trip for its tile to find that session again.
//
// tmux session names are unique only inside one user's server — projects.go's
// SessionRef carries an owner for exactly that reason — so "auth" on its own
// does not say whose "auth" it is, and two people having a session of that name
// is ordinary rather than contrived. A member that lost its owner between the
// PUT and the GET would come back naming a session of the CALLER'S own: a
// different terminal where one exists under that name, and nothing at all where
// it does not.
//
// The omitted owner is the other half of the same contract. It means the
// caller, so a workspace of your own sessions stays the document it was and no
// member gains an "owner":"" it never had — which matters because both sides
// compare members for equality, and "" is not the same value as absent.
//
// The GET body is compared byte for byte with the PUT body on purpose: one
// assertion pins the field order, the omitted owner and the version, and it is
// the same literal frontend-v2/test/workspaces.api.test.ts pins from the other
// side of the wire.
func TestHandleWorkspacesForeignMemberKeepsItsOwner(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osSelf+"\n")
	withTempWorkspaceStore(t)

	// The shape the design pins (docs/plans/2026-09-12-multi-session-workspaces
	// -design.md): a member is {name, owner?}, owner omitted meaning the caller.
	body := `{"version":1,"workspaces":[{"id":"w1","members":[{"name":"auth","owner":"emo"},{"name":"deploy"}]}]}`
	rec := httptest.NewRecorder()
	handleWorkspaces(rec, workspacesReq(http.MethodPut, body, "alice"))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("PUT a workspace holding a foreign member: got %d (%s), want %d",
			rec.Code, strings.TrimSpace(rec.Body.String()), http.StatusNoContent)
	}

	rec = httptest.NewRecorder()
	handleWorkspaces(rec, workspacesReq(http.MethodGet, "", "alice"))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET: got %d, want 200", rec.Code)
	}
	if got := strings.TrimSpace(rec.Body.String()); got != body {
		t.Fatalf("round trip changed the document:\n got %s\nwant %s", got, body)
	}
}

// Membership roams because it is server-side, so the second device's GET has
// to answer with what the first device PUT (ADR-0027).
func TestHandleWorkspacesPutFromOneDeviceIsVisibleToAnother(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	// Two auth identities mapped to ONE OS user: the same person on a laptop
	// and a phone, which is what "follows the user across devices" means here.
	withUserMap(t, "laptop="+osSelf+"\nphone="+osSelf+"\n")
	withTempWorkspaceStore(t)

	body := `{"version":1,"workspaces":[{"id":"w1","members":[{"name":"auth"},{"name":"deploy"}]}]}`
	rec := httptest.NewRecorder()
	handleWorkspaces(rec, workspacesReq(http.MethodPut, body, "laptop"))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("PUT from the laptop: got %d (%s)", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	handleWorkspaces(rec, workspacesReq(http.MethodGet, "", "phone"))
	if !strings.Contains(rec.Body.String(), `"members":[{"name":"auth"},{"name":"deploy"}]`) {
		t.Fatalf("the phone must see the laptop's workspace, got %s", rec.Body.String())
	}
}

func TestHandleWorkspacesRejectsAnInvalidDocument(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osSelf+"\n")
	withTempWorkspaceStore(t)

	cases := []struct{ name, body string }{
		{"not json", `{nope`},
		{"wrong version", `{"version":2,"workspaces":[]}`},
		{"single member", `{"version":1,"workspaces":[{"id":"w1","members":[{"name":"auth"}]}]}`},
		{"bad member name", `{"version":1,"workspaces":[{"id":"w1","members":[{"name":"auth"},{"name":"bad name"}]}]}`},
		{"bad id", `{"version":1,"workspaces":[{"id":"bad id","members":[{"name":"auth"},{"name":"deploy"}]}]}`},
		{"session in two workspaces", `{"version":1,"workspaces":[{"id":"w1","members":[{"name":"auth"},{"name":"deploy"}]},{"id":"w2","members":[{"name":"auth"},{"name":"docs"}]}]}`},
		{"foreign session in two workspaces", `{"version":1,"workspaces":[{"id":"w1","members":[{"name":"auth","owner":"emo"},{"name":"deploy"}]},{"id":"w2","members":[{"name":"auth","owner":"emo"},{"name":"docs"}]}]}`},
		{"bad member owner", `{"version":1,"workspaces":[{"id":"w1","members":[{"name":"auth","owner":"bad owner"},{"name":"deploy"}]}]}`},
		// The shape before the owner existed. A bare name is not a member, and
		// no released server ever served one — the /workspaces route arrives
		// with this branch — so there is nothing to migrate and nothing to
		// accept quietly.
		{"members as bare names", `{"version":1,"workspaces":[{"id":"w1","members":["auth","deploy"]}]}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			handleWorkspaces(rec, workspacesReq(http.MethodPut, c.body, "alice"))
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("PUT %s: got %d, want %d", c.name, rec.Code, http.StatusBadRequest)
			}
		})
	}
	// A rejected PUT must not have touched the stored document.
	ws, err := workspaceStoreInstance.load(osSelf)
	if err != nil {
		t.Fatalf("load after the rejections: %v", err)
	}
	if len(ws.Workspaces) != 0 {
		t.Fatalf("a rejected PUT wrote something: %+v", ws)
	}
}

func TestHandleWorkspacesRejectsAnOversizedBody(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osSelf+"\n")
	withTempWorkspaceStore(t)

	var sb strings.Builder
	sb.WriteString(`{"version":1,"workspaces":[{"id":"w1","members":[{"name":"auth"},{"name":"deploy"}],"pad":"`)
	sb.WriteString(strings.Repeat("x", maxWorkspacesBody))
	sb.WriteString(`"}]}`)

	rec := httptest.NewRecorder()
	handleWorkspaces(rec, workspacesReq(http.MethodPut, sb.String(), "alice"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("oversized PUT: got %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

// An unknown field is SILENTLY DROPPED unless it is a real struct field, which
// is how the dock vanished after its 4s grace before DockState existed
// (layout.go). Pinned here so the next person to add per-workspace state to the
// client knows the server will eat it until this struct grows a field.
//
// The trap is one level deeper now that a member is an object: `title` tucked
// into a member goes the same way `tree` tucked into a workspace does, and a
// client that kept either would show state that survives in one tab and nowhere
// else.
func TestHandleWorkspacesDropsFieldsTheStructDoesNotHave(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osSelf+"\n")
	withTempWorkspaceStore(t)

	body := `{"version":1,"workspaces":[{"id":"w1","members":[{"name":"auth","title":"fix the parser"},{"name":"deploy"}],"tree":{"dir":"row"},"focused":"auth"}]}`
	rec := httptest.NewRecorder()
	handleWorkspaces(rec, workspacesReq(http.MethodPut, body, "alice"))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("PUT: got %d (%s)", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	handleWorkspaces(rec, workspacesReq(http.MethodGet, "", "alice"))
	for _, gone := range []string{"tree", "focused", "row", "title", "parser"} {
		if strings.Contains(rec.Body.String(), gone) {
			t.Fatalf("%q survived without a struct field: %s", gone, rec.Body.String())
		}
	}
	if !strings.Contains(rec.Body.String(), `"members":[{"name":"auth"},{"name":"deploy"}]`) {
		t.Fatalf("the real fields must survive: %s", rec.Body.String())
	}
}

// An own member carries no owner ON THE WIRE, in either direction. The client
// compares members for equality to decide whether an arrangement still matches
// the membership it was built from, so a document that came back with
// "owner":"" on every entry would not match the one that was sent, and the tab
// that sent it would rebuild its trees for nothing.
//
// An explicit "" is the same thing said the long way, so it comes back omitted
// rather than preserved — `omitempty` on the struct field is what makes the two
// spellings one document.
func TestHandleWorkspacesAnOwnMemberNeverGainsAnEmptyOwner(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osSelf+"\n")
	withTempWorkspaceStore(t)

	body := `{"version":1,"workspaces":[{"id":"w1","members":[{"name":"auth","owner":""},{"name":"deploy"}]}]}`
	rec := httptest.NewRecorder()
	handleWorkspaces(rec, workspacesReq(http.MethodPut, body, "alice"))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("PUT: got %d (%s)", rec.Code, strings.TrimSpace(rec.Body.String()))
	}

	rec = httptest.NewRecorder()
	handleWorkspaces(rec, workspacesReq(http.MethodGet, "", "alice"))
	want := `{"version":1,"workspaces":[{"id":"w1","members":[{"name":"auth"},{"name":"deploy"}]}]}`
	if got := strings.TrimSpace(rec.Body.String()); got != want {
		t.Fatalf("an own member must come back ownerless:\n got %s\nwant %s", got, want)
	}
}

// --- membership survives a kill ---------------------------------------------

// The headline behaviour, and the one that is an ABSENCE in the code: killSession
// drops the layout reference on purpose and must leave workspace membership
// alone, so restoring the session later puts its tile back. This drives the real
// DELETE handler, and checks the layout reference went in the same breath — a
// kill that quietly did nothing would otherwise pass.
func TestWorkspaceMembershipSurvivesADeliberateKill(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)        // caller == current user: tmuxCmd skips sudo,
	withUserMap(t, "alice="+osSelf+"\n") // so the stub runs directly
	withTempLayoutStore(t)
	withTempAssignmentStore(t)
	withTempWorkspaceStore(t)
	withTmuxStub(t, "exit 0")
	withSudoStub(t, "exit 0")

	if err := layoutStoreInstance.save(osSelf, Layout{
		Version:   1,
		Projects:  []Project{{Name: "code", Sessions: []string{"repowise", "deploy"}}},
		Ungrouped: []string{},
	}); err != nil {
		t.Fatal(err)
	}
	if err := workspaceStoreInstance.save(osSelf, Workspaces{
		Version:    workspacesVersion,
		Workspaces: []Workspace{{ID: "w1", Members: ownMembers("repowise", "deploy")}},
	}); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	handleSessionByName(rec, sessionReq(http.MethodDelete, "/sessions/repowise", "", "alice"))
	if rec.Code != http.StatusOK {
		t.Fatalf("DELETE /sessions/repowise: got %d, want %d", rec.Code, http.StatusOK)
	}

	l, _ := layoutStoreInstance.load(osSelf)
	if len(l.Projects[0].Sessions) != 1 || l.Projects[0].Sessions[0] != "deploy" {
		t.Fatalf("the kill must still drop the LAYOUT reference: %+v", l.Projects[0])
	}
	ws, err := workspaceStoreInstance.load(osSelf)
	if err != nil {
		t.Fatalf("workspaces after the kill: %v", err)
	}
	if len(ws.Workspaces) != 1 {
		t.Fatalf("the workspace must survive the kill: %+v", ws.Workspaces)
	}
	want := ownMembers("repowise", "deploy")
	if !reflect.DeepEqual(ws.Workspaces[0].Members, want) {
		t.Fatalf("membership after a kill: got %v, want %v — a killed member keeps its tile",
			ws.Workspaces[0].Members, want)
	}
}

// Restored under its own name, the member is already listed, so the tile comes
// back with no server write at all. This is what the survival above buys.
func TestKilledMemberIsStillListedForARestoreUnderTheSameName(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osSelf+"\n")
	withTempLayoutStore(t)
	withTempAssignmentStore(t)
	withTempWorkspaceStore(t)
	withTmuxStub(t, "exit 0")
	withSudoStub(t, "exit 0")

	if err := workspaceStoreInstance.save(osSelf, Workspaces{
		Version:    workspacesVersion,
		Workspaces: []Workspace{{ID: "w1", Members: ownMembers("repowise", "deploy")}},
	}); err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	handleSessionByName(rec, sessionReq(http.MethodDelete, "/sessions/repowise", "", "alice"))
	if rec.Code != http.StatusOK {
		t.Fatalf("DELETE: got %d", rec.Code)
	}

	ws, _ := workspaceStoreInstance.load(osSelf)
	if id, ok := workspaceOfSession(ws, osSelf, SessionRef{Owner: osSelf, Name: "repowise"}); !ok || id != "w1" {
		t.Fatalf("a restore under the same name finds its workspace: got (%q, %v), want (\"w1\", true)", id, ok)
	}
}

// A restore that had to rename — the name was taken, so the session returns as
// `<name>-<HHMM>` — is the one case where survival is not enough: the member
// listed is a name the restored session no longer answers to. The rename hook
// hands the tile to the name it came back under, in the slot it had.
func TestKilledMemberRestoredUnderANewNameKeepsItsTile(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osSelf+"\n")
	withTempLayoutStore(t)
	withTempAssignmentStore(t)
	withTempWorkspaceStore(t)
	withTmuxStub(t, "exit 0")
	withSudoStub(t, "exit 0")

	if err := workspaceStoreInstance.save(osSelf, Workspaces{
		Version:    workspacesVersion,
		Workspaces: []Workspace{{ID: "w1", Members: ownMembers("repowise", "deploy", "docs")}},
	}); err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	handleSessionByName(rec, sessionReq(http.MethodDelete, "/sessions/repowise", "", "alice"))
	if rec.Code != http.StatusOK {
		t.Fatalf("DELETE: got %d", rec.Code)
	}

	// What a renamed restore does, once it is wired into placeRestoredSessions.
	if err := workspaceStoreInstance.renameSession(osSelf, "repowise", "repowise-1430"); err != nil {
		t.Fatalf("renameSession: %v", err)
	}

	ws, _ := workspaceStoreInstance.load(osSelf)
	want := ownMembers("repowise-1430", "deploy", "docs")
	if !reflect.DeepEqual(ws.Workspaces[0].Members, want) {
		t.Fatalf("restored under a new name: got %v, want %v", ws.Workspaces[0].Members, want)
	}
}
