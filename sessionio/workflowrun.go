package sessionio

import (
	"encoding/json"
	"errors"
	"sort"
)

// workflowRun is a Workflow run as its run file records it:
// workflows/wf_<runId>.json beside the session's subagents/ directory.
//
// Claude Code writes that file once, when the run is over (completed, failed
// or killed), as a plain in-place write rather than a rename. Measured against
// Claude Code 2.1.281, which has one writer for it and calls it only after the
// run's script returns. So a run that is still going has no run file, and a
// resumed run keeps its previous attempt's file until the new attempt ends. See
// Workflow for how a live run is read without one.
type workflowRun struct {
	ID         string // runId, "wf_<runId>"
	Name       string // workflowName
	Summary    string
	Status     string // as written: "completed", "failed" or "killed"
	Error      string // why a killed or failed run stopped
	StartedAt  int64  // startTime, ms epoch
	EndedAt    int64  // startTime plus durationMs, else when the file was written
	Phases     []WorkflowPhase
	AgentCount int   // the highest member index the run started
	Tokens     int64 // totalTokens: the members' token counts summed (see workflowMember.Tokens)
	ToolCalls  int   // totalToolCalls
	Members    []workflowMember
}

// workflowMember is one agent a run started or queued, from the run file's
// workflowProgress. A member that never started has no agent yet, so no
// AgentID: one still queued when the run was killed, or one a safety check
// blocked.
type workflowMember struct {
	AgentID         string
	Index           int // the run's own numbering, from 1
	Label           string
	PhaseIndex      int // from 1, matching the run's phases
	PhaseTitle      string
	AgentType       string
	Model           string
	State           string // "start" (queued), "progress", "done" or "error"
	StartedAt       int64
	LastProgressAt  int64
	DurationMs      int64
	LastToolName    string
	LastToolSummary string
	// Tokens is the size of the agent's context at its latest message, which
	// is how Claude Code counts it, not the output tokens the panel shows:
	// 300,441 for a member whose transcript sums to 91,648 output tokens.
	Tokens        int64
	ToolCalls     int
	ResultPreview string
	Error         string
	// Cached marks a member a resumed run replayed from its journal instead of
	// running again. Its times are the resume's, and it carries no counts.
	Cached bool
}

// parseWorkflowRun decodes a run file field by field, so one field of an
// unexpected type costs only itself. It fails only when the bytes are not a
// whole JSON object, which is what a file read mid-write looks like; the caller
// keeps the run it had and reads again.
func parseWorkflowRun(b []byte) (workflowRun, error) {
	var f jsonFields
	if err := json.Unmarshal(b, &f); err != nil {
		return workflowRun{}, err
	}
	if f == nil {
		return workflowRun{}, errors.New("workflow run: not a JSON object")
	}
	r := workflowRun{
		ID:         f.str("runId"),
		Name:       f.str("workflowName"),
		Summary:    f.str("summary"),
		Status:     f.str("status"),
		Error:      f.str("error"),
		StartedAt:  f.num("startTime"),
		AgentCount: int(f.num("agentCount")),
		Tokens:     f.num("totalTokens"),
		ToolCalls:  int(f.num("totalToolCalls")),
	}
	if d := f.num("durationMs"); r.StartedAt > 0 && d > 0 {
		r.EndedAt = r.StartedAt + d
	} else {
		r.EndedAt = parseAt(f.str("timestamp"))
	}

	var phases []jsonFields
	_ = json.Unmarshal(f["phases"], &phases)
	for i, p := range phases {
		r.Phases = append(r.Phases, WorkflowPhase{Index: i + 1, Title: p.str("title"), Detail: p.str("detail")})
	}

	var progress []json.RawMessage
	_ = json.Unmarshal(f["workflowProgress"], &progress)
	var markers []WorkflowPhase
	for _, raw := range progress {
		var e jsonFields
		if json.Unmarshal(raw, &e) != nil || e == nil {
			continue
		}
		switch e.str("type") {
		case "workflow_phase":
			markers = append(markers, WorkflowPhase{Index: int(e.num("index")), Title: e.str("title")})
		case "workflow_agent":
			r.Members = append(r.Members, workflowMember{
				AgentID:         e.str("agentId"),
				Index:           int(e.num("index")),
				Label:           e.str("label"),
				PhaseIndex:      int(e.num("phaseIndex")),
				PhaseTitle:      e.str("phaseTitle"),
				AgentType:       e.str("agentType"),
				Model:           e.str("model"),
				State:           e.str("state"),
				StartedAt:       e.num("startedAt"),
				LastProgressAt:  e.num("lastProgressAt"),
				DurationMs:      e.num("durationMs"),
				LastToolName:    e.str("lastToolName"),
				LastToolSummary: e.str("lastToolSummary"),
				Tokens:          e.num("tokens"),
				ToolCalls:       int(e.num("toolCalls")),
				ResultPreview:   e.str("resultPreview"),
				Error:           e.str("error"),
				Cached:          e.flag("cached"),
			})
		}
	}
	// A script that declares no phases up front still marks each one as it
	// enters it. Over the 151 run files on this box, the two always agreed
	// where both were present.
	if len(r.Phases) == 0 && len(markers) > 0 {
		sort.SliceStable(markers, func(i, j int) bool { return markers[i].Index < markers[j].Index })
		r.Phases = markers
	}
	return r, nil
}

// state maps the run file's status onto the panel's. A missing or unfamiliar
// status reads the way the CLI's own reader takes it: failed when the file
// carries an error, done otherwise. "paused" is how the CLI shows a run
// restored from disk that can be resumed; nothing in it is running, and a
// resume shows up as a new attempt.
func (r workflowRun) state() WorkflowState {
	switch r.Status {
	case "completed":
		return WorkflowDone
	case "failed":
		return WorkflowFailed
	case "killed", "paused":
		return WorkflowKilled
	case "running":
		return WorkflowRunning
	}
	if r.Error != "" {
		return WorkflowFailed
	}
	return WorkflowDone
}

// jsonFields is a JSON object read one field at a time. A field that is
// absent or of another type reads as its zero value.
type jsonFields map[string]json.RawMessage

func (f jsonFields) str(k string) string {
	var s string
	_ = json.Unmarshal(f[k], &s)
	return s
}

func (f jsonFields) num(k string) int64 {
	var n float64 // a JSON number, even one written with a fraction
	_ = json.Unmarshal(f[k], &n)
	return int64(n)
}

func (f jsonFields) flag(k string) bool {
	var b bool
	_ = json.Unmarshal(f[k], &b)
	return b
}
