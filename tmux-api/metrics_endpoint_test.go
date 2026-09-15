package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMetricsEndpointReportsLivenessAndBuild(t *testing.T) {
	body := scrape(t)
	for _, want := range []string{
		"tl_build_info{",
		"tl_uptime_seconds ",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %q in:\n%s", want, body)
		}
	}
}

// The point of the endpoint. A scrape that succeeds is itself the liveness
// signal, so the handler must answer even when tmux is unreachable and every
// gauge below is therefore unknown.
func TestMetricsEndpointAnswersEvenWhenTmuxIsUnavailable(t *testing.T) {
	prev := sessionCounter
	sessionCounter = func() map[string]int { return nil }
	defer func() { sessionCounter = prev }()

	rec := httptest.NewRecorder()
	handleMetrics(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d; a scrape must not fail because tmux is down", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "tl_uptime_seconds") {
		t.Error("liveness metrics vanished with the session gauges")
	}
}

func TestMetricsEndpointReportsSessionsPerUser(t *testing.T) {
	prev := sessionCounter
	sessionCounter = func() map[string]int { return map[string]int{"wizard": 33, "emo": 16} }
	defer func() { sessionCounter = prev }()

	body := scrape(t)
	for _, want := range []string{
		`tl_sessions{user="wizard"} 33`,
		`tl_sessions{user="emo"} 16`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %q in:\n%s", want, body)
		}
	}
}

// Session names are user-supplied and unbounded; OS usernames are not. Only
// the second may become a label, which is the same rule the event stream
// follows for Loki.
func TestMetricsEndpointNeverLabelsBySessionName(t *testing.T) {
	prev := sessionCounter
	sessionCounter = func() map[string]int { return map[string]int{"wizard": 2} }
	defer func() { sessionCounter = prev }()

	if body := scrape(t); strings.Contains(body, "session=") {
		t.Fatalf("a session-name label reached the exposition:\n%s", body)
	}
}

// -- workspaces ---------------------------------------------------------------
//
// Viktor, 2026-09-15: *"let's also add some metrics - to know if users are
// using this feature. e.g we can report number of active panes per user"*.
//
// The event stream already says a workspace document was WRITTEN
// (`workspace.arranged`), which answers how often somebody rearranges and
// nothing about how many people hold an arrangement right now — a workspace
// made on Monday and used all week emits once. A gauge is the other half: it is
// read at scrape time, so it counts what exists rather than what changed.

func TestMetricsEndpointReportsWorkspacesAndTilesPerUser(t *testing.T) {
	prev := workspaceCounter
	workspaceCounter = func() map[string]workspaceUse {
		return map[string]workspaceUse{
			"wizard": {Groups: 2, Tiles: 7, Largest: 4},
			"emo":    {Groups: 1, Tiles: 2, Largest: 2},
		}
	}
	defer func() { workspaceCounter = prev }()

	body := scrape(t)
	for _, want := range []string{
		`tl_workspaces{user="wizard"} 2`,
		`tl_workspace_tiles{user="wizard"} 7`,
		`tl_workspace_max_tiles{user="wizard"} 4`,
		`tl_workspaces{user="emo"} 1`,
		`tl_workspace_tiles{user="emo"} 2`,
		"tl_workspaces_total 3",
		"tl_workspace_tiles_total 9",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %q in:\n%s", want, body)
		}
	}
}

// A user who has never made one, and a user who closed their last one back to a
// single tile, both report zero rather than disappearing. A vanished series
// reads as "no data" on a graph, which is the same shape as the scrape being
// broken; a zero is the answer to the question actually being asked.
func TestMetricsEndpointReportsZeroForAUserWithNoWorkspace(t *testing.T) {
	prev := workspaceCounter
	workspaceCounter = func() map[string]workspaceUse {
		return map[string]workspaceUse{"wizard": {}, "emo": {Groups: 1, Tiles: 3, Largest: 3}}
	}
	defer func() { workspaceCounter = prev }()

	body := scrape(t)
	if !strings.Contains(body, `tl_workspaces{user="wizard"} 0`) {
		t.Errorf("a user with no workspace left the exposition entirely:\n%s", body)
	}
}

// The endpoint's one design constraint: a successful scrape IS the liveness
// signal, so nothing below the build and uptime may take it down. A workspaces
// directory that cannot be read is exactly as plausible as tmux being down.
func TestMetricsEndpointAnswersWhenWorkspacesCannotBeRead(t *testing.T) {
	prev := workspaceCounter
	workspaceCounter = func() map[string]workspaceUse { return nil }
	defer func() { workspaceCounter = prev }()

	rec := httptest.NewRecorder()
	handleMetrics(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d; a scrape must not fail because a document is unreadable", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "tl_uptime_seconds") {
		t.Error("liveness metrics vanished with the workspace gauges")
	}
}

// The real counter, over a real directory: the seam above is only worth having
// if what it stands in for agrees with it.
func TestWorkspaceUseCountsTheStoredDocuments(t *testing.T) {
	dir := t.TempDir()
	prevStore := workspaceStoreInstance
	workspaceStoreInstance = newWorkspaceStore(dir)
	defer func() { workspaceStoreInstance = prevStore }()

	if err := workspaceStoreInstance.save("wizard", Workspaces{
		Version: workspacesVersion,
		Workspaces: []Workspace{
			{ID: "w1", Members: []WorkspaceMember{{Name: "auth"}, {Name: "deploy"}}},
			{ID: "w2", Members: []WorkspaceMember{
				{Name: "docs"}, {Name: "logs"}, {Name: "build"}, {Name: "release"},
			}},
		},
	}); err != nil {
		t.Fatalf("save: %v", err)
	}

	got := workspaceUseFor([]string{"wizard", "emo"})
	want := map[string]workspaceUse{
		"wizard": {Groups: 2, Tiles: 6, Largest: 4},
		// No document at all, which is what every user starts as.
		"emo": {},
	}
	if fmt.Sprintf("%v", got) != fmt.Sprintf("%v", want) {
		t.Errorf("workspaceUseFor = %v, want %v", got, want)
	}
}

func scrape(t *testing.T) string {
	t.Helper()
	rec := httptest.NewRecorder()
	handleMetrics(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	return rec.Body.String()
}
