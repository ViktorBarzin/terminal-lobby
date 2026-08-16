package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// POST /sessions/{name}/title and PATCH /sessions/{name} — the two ways a
// display title reaches a session. Same posture as the rename-handler suite:
// hermetic table tests through the REAL route (handleSessionByName), the user
// map pointed at a fixture and the tmux binary swapped for a stub.

func swapTitleStore(t *testing.T) *titleStore {
	t.Helper()
	old := titleStoreInstance
	titleStoreInstance = newTitleStore(t.TempDir())
	t.Cleanup(func() { titleStoreInstance = old })
	return titleStoreInstance
}

func TestSetTitleEndpoint(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)

	cases := []struct {
		name       string
		method     string
		path       string
		body       string
		auth       string
		stub       string
		wantStatus int
		wantArgv   []string // substrings every one of which must appear
		wantNoArgv bool
		wantStored string
	}{
		{
			name:   "stamps the option and remembers it",
			method: http.MethodPost, path: "/sessions/deploy-the-thing/title",
			body: `{"title":"Deploy the thing 🚀"}`, auth: "authself",
			wantStatus: http.StatusNoContent,
			// The pane target form, not the session one: set-option's -t takes
			// a pane, and the '=' stops a bare name resolving by prefix onto a
			// sibling like `deploy`.
			wantArgv:   []string{"set-option", "-t", "=deploy-the-thing:", "@title", "Deploy the thing 🚀"},
			wantStored: "Deploy the thing 🚀",
		},
		{
			name:   "a title in any script reaches tmux verbatim",
			method: http.MethodPost, path: "/sessions/testova-sesiya/title",
			body: `{"title":"тестова сесия"}`, auth: "authself",
			wantStatus: http.StatusNoContent,
			wantArgv:   []string{"@title", "тестова сесия"},
			wantStored: "тестова сесия",
		},
		{
			name:   "a pipe in a title is not special any more",
			method: http.MethodPost, path: "/sessions/work/title",
			body: `{"title":"Deploy | stage 2"}`, auth: "authself",
			wantStatus: http.StatusNoContent,
			wantArgv:   []string{"@title", "Deploy | stage 2"},
			wantStored: "Deploy | stage 2",
		},
		{
			name:   "an empty title UNSETS the option and forgets it",
			method: http.MethodPost, path: "/sessions/work/title",
			body: `{"title":""}`, auth: "authself",
			wantStatus: http.StatusNoContent,
			wantArgv:   []string{"set-option", "-u", "-t", "=work:", "@title"},
			wantStored: "",
		},
		{
			name:   "control characters are stripped before tmux sees them",
			method: http.MethodPost, path: "/sessions/work/title",
			body: `{"title":"line\u0000one\ttwo"}`, auth: "authself",
			wantStatus: http.StatusNoContent,
			wantArgv:   []string{"@title", "line one two"},
			wantStored: "line one two",
		},
		{
			name:   "an over-long title is capped, not refused",
			method: http.MethodPost, path: "/sessions/work/title",
			body: `{"title":"` + strings.Repeat("a", 200) + `"}`, auth: "authself",
			wantStatus: http.StatusNoContent,
			wantStored: strings.Repeat("a", 64),
		},
		{
			name:   "a session that is gone is a 404",
			method: http.MethodPost, path: "/sessions/absent/title",
			body: `{"title":"x"}`, auth: "authself",
			// The message set-option actually emits, measured on tmux 3.4 —
			// NOT the "can't find session" that rename and kill produce.
			stub:       "echo 'no such session: =absent:' >&2; exit 1",
			wantStatus: http.StatusNotFound,
		},
		{
			name:   "a stopped tmux server is a 404, not a 500",
			method: http.MethodPost, path: "/sessions/work/title",
			body: `{"title":"x"}`, auth: "authself",
			stub:       "echo 'no server running on /tmp/tmux-1000/default' >&2; exit 1",
			wantStatus: http.StatusNotFound,
		},
		{
			name:   "an unrecognised tmux failure stays a 500",
			method: http.MethodPost, path: "/sessions/work/title",
			body: `{"title":"x"}`, auth: "authself",
			stub:       "echo 'something else entirely' >&2; exit 1",
			wantStatus: http.StatusInternalServerError,
		},
		{
			name:   "an invalid session name never reaches tmux",
			method: http.MethodPost, path: "/sessions/not%20a%20name/title",
			body: `{"title":"x"}`, auth: "authself",
			wantStatus: http.StatusBadRequest, wantNoArgv: true,
		},
		{
			name:   "a malformed body never reaches tmux",
			method: http.MethodPost, path: "/sessions/work/title",
			body: `{"title":`, auth: "authself",
			wantStatus: http.StatusBadRequest, wantNoArgv: true,
		},
		{
			name:   "an unauthenticated caller never reaches tmux",
			method: http.MethodPost, path: "/sessions/work/title",
			body: `{"title":"x"}`, auth: "",
			wantStatus: http.StatusUnauthorized, wantNoArgv: true,
		},
		{
			name:   "GET is not a way to set a title",
			method: http.MethodGet, path: "/sessions/work/title",
			auth:       "authself",
			wantStatus: http.StatusMethodNotAllowed, wantNoArgv: true,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			withUserMap(t, "authself="+osSelf+"\n")
			store := swapTitleStore(t)
			argvFile := withTmuxStub(t, c.stub)

			w := httptest.NewRecorder()
			handleSessionByName(w, sessionReq(c.method, c.path, c.body, c.auth))

			if w.Code != c.wantStatus {
				t.Fatalf("status = %d, want %d (body %q)", w.Code, c.wantStatus, w.Body)
			}
			argv := recordedArgv(t, argvFile)
			if c.wantNoArgv && argv != "" {
				t.Fatalf("tmux was invoked when it should not have been: %q", argv)
			}
			for _, want := range c.wantArgv {
				if !strings.Contains(argv, want+"\n") {
					t.Errorf("argv missing %q:\n%s", want, argv)
				}
			}
			if c.wantStatus == http.StatusNoContent {
				name := strings.Split(strings.TrimPrefix(c.path, "/sessions/"), "/")[0]
				if got := store.get(osSelf, name); got != c.wantStored {
					t.Errorf("remembered title = %q, want %q", got, c.wantStored)
				}
			}
		})
	}
}

