package main

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// args decodes a JSON object the way the rewrite does, numbers kept as
// json.Number, so a table row can be written as the caller would send it.
func args(t *testing.T, s string) map[string]any {
	t.Helper()
	m, err := decodeArgs(json.RawMessage(s))
	if err != nil {
		t.Fatalf("decode %s: %v", s, err)
	}
	return m
}

func TestPinLaunchArgs(t *testing.T) {
	for _, c := range []struct {
		name    string
		pin     callerPin
		in      string
		want    string
		changed []string
	}{
		{
			name: "no pin leaves the call alone",
			in:   `{"title":"x","runtimeMode":"approval-required"}`,
			want: `{"title":"x","runtimeMode":"approval-required"}`,
		},
		{
			name:    "a pinned model is set when the caller sent none",
			pin:     callerPin{Model: "claude-opus-5-5"},
			in:      `{"title":"x"}`,
			want:    `{"title":"x","modelSelection":{"instanceId":"claudeAgent","model":"claude-opus-5-5"}}`,
			changed: []string{"modelSelection"},
		},
		{
			name:    "a pinned model replaces the caller's and keeps its Claude options",
			pin:     callerPin{Model: "claude-opus-5-5"},
			in:      `{"modelSelection":{"instanceId":"claudeAgent","model":"claude-opus-5","options":[{"id":"fastMode","value":true}]}}`,
			want:    `{"modelSelection":{"instanceId":"claudeAgent","model":"claude-opus-5-5","options":[{"id":"fastMode","value":true}]}}`,
			changed: []string{"modelSelection"},
		},
		{
			name:    "a pinned model moves another provider's selection to Claude and drops its options",
			pin:     callerPin{Model: "claude-opus-5-5"},
			in:      `{"modelSelection":{"instanceId":"codex","model":"gpt-5-codex","options":[{"id":"reasoningEffort","value":"high"}]}}`,
			want:    `{"modelSelection":{"instanceId":"claudeAgent","model":"claude-opus-5-5"}}`,
			changed: []string{"modelSelection"},
		},
		{
			name: "a pinned model the caller already chose changes nothing",
			pin:  callerPin{Model: "claude-opus-5-5"},
			in:   `{"modelSelection":{"instanceId":"claudeAgent","model":"claude-opus-5-5"}}`,
			want: `{"modelSelection":{"instanceId":"claudeAgent","model":"claude-opus-5-5"}}`,
		},
		{
			name: "model inherit leaves the caller's choice",
			pin:  callerPin{Model: pinInherit, Effort: pinInherit, PermissionMode: pinInherit},
			in:   `{"modelSelection":{"instanceId":"claudeAgent","model":"claude-fable-5"},"runtimeMode":"auto"}`,
			want: `{"modelSelection":{"instanceId":"claudeAgent","model":"claude-fable-5"},"runtimeMode":"auto"}`,
		},
		{
			name:    "a pinned effort replaces the caller's effort option",
			pin:     callerPin{Effort: "xhigh"},
			in:      `{"modelSelection":{"instanceId":"claudeAgent","model":"m","options":[{"id":"effort","value":"low"},{"id":"fastMode","value":false}]}}`,
			want:    `{"modelSelection":{"instanceId":"claudeAgent","model":"m","options":[{"id":"effort","value":"xhigh"},{"id":"fastMode","value":false}]}}`,
			changed: []string{"modelSelection"},
		},
		{
			name:    "a pinned effort is added to options that have none",
			pin:     callerPin{Effort: "high"},
			in:      `{"modelSelection":{"instanceId":"claudeAgent","model":"m"}}`,
			want:    `{"modelSelection":{"instanceId":"claudeAgent","model":"m","options":[{"id":"effort","value":"high"}]}}`,
			changed: []string{"modelSelection"},
		},
		{
			name:    "a pinned effort is written into the legacy object form",
			pin:     callerPin{Effort: "max"},
			in:      `{"modelSelection":{"instanceId":"claudeAgent","model":"m","options":{"effort":"low","fastMode":true}}}`,
			want:    `{"modelSelection":{"instanceId":"claudeAgent","model":"m","options":{"effort":"max","fastMode":true}}}`,
			changed: []string{"modelSelection"},
		},
		{
			name: "a pinned effort without any model to attach it to is left to T3",
			pin:  callerPin{Effort: "max"},
			in:   `{"title":"x"}`,
			want: `{"title":"x"}`,
		},
		{
			name:    "a pinned model and effort make a whole selection",
			pin:     callerPin{Model: "claude-opus-5-5", Effort: "high"},
			in:      `{}`,
			want:    `{"modelSelection":{"instanceId":"claudeAgent","model":"claude-opus-5-5","options":[{"id":"effort","value":"high"}]}}`,
			changed: []string{"modelSelection"},
		},
		{
			name:    "bypassPermissions is full access",
			pin:     callerPin{PermissionMode: "bypassPermissions"},
			in:      `{"runtimeMode":"approval-required","interactionMode":"plan"}`,
			want:    `{"runtimeMode":"full-access","interactionMode":"default"}`,
			changed: []string{"runtimeMode", "interactionMode"},
		},
		{
			name:    "bypassPermissions is set when the caller sent no mode",
			pin:     callerPin{PermissionMode: "bypassPermissions"},
			in:      `{}`,
			want:    `{"runtimeMode":"full-access","interactionMode":"default"}`,
			changed: []string{"runtimeMode", "interactionMode"},
		},
		{
			name:    "acceptEdits auto-accepts edits",
			pin:     callerPin{PermissionMode: "acceptEdits"},
			in:      `{"runtimeMode":"full-access"}`,
			want:    `{"runtimeMode":"auto-accept-edits","interactionMode":"default"}`,
			changed: []string{"runtimeMode", "interactionMode"},
		},
		{
			name:    "default asks for approval",
			pin:     callerPin{PermissionMode: "default"},
			in:      `{"runtimeMode":"full-access","interactionMode":"default"}`,
			want:    `{"runtimeMode":"approval-required","interactionMode":"default"}`,
			changed: []string{"runtimeMode"},
		},
		{
			name:    "plan asks for approval in plan mode",
			pin:     callerPin{PermissionMode: "plan"},
			in:      `{"runtimeMode":"full-access"}`,
			want:    `{"runtimeMode":"approval-required","interactionMode":"plan"}`,
			changed: []string{"runtimeMode", "interactionMode"},
		},
		{
			name:    "the other fields of the call are untouched, numbers included",
			pin:     callerPin{PermissionMode: "bypassPermissions"},
			in:      `{"projectId":"p1","message":"hi","attachments":[{"n":12345678901234567}],"runtimeMode":"full-access","interactionMode":"default"}`,
			want:    `{"projectId":"p1","message":"hi","attachments":[{"n":12345678901234567}],"runtimeMode":"full-access","interactionMode":"default"}`,
			changed: nil,
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			a := args(t, c.in)
			changed := pinLaunchArgs(a, c.pin)
			got, _ := json.Marshal(a)
			if !jsonEqual(t, got, []byte(c.want)) {
				t.Errorf("args\n got %s\nwant %s", got, c.want)
			}
			if !reflect.DeepEqual(changed, c.changed) {
				t.Errorf("changed %v, want %v", changed, c.changed)
			}
		})
	}
}

