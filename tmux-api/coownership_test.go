package main

import (
	"bytes"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

// fakeHomes resolves homes for test users without reading /etc/passwd.
func fakeHomes(m map[string]string) func(string) string {
	return func(u string) string { return m[u] }
}

func TestPathStrictlyUnder(t *testing.T) {
	cases := []struct {
		path, dir string
		want      bool
	}{
		{"/home/emo/proj", "/home/emo", true},
		{"/home/emo/a/b/c", "/home/emo", true},
		{"/home/emo/proj/", "/home/emo", true},
		{"/home/emo", "/home/emo", false},                // the home root itself
		{"/home/emo/../wizard/.ssh", "/home/emo", false}, // walks out
		{"/home/emo2/proj", "/home/emo", false},          // string prefix, not a path boundary
		{"/home/wizard/.ssh", "/home/emo", false},
		{"/home", "/home/emo", false},
		{"", "/home/emo", false},
		{"/home/emo/proj", "", false},
		{"relative/path", "/home/emo", false},
	}
	for _, tc := range cases {
		if got := pathStrictlyUnder(tc.path, tc.dir); got != tc.want {
			t.Errorf("pathStrictlyUnder(%q, %q) = %v, want %v", tc.path, tc.dir, got, tc.want)
		}
	}
}

// The ACL owner is the person whose home holds the tree. A dir nobody involved
// owns has no owner, so the op refuses rather than running unbound (TL-2).
func TestCoownDirOwner(t *testing.T) {
	homes := fakeHomes(map[string]string{"emo": "/home/emo", "wizard": "/home/wizard"})
	cases := []struct {
		name       string
		dir        string
		candidates []string
		want       string
	}{
		{"member's own tree", "/home/emo/proj", []string{"emo"}, "emo"},
		{"shared tree under the other member's home", "/home/wizard/code/p", []string{"emo", "wizard"}, "wizard"},
		{"another user's private dir", "/home/wizard/.ssh", []string{"emo"}, ""},
		{"outside every home", "/srv/shared", []string{"emo", "wizard"}, ""},
		{"the home root itself", "/home/emo", []string{"emo"}, ""},
		{"unresolvable candidate", "/home/emo/p", []string{"ghost"}, ""},
		{"no dir", "", []string{"emo"}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := coownDirOwner(tc.dir, tc.candidates, homes); got != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
	}
}

func TestCoownOpsForPatch(t *testing.T) {
	m := []string{"wizard", "bob"}
	homes := fakeHomes(map[string]string{"wizard": "/home/wizard", "bob": "/home/bob"})
	ownerOf := func(dir string) string { return coownDirOwner(dir, m, homes) }
	cases := []struct {
		name   string
		was    bool
		oldDir string
		now    bool
		newDir string
		want   []coownOp
	}{
		{"enable with dir", false, "", true, "/home/wizard/code/p",
			[]coownOp{{"grant", "/home/wizard/code/p", m, "wizard"}}},
		{"enable without dir", false, "", true, "", nil},
		{"disable", true, "/home/wizard/code/p", false, "/home/wizard/code/p",
			[]coownOp{{"revoke", "/home/wizard/code/p", m, "wizard"}}},
		{"dir change while coowned", true, "/home/wizard/code/a", true, "/home/bob/b",
			[]coownOp{{"revoke", "/home/wizard/code/a", m, "wizard"}, {"grant", "/home/bob/b", m, "bob"}}},
		{"same dir coowned no-op", true, "/home/wizard/code/p", true, "/home/wizard/code/p", nil},
		{"stays off", false, "", false, "/home/wizard/code/p", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := coownOpsForPatch(tc.was, tc.oldDir, tc.now, tc.newDir, m, ownerOf)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %+v want %+v", got, tc.want)
			}
		})
	}
}

