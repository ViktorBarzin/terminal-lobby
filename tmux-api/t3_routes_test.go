package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"terminal-lobby/t3client"
)

// withT3 installs a poller over f for the test, with one poll done so the
// fake's threads are in the alias map.
func withT3(t *testing.T, f *fakeT3) *t3Poller {
	t.Helper()
	p, _, _ := testPoller(f)
	old := t3PollerInstance
	t3PollerInstance = p
	t.Cleanup(func() { t3PollerInstance = old })
	return p
}

func withLayoutStore(t *testing.T) {
	t.Helper()
	old := layoutStoreInstance
	layoutStoreInstance = newLayoutStore(t.TempDir())
	t.Cleanup(func() { layoutStoreInstance = old })
}

func withManagedSettings(t *testing.T, body string) {
	t.Helper()
	f := filepath.Join(t.TempDir(), "managed-settings.json")
	if err := os.WriteFile(f, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	old := managedSettingsPath
	managedSettingsPath = f
	t.Cleanup(func() { managedSettingsPath = old })
}

func TestT3SessionVerbs(t *testing.T) {
	me, other := twoLocalUsers(t)
	alias := t3client.Alias("mcp:a")
	unknown := t3client.Alias("mcp:gone")

	cases := []struct {
		name         string
		method, path string
		body         string
		fail         error
		wantStatus   int
		wantRenamed  string
		wantArchived string
	}{
		{name: "a title renames the thread", method: http.MethodPost, path: "/sessions/" + alias + "/title",
			body: `{"title":"  Fix\tthe build "}`, wantStatus: http.StatusNoContent, wantRenamed: "mcp:a=Fix the build"},
		{name: "an empty title is refused, since T3 cannot clear one", method: http.MethodPost,
			path: "/sessions/" + alias + "/title", body: `{"title":"  "}`, wantStatus: http.StatusBadRequest},
		{name: "a bad body is refused", method: http.MethodPost,
			path: "/sessions/" + alias + "/title", body: `{`, wantStatus: http.StatusBadRequest},
		{name: "DELETE archives", method: http.MethodDelete, path: "/sessions/" + alias,
			wantStatus: http.StatusNoContent, wantArchived: "mcp:a"},
		{name: "GET on the row is not a verb", method: http.MethodGet, path: "/sessions/" + alias,
			wantStatus: http.StatusMethodNotAllowed},
		{name: "an unknown alias is not found (archive)", method: http.MethodDelete, path: "/sessions/" + unknown,
			wantStatus: http.StatusNotFound},
		{name: "an unknown alias is not found (title)", method: http.MethodPost, path: "/sessions/" + unknown + "/title",
			body: `{"title":"x"}`, wantStatus: http.StatusNotFound},
		{name: "a T3 failure is a bad gateway", method: http.MethodDelete, path: "/sessions/" + alias,
			fail: errors.New("connection refused"), wantStatus: http.StatusBadGateway, wantArchived: "mcp:a"},
		{name: "another owner's T3 row is not reachable", method: http.MethodDelete,
			path: "/sessions/" + alias + "?owner=" + other, wantStatus: http.StatusNotFound},
	}
	// Every tmux verb is refused on a T3 row, before tmux is asked anything.
	for _, verb := range []string{"rename", "origin", "state", "copy-mode", "grid", "resume", "restart", "capture", "nope"} {
		method := http.MethodPost
		if verb == "capture" {
			method = http.MethodGet
		}
		cases = append(cases, struct {
			name         string
			method, path string
			body         string
			fail         error
			wantStatus   int
			wantRenamed  string
			wantArchived string
		}{name: "refuses " + verb, method: method, path: "/sessions/" + alias + "/" + verb, body: `{}`,
			wantStatus: http.StatusBadRequest})
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			withUserMap(t, "authself="+me+"\n")
			f := newFakeT3()
			f.has = map[string]bool{me: true}
			f.threads = []t3client.Thread{thread("mcp:a", "Old", "idle")}
			f.renameErr, f.archErr = c.fail, c.fail
			p := withT3(t, f)
			p.poll(me)
			argv := withTmuxStub(t, "exit 1")

			w := httptest.NewRecorder()
			handleSessionByName(w, sessionReq(c.method, c.path, c.body, "authself"))
			if w.Code != c.wantStatus {
				t.Fatalf("status = %d, want %d (%s)", w.Code, c.wantStatus, w.Body)
			}
			if got := recordedArgv(t, argv); got != "" {
				t.Fatalf("tmux was asked about a T3 row: %q", got)
			}
			if got := strings.Join(f.renamed, ","); got != c.wantRenamed {
				t.Errorf("renamed %q, want %q", got, c.wantRenamed)
			}
			if got := strings.Join(f.archived, ","); got != c.wantArchived {
				t.Errorf("archived %q, want %q", got, c.wantArchived)
			}
			rows := p.rows(me, nil)
			switch {
			case c.wantStatus == http.StatusNoContent && c.wantArchived != "":
				if len(rows) != 0 {
					t.Error("an archived row is still listed")
				}
			case c.wantStatus == http.StatusNoContent && c.wantRenamed != "":
				if rows[0].Title != "Fix the build" {
					t.Errorf("listed title = %q after the rename", rows[0].Title)
				}
			}
		})
	}
}