func TestCapWaitArgs(t *testing.T) {
	const capMs = 300000
	for _, c := range []struct {
		name    string
		tool    string
		in      string
		want    string
		changed []string
	}{
		{"a short wait is kept", "t3_thread_wait", `{"threadId":"t","timeoutMs":5000}`, `{"threadId":"t","timeoutMs":5000}`, nil},
		{"a long wait is shortened", "t3_thread_wait", `{"threadId":"t","timeoutMs":3600000}`, `{"threadId":"t","timeoutMs":300000}`, []string{"timeoutMs"}},
		{"an open-ended wait gets the cap, since T3's default is ten minutes", "t3_thread_wait", `{"threadId":"t"}`, `{"threadId":"t","timeoutMs":300000}`, []string{"timeoutMs"}},
		{"the background wait too", "t3_background_wait", `{}`, `{"timeoutMs":300000}`, []string{"timeoutMs"}},
		{"any tool's long timeoutMs is shortened", "delegate_task", `{"mode":"wait","timeoutMs":900000}`, `{"mode":"wait","timeoutMs":300000}`, []string{"timeoutMs"}},
		{"a tool with no wait is left alone", "t3_thread_read", `{"threadId":"t"}`, `{"threadId":"t"}`, nil},
		{"a timeoutMs that is not a number is T3's to refuse", "t3_thread_wait", `{"timeoutMs":"soon"}`, `{"timeoutMs":"soon"}`, nil},
	} {
		t.Run(c.name, func(t *testing.T) {
			a := args(t, c.in)
			changed := capWaitArgs(c.tool, a, capMs)
			got, _ := json.Marshal(a)
			if !jsonEqual(t, got, []byte(c.want)) {
				t.Errorf("args\n got %s\nwant %s", got, c.want)
			}
			if !reflect.DeepEqual(changed, c.changed) {
				t.Errorf("changed %v, want %v", changed, c.changed)
			}
		})
	}
}