// coownArgs is the gate in front of the root wrapper: it refuses any op whose
// directory is not bound to the owner's home, and names the owner as the
// wrapper's fourth argument so root can re-check the binding itself.
func TestCoownArgs(t *testing.T) {
	homes := fakeHomes(map[string]string{"wizard": "/home/wizard", "emo": "/home/emo"})
	ok := coownOp{"grant", "/home/wizard/code/p", []string{"emo"}, "wizard"}
	args, err := coownArgs(ok, homes)
	if err != nil {
		t.Fatalf("valid op refused: %v", err)
	}
	want := []string{"-n", setfaclWrapper, "grant", "/home/wizard/code/p", "emo", "wizard"}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("args = %q, want %q", args, want)
	}

	bad := []struct {
		name string
		op   coownOp
	}{
		{"no owner", coownOp{"grant", "/home/wizard/code/p", []string{"emo"}, ""}},
		{"dir under someone else's home", coownOp{"grant", "/home/wizard/.ssh", []string{"emo"}, "emo"}},
		{"owner has no home", coownOp{"grant", "/home/ghost/p", []string{"emo"}, "ghost"}},
		{"the home root itself", coownOp{"grant", "/home/wizard", []string{"emo"}, "wizard"}},
		{"no dir", coownOp{"grant", "", []string{"emo"}, "wizard"}},
		{"no users", coownOp{"grant", "/home/wizard/code/p", nil, "wizard"}},
	}
	for _, tc := range bad {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := coownArgs(tc.op, homes); err == nil {
				t.Fatalf("op %+v was accepted, want refusal", tc.op)
			}
		})
	}
}

// A project directory is bound to the caller's own home at the moment it is
// set. Without that, a member points a project at another user's private
// directory, flips co-ownership on, and root hands them an ACL on it (TL-2).
func TestCallerOwnsDir(t *testing.T) {
	me, _ := twoLocalUsers(t)
	home := homeOfUser(me)
	if home == "" {
		t.Skipf("no home for %q", me)
	}
	if !callerOwnsDir(home+"/tl-coown-test", me) {
		t.Fatalf("%q rejected its own home subdir", me)
	}
	for _, d := range []string{"/home", "/etc", home, home + "/../elsewhere", ""} {
		if callerOwnsDir(d, me) {
			t.Fatalf("%q accepted for %q", d, me)
		}
	}
}

func TestProjectDirMustBeUnderCallerHome(t *testing.T) {
	swapProjectStore(t)
	me, _ := twoLocalUsers(t)
	withUserMap(t, me+"="+me+"\n")

	rec := httptest.NewRecorder()
	handleProjects(rec, projectsReq(http.MethodPost, "/projects", `{"name":"tripit","dir":"/home"}`, me))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("create with an out-of-home dir: got %d, want 400; body=%s", rec.Code, rec.Body.String())
	}

	p := createProjectVia(t, me, `{"name":"tripit"}`)
	rec = httptest.NewRecorder()
	handleProjectByID(rec, projectsReq(http.MethodPatch, "/projects/"+p.ID, `{"dir":"/etc"}`, me))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("patch to an out-of-home dir: got %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
}

// The two directions bind differently. A grant that cannot name an owner among
// the project's own people must not run. A revoke must, because the ACL it is
// taking back may predate the binding — and the alternative is access nobody
// can remove any more (TL-2).
func TestCoownOwnerForOp(t *testing.T) {
	homes := fakeHomes(map[string]string{"emo": "/home/emo", "wizard": "/home/wizard"})
	mapped := []string{"emo", "wizard"}

	stray := "/home/wizard/.ssh"
	if got := coownOwnerForOp(coownOp{"grant", stray, []string{"emo"}, ""}, mapped, homes); got != "" {
		t.Fatalf("grant owner = %q, want \"\" so coownArgs fails it closed", got)
	}
	if got := coownOwnerForOp(coownOp{"revoke", stray, []string{"emo"}, ""}, mapped, homes); got != "wizard" {
		t.Fatalf("revoke owner = %q, want wizard (the home that holds the tree)", got)
	}
	if _, err := coownArgs(coownOp{"revoke", stray, []string{"emo"}, "wizard"}, homes); err != nil {
		t.Fatalf("revoke bound to the tree's real owner was refused: %v", err)
	}
	if got := coownOwnerForOp(coownOp{"revoke", "/srv/shared", []string{"emo"}, ""}, mapped, homes); got != "" {
		t.Fatalf("revoke owner = %q for a dir under no home, want \"\"", got)
	}
	// A revoke whose membership-derived owner already binds keeps it.
	if got := coownOwnerForOp(coownOp{"revoke", "/home/emo/p", []string{"emo"}, "emo"}, mapped, homes); got != "emo" {
		t.Fatalf("revoke owner = %q, want emo", got)
	}
}

