package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
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

func TestParseSessionsEightFields(t *testing.T) {
	// Fixture rows follow tmuxListFmt, which grew pane_current_command +
	// pane_title in Task 2.5 (6 → 8 fields; the new-field cases live in
	// sessions_test.go).
	out := []byte("alpha|1|1751800000|1751700000|running|4242|claude|~/code\n" +
		"beta|0|1751800001|1751700001||991|zsh|devvm\n")
	got := parseSessions(out)
	want := []Session{
		{Name: "alpha", Attached: 1, LastActivity: 1751800000, Created: 1751700000, State: "running", PanePID: 4242, Command: "claude", Title: "~/code"},
		{Name: "beta", Attached: 0, LastActivity: 1751800001, Created: 1751700001, PanePID: 991, Command: "zsh", Title: "devvm"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parse:\n got %+v\nwant %+v", got, want)
	}
}

func TestParseSessionsSkipsMalformed(t *testing.T) {
	out := []byte("only|three|fields\n\nok|0|1|2|done|77|cat|\n")
	got := parseSessions(out)
	if len(got) != 1 || got[0].Name != "ok" || got[0].State != "done" {
		t.Fatalf("malformed handling: %+v", got)
	}
}

func TestParseSessionsUnknownStateDropped(t *testing.T) {
	out := []byte("alpha|0|1|2|banana|77|cat|\n")
	got := parseSessions(out)
	if got[0].State != "" {
		t.Fatalf("unknown state value must be dropped, got %q", got[0].State)
	}
}

func TestApplyLayoutResolvesProjects(t *testing.T) {
	sessions := []Session{{Name: "fix-dates"}, {Name: "scratch"}, {Name: "new-one"}}
	applyLayout(sessions, validLayout())
	if sessions[0].Project != "tripit" {
		t.Fatalf("fix-dates project: %q", sessions[0].Project)
	}
	if sessions[1].Project != "" || sessions[2].Project != "" {
		t.Fatalf("ungrouped/unknown sessions must have empty project: %+v", sessions[1:])
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