// The body-level rewrite: only a tools/call is touched, everything else in
// the message survives byte-for-byte in meaning, and a body it cannot read is
// forwarded as it came so T3 states the error.
func TestRewriteMCPBody(t *testing.T) {
	pin := &callerPin{PermissionMode: "bypassPermissions"}
	for _, c := range []struct {
		name    string
		pin     *callerPin
		in      string
		want    string
		changed []string
	}{
		{
			name:    "a launch is pinned",
			pin:     pin,
			in:      `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"t3_thread_launch","arguments":{"title":"x"},"_meta":{"progressToken":1}}}`,
			want:    `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"t3_thread_launch","arguments":{"title":"x","runtimeMode":"full-access","interactionMode":"default"},"_meta":{"progressToken":1}}}`,
			changed: []string{"runtimeMode", "interactionMode"},
		},
		{
			name: "a caller with no pin launches as it asked",
			in:   `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"t3_thread_launch","arguments":{"title":"x"}}}`,
			want: `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"t3_thread_launch","arguments":{"title":"x"}}}`,
		},
		{
			name:    "a launch with no arguments object still gets the pin",
			pin:     pin,
			in:      `{"jsonrpc":"2.0","id":"a","method":"tools/call","params":{"name":"t3_thread_launch"}}`,
			want:    `{"jsonrpc":"2.0","id":"a","method":"tools/call","params":{"name":"t3_thread_launch","arguments":{"runtimeMode":"full-access","interactionMode":"default"}}}`,
			changed: []string{"runtimeMode", "interactionMode"},
		},
		{
			name: "another tool is not pinned",
			pin:  pin,
			in:   `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"t3_thread_send","arguments":{"threadId":"t","message":"hi"}}}`,
			want: `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"t3_thread_send","arguments":{"threadId":"t","message":"hi"}}}`,
		},
		{
			name:    "a wait is capped whoever calls",
			in:      `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"t3_thread_wait","arguments":{"threadId":"t"}}}`,
			want:    `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"t3_thread_wait","arguments":{"threadId":"t","timeoutMs":300000}}}`,
			changed: []string{"timeoutMs"},
		},
		{
			name: "a method other than tools/call is not touched",
			pin:  pin,
			in:   `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`,
			want: `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`,
		},
		{
			name: "arguments that are not an object go to T3 as they came",
			pin:  pin,
			in:   `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"t3_thread_launch","arguments":[1,2]}}`,
			want: `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"t3_thread_launch","arguments":[1,2]}}`,
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			got, changed := rewriteMCPBody([]byte(c.in), c.pin, 300000)
			if !jsonEqual(t, got, []byte(c.want)) {
				t.Errorf("body\n got %s\nwant %s", got, c.want)
			}
			if !reflect.DeepEqual(changed, c.changed) {
				t.Errorf("changed %v, want %v", changed, c.changed)
			}
			if c.changed == nil && string(got) != c.in {
				t.Errorf("an unchanged body was re-encoded: %s", got)
			}
		})
	}
}

func jsonEqual(t *testing.T, a, b []byte) bool {
	t.Helper()
	var x, y any
	da := json.NewDecoder(strings.NewReader(string(a)))
	da.UseNumber()
	db := json.NewDecoder(strings.NewReader(string(b)))
	db.UseNumber()
	if err := da.Decode(&x); err != nil {
		t.Fatalf("decode %s: %v", a, err)
	}
	if err := db.Decode(&y); err != nil {
		t.Fatalf("decode %s: %v", b, err)
	}
	return reflect.DeepEqual(x, y)
}

