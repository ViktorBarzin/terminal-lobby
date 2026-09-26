package sessionio

import (
	"reflect"
	"testing"
)

// The two recorded run files parse into what the panel needs from them. They
// are sanitized from real runs on this box: a run that completed after one
// resume (its first member replayed from the journal, so it carries no counts
// of its own) with a member that failed, and a run the operator killed with two
// members mid-phase (no result, an error, members still "progress").
func TestParseWorkflowRunFixtures(t *testing.T) {
	const dir = "testdata/agents/workflows/"
	for _, tc := range []struct {
		name string
		file string
		want workflowRun
	}{
		{"completed after a resume", dir + "wf_7e41b0c2-5d8.json", workflowRun{
			ID: "wf_7e41b0c2-5d8", Name: "fix-answer-card",
			Summary: "Make multi-select questions toggle on click, review the change, and land it",
			Status:  "completed", StartedAt: 1790202600000, EndedAt: 1790202600000 + 1688880,
			Phases: []WorkflowPhase{
				{Index: 1, Title: "Build", Detail: "server and card in parallel, test-first"},
				{Index: 2, Title: "Review", Detail: "two blind reviewers"},
				{Index: 3, Title: "Land", Detail: "merge, push and watch CI"},
			},
			AgentCount: 5, Tokens: 61234 + 40210 + 30877 + 52011, ToolCalls: 20,
			Members: []workflowMember{
				{AgentID: "a1b3c5d7e9f1b0011", Index: 1, Label: "build:server", PhaseIndex: 1, PhaseTitle: "Build",
					Model: "claude-opus-5-5", State: "done", StartedAt: 1790202600050, LastProgressAt: 1790202600050, Cached: true,
					ResultPreview: `{"ok":true,"summary":"Server half in place; toggles stay on the question."}`},
				{AgentID: "a1b3c5d7e9f1b0013", Index: 2, Label: "build:card", PhaseIndex: 1, PhaseTitle: "Build",
					Model: "claude-opus-5-5", State: "done", StartedAt: 1790202600110, LastProgressAt: 1790203269170,
					DurationMs: 669060, LastToolName: "StructuredOutput",
					LastToolSummary: "The card sends one toggle per click and waits for the reading.",
					Tokens:          61234, ToolCalls: 3,
					ResultPreview: `{"ok":true,"summary":"The card sends one toggle per click and waits for the reading."}`},
				{AgentID: "a1b3c5d7e9f1b0014", Index: 3, Label: "review:bugs", PhaseIndex: 2, PhaseTitle: "Review",
					Model: "claude-opus-5-5", State: "done", StartedAt: 1790203269320, LastProgressAt: 1790203828380,
					DurationMs: 559060, LastToolName: "StructuredOutput", LastToolSummary: "No correctness bugs found.",
					Tokens: 40210, ToolCalls: 2, ResultPreview: `{"findings":[],"summary":"No correctness bugs found."}`},
				{AgentID: "a1b3c5d7e9f1b0015", Index: 4, Label: "review:design", PhaseIndex: 2, PhaseTitle: "Review",
					Model: "claude-opus-5-5", State: "error", StartedAt: 1790203269430, LastProgressAt: 1790203649430,
					DurationMs: 380000, LastToolName: "Read", LastToolSummary: "/home/user/project/docs/plans/answer-card.md",
					Tokens: 30877, ToolCalls: 1, Error: "API Error: 400 The request could not be processed."},
				{AgentID: "a1b3c5d7e9f1b0016", Index: 5, Label: "land", PhaseIndex: 3, PhaseTitle: "Land",
					Model: "claude-opus-5-5", State: "done", StartedAt: 1790203828780, LastProgressAt: 1790204288580,
					DurationMs: 459800, LastToolName: "StructuredOutput", LastToolSummary: "ee5ace5",
					Tokens: 52011, ToolCalls: 14, ResultPreview: `{"ok":true,"landed_sha":"ee5ace5"}`},
			},
		}},
		{"killed mid-phase", dir + "wf_3b9d27f4-a16.json", workflowRun{
			ID: "wf_3b9d27f4-a16", Name: "delete-old-page",
			Summary: "Delete the old terminal page and re-point what referenced it",
			Status:  "killed", StartedAt: 1790211600000, EndedAt: 1790211600000 + 570000,
			Error: "Error: Workflow aborted\n    at c (/$bunfs/root/chunk-gvm795t7.js:82:5093)\n    at abort (unknown)",
			Phases: []WorkflowPhase{
				{Index: 1, Title: "Survey", Detail: "classify every referencing file"},
				{Index: 2, Title: "Delete", Detail: "disjoint file sets in parallel"},
				{Index: 3, Title: "Verify", Detail: "build and drive every entry path"},
			},
			AgentCount: 3, Tokens: 88100 + 70420 + 51007, ToolCalls: 5,
			Members: []workflowMember{
				{AgentID: "a3c5e7f9b1d3c0021", Index: 1, Label: "classify files", PhaseIndex: 1, PhaseTitle: "Survey",
					Model: "claude-opus-5-5", State: "done", StartedAt: 1790211600080, LastProgressAt: 1790211899140,
					DurationMs: 299060, LastToolName: "StructuredOutput", Tokens: 88100, ToolCalls: 2,
					ResultPreview: `{"delete":["frontend/term.html"],"keep":[]}`},
				{AgentID: "a3c5e7f9b1d3c0022", Index: 2, Label: "frontend source", PhaseIndex: 2, PhaseTitle: "Delete",
					Model: "claude-opus-5-5", State: "progress", StartedAt: 1790211899280, LastProgressAt: 1790212149280,
					LastToolName: "Edit", LastToolSummary: "/home/user/project/frontend-v2/src/components/Dock.tsx",
					Tokens: 70420, ToolCalls: 2},
				{AgentID: "a3c5e7f9b1d3c0023", Index: 3, Label: "docs and the ADR", PhaseIndex: 2, PhaseTitle: "Delete",
					Model: "claude-opus-5-5", State: "progress", StartedAt: 1790211899290, LastProgressAt: 1790211901790,
					LastToolName: "Bash", LastToolSummary: "sed -n '125,160p' packaging/build-deb.sh",
					Tokens: 51007, ToolCalls: 1},
			},
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseWorkflowRun([]byte(mustRead(t, tc.file)))
			if err != nil {
				t.Fatalf("parseWorkflowRun: %v", err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("parseWorkflowRun\n got %+v\nwant %+v", got, tc.want)
			}
		})
	}
}

// A run file is decoded field by field, so one field of an unexpected shape
// costs only itself. It fails only when the bytes are not a whole JSON object,
// which is what a file caught mid-write looks like: Claude Code writes it in
// place, not by rename.
func TestParseWorkflowRunTolerance(t *testing.T) {
	whole := mustRead(t, "testdata/agents/workflows/wf_3b9d27f4-a16.json")
	for _, tc := range []struct {
		name    string
		in      string
		want    workflowRun
		wantErr bool
	}{
		{"caught mid-write", whole[:len(whole)/2], workflowRun{}, true},
		{"truncated to nothing", "", workflowRun{}, true},
		{"not an object", `["wf_1"]`, workflowRun{}, true},
		{"null", `null`, workflowRun{}, true},
		{"an empty object", `{}`, workflowRun{}, false},
		{"fields of the wrong type cost only themselves",
			`{"runId":"wf_1","workflowName":7,"status":"completed","startTime":"soon","durationMs":10,"agentCount":"two","totalTokens":5}`,
			workflowRun{ID: "wf_1", Status: "completed", Tokens: 5}, false},
		{"no duration: the snapshot's own timestamp ends it",
			`{"runId":"wf_1","status":"completed","startTime":1790000000000,"timestamp":"2026-09-24T06:00:00.000Z"}`,
			workflowRun{ID: "wf_1", Status: "completed", StartedAt: 1790000000000, EndedAt: 1790229600000}, false},
		{"entries that are not members are skipped",
			`{"workflowProgress":[{"type":"workflow_log","message":"hi"},"junk",{"type":"workflow_agent","index":"x","agentId":"a1","state":"done"},{"type":"workflow_agent","index":2,"agentId":"a2","state":"progress","tokens":"many"}]}`,
			workflowRun{Members: []workflowMember{{AgentID: "a1", State: "done"}, {AgentID: "a2", Index: 2, State: "progress"}}}, false},
		{"no phases list: the phase markers stand in",
			`{"workflowProgress":[{"type":"workflow_phase","index":2,"title":"Review"},{"type":"workflow_phase","index":1,"title":"Build"}]}`,
			workflowRun{Phases: []WorkflowPhase{{Index: 1, Title: "Build"}, {Index: 2, Title: "Review"}}}, false},
		{"the phases list wins over the markers",
			`{"phases":[{"title":"Build","detail":"d"},{"title":7}],"workflowProgress":[{"type":"workflow_phase","index":1,"title":"Other"}]}`,
			workflowRun{Phases: []WorkflowPhase{{Index: 1, Title: "Build", Detail: "d"}, {Index: 2}}}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseWorkflowRun([]byte(tc.in))
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tc.wantErr)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("got  %+v\nwant %+v", got, tc.want)
			}
		})
	}
}

// Claude Code writes a run file only when the run is over, with one of three
// statuses. The CLI's own reader treats a missing status as failed when the
// file carries an error and completed otherwise, and so does this. "paused" is
// what the CLI calls a run restored from disk that can be resumed: nothing in
// it is running, and a resume shows up as a new attempt.
func TestWorkflowRunState(t *testing.T) {
	for _, tc := range []struct {
		status, err string
		want        WorkflowState
	}{
		{"completed", "", WorkflowDone},
		{"failed", "Error: boom", WorkflowFailed},
		{"killed", "Error: Workflow aborted", WorkflowKilled},
		{"paused", "", WorkflowKilled},
		{"running", "", WorkflowRunning},
		{"", "Error: boom", WorkflowFailed},
		{"", "", WorkflowDone},
		{"some-future-status", "", WorkflowDone},
		{"some-future-status", "Error: boom", WorkflowFailed},
	} {
		if got := (workflowRun{Status: tc.status, Error: tc.err}).state(); got != tc.want {
			t.Errorf("status %q error %q: state %q, want %q", tc.status, tc.err, got, tc.want)
		}
	}
}
