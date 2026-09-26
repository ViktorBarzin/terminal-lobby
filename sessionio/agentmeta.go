package sessionio

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
)

// AgentMeta is an agent's identity, read from the agent-<id>.meta.json sidecar
// Claude Code writes beside its transcript about two seconds before the first
// record. It names what the transcript never says about itself: who spawned the
// agent, as what, and in which colour.
//
// Every field is optional. Sidecars vary by Claude Code version and by how the
// agent was spawned: measured over 2,834 on this box, description was absent on
// 1,190, and name, colour and model appear only for teammates and agents given
// one. A missing field is "" or 0, never an error.
type AgentMeta struct {
	AgentType   string // "general-purpose", "Explore", "workflow-subagent", or a custom agent's name
	Description string
	Name        string // a teammate's name
	Model       string // as the spawn asked for it: a slug, or an alias such as "opus"
	Color       string // Claude Code's own colour name for the agent
	// ToolUseID is the Agent tool_use block that spawned this agent, in the
	// spawner's transcript: the session's for a top-level agent, another
	// agent's for a nested one.
	ToolUseID string
	// ParentAgentID names the spawning agent directly. Newer versions write it
	// for nested agents; without it the parent is found through ToolUseID.
	ParentAgentID string
	SpawnDepth    int
	WorkflowPhase string // a workflow member's phase title
	// StoppedByUser is written into the sidecar when the operator stops the
	// agent, which can be long after its transcript last grew.
	StoppedByUser bool
	// WrittenAt is the sidecar's modification time, ms epoch. The file's bytes
	// do not carry it, so ParseAgentMeta leaves it 0 and whoever read the file
	// sets it. It stands in for the start time before the first record lands,
	// and dates a stop.
	WrittenAt int64
}

// ParseAgentMeta decodes a sidecar field by field, so one field of an
// unexpected type costs only itself. It fails only when the bytes are not a
// JSON object, which is what a sidecar read mid-write looks like; the caller
// keeps what it had and reads again later.
func ParseAgentMeta(b []byte) (AgentMeta, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(b, &fields); err != nil {
		return AgentMeta{}, err
	}
	if fields == nil {
		return AgentMeta{}, errors.New("agent meta: not a JSON object")
	}
	str := func(k string) string {
		var s string
		_ = json.Unmarshal(fields[k], &s) // absent or not a string: ""
		return s
	}
	var m AgentMeta
	m.AgentType = str("agentType")
	m.Description = str("description")
	m.Name = str("name")
	m.Model = str("model")
	m.Color = str("color")
	m.ToolUseID = str("toolUseId")
	m.ParentAgentID = str("parentAgentId")
	m.WorkflowPhase = str("workflowPhase")
	_ = json.Unmarshal(fields["spawnDepth"], &m.SpawnDepth)
	_ = json.Unmarshal(fields["stoppedByUser"], &m.StoppedByUser)
	return m, nil
}

const (
	agentFilePrefix = "agent-"
	agentFileSuffix = ".jsonl"
	agentMetaSuffix = ".meta.json"
)

// AgentFileID is the agent id an agent-<id>.jsonl transcript is named for. It
// takes a bare name or a path, and ok=false for anything else in the
// directory, the sidecars included.
func AgentFileID(path string) (id string, ok bool) {
	name := filepath.Base(path)
	if !strings.HasPrefix(name, agentFilePrefix) || !strings.HasSuffix(name, agentFileSuffix) {
		return "", false
	}
	id = strings.TrimSuffix(strings.TrimPrefix(name, agentFilePrefix), agentFileSuffix)
	return id, id != ""
}

// AgentMetaPath is the identity sidecar beside an agent transcript.
func AgentMetaPath(transcript string) string {
	return strings.TrimSuffix(transcript, agentFileSuffix) + agentMetaSuffix
}

// workflowOf is the run a workflow member's transcript belongs to, "wf_<runId>",
// read off its subagents/workflows/wf_<runId>/ directory; "" for any other agent.
func workflowOf(transcript string) string {
	dir := filepath.Dir(transcript)
	run := filepath.Base(dir)
	if strings.HasPrefix(run, "wf_") && filepath.Base(filepath.Dir(dir)) == "workflows" {
		return run
	}
	return ""
}