func TestCreateT3Session(t *testing.T) {
	me, _ := twoLocalUsers(t)
	withManagedSettings(t, `{"model":"claude-opus-5-5","effortLevel":"high"}`)

	type want struct {
		status  int
		dir     string
		launch  *t3client.LaunchRequest
		placed  string
		errText string
	}
	home := homeOfUser(me)
	cases := []struct {
		name string
		body string
		has  bool
		fail error
		want want
	}{
		{name: "launches in the directory's project with the box default model",
			body: `{"dir":"/home/x/code/lobby/web","prompt":"Fix the login page\nIt 500s on submit","project":"lobby"}`, has: true,
			want: want{status: http.StatusCreated, dir: "/home/x/code/lobby/web", placed: "lobby",
				launch: &t3client.LaunchRequest{ProjectID: "p1", Title: "Fix the login page",
					Prompt: "Fix the login page\nIt 500s on submit", Model: "claude-opus-5-5", RuntimeMode: "full-access"}}},
		{name: "keeps a chosen model, effort and title",
			body: `{"dir":"/srv/a","prompt":"hi","model":"claude-sonnet-5","effort":"max","title":"Mine"}`, has: true,
			want: want{status: http.StatusCreated, dir: "/srv/a",
				launch: &t3client.LaunchRequest{ProjectID: "p1", Title: "Mine", Prompt: "hi",
					Model: "claude-sonnet-5", Effort: "max", RuntimeMode: "full-access"}}},
		{name: "no directory means home", body: `{"prompt":"hi"}`, has: true,
			want: want{status: http.StatusCreated, dir: home,
				launch: &t3client.LaunchRequest{ProjectID: "p1", Title: "hi", Prompt: "hi",
					Model: "claude-opus-5-5", RuntimeMode: "full-access"}}},
		{name: "a relative directory is refused", body: `{"dir":"code","prompt":"hi"}`, has: true,
			want: want{status: http.StatusBadRequest}},
		{name: "a malformed model is refused", body: `{"dir":"/srv/a","model":"$(x)"}`, has: true,
			want: want{status: http.StatusBadRequest}},
		{name: "a malformed effort is refused", body: `{"dir":"/srv/a","effort":"HIGH!"}`, has: true,
			want: want{status: http.StatusBadRequest}},
		{name: "a user with no T3 is told so", body: `{"dir":"/srv/a"}`, has: false,
			want: want{status: http.StatusNotFound}},
		{name: "a T3 failure is a bad gateway", body: `{"dir":"/srv/a","prompt":"hi"}`, has: true,
			fail: errors.New("connection refused"), want: want{status: http.StatusBadGateway, dir: "/srv/a"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			withUserMap(t, "authself="+me+"\n")
			withLayoutStore(t)
			if err := layoutStoreInstance.save(me, Layout{Version: 1, Projects: []Project{{Name: "lobby"}}}); err != nil {
				t.Fatal(err)
			}
			f := newFakeT3()
			f.has = map[string]bool{me: c.has}
			f.project = t3client.Project{ID: "p1", WorkspaceRoot: "/home/x/code/lobby"}
			f.forDirErr = c.fail
			f.launch = t3client.Launched{ThreadID: "mcp:new", ProjectID: "p1"}
			p := withT3(t, f)
			p.changed = nil
			oldCache := sessionsCacheInstance
			sessionsCacheInstance = newSessionsCache(sessionsTTL)
			t.Cleanup(func() { sessionsCacheInstance = oldCache })
			sessionsCacheInstance.put(me, []byte("stale"))

			w := httptest.NewRecorder()
			handleT3Create(w, sessionReq(http.MethodPost, "/sessions/t3", c.body, "authself"))
			if w.Code != c.want.status {
				t.Fatalf("status = %d, want %d (%s)", w.Code, c.want.status, w.Body)
			}
			if c.want.dir != "" && (len(f.forDir) != 1 || f.forDir[0] != c.want.dir) {
				t.Errorf("ProjectForDir got %q, want %q", f.forDir, c.want.dir)
			}
			if c.want.launch == nil {
				if len(f.launched) != 0 {
					t.Fatalf("launched %+v", f.launched)
				}
				return
			}
			if len(f.launched) != 1 {
				t.Fatalf("launched %d threads", len(f.launched))
			}
			got := f.launched[0]
			got.ClientRequestID = ""
			if got != *c.want.launch {
				t.Errorf("launch\n got %+v\nwant %+v", got, *c.want.launch)
			}
			var body struct {
				Name, URL, AppURL, ThreadID string
			}
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body.Name != t3client.Alias("mcp:new") || body.ThreadID != "mcp:new" ||
				body.URL != "https://t3.example.test/env-1/mcp%3Anew" || body.AppURL != "t3code://threads/env-1/mcp:new" {
				t.Errorf("response %+v", body)
			}
			if id, ok := p.threadFor(me, body.Name); !ok || id != "mcp:new" {
				t.Error("the new thread's alias does not resolve before the next poll")
			}
			if _, ok := sessionsCacheInstance.get(me); ok {
				t.Error("the session list cache survived a create")
			}
			l, _ := layoutStoreInstance.load(me)
			placed := ""
			for _, pr := range l.Projects {
				for _, s := range pr.Sessions {
					if s == body.Name {
						placed = pr.Name
					}
				}
			}
			if placed != c.want.placed {
				t.Errorf("placed in %q, want %q", placed, c.want.placed)
			}
		})
	}
}

