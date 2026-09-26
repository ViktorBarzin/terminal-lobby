package sessionio

import (
	"encoding/json"
	"reflect"
	"sort"
	"testing"
)

// The field names are the wire contract the panel builds against (the shared
// context's AgentSet, AgentInfo and WorkflowInfo). A renamed tag would still
// compile on both sides and leave the panel reading undefined, so the names
// are pinned here, one table row per type.
func TestAgentWireFieldNames(t *testing.T) {
	for _, tc := range []struct {
		name  string
		value any
		want  []string
	}{
		{"AgentSet", AgentSet{}, []string{"at", "agents", "workflows"}},
		{"AgentInfo", AgentInfo{}, []string{
			"id", "description", "name", "agentType", "model", "color", "depth",
			"parentId", "toolUseId", "workflowId", "phaseIndex", "label", "state",
			"startedAt", "lastActivityAt", "endedAt", "tool", "toolDetail",
			"toolCalls", "outputTokens", "result",
		}},
		{"WorkflowInfo", WorkflowInfo{}, []string{
			"id", "name", "summary", "state", "startedAt", "endedAt", "phases",
			"currentPhase", "agentCount", "tokens", "toolCalls",
		}},
		{"WorkflowPhase", WorkflowPhase{}, []string{"index", "title", "detail"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b, err := json.Marshal(tc.value)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(b, &fields); err != nil {
				t.Fatalf("unmarshal %s: %v", b, err)
			}
			got := make([]string, 0, len(fields))
			for k := range fields {
				got = append(got, k)
			}
			want := append([]string(nil), tc.want...)
			sort.Strings(got)
			sort.Strings(want)
			if !reflect.DeepEqual(got, want) {
				t.Errorf("%s fields = %v, want %v", tc.name, got, want)
			}
		})
	}
}

// The client treats agents, workflows and phases as arrays. A nil slice
// marshals as null, which would break it on the very first snapshot of a
// session with nothing running, and workflows stays empty until T3 fills it.
func TestAgentWireEmptyListsAreArrays(t *testing.T) {
	for _, tc := range []struct {
		name  string
		value any
		want  string
	}{
		{"empty set", AgentSet{}, `{"at":0,"agents":[],"workflows":[]}`},
		{"set with one agent", AgentSet{At: 5, Agents: []AgentInfo{{ID: "a1", State: AgentRunning}}},
			`{"at":5,"agents":[{"id":"a1","description":"","name":"","agentType":"","model":"","color":"","depth":0,"parentId":"","toolUseId":"","workflowId":"","phaseIndex":0,"label":"","state":"running","startedAt":0,"lastActivityAt":0,"endedAt":0,"tool":"","toolDetail":"","toolCalls":0,"outputTokens":0,"result":""}],"workflows":[]}`},
		{"workflow without phases", WorkflowInfo{ID: "wf_1", State: WorkflowRunning},
			`{"id":"wf_1","name":"","summary":"","state":"running","startedAt":0,"endedAt":0,"phases":[],"currentPhase":0,"agentCount":0,"tokens":0,"toolCalls":0}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b, err := json.Marshal(tc.value)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			if string(b) != tc.want {
				t.Errorf("got  %s\nwant %s", b, tc.want)
			}
		})
	}
}
