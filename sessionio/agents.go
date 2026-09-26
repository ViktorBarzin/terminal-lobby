package sessionio

import "encoding/json"

// The agent panel's wire contract: what the `agents` SSE event carries for one
// session (design: docs/plans/2026-09-12-agent-workflow-visualisation-design.md).
//
// A session's subagents never reach its transcript. Each one writes its own
// agent-<id>.jsonl beside a agent-<id>.meta.json identity sidecar under the
// session's subagents/ directory, and a Workflow run adds workflows/wf_<id>.json.
// These types are the snapshot built from those files. The field names are the
// contract the frontend builds against, so a rename is a coordinated change on
// both sides, never a local one.

// AgentState is where one agent is in its life. Nothing here judges liveness:
// an agent silent for minutes is still "running", and the panel shows its last
// activity instead of guessing.
type AgentState string

const (
	AgentQueued  AgentState = "queued"  // a workflow member the run has not started yet
	AgentRunning AgentState = "running" // anything that has not ended, however quiet
	AgentDone    AgentState = "done"    // its last assistant record ended the turn
	AgentFailed  AgentState = "failed"  // its last record is an API error
)

// WorkflowState is a Workflow run's status, mapped from wf_*.json.
type WorkflowState string

const (
	WorkflowRunning WorkflowState = "running"
	WorkflowDone    WorkflowState = "done"
	WorkflowFailed  WorkflowState = "failed"
	WorkflowKilled  WorkflowState = "killed"
)

// AgentSet is one snapshot of a session's concurrent work.
type AgentSet struct {
	At        int64          `json:"at"`        // server clock, ms epoch, when the snapshot was built
	Agents    []AgentInfo    `json:"agents"`    // spawn order: startedAt ascending, then id
	Workflows []WorkflowInfo `json:"workflows"` // start order
}

// MarshalJSON writes empty lists as [] rather than null, because the client
// reads both lists as arrays and a session with nothing running is the common
// snapshot, not an edge case.
func (s AgentSet) MarshalJSON() ([]byte, error) {
	type wire AgentSet // shed the method, keep the tags
	w := wire(s)
	if w.Agents == nil {
		w.Agents = []AgentInfo{}
	}
	if w.Workflows == nil {
		w.Workflows = []WorkflowInfo{}
	}
	return json.Marshal(w)
}

// AgentInfo is one agent: identity from its meta sidecar, live state from its
// own transcript, and for a workflow member, structure from the run file.
// Every string is "" and every number 0 when its source does not carry it.
type AgentInfo struct {
	ID          string     `json:"id"`          // agentId, from the file name agent-<id>.jsonl
	Description string     `json:"description"` // meta.description
	Name        string     `json:"name"`        // meta.name
	AgentType   string     `json:"agentType"`   // meta.agentType
	Model       string     `json:"model"`       // meta.model, else the newest assistant record's message.model
	Color       string     `json:"color"`       // meta.color exactly as Claude Code assigned it
	Depth       int        `json:"depth"`       // meta.spawnDepth
	ParentID    string     `json:"parentId"`    // the agent that spawned this one; "" = the session's main thread
	ToolUseID   string     `json:"toolUseId"`   // meta.toolUseId: the Agent tool_use block that spawned it
	WorkflowID  string     `json:"workflowId"`  // "wf_<runId>" for a workflow member
	PhaseIndex  int        `json:"phaseIndex"`  // a workflow member's phase
	Label       string     `json:"label"`       // a workflow member's label
	State       AgentState `json:"state"`

	StartedAt      int64 `json:"startedAt"`      // ms epoch of the first record, else the meta file's mtime
	LastActivityAt int64 `json:"lastActivityAt"` // ms epoch of the newest record
	EndedAt        int64 `json:"endedAt"`        // ms epoch when the state became done or failed, else 0

	Tool         string `json:"tool"`         // name of the newest tool_use block
	ToolDetail   string `json:"toolDetail"`   // one line from that call's input, at most 120 chars
	ToolCalls    int    `json:"toolCalls"`    // tool_use blocks so far
	OutputTokens int64  `json:"outputTokens"` // summed over distinct message ids, the last record of each winning
	Result       string `json:"result"`       // once ended: at most 200 chars of the final text or error
}

// WorkflowPhase is one phase of a Workflow run, in run order.
type WorkflowPhase struct {
	Index  int    `json:"index"`
	Title  string `json:"title"`
	Detail string `json:"detail"`
}

// WorkflowInfo is one Workflow run. It is read from workflows/wf_<runId>.json
// once the run is over, and from its journal and members' transcripts while it
// is going (see Workflow). Its members are ordinary entries in AgentSet.Agents
// with WorkflowID set.
type WorkflowInfo struct {
	ID           string          `json:"id"` // "wf_<runId>"
	Name         string          `json:"name"`
	Summary      string          `json:"summary"`
	State        WorkflowState   `json:"state"`
	StartedAt    int64           `json:"startedAt"`
	EndedAt      int64           `json:"endedAt"` // 0 while running
	Phases       []WorkflowPhase `json:"phases"`
	CurrentPhase int             `json:"currentPhase"` // highest phase with a running member, else the highest started
	AgentCount   int             `json:"agentCount"`
	Tokens       int64           `json:"tokens"`
	ToolCalls    int             `json:"toolCalls"`
}

// MarshalJSON writes a run with no phases yet as [] rather than null, for the
// same reason as AgentSet.
func (w WorkflowInfo) MarshalJSON() ([]byte, error) {
	type wire WorkflowInfo
	v := wire(w)
	if v.Phases == nil {
		v.Phases = []WorkflowPhase{}
	}
	return json.Marshal(v)
}