func TestT3CreateRouteLeavesOtherMethodsToASessionNamedT3(t *testing.T) {
	me, _ := twoLocalUsers(t)
	withUserMap(t, "authself="+me+"\n")
	withT3(t, newFakeT3())
	// A tmux session may be called "t3"; DELETE on it still reaches tmux.
	argv := withTmuxStub(t, "echo \"can't find session: t3\" >&2; exit 1")
	w := httptest.NewRecorder()
	handleT3Create(w, sessionReq(http.MethodDelete, "/sessions/t3", "", "authself"))
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want the tmux path's 404", w.Code)
	}
	if !strings.Contains(recordedArgv(t, argv), "=t3") {
		t.Fatalf("tmux was not asked about the session named t3: %q", recordedArgv(t, argv))
	}
}

func TestT3AliasesHaveNoTerminal(t *testing.T) {
	me, _ := twoLocalUsers(t)
	alias := t3client.Alias("mcp:a")
	got, err := sessionAccess(me, alias, me)
	if err != nil || got.Mode != "" {
		t.Fatalf("sessionAccess on a T3 alias = %+v, %v; want no access", got, err)
	}
	// A title never derives a name the T3 routes would claim.
	if name, ok := derivedNameFor("abcdefghjkmn", alias, map[string]bool{}); ok {
		t.Fatalf("a title derived the alias-shaped name %q", name)
	}
}