// PATCH is the retitle: rename and stamp together, so the two cannot
// half-apply. A 409 has to leave BOTH the name and the title as they were.
func TestRetitleEndpoint(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)

	cases := []struct {
		name       string
		body       string
		stub       string
		wantStatus int
		wantArgv   []string
		wantNoArgv bool
		// after a successful retitle, the title is remembered under the NEW name
		wantUnder string
		wantTitle string
	}{
		{
			name:       "renames and stamps in one call",
			body:       `{"name":"fix-the-parser","title":"Fix the parser"}`,
			wantStatus: http.StatusNoContent,
			wantArgv: []string{
				"rename-session", "-t", "=deploy-the-thing", "fix-the-parser",
				"set-option", "-t", "=fix-the-parser:", "@title", "Fix the parser",
			},
			wantUnder: "fix-the-parser", wantTitle: "Fix the parser",
		},
		{
			name: "an unchanged name stamps the title WITHOUT renaming",
			// This is what stops adding an emoji to a title from reloading the
			// terminal: the derived name did not move, so neither does tmux.
			body:       `{"name":"deploy-the-thing","title":"Deploy the thing 🚀"}`,
			wantStatus: http.StatusNoContent,
			wantArgv:   []string{"set-option", "@title", "Deploy the thing 🚀"},
			wantUnder:  "deploy-the-thing", wantTitle: "Deploy the thing 🚀",
		},
		{
			name:       "a taken name is a 409 and nothing is stamped",
			body:       `{"name":"taken","title":"Fix the parser"}`,
			stub:       `case "$1" in rename-session) echo "duplicate session: taken" >&2; exit 1;; esac`,
			wantStatus: http.StatusConflict,
			wantUnder:  "deploy-the-thing", wantTitle: "",
		},
		{
			name:       "a session that is gone is a 404",
			body:       `{"name":"fix-the-parser","title":"x"}`,
			stub:       `case "$1" in rename-session) echo "can't find session: deploy-the-thing" >&2; exit 1;; esac`,
			wantStatus: http.StatusNotFound,
		},
		{
			name:       "a name outside the charset never reaches tmux",
			body:       `{"name":"not a name","title":"x"}`,
			wantStatus: http.StatusBadRequest, wantNoArgv: true,
		},
		{
			name:       "an empty name never reaches tmux",
			body:       `{"name":"","title":"x"}`,
			wantStatus: http.StatusBadRequest, wantNoArgv: true,
		},
		{
			name:       "a malformed body never reaches tmux",
			body:       `not json`,
			wantStatus: http.StatusBadRequest, wantNoArgv: true,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			withUserMap(t, "authself="+osSelf+"\n")
			withTempLayoutStore(t)
			store := swapTitleStore(t)
			argvFile := withTmuxStub(t, c.stub)

			w := httptest.NewRecorder()
			handleSessionByName(w, sessionReq(http.MethodPatch,
				"/sessions/deploy-the-thing", c.body, "authself"))

			if w.Code != c.wantStatus {
				t.Fatalf("status = %d, want %d (body %q)", w.Code, c.wantStatus, w.Body)
			}
			argv := recordedArgv(t, argvFile)
			if c.wantNoArgv && argv != "" {
				t.Fatalf("tmux was invoked when it should not have been: %q", argv)
			}
			for _, want := range c.wantArgv {
				if !strings.Contains(argv, want+"\n") {
					t.Errorf("argv missing %q:\n%s", want, argv)
				}
			}
			if c.wantUnder != "" {
				if got := store.get(osSelf, c.wantUnder); got != c.wantTitle {
					t.Errorf("title under %q = %q, want %q", c.wantUnder, got, c.wantTitle)
				}
			}
		})
	}
}

