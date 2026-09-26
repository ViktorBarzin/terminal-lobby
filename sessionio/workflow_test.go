package sessionio

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// runAgents follows every agent transcript under a run's directory the way the
// watcher does: one tail each, read to the end, with its sidecar applied.
func runAgents(t *testing.T, sessionDir, id string) []RunAgent {
	t.Helper()
	paths, err := filepath.Glob(filepath.Join(sessionDir, "subagents", "workflows", id, "agent-*.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	var out []RunAgent
	for _, p := range paths {
		tail := NewAgentTail(p, LocalReader{})
		if _, err := tail.Poll(); err != nil {
			t.Fatal(err)
		}
		meta := readMeta(t, p)
		out = append(out, RunAgent{Info: tail.Info(meta), Phase: meta.WorkflowPhase})
	}
	return out
}

// openWorkflow reads a run's files the way the watcher does: the run file when
// there is one, the run's script when there is one, and the journal.
func openWorkflow(t *testing.T, sessionDir, id string) *Workflow {
	t.Helper()
	w := NewWorkflow(sessionDir, id, LocalReader{})
	if b, err := os.ReadFile(w.RunPath()); err == nil {
		if err := w.SetRunFile(b); err != nil {
			t.Fatalf("SetRunFile: %v", err)
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		t.Fatal(err)
	}
	scripts, err := filepath.Glob(filepath.Join(sessionDir, "workflows", "scripts", "*-"+id+".js"))
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range scripts {
		if !w.SetScript([]byte(mustRead(t, p))) {
			t.Fatalf("SetScript(%s) found no meta", p)
		}
	}
	if _, err := w.PollJournal(); err != nil {
		t.Fatalf("PollJournal: %v", err)
	}
	return w
}

// The design's "done when" for this step: a workflow run reports its phases and
// members. One fixture per way a run is measured to look on disk: completed
// after a resume, killed by the operator, and still going (no run file yet,
// because Claude Code writes that only when a run ends).
func TestWorkflowFixtures(t *testing.T) {
	const session = "testdata/agents"
	for _, tc := range []struct {
		name        string
		id          string
		wantRunning bool
		want        WorkflowInfo
		members     []AgentInfo
	}{
		{"completed after a resume", "wf_7e41b0c2-5d8", false, WorkflowInfo{
			ID: "wf_7e41b0c2-5d8", Name: "fix-answer-card",
			Summary: "Make multi-select questions toggle on click, review the change, and land it",
			State:   WorkflowDone, StartedAt: 1790202600000, EndedAt: 1790204288880,
			Phases: []WorkflowPhase{
				{Index: 1, Title: "Build", Detail: "server and card in parallel, test-first"},
				{Index: 2, Title: "Review", Detail: "two blind reviewers"},
				{Index: 3, Title: "Land", Detail: "merge, push and watch CI"},
			},
			CurrentPhase: 3, AgentCount: 5, Tokens: 184332, ToolCalls: 20,
		}, []AgentInfo{
			// Replayed from the journal on the resume: the run file says only
			// that it is done, so everything else comes from its transcript,
			// written in the first attempt.
			{ID: "a1b3c5d7e9f1b0011", Description: "build:server", AgentType: "workflow-subagent", Model: "claude-opus-5-5",
				Depth: 1, WorkflowID: "wf_7e41b0c2-5d8", PhaseIndex: 1, Label: "build:server", State: AgentDone,
				StartedAt: ms(t, "2026-09-23T22:01:34.120Z"), LastActivityAt: ms(t, "2026-09-23T22:10:04.180Z"),
				EndedAt: ms(t, "2026-09-23T22:10:04.160Z"), Tool: "StructuredOutput",
				ToolDetail: "Server half in place; toggles stay on the question.", ToolCalls: 3, OutputTokens: 96 + 140 + 380,
				Result: `{"ok":true,"summary":"Server half in place; toggles stay on the question."}`},
			{ID: "a1b3c5d7e9f1b0013", Description: "build:card", AgentType: "workflow-subagent", Model: "claude-opus-5-5",
				Depth: 1, WorkflowID: "wf_7e41b0c2-5d8", PhaseIndex: 1, Label: "build:card", State: AgentDone,
				StartedAt: ms(t, "2026-09-23T22:30:00.110Z"), LastActivityAt: ms(t, "2026-09-23T22:41:09.170Z"),
				EndedAt: ms(t, "2026-09-23T22:41:09.150Z"), Tool: "StructuredOutput",
				ToolDetail: "The card sends one toggle per click and waits for the reading.", ToolCalls: 3, OutputTokens: 90 + 150 + 420,
				Result: `{"ok":true,"summary":"The card sends one toggle per click and waits for the reading."}`},
			{ID: "a1b3c5d7e9f1b0014", Description: "review:bugs", AgentType: "workflow-subagent", Model: "claude-opus-5-5",
				Depth: 1, WorkflowID: "wf_7e41b0c2-5d8", PhaseIndex: 2, Label: "review:bugs", State: AgentDone,
				StartedAt: ms(t, "2026-09-23T22:41:09.320Z"), LastActivityAt: ms(t, "2026-09-23T22:50:28.380Z"),
				EndedAt: ms(t, "2026-09-23T22:50:28.360Z"), Tool: "StructuredOutput",
				ToolDetail: "No correctness bugs found.", ToolCalls: 2, OutputTokens: 70 + 510,
				Result: `{"findings":[],"summary":"No correctness bugs found."}`},
			{ID: "a1b3c5d7e9f1b0015", Description: "review:design", AgentType: "workflow-subagent", Model: "claude-opus-5-5",
				Depth: 1, WorkflowID: "wf_7e41b0c2-5d8", PhaseIndex: 2, Label: "review:design", State: AgentFailed,
				StartedAt: ms(t, "2026-09-23T22:41:09.430Z"), LastActivityAt: ms(t, "2026-09-23T22:47:29.430Z"),
				EndedAt: ms(t, "2026-09-23T22:47:29.430Z"), Tool: "Read",
				ToolDetail: "/home/user/project/docs/plans/answer-card.md", ToolCalls: 1, OutputTokens: 64,
				Result: "API Error: 400 The request could not be processed."},
			// No transcript for this one: the run file's own figures stand in,
			// all but its token count, which measures context rather than output.
			{ID: "a1b3c5d7e9f1b0016", Model: "claude-opus-5-5", WorkflowID: "wf_7e41b0c2-5d8", PhaseIndex: 3, Label: "land",
				State: AgentDone, StartedAt: 1790203828780, LastActivityAt: 1790204288580, EndedAt: 1790204288580,
				Tool: "StructuredOutput", ToolDetail: "ee5ace5", ToolCalls: 14, Result: `{"ok":true,"landed_sha":"ee5ace5"}`},
			// The first attempt's build:card, cut off by the kill and run again
			// as a1b3c5d7e9f1b0013, is not a member of the run that completed.
		}},
		{"killed mid-phase", "wf_3b9d27f4-a16", false, WorkflowInfo{
			ID: "wf_3b9d27f4-a16", Name: "delete-old-page",
			Summary: "Delete the old terminal page and re-point what referenced it",
			State:   WorkflowKilled, StartedAt: 1790211600000, EndedAt: 1790212170000,
			Phases: []WorkflowPhase{
				{Index: 1, Title: "Survey", Detail: "classify every referencing file"},
				{Index: 2, Title: "Delete", Detail: "disjoint file sets in parallel"},
				{Index: 3, Title: "Verify", Detail: "build and drive every entry path"},
			},
			CurrentPhase: 2, AgentCount: 3, Tokens: 209527, ToolCalls: 5,
		}, []AgentInfo{
			{ID: "a3c5e7f9b1d3c0021", Description: "classify files", AgentType: "workflow-subagent", Model: "claude-opus-5-5",
				Depth: 1, WorkflowID: "wf_3b9d27f4-a16", PhaseIndex: 1, Label: "classify files", State: AgentDone,
				StartedAt: ms(t, "2026-09-24T01:00:00.080Z"), LastActivityAt: ms(t, "2026-09-24T01:04:59.140Z"),
				EndedAt: ms(t, "2026-09-24T01:04:59.120Z"), Tool: "StructuredOutput", ToolCalls: 2, OutputTokens: 55 + 300,
				Result: `{"delete":["frontend/term.html"],"keep":[]}`},
			// The run file still says "progress" for these two; their own
			// transcripts end on the interrupt the kill wrote.
			{ID: "a3c5e7f9b1d3c0022", Description: "frontend source", AgentType: "workflow-subagent", Model: "claude-opus-5-5",
				Depth: 1, WorkflowID: "wf_3b9d27f4-a16", PhaseIndex: 2, Label: "frontend source", State: AgentFailed,
				StartedAt: ms(t, "2026-09-24T01:04:59.280Z"), LastActivityAt: ms(t, "2026-09-24T01:09:30.000Z"),
				EndedAt: ms(t, "2026-09-24T01:09:30.000Z"), Tool: "Edit",
				ToolDetail: "/home/user/project/frontend-v2/src/components/Dock.tsx", ToolCalls: 2, OutputTokens: 60 + 220,
				Result: "[Request interrupted by user]"},
			{ID: "a3c5e7f9b1d3c0023", Description: "docs and the ADR", AgentType: "workflow-subagent", Model: "claude-opus-5-5",
				Depth: 1, WorkflowID: "wf_3b9d27f4-a16", PhaseIndex: 2, Label: "docs and the ADR", State: AgentFailed,
				StartedAt: ms(t, "2026-09-24T01:04:59.290Z"), LastActivityAt: ms(t, "2026-09-24T01:09:30.000Z"),
				EndedAt: ms(t, "2026-09-24T01:09:30.000Z"), Tool: "Bash",
				ToolDetail: "sed -n '125,160p' packaging/build-deb.sh", ToolCalls: 1, OutputTokens: 48,
				Result: "[Request interrupted by user]"},
		}},
		{"still going: no run file yet", "wf_5c2d9e1a-7b3", true, WorkflowInfo{
			// The run file comes only when the run ends. The script, written at
			// launch, names the run and every phase it will go through, the one
			// not started yet included.
			ID: "wf_5c2d9e1a-7b3", Name: "plan-and-review",
			Summary: "Plan the reviewers, run them side by side, then land what they pass",
			State:   WorkflowRunning, StartedAt: ms(t, "2026-09-24T04:58:00.000Z"),
			Phases: []WorkflowPhase{
				{Index: 1, Title: "Plan", Detail: "pick the reviewers"},
				{Index: 2, Title: "Review", Detail: "one agent per reviewer, in parallel"},
				{Index: 3, Title: "Land", Detail: "merge, push and watch CI"},
			},
			CurrentPhase: 2, AgentCount: 3, ToolCalls: 5,
		}, []AgentInfo{
			{ID: "a0b2c4d6e8f0a0005", Description: "plan", AgentType: "workflow-subagent", Model: "claude-opus-5-5",
				Depth: 1, WorkflowID: "wf_5c2d9e1a-7b3", PhaseIndex: 1, Label: "plan", State: AgentDone,
				StartedAt: ms(t, "2026-09-24T04:58:00.000Z"), LastActivityAt: ms(t, "2026-09-24T04:59:58.060Z"),
				EndedAt: ms(t, "2026-09-24T04:59:58.040Z"), Tool: "StructuredOutput", ToolCalls: 2, OutputTokens: 40 + 180,
				Result: `{"reviewers":["bugs","design"]}`},
			{ID: "a2c4e6f8a0b1c0003", Description: "review:bugs", AgentType: "workflow-subagent", Model: "claude-opus-5-5",
				Depth: 1, WorkflowID: "wf_5c2d9e1a-7b3", PhaseIndex: 2, Label: "review:bugs", State: AgentRunning,
				StartedAt: ms(t, "2026-09-24T05:00:00.000Z"), LastActivityAt: ms(t, "2026-09-24T05:00:03.000Z"),
				Tool: "Bash", ToolDetail: "go test ./... …", ToolCalls: 1, OutputTokens: 150},
			{ID: "a6b8d0f2c4e6d0004", Description: "review:design", AgentType: "workflow-subagent", Model: "claude-opus-5-5",
				Depth: 1, WorkflowID: "wf_5c2d9e1a-7b3", PhaseIndex: 2, Label: "review:design", State: AgentDone,
				StartedAt: ms(t, "2026-09-24T05:00:00.500Z"), LastActivityAt: ms(t, "2026-09-24T05:00:12.060Z"),
				EndedAt: ms(t, "2026-09-24T05:00:12.040Z"), Tool: "StructuredOutput",
				ToolDetail: "The diff matches the design.", ToolCalls: 2, OutputTokens: 95 + 310,
				Result: `{"ok":true,"summary":"The diff matches the design.","findings":[]}`},
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := openWorkflow(t, session, tc.id)
			if w.Running() != tc.wantRunning {
				t.Errorf("Running = %v, want %v", w.Running(), tc.wantRunning)
			}
			info, members := w.Merge(runAgents(t, session, tc.id))
			if !reflect.DeepEqual(info, tc.want) {
				t.Errorf("WorkflowInfo\n got %+v\nwant %+v", info, tc.want)
			}
			if len(members) != len(tc.members) {
				t.Fatalf("%d members, want %d: %+v", len(members), len(tc.members), members)
			}
			for i := range members {
				if members[i] != tc.members[i] {
					t.Errorf("member %d\n got %+v\nwant %+v", i, members[i], tc.members[i])
				}
			}
		})
	}
}

// A run file read mid-write fails to parse, and the run keeps what it last
// parsed rather than going blank until the next read.
func TestWorkflowKeepsLastGoodRunFile(t *testing.T) {
	const session, id = "testdata/agents", "wf_3b9d27f4-a16"
	w := openWorkflow(t, session, id)
	agents := runAgents(t, session, id)
	before, _ := w.Merge(agents)

	whole := []byte(mustRead(t, w.RunPath()))
	if err := w.SetRunFile(whole[:len(whole)-40]); err == nil {
		t.Fatal("SetRunFile took a truncated run file")
	}
	after, _ := w.Merge(agents)
	if !reflect.DeepEqual(after, before) || w.Running() {
		t.Errorf("after a bad read: running %v, %+v\nwant %+v", w.Running(), after, before)
	}
}

// A run's life on disk, one write at a time: the journal grows (a line still
// being written is left for the next poll), members appear as they start and
// end, and the run file lands only when the run is over.
func TestWorkflowFollowsARun(t *testing.T) {
	session := t.TempDir()
	const id = "wf_0a1b2c3d-4e5"
	w := NewWorkflow(session, id, LocalReader{})
	if want := filepath.Join(session, "subagents", "workflows", id, "journal.jsonl"); w.JournalPath() != want {
		t.Fatalf("JournalPath = %q, want %q", w.JournalPath(), want)
	}
	if want := filepath.Join(session, "workflows", id+".json"); w.RunPath() != want {
		t.Fatalf("RunPath = %q, want %q", w.RunPath(), want)
	}

	merge := func() (WorkflowInfo, map[string]AgentInfo) {
		t.Helper()
		info, members := w.Merge(nil)
		byID := map[string]AgentInfo{}
		for _, m := range members {
			byID[m.ID] = m
		}
		return info, byID
	}
	poll := func(wantChanged bool) {
		t.Helper()
		changed, err := w.PollJournal()
		if err != nil {
			t.Fatalf("PollJournal: %v", err)
		}
		if changed != wantChanged {
			t.Fatalf("PollJournal changed = %v, want %v", changed, wantChanged)
		}
	}

	// Launched, nothing written yet.
	if _, err := w.PollJournal(); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("PollJournal before the journal exists = %v, want not-exist", err)
	}
	if info, members := merge(); !w.Running() || info.State != WorkflowRunning || len(members) != 0 || info.ID != id {
		t.Fatalf("before anything: running %v, %+v, %v", w.Running(), info, members)
	}

	journal := w.JournalPath()
	if err := os.MkdirAll(filepath.Dir(journal), 0o755); err != nil {
		t.Fatal(err)
	}
	second := journalStarted("k2", "a2", "review", "Review")
	appendTo(t, journal, `{"type":"launched"}`+"\n"+journalStarted("k1", "a1", "plan", "Plan")+"\n"+second[:20])
	poll(true)
	info, members := merge()
	if len(members) != 1 || members["a1"].State != AgentRunning || members["a1"].PhaseIndex != 1 || members["a1"].Label != "plan" {
		t.Fatalf("after the first start: %+v", members)
	}
	if !reflect.DeepEqual(info.Phases, []WorkflowPhase{{Index: 1, Title: "Plan"}}) || info.CurrentPhase != 1 {
		t.Errorf("phases after the first start: %+v, current %d", info.Phases, info.CurrentPhase)
	}

	appendTo(t, journal, second[20:]+"\n")
	poll(true)
	poll(false)
	appendTo(t, journal, `{"type":"result","key":"k1","agentId":"a1","result":"Two reviewers."}`+"\n")
	poll(true)
	info, members = merge()
	if members["a1"].State != AgentDone || members["a1"].Result != "Two reviewers." || members["a2"].State != AgentRunning {
		t.Errorf("after the first result: %+v", members)
	}
	if info.CurrentPhase != 2 || len(info.Phases) != 2 || !w.Running() {
		t.Errorf("after the first result: running %v, %+v", w.Running(), info)
	}

	// The run ends and its run file lands.
	run := `{"runId":"` + id + `","workflowName":"review","summary":"Review it","status":"completed","startTime":1790000000000,"durationMs":60000,` +
		`"phases":[{"title":"Plan","detail":"p"},{"title":"Review","detail":"r"}],"agentCount":2,"totalTokens":900,"totalToolCalls":4,` +
		`"workflowProgress":[{"type":"workflow_agent","index":1,"label":"plan","phaseIndex":1,"phaseTitle":"Plan","agentId":"a1","state":"done","startedAt":1790000000100,"lastProgressAt":1790000030000,"durationMs":29900,"toolCalls":1,"resultPreview":"Two reviewers."},` +
		`{"type":"workflow_agent","index":2,"label":"review","phaseIndex":2,"phaseTitle":"Review","agentId":"a2","state":"done","startedAt":1790000030100,"lastProgressAt":1790000059000,"durationMs":28900,"toolCalls":3,"resultPreview":"Fine."}]}`
	if err := w.SetRunFile([]byte(run)); err != nil {
		t.Fatal(err)
	}
	info, members = merge()
	if w.Running() || info.State != WorkflowDone || info.Name != "review" || info.EndedAt != 1790000060000 || info.Phases[1].Detail != "r" {
		t.Errorf("after the run file: running %v, %+v", w.Running(), info)
	}
	if members["a2"].State != AgentDone || members["a2"].Result != "Fine." || members["a2"].EndedAt != 1790000059000 {
		t.Errorf("after the run file: %+v", members["a2"])
	}
}

// Claude Code writes a run's script when it launches the run, and the run file
// only when the run is over. So mid-run the script's meta is the one record of
// the run's name, its description and its phases, the ones not started yet
// included; the journal and the members still say where the run is. Once the
// run file lands it is the authority again, as it is for everything else.
func TestWorkflowScriptDescribesARunBeforeItsRunFile(t *testing.T) {
	session := t.TempDir()
	const id = "wf_1a2b3c4d-5e6"
	w := NewWorkflow(session, id, LocalReader{})
	script := `export const meta = {
  name: 'check-change',
  description: 'Check the change before it lands',
  phases: [
    { title: 'Survey', detail: 'read the diff' },
    { title: 'Check', detail: 'three checkers in parallel' },
    { title: 'Land' },
  ],
}
`
	if !w.SetScript([]byte(script)) {
		t.Fatal("SetScript found no meta")
	}
	declared := []WorkflowPhase{
		{Index: 1, Title: "Survey", Detail: "read the diff"},
		{Index: 2, Title: "Check", Detail: "three checkers in parallel"},
		{Index: 3, Title: "Land"},
	}

	// Launched: nothing has started, and every phase is still to come.
	info, members := w.Merge(nil)
	want := WorkflowInfo{ID: id, Name: "check-change", Summary: "Check the change before it lands", State: WorkflowRunning, Phases: declared}
	if !w.Running() || !reflect.DeepEqual(info, want) || len(members) != 0 {
		t.Fatalf("launched: running %v, %d members\n got %+v\nwant %+v", w.Running(), len(members), info, want)
	}

	// A member of the second phase starts first. Its phase keeps the script's
	// number rather than the order the journal happens to name phases in.
	if err := os.MkdirAll(filepath.Dir(w.JournalPath()), 0o755); err != nil {
		t.Fatal(err)
	}
	appendTo(t, w.JournalPath(), `{"type":"launched"}`+"\n"+journalStarted("k1", "a1", "check:bugs", "Check")+"\n")
	if _, err := w.PollJournal(); err != nil {
		t.Fatal(err)
	}
	info, members = w.Merge(nil)
	if len(members) != 1 || members[0].PhaseIndex != 2 || info.CurrentPhase != 2 || !reflect.DeepEqual(info.Phases, declared) {
		t.Fatalf("after a phase 2 start: current %d, phases %+v, members %+v", info.CurrentPhase, info.Phases, members)
	}

	// A phase the script never declared still gets a place, after its own.
	appendTo(t, w.JournalPath(), journalStarted("k2", "a2", "retry", "Retry")+"\n")
	if _, err := w.PollJournal(); err != nil {
		t.Fatal(err)
	}
	info, members = w.Merge(nil)
	if n := len(info.Phases); n != 4 || info.Phases[3] != (WorkflowPhase{Index: 4, Title: "Retry"}) || members[1].PhaseIndex != 4 {
		t.Fatalf("an undeclared phase: %+v, members %+v", info.Phases, members)
	}

	// A script read again that no longer parses, caught mid-rewrite, changes
	// nothing: the last one read stands.
	if w.SetScript([]byte(script[:40])) {
		t.Fatal("SetScript took a script cut off mid-literal")
	}
	if again, _ := w.Merge(nil); !reflect.DeepEqual(again, info) {
		t.Fatalf("a bad read changed the run\n got %+v\nwant %+v", again, info)
	}

	// The run file lands, and where it names things its words stand.
	run := `{"runId":"` + id + `","workflowName":"check-change-2","summary":"Checked and landed","status":"completed","startTime":1790000000000,"durationMs":60000,` +
		`"phases":[{"title":"Survey","detail":"s"},{"title":"Check","detail":"c"},{"title":"Retry","detail":"r"}],"agentCount":2,"totalTokens":900,"totalToolCalls":4,` +
		`"workflowProgress":[{"type":"workflow_agent","index":1,"label":"check:bugs","phaseIndex":2,"phaseTitle":"Check","agentId":"a1","state":"done","startedAt":1790000000100,"lastProgressAt":1790000030000,"durationMs":29900,"toolCalls":1,"resultPreview":"Fine."},` +
		`{"type":"workflow_agent","index":2,"label":"retry","phaseIndex":3,"phaseTitle":"Retry","agentId":"a2","state":"done","startedAt":1790000030100,"lastProgressAt":1790000059000,"durationMs":28900,"toolCalls":3,"resultPreview":"Fine."}]}`
	if err := w.SetRunFile([]byte(run)); err != nil {
		t.Fatal(err)
	}
	info, _ = w.Merge(nil)
	wantPhases := []WorkflowPhase{{Index: 1, Title: "Survey", Detail: "s"}, {Index: 2, Title: "Check", Detail: "c"}, {Index: 3, Title: "Retry", Detail: "r"}}
	if w.Running() || info.Name != "check-change-2" || info.Summary != "Checked and landed" || !reflect.DeepEqual(info.Phases, wantPhases) {
		t.Fatalf("after the run file: running %v, %+v", w.Running(), info)
	}

	// A run file that names nothing leaves the script's words in place.
	bare := `{"runId":"` + id + `","status":"completed","startTime":1790000000000,"durationMs":60000,"workflowProgress":[` +
		`{"type":"workflow_agent","index":1,"agentId":"a1","state":"done"},{"type":"workflow_agent","index":2,"agentId":"a2","state":"done"}]}`
	if err := w.SetRunFile([]byte(bare)); err != nil {
		t.Fatal(err)
	}
	info, _ = w.Merge(nil)
	if w.Running() || info.Name != "check-change" || info.Summary != "Check the change before it lands" || !reflect.DeepEqual(info.Phases[:3], declared) {
		t.Fatalf("a run file with no name or phases: running %v, %+v", w.Running(), info)
	}
}

// A resumed run keeps its run id, and the previous attempt's run file stays on
// disk while the new attempt runs. The journal is what says a new attempt has
// started: it names agents after the last one that file lists. Until the new
// attempt's own run file lands, the run is running; its members are the ones
// the old file saw finish (replayed from the journal) and the new attempt's
// starts, not the agents the old attempt's kill cut off.
func TestWorkflowResumedRun(t *testing.T) {
	session := t.TempDir()
	const id = "wf_9e8d7c6b-5a4"
	w := NewWorkflow(session, id, LocalReader{})
	if err := os.MkdirAll(filepath.Dir(w.JournalPath()), 0o755); err != nil {
		t.Fatal(err)
	}
	stale := `{"runId":"` + id + `","workflowName":"fix","summary":"Fix it","status":"killed","error":"Error: Workflow aborted","startTime":1790000000000,"durationMs":600000,` +
		`"phases":[{"title":"Build","detail":"b"},{"title":"Review","detail":"r"}],"agentCount":2,"totalTokens":500,"totalToolCalls":9,` +
		`"workflowProgress":[{"type":"workflow_agent","index":1,"label":"build:server","phaseIndex":1,"phaseTitle":"Build","agentId":"a1","state":"done","startedAt":1790000000100,"lastProgressAt":1790000300000,"durationMs":299900,"toolCalls":5,"resultPreview":"Server done."},` +
		`{"type":"workflow_agent","index":2,"label":"build:card","phaseIndex":1,"phaseTitle":"Build","agentId":"a2","state":"progress","startedAt":1790000000200,"lastProgressAt":1790000500000,"toolCalls":4}]}`
	if err := w.SetRunFile([]byte(stale)); err != nil {
		t.Fatal(err)
	}
	appendTo(t, w.JournalPath(), strings.Join([]string{
		`{"type":"launched"}`,
		journalStarted("k1", "a1", "build:server", "Build"),
		journalStarted("k2", "a2", "build:card", "Build"),
		`{"type":"result","key":"k1","agentId":"a1","result":{"ok":true}}`,
	}, "\n")+"\n")
	if _, err := w.PollJournal(); err != nil {
		t.Fatal(err)
	}
	if w.Running() {
		t.Fatal("the killed attempt's run file, with nothing after it, reads as running")
	}

	// The operator resumes: a2's work is started again as a3, and review
	// starts beside it.
	appendTo(t, w.JournalPath(), journalStarted("k2", "a3", "build:card", "Build")+"\n"+journalStarted("k4", "a4", "review", "Review")+"\n")
	if _, err := w.PollJournal(); err != nil {
		t.Fatal(err)
	}
	agents := []RunAgent{
		{Info: AgentInfo{ID: "a1", Description: "build:server", WorkflowID: id, State: AgentDone, StartedAt: 1790000000100, LastActivityAt: 1790000300000, EndedAt: 1790000300000, ToolCalls: 5, Result: `{"ok":true}`}, Phase: "Build"},
		{Info: AgentInfo{ID: "a2", Description: "build:card", WorkflowID: id, State: AgentFailed, StartedAt: 1790000000200, LastActivityAt: 1790000600000, EndedAt: 1790000600000, ToolCalls: 4, Result: "[Request interrupted by user]"}, Phase: "Build"},
		{Info: AgentInfo{ID: "a3", Description: "build:card", WorkflowID: id, State: AgentRunning, StartedAt: 1790000900000, LastActivityAt: 1790000950000, Tool: "Edit", ToolCalls: 2}, Phase: "Build"},
		{Info: AgentInfo{ID: "a4", Description: "review", WorkflowID: id, State: AgentRunning, StartedAt: 1790000900100, LastActivityAt: 1790000940000, Tool: "Read", ToolCalls: 1}, Phase: "Review"},
	}
	if !w.Running() {
		t.Fatal("a resumed run reads as over")
	}
	info, members := w.Merge(agents)
	want := WorkflowInfo{
		ID: id, Name: "fix", Summary: "Fix it", State: WorkflowRunning, StartedAt: 1790000900000,
		Phases:       []WorkflowPhase{{Index: 1, Title: "Build", Detail: "b"}, {Index: 2, Title: "Review", Detail: "r"}},
		CurrentPhase: 2, AgentCount: 3, ToolCalls: 3,
	}
	if !reflect.DeepEqual(info, want) {
		t.Errorf("resumed\n got %+v\nwant %+v", info, want)
	}
	var ids []string
	for _, m := range members {
		ids = append(ids, fmt.Sprintf("%s:%s:%d", m.ID, m.State, m.PhaseIndex))
	}
	if got := strings.Join(ids, " "); got != "a1:done:1 a3:running:1 a4:running:2" {
		t.Errorf("resumed members = %s", got)
	}

	// The new attempt ends: its own run file replaces the old one.
	done := `{"runId":"` + id + `","workflowName":"fix","summary":"Fix it","status":"completed","startTime":1790000900000,"durationMs":100000,` +
		`"phases":[{"title":"Build","detail":"b"},{"title":"Review","detail":"r"}],"agentCount":3,"totalTokens":700,"totalToolCalls":6,` +
		`"workflowProgress":[{"type":"workflow_agent","index":1,"label":"build:server","phaseIndex":1,"phaseTitle":"Build","agentId":"a1","state":"done","startedAt":1790000900010,"lastProgressAt":1790000900010,"cached":true,"resultPreview":"{\"ok\":true}"},` +
		`{"type":"workflow_agent","index":2,"label":"build:card","phaseIndex":1,"phaseTitle":"Build","agentId":"a3","state":"done","startedAt":1790000900000,"lastProgressAt":1790000990000,"durationMs":90000,"toolCalls":4,"resultPreview":"Card done."},` +
		`{"type":"workflow_agent","index":3,"label":"review","phaseIndex":2,"phaseTitle":"Review","agentId":"a4","state":"done","startedAt":1790000900100,"lastProgressAt":1790000995000,"durationMs":94900,"toolCalls":2,"resultPreview":"Fine."}]}`
	if err := w.SetRunFile([]byte(done)); err != nil {
		t.Fatal(err)
	}
	if w.Running() {
		t.Fatal("the new attempt's run file reads as running")
	}
	info, members = w.Merge(agents)
	ids = ids[:0]
	for _, m := range members {
		ids = append(ids, fmt.Sprintf("%s:%s", m.ID, m.State))
	}
	if got := strings.Join(ids, " "); info.State != WorkflowDone || got != "a1:done a3:done a4:done" {
		t.Errorf("after the new run file: %s, members %s", info.State, got)
	}
}

// Which of a member's sources decides its state. The transcript is the live
// source, but the run file is written after every member has stopped, so where
// it says a member finished it has; the journal says the same for a run still
// going. A member of a run that is over and still reads as running was cut off
// with the run: its state is left as its sources say, and its end is the run's.
func TestWorkflowMemberState(t *testing.T) {
	const id = "wf_1"
	killedRun := func(member string) string {
		return `{"runId":"wf_1","status":"killed","startTime":1000,"durationMs":9000,"workflowProgress":[` + member + `]}`
	}
	for _, tc := range []struct {
		name    string
		run     string // "" = no run file
		journal []string
		agent   *AgentInfo
		phase   string // the agent's sidecar phase
		want    AgentInfo
	}{
		{"the run file says done: done, whatever the transcript has reached",
			`{"runId":"wf_1","status":"completed","startTime":1000,"durationMs":9000,"workflowProgress":[{"type":"workflow_agent","index":1,"label":"x","agentId":"a1","state":"done","startedAt":1100,"lastProgressAt":5000,"durationMs":3900,"resultPreview":"ok"}]}`,
			nil, &AgentInfo{ID: "a1", State: AgentRunning, StartedAt: 1100, LastActivityAt: 4000, Tool: "Read", ToolCalls: 2}, "",
			AgentInfo{ID: "a1", WorkflowID: id, Label: "x", State: AgentDone, StartedAt: 1100, LastActivityAt: 4000, EndedAt: 5000, Tool: "Read", ToolCalls: 2, Result: "ok"}},
		{"the run file says error: failed, with the run's reason",
			`{"runId":"wf_1","status":"completed","startTime":1000,"durationMs":9000,"workflowProgress":[{"type":"workflow_agent","index":1,"agentId":"a1","state":"error","startedAt":1100,"lastProgressAt":5000,"error":"agent({schema}): StructuredOutput retry cap (5) exceeded"}]}`,
			nil, &AgentInfo{ID: "a1", State: AgentRunning, StartedAt: 1100, LastActivityAt: 4000}, "",
			AgentInfo{ID: "a1", WorkflowID: id, State: AgentFailed, StartedAt: 1100, LastActivityAt: 4000, EndedAt: 5000, Result: "agent({schema}): StructuredOutput retry cap (5) exceeded"}},
		{"cut off by a kill, transcript silent since: running, ended with the run",
			killedRun(`{"type":"workflow_agent","index":1,"agentId":"a1","state":"progress","startedAt":1100,"lastProgressAt":5000}`),
			nil, &AgentInfo{ID: "a1", State: AgentRunning, StartedAt: 1100, LastActivityAt: 4000, Tool: "Bash"}, "",
			AgentInfo{ID: "a1", WorkflowID: id, State: AgentRunning, StartedAt: 1100, LastActivityAt: 4000, EndedAt: 10000, Tool: "Bash"}},
		{"cut off by a kill, no transcript: the run file's figures",
			killedRun(`{"type":"workflow_agent","index":1,"label":"x","phaseIndex":2,"phaseTitle":"B","agentId":"a1","model":"claude-opus-5-5","agentType":"Explore","state":"progress","startedAt":1100,"lastProgressAt":5000,"lastToolName":"Bash","lastToolSummary":"go test\n./...","tokens":99999,"toolCalls":7}`),
			nil, nil, "",
			AgentInfo{ID: "a1", AgentType: "Explore", Model: "claude-opus-5-5", WorkflowID: id, PhaseIndex: 2, Label: "x", State: AgentRunning, StartedAt: 1100, LastActivityAt: 5000, EndedAt: 10000, Tool: "Bash", ToolDetail: "go test ./...", ToolCalls: 7}},
		{"queued when the run was killed: no agent yet, so no agent id",
			killedRun(`{"type":"workflow_agent","index":4,"label":"later","state":"start","queuedAt":2000,"lastProgressAt":2000}`),
			nil, nil, "",
			AgentInfo{ID: "wf_1#4", WorkflowID: id, Label: "later", State: AgentQueued, LastActivityAt: 2000, EndedAt: 10000}},
		{"blocked before it started",
			`{"runId":"wf_1","status":"completed","startTime":1000,"durationMs":9000,"workflowProgress":[{"type":"workflow_agent","index":2,"label":"risky","state":"error","blocked":true,"error":"[risky] blocked by safety classifier: no","queuedAt":2000,"lastProgressAt":2100}]}`,
			nil, nil, "",
			AgentInfo{ID: "wf_1#2", WorkflowID: id, Label: "risky", State: AgentFailed, LastActivityAt: 2100, EndedAt: 2100, Result: "[risky] blocked by safety classifier: no"}},
		{"the journal has its result before the transcript shows the end",
			"", []string{journalStarted("k1", "a1", "x", "A"), `{"type":"result","key":"k1","agentId":"a1","result":{"ok":true,"n":2}}`},
			&AgentInfo{ID: "a1", State: AgentRunning, StartedAt: 1100, LastActivityAt: 4000}, "A",
			AgentInfo{ID: "a1", WorkflowID: id, PhaseIndex: 1, Label: "x", State: AgentDone, StartedAt: 1100, LastActivityAt: 4000, EndedAt: 4000, Result: `{"ok":true,"n":2}`}},
		{"the journal says it failed",
			"", []string{journalStarted("k1", "a1", "x", "A"), `{"type":"failed","key":"k1","agentId":"a1"}`},
			&AgentInfo{ID: "a1", State: AgentRunning, StartedAt: 1100, LastActivityAt: 4000}, "A",
			AgentInfo{ID: "a1", WorkflowID: id, PhaseIndex: 1, Label: "x", State: AgentFailed, StartedAt: 1100, LastActivityAt: 4000, EndedAt: 4000}},
		{"started, transcript not opened yet",
			"", []string{journalStarted("k1", "a1", "x", "A")}, nil, "",
			AgentInfo{ID: "a1", WorkflowID: id, PhaseIndex: 1, Label: "x", State: AgentRunning}},
		{"a result with no agent id is the latest start of its key",
			"", []string{journalStarted("k1", "a0", "x", "A"), journalStarted("k1", "a1", "x", "A"), `{"type":"result","key":"k1","agentId":"","result":"Short\nanswer."}`}, nil, "",
			AgentInfo{ID: "a1", WorkflowID: id, PhaseIndex: 1, Label: "x", State: AgentDone, Result: "Short answer."}},
		{"a transcript the journal has not named yet: its sidecar's label and phase",
			"", nil, &AgentInfo{ID: "a1", Description: "x", State: AgentRunning, StartedAt: 1100, LastActivityAt: 4000}, "A",
			AgentInfo{ID: "a1", Description: "x", WorkflowID: id, PhaseIndex: 1, Label: "x", State: AgentRunning, StartedAt: 1100, LastActivityAt: 4000}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			session := t.TempDir()
			w := NewWorkflow(session, id, LocalReader{})
			if tc.run != "" {
				if err := w.SetRunFile([]byte(tc.run)); err != nil {
					t.Fatal(err)
				}
			}
			if len(tc.journal) > 0 {
				if err := os.MkdirAll(filepath.Dir(w.JournalPath()), 0o755); err != nil {
					t.Fatal(err)
				}
				appendTo(t, w.JournalPath(), strings.Join(tc.journal, "\n")+"\n")
				if _, err := w.PollJournal(); err != nil {
					t.Fatal(err)
				}
			}
			var agents []RunAgent
			if tc.agent != nil {
				agents = append(agents, RunAgent{Info: *tc.agent, Phase: tc.phase})
			}
			_, members := w.Merge(agents)
			if len(members) != 1 {
				t.Fatalf("%d members, want 1: %+v", len(members), members)
			}
			if members[0] != tc.want {
				t.Errorf("member\n got %+v\nwant %+v", members[0], tc.want)
			}
		})
	}
}

// The phase a run is in: the highest one with a member running, else the
// highest one any member has started in.
func TestWorkflowCurrentPhase(t *testing.T) {
	for _, tc := range []struct {
		name    string
		members []AgentInfo
		want    int
	}{
		{"nothing started", nil, 0},
		{"a running member wins over a later finished one",
			[]AgentInfo{{PhaseIndex: 1, State: AgentRunning}, {PhaseIndex: 3, State: AgentDone}}, 1},
		{"the highest running phase", []AgentInfo{{PhaseIndex: 2, State: AgentRunning}, {PhaseIndex: 1, State: AgentRunning}}, 2},
		{"all ended: the highest started", []AgentInfo{{PhaseIndex: 2, State: AgentFailed}, {PhaseIndex: 1, State: AgentDone}}, 2},
		{"queued members have not started", []AgentInfo{{PhaseIndex: 1, State: AgentDone}, {PhaseIndex: 2, State: AgentQueued}}, 1},
	} {
		if got := currentPhase(tc.members); got != tc.want {
			t.Errorf("%s: currentPhase = %d, want %d", tc.name, got, tc.want)
		}
	}
}

func journalStarted(key, agentID, label, phase string) string {
	return fmt.Sprintf(`{"type":"started","key":%q,"agentId":%q,"label":%q,"phase":%q}`, key, agentID, label, phase)
}
