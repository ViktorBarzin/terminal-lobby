package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

// --- layout store ---------------------------------------------------------

func testStore(t *testing.T) *layoutStore {
	t.Helper()
	return newLayoutStore(t.TempDir())
}

func TestLayoutLoadMissingFileReturnsEmptyDefault(t *testing.T) {
	st := testStore(t)
	l, err := st.load("alice")
	if err != nil {
		t.Fatalf("load on missing file: %v", err)
	}
	if l.Version != 1 {
		t.Fatalf("default version: got %d, want 1", l.Version)
	}
	if l.Projects == nil || l.Ungrouped == nil {
		t.Fatalf("default slices must be non-nil (JSON [] not null): %+v", l)
	}
	if len(l.Projects) != 0 || len(l.Ungrouped) != 0 {
		t.Fatalf("default layout not empty: %+v", l)
	}
}

func TestLayoutSaveLoadRoundtrip(t *testing.T) {
	st := testStore(t)
	in := Layout{
		Version: 1,
		Projects: []Project{
			{Name: "tripit", Sessions: []string{"fix-dates", "demo"}},
			{Name: "infra", Sessions: []string{}},
		},
		Ungrouped:      []string{"scratch"},
		UngroupedIndex: 2,
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

// A project's directory (the base pwd for sessions launched inside it) must
// survive save→load; a dir-less project stays dir-less.
func TestLayoutProjectDirRoundtrip(t *testing.T) {
	st := testStore(t)
	in := Layout{
		Version: 1,
		Projects: []Project{
			{Name: "tripit", Sessions: []string{"fix-dates"}, Dir: "/home/wizard/code/tripit"},
			{Name: "infra", Sessions: []string{}},
		},
		Ungrouped: []string{"scratch"},
	}
	if err := st.save("alice", in); err != nil {
		t.Fatalf("save: %v", err)
	}
	out, err := st.load("alice")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if out.Projects[0].Dir != "/home/wizard/code/tripit" {
		t.Fatalf("project dir roundtrip: got %q, want /home/wizard/code/tripit", out.Projects[0].Dir)
	}
	if out.Projects[1].Dir != "" {
		t.Fatalf("dir-less project must load with empty Dir, got %q", out.Projects[1].Dir)
	}
}

// Documents written before projects had a dir must load with an empty Dir —
// back-compat with pre-field layouts (their sessions stay home-rooted).
func TestLayoutLegacyDocHasEmptyProjectDir(t *testing.T) {
	st := testStore(t)
	if err := os.MkdirAll(st.dir, 0o700); err != nil {
		t.Fatal(err)
	}
	legacy := `{"version":1,"projects":[{"name":"tripit","sessions":["fix-dates"]}],"ungrouped":[]}`
	if err := os.WriteFile(filepath.Join(st.dir, "alice.json"), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	l, err := st.load("alice")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if l.Projects[0].Dir != "" {
		t.Fatalf("legacy project dir: got %q, want empty", l.Projects[0].Dir)
	}
}

// Documents written before the Ungrouped section became movable have no
// ungroupedIndex — they must load as 0 (top), preserving the old layout.
func TestLayoutLoadLegacyDocDefaultsUngroupedIndexZero(t *testing.T) {
	st := testStore(t)
	if err := os.MkdirAll(st.dir, 0o700); err != nil {
		t.Fatal(err)
	}
	legacy := `{"version":1,"projects":[{"name":"tripit","sessions":[]}],"ungrouped":["scratch"]}`
	if err := os.WriteFile(filepath.Join(st.dir, "alice.json"), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	l, err := st.load("alice")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if l.UngroupedIndex != 0 {
		t.Fatalf("legacy ungroupedIndex: got %d, want 0", l.UngroupedIndex)
	}
}

func TestLayoutSaveIsPrivate(t *testing.T) {
	st := testStore(t)
	if err := st.save("alice", Layout{Version: 1, Projects: []Project{}, Ungrouped: []string{}}); err != nil {
		t.Fatalf("save: %v", err)
	}
	fi, err := os.Stat(filepath.Join(st.dir, "alice.json"))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("layout file mode: got %o, want 600", fi.Mode().Perm())
	}
}

func TestLayoutLoadCorruptFileErrors(t *testing.T) {
	st := testStore(t)
	if err := os.MkdirAll(st.dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(st.dir, "alice.json"), []byte("{nope"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := st.load("alice"); err == nil {
		t.Fatal("load of corrupt file: want error, got nil")
	}
}

// A UI kill is the ONE deliberate removal — the session leaves every list.
// (Deaths outside the API — OOM, CLI kill — never call this, so a restore
// finds its project again; see ADR-0002.)
func TestLayoutRemoveSession(t *testing.T) {
	st := testStore(t)
	if err := st.save("alice", Layout{
		Version: 1,
		Projects: []Project{
			{Name: "tripit", Sessions: []string{"fix-dates", "demo"}},
		},
		Ungrouped: []string{"scratch"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.removeSession("alice", "demo"); err != nil {
		t.Fatalf("removeSession: %v", err)
	}
	if err := st.removeSession("alice", "scratch"); err != nil {
		t.Fatalf("removeSession ungrouped: %v", err)
	}
	l, _ := st.load("alice")
	if got := l.Projects[0].Sessions; !reflect.DeepEqual(got, []string{"fix-dates"}) {
		t.Fatalf("project members after remove: %v", got)
	}
	if len(l.Ungrouped) != 0 {
		t.Fatalf("ungrouped after remove: %v", l.Ungrouped)
	}
}

// Removing a session that is in no list must not touch the file (no-op).
func TestLayoutRemoveSessionAbsentIsNoop(t *testing.T) {
	st := testStore(t)
	if err := st.removeSession("alice", "ghost"); err != nil {
		t.Fatalf("removeSession on empty store: %v", err)
	}
	if _, err := os.Stat(filepath.Join(st.dir, "alice.json")); !os.IsNotExist(err) {
		t.Fatalf("no-op remove must not create a layout file")
	}
}

func TestLayoutRenameSession(t *testing.T) {
	st := testStore(t)
	if err := st.save("alice", Layout{
		Version:   1,
		Projects:  []Project{{Name: "tripit", Sessions: []string{"fix-dates"}}},
		Ungrouped: []string{"scratch"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.renameSession("alice", "fix-dates", "fix-tz"); err != nil {
		t.Fatalf("renameSession: %v", err)
	}
	if err := st.renameSession("alice", "scratch", "notes"); err != nil {
		t.Fatalf("renameSession ungrouped: %v", err)
	}
	l, _ := st.load("alice")
	if got := l.Projects[0].Sessions[0]; got != "fix-tz" {
		t.Fatalf("project member after rename: %q", got)
	}
	if got := l.Ungrouped[0]; got != "notes" {
		t.Fatalf("ungrouped after rename: %q", got)
	}
}

// The dock (Ctrl+J scratch shell) must survive save→load like the rest of the
// layout — the field's absence was the "auto-close" bug (server dropped it, so
// the panel only lived for the client's 4s grace).
func TestLayoutDockRoundtrip(t *testing.T) {
	st := testStore(t)
	in := Layout{
		Version:   1,
		Projects:  []Project{{Name: "tripit", Sessions: []string{"fix-dates"}}},
		Ungrouped: []string{},
		Dock:      &DockState{Session: "shell", Visible: true, Dir: "/home/wizard/code"},
	}
	if err := st.save("alice", in); err != nil {
		t.Fatalf("save: %v", err)
	}
	out, err := st.load("alice")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if out.Dock == nil {
		t.Fatal("dock lost across roundtrip (server dropped it — the bug)")
	}
	if !reflect.DeepEqual(in.Dock, out.Dock) {
		t.Fatalf("dock roundtrip mismatch:\n in: %+v\nout: %+v", in.Dock, out.Dock)
	}
	// visible:false must round-trip as false (no omitempty on Visible).
	in.Dock.Visible = false
	if err := st.save("alice", in); err != nil {
		t.Fatal(err)
	}
	out, _ = st.load("alice")
	if out.Dock.Visible {
		t.Fatal("dock visible:false must round-trip as false")
	}
}

// A document written before the dock field existed must load with a nil Dock
// (back-compat, exactly like legacy project dirs / ungroupedIndex).
func TestLayoutLegacyDocHasNilDock(t *testing.T) {
	st := testStore(t)
	if err := os.MkdirAll(st.dir, 0o700); err != nil {
		t.Fatal(err)
	}
	legacy := `{"version":1,"projects":[],"ungrouped":["scratch"]}`
	if err := os.WriteFile(filepath.Join(st.dir, "alice.json"), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	l, err := st.load("alice")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if l.Dock != nil {
		t.Fatalf("legacy doc must load with nil Dock, got %+v", l.Dock)
	}
}

// Killing the docked session (UI kill → removeSession) clears the dock;
// killing any other session leaves the dock intact.
func TestLayoutRemoveSessionKeepsDockInLockstep(t *testing.T) {
	st := testStore(t)
	base := func() Layout {
		return Layout{
			Version:   1,
			Projects:  []Project{{Name: "tripit", Sessions: []string{"fix-dates"}}},
			Ungrouped: []string{},
			Dock:      &DockState{Session: "shell", Visible: true},
		}
	}
	// Killing a non-dock session preserves the dock.
	if err := st.save("alice", base()); err != nil {
		t.Fatal(err)
	}
	if err := st.removeSession("alice", "fix-dates"); err != nil {
		t.Fatalf("removeSession: %v", err)
	}
	if l, _ := st.load("alice"); l.Dock == nil || l.Dock.Session != "shell" {
		t.Fatalf("dock must survive an unrelated kill, got %+v", l.Dock)
	}
	// Killing the docked session clears the dock.
	if err := st.save("bob", base()); err != nil {
		t.Fatal(err)
	}
	if err := st.removeSession("bob", "shell"); err != nil {
		t.Fatalf("removeSession dock: %v", err)
	}
	if l, _ := st.load("bob"); l.Dock != nil {
		t.Fatalf("killing the docked session must clear the dock, got %+v", l.Dock)
	}
}

// A rename of the docked session follows it, so the dock never silently
// detaches from a renamed shell.
func TestLayoutRenameSessionFollowsDock(t *testing.T) {
	st := testStore(t)
	if err := st.save("alice", Layout{
		Version:   1,
		Projects:  []Project{},
		Ungrouped: []string{},
		Dock:      &DockState{Session: "shell", Visible: true},
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.renameSession("alice", "shell", "scratchpad"); err != nil {
		t.Fatalf("renameSession: %v", err)
	}
	if l, _ := st.load("alice"); l.Dock == nil || l.Dock.Session != "scratchpad" {
		t.Fatalf("rename must follow the dock, got %+v", l.Dock)
	}
}

// --- validation ------------------------------------------------------------

func validLayout() Layout {
	return Layout{
		Version: 1,
		Projects: []Project{
			{Name: "tripit", Sessions: []string{"fix-dates"}},
			{Name: "infra", Sessions: []string{}},
		},
		Ungrouped: []string{"scratch"},
	}
}

func TestValidateLayoutAccepts(t *testing.T) {
	if err := validateLayout(validLayout()); err != nil {
		t.Fatalf("valid layout rejected: %v", err)
	}
}

func TestValidateLayoutAcceptsAbsoluteProjectDir(t *testing.T) {
	l := validLayout()
	l.Projects[0].Dir = "/home/wizard/code/tripit"
	if err := validateLayout(l); err != nil {
		t.Fatalf("absolute project dir rejected: %v", err)
	}
}

func TestValidateLayoutAcceptsDock(t *testing.T) {
	l := validLayout()
	l.Dock = &DockState{Session: "shell", Visible: true, Dir: "/home/wizard/code"}
	if err := validateLayout(l); err != nil {
		t.Fatalf("valid dock rejected: %v", err)
	}
	// A dock session need NOT appear in projects/ungrouped — it's the hidden
	// scratch shell, deliberately absent from the sidebar lists.
	l.Dock.Session = "not-listed-anywhere"
	if err := validateLayout(l); err != nil {
		t.Fatalf("dock session absent from lists must be allowed: %v", err)
	}
}

func TestValidateLayoutRejects(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*Layout)
	}{
		{"wrong version", func(l *Layout) { l.Version = 2 }},
		{"bad project name", func(l *Layout) { l.Projects[0].Name = "has space" }},
		{"empty project name", func(l *Layout) { l.Projects[0].Name = "" }},
		{"duplicate project", func(l *Layout) { l.Projects[1].Name = "tripit" }},
		{"bad session name", func(l *Layout) { l.Projects[0].Sessions[0] = "bad!name" }},
		{"bad ungrouped name", func(l *Layout) { l.Ungrouped[0] = "bad!name" }},
		{"session in two projects", func(l *Layout) { l.Projects[1].Sessions = []string{"fix-dates"} }},
		{"session both grouped and ungrouped", func(l *Layout) { l.Ungrouped = append(l.Ungrouped, "fix-dates") }},
		{"relative project dir", func(l *Layout) { l.Projects[0].Dir = "relative/path" }},
		{"project dir too long", func(l *Layout) { l.Projects[0].Dir = "/" + strings.Repeat("a", maxDirLen) }},
		{"bad dock session name", func(l *Layout) { l.Dock = &DockState{Session: "bad!name", Visible: true} }},
		{"relative dock dir", func(l *Layout) { l.Dock = &DockState{Session: "shell", Dir: "relative/path"} }},
		{"dock dir too long", func(l *Layout) { l.Dock = &DockState{Session: "shell", Dir: "/" + strings.Repeat("a", maxDirLen)} }},
		{"negative ungroupedIndex", func(l *Layout) { l.UngroupedIndex = -1 }},
		{"ungroupedIndex past last slot", func(l *Layout) { l.UngroupedIndex = len(l.Projects) + 1 }},
		{"too many projects", func(l *Layout) {
			for i := 0; i < maxProjects+1; i++ {
				l.Projects = append(l.Projects, Project{Name: "p" + strconv.Itoa(i), Sessions: []string{}})
			}
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			l := validLayout()
			c.mutate(&l)
			if err := validateLayout(l); err == nil {
				t.Fatalf("%s: want error, got nil", c.name)
			}
		})
	}
}

// --- session parsing + enrichment -------------------------------------------

func TestParseSessionsAllFields(t *testing.T) {
	// Fixture rows follow tmuxListFmt, which grew pane_current_command +
	// pane_title in Task 2.5 and session_id + @title with session titles
	// (2026-08-16). The per-field cases live in sessions_test.go.
	out := []byte(row("$0", "alpha", "1", "1751800000", "1751700000", "", "running", "4242", "claude", "Alpha work", "~/code") + "\n" +
		row("$1", "beta", "0", "1751800001", "1751700001", "", "", "991", "zsh", "", "devvm") + "\n")
	got := parseSessions(out)
	want := []Session{
		{ID: "$0", Name: "alpha", Attached: 1, LastActivity: 1751800000, Created: 1751700000, State: "running", PanePID: 4242, Command: "claude", Title: "Alpha work", PaneTitle: "~/code"},
		{ID: "$1", Name: "beta", Attached: 0, LastActivity: 1751800001, Created: 1751700001, PanePID: 991, Command: "zsh", PaneTitle: "devvm"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parse:\n got %+v\nwant %+v", got, want)
	}
}

func TestParseSessionsSkipsMalformed(t *testing.T) {
	out := []byte(row("only", "three", "fields") + "\n\n" +
		row("$2", "ok", "0", "1", "2", "", "done", "77", "cat", "", "") + "\n")
	got := parseSessions(out)
	if len(got) != 1 || got[0].Name != "ok" || got[0].State != "done" {
		t.Fatalf("malformed handling: %+v", got)
	}
}

func TestParseSessionsUnknownStateDropped(t *testing.T) {
	out := []byte(row("$3", "alpha", "0", "1", "2", "", "banana", "77", "cat", "", "") + "\n")
	got := parseSessions(out)
	if got[0].State != "" {
		t.Fatalf("unknown state value must be dropped, got %q", got[0].State)
	}
}

// --- handler gates (mirroring the existing restore gate tests) -------------

func TestHandleLayoutRejectsDelete(t *testing.T) {
	rec := httptest.NewRecorder()
	handleLayout(rec, httptest.NewRequest(http.MethodDelete, "/layout", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("DELETE /layout: got %d, want %d", rec.Code, http.StatusMethodNotAllowed)
	}
}

func TestHandleLayoutRequiresAuth(t *testing.T) {
	for _, m := range []string{http.MethodGet, http.MethodPut} {
		rec := httptest.NewRecorder()
		handleLayout(rec, httptest.NewRequest(m, "/layout", nil))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s /layout without %s: got %d, want %d", m, authHeader, rec.Code, http.StatusUnauthorized)
		}
	}
}