func TestRenameRefusesAnAliasShapedName(t *testing.T) {
	me, _ := twoLocalUsers(t)
	withUserMap(t, "authself="+me+"\n")
	argv := withTmuxStub(t, "")
	w := httptest.NewRecorder()
	handleSessionByName(w, sessionReq(http.MethodPost, "/sessions/work/rename",
		`{"name":"`+t3client.Alias("mcp:a")+`"}`, "authself"))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
	if got := recordedArgv(t, argv); strings.Contains(got, "rename-session") {
		t.Fatalf("tmux renamed a session to a T3 alias: %q", got)
	}
}

func TestSessionsListAppendsT3Rows(t *testing.T) {
	me, _ := twoLocalUsers(t)
	withUserMap(t, "authself="+me+"\n")
	withLayoutStore(t)
	oldP, oldS := projectStoreInstance, shareStoreInstance
	projectStoreInstance = newProjectStore(t.TempDir() + "/projects.json")
	shareStoreInstance = newShareStore(t.TempDir() + "/shares.json")
	t.Cleanup(func() { projectStoreInstance, shareStoreInstance = oldP, oldS })
	oldCache := sessionsCacheInstance
	sessionsCacheInstance = newSessionsCache(sessionsTTL)
	t.Cleanup(func() { sessionsCacheInstance = oldCache })
	withTmuxStub(t, "exit 1") // tmux down: the T3 rows still list

	f := newFakeT3()
	f.has = map[string]bool{me: true}
	f.threads = []t3client.Thread{thread("mcp:a", "From T3", "waiting")}
	p := withT3(t, f)

	get := func() []Session {
		w := httptest.NewRecorder()
		handleSessions(w, sessionReq(http.MethodGet, "/sessions", "", "authself"))
		var out []Session
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatalf("body %q: %v", w.Body, err)
		}
		return out
	}
	// The first request starts the poll and does not wait for it.
	_ = get()
	waitForT3(t, "the first poll", func() bool { return len(p.rows(me, nil)) == 1 })
	sessionsCacheInstance.invalidate(me)
	rows := get()
	if len(rows) != 1 || rows[0].Backend != "t3" || rows[0].Title != "From T3" || rows[0].State != "awaiting" {
		t.Fatalf("rows = %+v", rows)
	}
}

func TestWhoamiSaysWhereNewClaudeSessionsRun(t *testing.T) {
	me, _ := twoLocalUsers(t)
	withUserMap(t, "authself="+me+"\n")
	cases := []struct {
		name     string
		has      bool
		defaults map[string]bool
		want     string
	}{
		{"a default user with a T3", true, map[string]bool{me: true}, "t3"},
		{"a user with a T3 who is not a default", true, map[string]bool{}, "tmux"},
		{"a default user without a T3", false, map[string]bool{me: true}, "tmux"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeT3()
			f.has = map[string]bool{me: c.has}
			withT3(t, f)
			old := t3DefaultUsers
			t3DefaultUsers = c.defaults
			t.Cleanup(func() { t3DefaultUsers = old })

			w := httptest.NewRecorder()
			handleWhoami(w, sessionReq(http.MethodGet, "/whoami", "", "authself"))
			var body struct {
				T3            bool   `json:"t3"`
				ClaudeBackend string `json:"claudeBackend"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body.ClaudeBackend != c.want || body.T3 != c.has {
				t.Fatalf("whoami = %+v, want claudeBackend %q and t3 %v", body, c.want, c.has)
			}
		})
	}
}

func TestParseT3DefaultUsers(t *testing.T) {
	got := parseT3DefaultUsers(" wizard, emo\tbad/user  ")
	if len(got) != 2 || !got["wizard"] || !got["emo"] {
		t.Fatalf("parseT3DefaultUsers = %v", got)
	}
}

func TestT3Toplevel(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	sub := filepath.Join(repo, "a", "b")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	// Another user's directory is resolved without running anything as
	// this service: a .git entry marks the root, and none means the dir.
	if got := dotGitToplevel(sub); got != repo {
		t.Errorf("dotGitToplevel(%q) = %q, want %q", sub, got, repo)
	}
	plain := filepath.Join(root, "plain")
	if err := os.MkdirAll(plain, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := dotGitToplevel(plain + "/"); got != plain {
		t.Errorf("dotGitToplevel(%q) = %q, want the dir itself", plain, got)
	}
}