// On /mcp, "inherit" means the box's own default, read from managed
// settings: a caller pinned that way runs what the box runs, whatever model
// it names. Where the box's default is unknown, inherit forces nothing.
func TestResolveMCPPin(t *testing.T) {
	box := models{Default: "claude-opus-5-5", DefaultEffort: "high"}
	for _, c := range []struct {
		name string
		pin  callerPin
		box  models
		want callerPin
	}{
		{"inherit is the box default", callerPin{Model: pinInherit, Effort: pinInherit, PermissionMode: "bypassPermissions"}, box,
			callerPin{Model: "claude-opus-5-5", Effort: "high", PermissionMode: "bypassPermissions"}},
		{"a named value stays", callerPin{Model: "claude-sonnet-5", Effort: "low"}, box, callerPin{Model: "claude-sonnet-5", Effort: "low"}},
		{"an unpinned field stays unpinned", callerPin{PermissionMode: "plan"}, box, callerPin{PermissionMode: "plan"}},
		{"an unknown box default forces nothing", callerPin{Model: pinInherit, Effort: pinInherit}, models{}, callerPin{}},
		{"permission inherit is left as it is", callerPin{PermissionMode: pinInherit}, box, callerPin{PermissionMode: pinInherit}},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := resolveMCPPin(c.pin, c.box); got != c.want {
				t.Fatalf("got %+v, want %+v", got, c.want)
			}
		})
	}
}

// t3_thread_configure changes a thread's model after launch. Its schema
// (T3 v0.1.5) takes modelSelection only, and without one it is a read, so a
// pin rewrites a selection the caller sent and never adds one.
func TestPinConfigureArgs(t *testing.T) {
	pin := callerPin{Model: "claude-opus-5-5", Effort: "high", PermissionMode: "bypassPermissions"}
	for _, c := range []struct {
		name    string
		pin     callerPin
		in      string
		want    string
		changed []string
	}{
		{"a read stays a read", pin, `{"threadId":"t"}`, `{"threadId":"t"}`, nil},
		{"a model change is pinned", pin,
			`{"threadId":"t","modelSelection":{"instanceId":"claudeAgent","model":"claude-opus-5"}}`,
			`{"threadId":"t","modelSelection":{"instanceId":"claudeAgent","model":"claude-opus-5-5","options":[{"id":"effort","value":"high"}]}}`,
			[]string{"modelSelection"}},
		{"an effort change is pinned", callerPin{Effort: "high"},
			`{"modelSelection":{"instanceId":"claudeAgent","model":"m","options":[{"id":"effort","value":"max"}]}}`,
			`{"modelSelection":{"instanceId":"claudeAgent","model":"m","options":[{"id":"effort","value":"high"}]}}`,
			[]string{"modelSelection"}},
		{"a permission pin adds no mode the tool does not take", callerPin{PermissionMode: "bypassPermissions"},
			`{"modelSelection":{"instanceId":"claudeAgent","model":"m"}}`,
			`{"modelSelection":{"instanceId":"claudeAgent","model":"m"}}`, nil},
	} {
		t.Run(c.name, func(t *testing.T) {
			a := args(t, c.in)
			changed := pinConfigureArgs(a, c.pin)
			got, _ := json.Marshal(a)
			if !jsonEqual(t, got, []byte(c.want)) {
				t.Errorf("args\n got %s\nwant %s", got, c.want)
			}
			if !reflect.DeepEqual(changed, c.changed) {
				t.Errorf("changed %v, want %v", changed, c.changed)
			}
		})
	}
}

func TestRewriteMCPBodyPinsConfigure(t *testing.T) {
	pin := &callerPin{Model: "claude-opus-5-5"}
	in := `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"t3_thread_configure","arguments":{"threadId":"t","modelSelection":{"instanceId":"claudeAgent","model":"claude-opus-5"}}}}`
	got, changed := rewriteMCPBody([]byte(in), pin, 300000)
	want := `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"t3_thread_configure","arguments":{"threadId":"t","modelSelection":{"instanceId":"claudeAgent","model":"claude-opus-5-5"}}}}`
	if !jsonEqual(t, got, []byte(want)) || !reflect.DeepEqual(changed, []string{"modelSelection"}) {
		t.Fatalf("got %s %v", got, changed)
	}
	read := `{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"t3_thread_configure","arguments":{"threadId":"t"}}}`
	if got, changed := rewriteMCPBody([]byte(read), pin, 300000); string(got) != read || changed != nil {
		t.Fatalf("a read was rewritten: %s %v", got, changed)
	}
}

