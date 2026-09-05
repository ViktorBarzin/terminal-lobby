package main

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
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