// "The session you named is not there" has four spellings across the verbs
// this service runs, and they are NOT interchangeable — set-option says one
// thing where rename and kill say another. Measured against tmux 3.4; getting
// this wrong turns a gone session into a 500 rather than a 404, which the
// lobby reads as "the server is broken" instead of "it is gone".
func TestTmuxTargetMissingCoversEveryVerbsSpelling(t *testing.T) {
	missing := []string{
		"can't find session: absent",                                       // rename-session, kill-session
		"no such session: =absent:",                                        // set-option
		"no server running on /tmp/tmux-1000/default",                      // server stopped
		"error connecting to /tmp/tmux-1000/x (No such file or directory)", // socket dir gone
	}
	for _, msg := range missing {
		if !tmuxTargetMissing(msg) {
			t.Errorf("tmuxTargetMissing(%q) = false, want true", msg)
		}
	}
	present := []string{
		"duplicate session: taken", // a 409, emphatically not a 404
		"not in a mode",
		"",
	}
	for _, msg := range present {
		if tmuxTargetMissing(msg) {
			t.Errorf("tmuxTargetMissing(%q) = true, want false", msg)
		}
	}
}

// A retitle that does not rename must not invoke rename-session at all —
// asserted separately because "argv contains X" cannot express "argv contains
// no Y".
func TestRetitleWithAnUnchangedNameNeverRenames(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "authself="+osSelf+"\n")
	withTempLayoutStore(t)
	swapTitleStore(t)
	argvFile := withTmuxStub(t, "")

	w := httptest.NewRecorder()
	handleSessionByName(w, sessionReq(http.MethodPatch, "/sessions/work",
		`{"name":"work","title":"Work"}`, "authself"))

	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 (body %q)", w.Code, w.Body)
	}
	if argv := recordedArgv(t, argvFile); strings.Contains(argv, "rename-session") {
		t.Fatalf("a no-op rename still called rename-session:\n%s", argv)
	}
}
