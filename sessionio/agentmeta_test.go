package sessionio

import (
	"os"
	"path/filepath"
	"testing"
)

// Sidecars differ by Claude Code version and by how the agent was spawned, and
// every field is optional. The rows are the shapes measured on this box: 2,834
// sidecars, description absent on 1,190 of them, colour only on teammates.
func TestParseAgentMeta(t *testing.T) {
	for _, tc := range []struct {
		name string
		raw  string
		want AgentMeta
	}{
		{"ad-hoc background agent",
			`{"agentType":"general-purpose","description":"Summarise open issues","toolUseId":"toolu_01MAIN","spawnDepth":1,"requestShape":"background","requestNonInteractive":true}`,
			AgentMeta{AgentType: "general-purpose", Description: "Summarise open issues", ToolUseID: "toolu_01MAIN", SpawnDepth: 1}},
		{"teammate, the design doc's sample",
			`{"agentType":"priorart-recon","description":"Find prior art for agent visualization","name":"priorart-recon","spawnDepth":0,"model":"claude-opus-5","taskKind":"in_process_teammate","teamName":"session-408579e1","color":"yellow"}`,
			AgentMeta{AgentType: "priorart-recon", Description: "Find prior art for agent visualization", Name: "priorart-recon", Model: "claude-opus-5", Color: "yellow"}},
		{"workflow member",
			`{"agentType":"workflow-subagent","description":"review:bugs","workflowPhase":"Review","spawnDepth":1,"requestShape":"foreground","requestNonInteractive":false}`,
			AgentMeta{AgentType: "workflow-subagent", Description: "review:bugs", WorkflowPhase: "Review", SpawnDepth: 1}},
		{"nested agent that names its parent",
			`{"agentType":"general-purpose","description":"Angle Altitude","toolUseId":"toolu_01QM","parentAgentId":"a247ac142f2b2ff6d","spawnDepth":2,"model":"opus"}`,
			AgentMeta{AgentType: "general-purpose", Description: "Angle Altitude", ToolUseID: "toolu_01QM", ParentAgentID: "a247ac142f2b2ff6d", SpawnDepth: 2, Model: "opus"}},
		{"stopped by the operator",
			`{"agentType":"general-purpose","spawnDepth":1,"requestShape":"background","requestNonInteractive":true,"stoppedByUser":true}`,
			AgentMeta{AgentType: "general-purpose", SpawnDepth: 1, StoppedByUser: true}},
		{"every field absent", `{}`, AgentMeta{}},
		// One field of an unexpected type must not cost the others.
		{"a field of the wrong type is dropped alone",
			`{"spawnDepth":"2","description":7,"name":"scout","color":null}`,
			AgentMeta{Name: "scout"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseAgentMeta([]byte(tc.raw))
			if err != nil {
				t.Fatalf("ParseAgentMeta: %v", err)
			}
			if got != tc.want {
				t.Errorf("got  %+v\nwant %+v", got, tc.want)
			}
		})
	}
}

// A sidecar read mid-write, or something that is not one, is an error the caller
// can retry on, never a zero identity passed off as real.
func TestParseAgentMetaRejectsWhatIsNotAnObject(t *testing.T) {
	for _, raw := range []string{``, `{"agentType":"gen`, `null`, `[]`, `"agent"`} {
		if got, err := ParseAgentMeta([]byte(raw)); err == nil {
			t.Errorf("ParseAgentMeta(%q) = %+v, want an error", raw, got)
		}
	}
}

func TestAgentFileID(t *testing.T) {
	for _, tc := range []struct {
		path string
		id   string
		ok   bool
	}{
		{"agent-a4f1c2e9b7d3a0001.jsonl", "a4f1c2e9b7d3a0001", true},
		{"/p/s/subagents/workflows/wf_1/agent-a2c4.jsonl", "a2c4", true},
		{"agent-a4f1c2e9b7d3a0001.meta.json", "", false},
		{"agent-.jsonl", "", false},
		{"session.jsonl", "", false},
		{"agent-a4f1.jsonl.tmp", "", false},
	} {
		id, ok := AgentFileID(tc.path)
		if id != tc.id || ok != tc.ok {
			t.Errorf("AgentFileID(%q) = %q, %v; want %q, %v", tc.path, id, ok, tc.id, tc.ok)
		}
	}
}

func TestAgentMetaPath(t *testing.T) {
	got := AgentMetaPath("/p/s/subagents/agent-a4f1.jsonl")
	if want := "/p/s/subagents/agent-a4f1.meta.json"; got != want {
		t.Errorf("AgentMetaPath = %q, want %q", got, want)
	}
}

// The recorded sidecars beside the fixture transcripts parse, which is what
// the tail tests below build on.
func TestAgentMetaFixturesParse(t *testing.T) {
	paths, err := filepath.Glob("testdata/agents/subagents/*.meta.json")
	if err != nil || len(paths) == 0 {
		t.Fatalf("no fixture sidecars: %v", err)
	}
	more, _ := filepath.Glob("testdata/agents/subagents/workflows/*/*.meta.json")
	for _, p := range append(paths, more...) {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		if m, err := ParseAgentMeta(b); err != nil || m.AgentType == "" {
			t.Errorf("%s: %+v, %v", p, m, err)
		}
	}
}