// delegate_task and create_threads (T3 v0.1.5 orchestratorMcp.ts) name the
// model in a `target` {providerInstanceId, driverKind, model, options} and
// take runtimeMode and interactionMode, each of which may also be "inherit".
// A pin replaces all of them, including nothing.
func TestPinTaskArgs(t *testing.T) {
	full := callerPin{Model: "claude-opus-5-5", Effort: "high", PermissionMode: "bypassPermissions"}
	for _, c := range []struct {
		name    string
		pin     callerPin
		in      string
		want    string
		changed []string
	}{
		{"no pin leaves the call alone", callerPin{},
			`{"task":"x","target":{"model":"claude-fable-5"},"runtimeMode":"approval-required"}`,
			`{"task":"x","target":{"model":"claude-fable-5"},"runtimeMode":"approval-required"}`, nil},
		{"a pin fills a call that named nothing", full, `{"task":"x"}`,
			`{"task":"x","target":{"providerInstanceId":"claudeAgent","model":"claude-opus-5-5","options":[{"id":"effort","value":"high"}]},"runtimeMode":"full-access","interactionMode":"default"}`,
			[]string{"target", "runtimeMode", "interactionMode"}},
		{"another provider's target moves to Claude and loses its options", callerPin{Model: "claude-opus-5-5"},
			`{"target":{"driverKind":"codex","model":"gpt-5-codex","options":{"reasoningEffort":"high"},"projectId":"p"}}`,
			`{"target":{"providerInstanceId":"claudeAgent","model":"claude-opus-5-5","projectId":"p"}}`,
			[]string{"target"}},
		{"a Claude target keeps its other options", callerPin{Effort: "low"},
			`{"target":{"providerInstanceId":"claudeAgent","model":"m","options":{"effort":"max","fastMode":true}}}`,
			`{"target":{"providerInstanceId":"claudeAgent","model":"m","options":{"effort":"low","fastMode":true}}}`,
			[]string{"target"}},
		{"an effort pin needs no model, since the target's model is optional", callerPin{Effort: "high"},
			`{}`, `{"target":{"options":[{"id":"effort","value":"high"}]}}`, []string{"target"}},
		{"a caller's inherit mode is replaced", callerPin{PermissionMode: "plan"},
			`{"runtimeMode":"inherit","interactionMode":"inherit"}`,
			`{"runtimeMode":"approval-required","interactionMode":"plan"}`, []string{"runtimeMode", "interactionMode"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			a := args(t, c.in)
			changed := pinTaskArgs(a, c.pin)
			got, _ := json.Marshal(a)
			if !jsonEqual(t, got, []byte(c.want)) {
				t.Errorf("args\n got %s\nwant %s", got, c.want)
			}
			if !reflect.DeepEqual(changed, c.changed) {
				t.Errorf("changed %v, want %v", changed, c.changed)
			}
		})
	}
}

func TestRewriteMCPBodyPinsEveryThreadMaker(t *testing.T) {
	pin := &callerPin{Model: "claude-opus-5-5", PermissionMode: "bypassPermissions"}
	for _, c := range []struct {
		name, in, want string
		changed        []string
	}{
		{"delegate_task",
			`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"delegate_task","arguments":{"task":"x","runtimeMode":"approval-required"}}}`,
			`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"delegate_task","arguments":{"task":"x","target":{"providerInstanceId":"claudeAgent","model":"claude-opus-5-5"},"runtimeMode":"full-access","interactionMode":"default"}}}`,
			[]string{"target", "runtimeMode", "interactionMode"}},
		{"create_threads, each thread",
			`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_threads","arguments":{"threads":[{"title":"a","runtimeMode":"full-access","interactionMode":"default","target":{"providerInstanceId":"claudeAgent","model":"claude-opus-5-5"}},{"title":"b","interactionMode":"plan"}]}}}`,
			`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_threads","arguments":{"threads":[{"title":"a","runtimeMode":"full-access","interactionMode":"default","target":{"providerInstanceId":"claudeAgent","model":"claude-opus-5-5"}},{"title":"b","target":{"providerInstanceId":"claudeAgent","model":"claude-opus-5-5"},"runtimeMode":"full-access","interactionMode":"default"}]}}}`,
			[]string{"threads[1].target", "threads[1].runtimeMode", "threads[1].interactionMode"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			got, changed := rewriteMCPBody([]byte(c.in), pin, 300000)
			if !jsonEqual(t, got, []byte(c.want)) {
				t.Errorf("body\n got %s\nwant %s", got, c.want)
			}
			if !reflect.DeepEqual(changed, c.changed) {
				t.Errorf("changed %v, want %v", changed, c.changed)
			}
		})
	}
}