// A revoke that never ran reads the same as a revoke that failed: either way
// the grantees may still hold ACL access.
func TestRefusedRevokeLogsLoudly(t *testing.T) {
	withUserMap(t, "")
	var buf bytes.Buffer
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })

	runCoownAsync(coownOp{"revoke", "/srv/nowhere", []string{"emo"}, ""})
	if !strings.Contains(buf.String(), "REVOKE FAILED") {
		t.Fatalf("refused revoke logged %q, want a REVOKE FAILED line", buf.String())
	}
	buf.Reset()
	runCoownAsync(coownOp{"grant", "/srv/nowhere", []string{"emo"}, ""})
	if strings.Contains(buf.String(), "REVOKE FAILED") {
		t.Fatalf("a refused grant used the revoke line: %q", buf.String())
	}
}

// TL-2: a PATCH of {"coOwned":true} carries no dir, so the binding has to be
// re-checked against the dir already stored. Without that, any member of a
// project whose dir sits under someone else's home flips the flag and root
// writes them an ACL over a tree they do not own.
func TestPatchCoOwnedRechecksStoredDir(t *testing.T) {
	swapProjectStore(t)
	me, other := twoLocalUsers(t)
	withUserMap(t, me+"="+me+"\n"+other+"="+other+"\n")
	otherHome := homeOfUser(other)
	if otherHome == "" || callerOwnsDir(otherHome+"/.ssh", me) {
		t.Skipf("no second home separable from %q's: %q", me, otherHome)
	}
	sudoArgv := withSudoStub(t, "exit 0")

	p := createProjectVia(t, me, `{"name":"legacy"}`)
	// Seeded straight into the store: the create path refuses this dir today,
	// and the projects written before it did are exactly the case at issue.
	if err := projectStoreInstance.update(func(ps *ProjectSet) error {
		ps.Projects[indexByID(ps, p.ID)].Dir = otherHome + "/.ssh"
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	handleProjectByID(rec, projectsReq(http.MethodPatch, "/projects/"+p.ID, `{"coOwned":true}`, me))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("coOwned flip on a dir under %s's home: got %d, want 400; body=%s", other, rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(sudoArgv); err == nil {
		t.Fatalf("sudo ran for a refused patch")
	}
	ps, err := projectStoreInstance.load()
	if err != nil {
		t.Fatal(err)
	}
	if got := ps.Projects[indexByID(&ps, p.ID)]; got.CoOwned {
		t.Fatalf("the refused patch still stored coOwned=true: %+v", got)
	}
}

// The same PATCH on the caller's own tree still works, and the grant reaches
// the wrapper with the caller as both grantee and owner. Waiting on the stub's
// argv rather than returning straight away also keeps the fire-and-forget
// goroutine from reading sudoBinary while t.Cleanup restores it.
func TestPatchCoOwnedAllowsOwnTree(t *testing.T) {
	swapProjectStore(t)
	me, _ := twoLocalUsers(t)
	withUserMap(t, me+"="+me+"\n")
	home := homeOfUser(me)
	if home == "" {
		t.Skipf("no home for %q", me)
	}
	sudoArgv := withSudoStub(t, "exit 0")

	dir := home + "/code/mine"
	p := createProjectVia(t, me, `{"name":"mine","dir":"`+dir+`"}`)
	rec := httptest.NewRecorder()
	handleProjectByID(rec, projectsReq(http.MethodPatch, "/projects/"+p.ID, `{"coOwned":true}`, me))
	if rec.Code != http.StatusOK {
		t.Fatalf("coOwned flip on my own tree: got %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	want := []string{"-n", setfaclWrapper, "grant", dir, me, me}
	got := waitForArgv(t, sudoArgv, len(want))
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("wrapper argv = %q, want %q", got, want)
	}
}

// waitForArgv blocks until the sudo stub has recorded n lines, so a test can
// assert on a fire-and-forget goroutine without a fixed sleep.
func waitForArgv(t *testing.T, path string, n int) []string {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		b, err := os.ReadFile(path)
		if err == nil {
			lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
			if len(lines) >= n {
				return lines
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("sudo stub recorded %q, want %d lines", string(b), n)
		}
		time.Sleep(5 * time.Millisecond)
	}
}
