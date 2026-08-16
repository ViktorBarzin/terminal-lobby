package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"

	"terminal-lobby/sessionio"
)

// protoFakeHandler stands in for the tmux side. The protocol loop is supposed
// to know nothing about tmux, and this is how that claim is tested: every test
// below runs the real decoder and encoder over two buffers, with no session,
// no transcript and no T3 anywhere.
type protoFakeHandler struct {
	sent       []string
	interrupts int
	sendErr    error
	intErr     error
}

func (h *protoFakeHandler) Send(text string) error {
	h.sent = append(h.sent, text)
	return h.sendErr
}

func (h *protoFakeHandler) Interrupt() error {
	h.interrupts++
	return h.intErr
}

// protoLoopOver wires a loop around a canned inbound script.
func protoLoopOver(t *testing.T, h protoHandler, lines ...string) (*protoLoop, *bytes.Buffer) {
	t.Helper()
	var in strings.Builder
	for _, l := range lines {
		in.WriteString(l)
		in.WriteString("\n")
	}
	out := &bytes.Buffer{}
	return &protoLoop{
		In:        NewDecoder(strings.NewReader(in.String())),
		Out:       NewEncoder(out),
		Handler:   h,
		SessionID: "sess-1",
	}, out
}

func protoLines(t *testing.T, b *bytes.Buffer) []string {
	t.Helper()
	s := strings.TrimSuffix(b.String(), "\n")
	if s == "" {
		return nil
	}
	return strings.Split(s, "\n")
}

func TestInboundText(t *testing.T) {
	tests := []struct {
		name  string
		frame string
		want  string
	}{
		{
			// The shape t3 v0.0.34 actually writes (buildUserMessage).
			name:  "blocks",
			frame: `{"type":"user","session_id":"","message":{"role":"user","content":[{"type":"text","text":"ship it"}]},"parent_tool_use_id":null}`,
			want:  "ship it",
		},
		{
			name:  "content is a plain string",
			frame: `{"type":"user","message":{"role":"user","content":"ship it"}}`,
			want:  "ship it",
		},
		{
			name:  "message is a plain string",
			frame: `{"type":"user","message":"ship it"}`,
			want:  "ship it",
		},
		{
			// Two text blocks are two lines of one prompt, not one welded word.
			name:  "several text blocks are newline-joined",
			frame: `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"one"},{"type":"text","text":"two"}]}}`,
			want:  "one\ntwo",
		},
		{
			name:  "non-text blocks are skipped",
			frame: `{"type":"user","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AA=="}},{"type":"text","text":"look"}]}}`,
			want:  "look",
		},
		{
			name:  "image only has no text",
			frame: `{"type":"user","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AA=="}}]}}`,
			want:  "",
		},
		{
			name:  "empty content",
			frame: `{"type":"user","message":{"role":"user","content":[]}}`,
			want:  "",
		},
		{
			name:  "no message at all",
			frame: `{"type":"user"}`,
			want:  "",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var in Inbound
			if err := json.Unmarshal([]byte(tc.frame), &in); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if got := in.Text(); got != tc.want {
				t.Fatalf("Text() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestInboundControlSubtype(t *testing.T) {
	tests := []struct {
		name  string
		frame string
		want  string
	}{
		{"initialize", `{"type":"control_request","request_id":"1","request":{"subtype":"initialize"}}`, "initialize"},
		{"interrupt", `{"type":"control_request","request_id":"1","request":{"subtype":"interrupt"}}`, "interrupt"},
		{"unknown subtype still reads", `{"type":"control_request","request_id":"1","request":{"subtype":"set_color","color":"red"}}`, "set_color"},
		{"not a control request", `{"type":"user","message":"hi"}`, ""},
		{"control request with no request object", `{"type":"control_request","request_id":"1"}`, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var in Inbound
			if err := json.Unmarshal([]byte(tc.frame), &in); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if got := in.ControlSubtype(); got != tc.want {
				t.Fatalf("ControlSubtype() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestDecoderSkipsNonFrames(t *testing.T) {
	src := strings.Join([]string{
		``,
		`not json at all`,
		`{"type":"user","message":"first"}`,
		`{`,
		`{"type":"user","message":"second"}`,
	}, "\n")
	d := NewDecoder(strings.NewReader(src))

	var got []string
	for {
		frame, err := d.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("Next: %v", err)
		}
		got = append(got, frame.Text())
	}
	if want := []string{"first", "second"}; !equalStrings(got, want) {
		t.Fatalf("frames = %q, want %q", got, want)
	}
}

func TestDecoderKeepsTheSourceLine(t *testing.T) {
	line := `{"type":"user","message":"hi"}`
	d := NewDecoder(strings.NewReader(line + "\n"))
	frame, err := d.Next()
	if err != nil {
		t.Fatalf("Next: %v", err)
	}
	if string(frame.Line) != line {
		t.Fatalf("Line = %q, want %q", frame.Line, line)
	}
}

// TestHandshakeByteSequence pins the exact bytes of T3's opening exchange.
// Verified fact 2: the reply must carry request_id on the INNER object, and the
// session_id in system/init becomes the thread's resume cursor.
func TestHandshakeByteSequence(t *testing.T) {
	cfg := Config{Resume: "6c420342-1111-2222-3333-444444444444", CWD: "/home/wizard/code/terminal-lobby", Model: "claude-opus-5", PermissionMode: "bypassPermissions"}

	h := &protoFakeHandler{}
	loop, out := protoLoopOver(t, h,
		`{"type":"control_request","request_id":"req-7","request":{"subtype":"initialize","hooks":{}}}`,
	)
	pending, err := loop.Handshake(protoSystemInit(cfg, "9.9.9"))
	if err != nil {
		t.Fatalf("Handshake: %v", err)
	}
	if len(pending) != 0 {
		t.Fatalf("pending = %v, want none", pending)
	}

	lines := protoLines(t, out)
	if len(lines) != 2 {
		t.Fatalf("wrote %d lines, want 2:\n%s", len(lines), out.String())
	}

	wantReply := `{"type":"control_response","response":{"subtype":"success","request_id":"req-7","response":{"commands":[],"agents":[],"output_style":"default","available_output_styles":["default"],"models":[]}}}`
	if lines[0] != wantReply {
		t.Fatalf("control_response =\n%s\nwant\n%s", lines[0], wantReply)
	}

	// The init frame's own uuid is freshly minted, so it is validated and then
	// substituted; every other byte is pinned.
	gotInit := protoSubstituteUUID(t, lines[1])
	wantInit := `{"type":"system","subtype":"init","session_id":"6c420342-1111-2222-3333-444444444444","uuid":"<uuid>","cwd":"/home/wizard/code/terminal-lobby","model":"claude-opus-5","permissionMode":"bypassPermissions","apiKeySource":"oauth","claude_code_version":"9.9.9","output_style":"default","tools":[],"slash_commands":[],"skills":[],"mcp_servers":[],"plugins":[]}`
	if gotInit != wantInit {
		t.Fatalf("system/init =\n%s\nwant\n%s", gotInit, wantInit)
	}
}

var protoUUIDRe = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`)

func protoSubstituteUUID(t *testing.T, line string) string {
	t.Helper()
	var frame struct {
		UUID string `json:"uuid"`
	}
	if err := json.Unmarshal([]byte(line), &frame); err != nil {
		t.Fatalf("unmarshal %q: %v", line, err)
	}
	if !protoUUIDRe.MatchString(frame.UUID) {
		t.Fatalf("uuid %q is not a v4 uuid", frame.UUID)
	}
	return strings.Replace(line, frame.UUID, "<uuid>", 1)
}

// A frame that arrives before initialize must not be dropped: it is a prompt
// T3 has already written, and losing it loses a turn.
func TestHandshakeHoldsFramesArrivingBeforeInitialize(t *testing.T) {
	h := &protoFakeHandler{}
	loop, out := protoLoopOver(t, h,
		`{"type":"user","message":{"role":"user","content":"early"}}`,
		`{"type":"control_request","request_id":"a","request":{"subtype":"set_permission_mode","mode":"plan"}}`,
		`{"type":"control_request","request_id":"b","request":{"subtype":"initialize"}}`,
	)
	pending, err := loop.Handshake(protoSystemInit(Config{Resume: "s"}, "9.9.9"))
	if err != nil {
		t.Fatalf("Handshake: %v", err)
	}
	if len(pending) != 1 || pending[0].Text() != "early" {
		t.Fatalf("pending = %+v, want the one early prompt", pending)
	}
	// The control_request that preceded initialize is still answered, or T3
	// waits on a promise that never settles.
	lines := protoLines(t, out)
	if len(lines) != 3 {
		t.Fatalf("wrote %d lines, want 3:\n%s", len(lines), out.String())
	}
	if !strings.Contains(lines[0], `"request_id":"a"`) || !strings.Contains(lines[0], `"subtype":"success"`) {
		t.Fatalf("first line did not answer request a: %s", lines[0])
	}
}

func TestHandshakeReportsAClosedPipe(t *testing.T) {
	h := &protoFakeHandler{}
	loop, _ := protoLoopOver(t, h)
	if _, err := loop.Handshake(protoSystemInit(Config{Resume: "s"}, "9.9.9")); err == nil {
		t.Fatal("Handshake over an empty pipe returned nil, want an error")
	}
}

// Every control_request gets a success, including the 30-odd subtypes the
// bridge has no opinion about: refusing them stalls the thread.
func TestServeAnswersEveryControlRequest(t *testing.T) {
	tests := []struct {
		name    string
		request string
	}{
		{"initialize", `{"subtype":"initialize"}`},
		{"set_permission_mode", `{"subtype":"set_permission_mode","mode":"plan"}`},
		{"get_context_usage", `{"subtype":"get_context_usage"}`},
		{"unknown subtype", `{"subtype":"set_color","color":"red"}`},
		{"subtype we cannot even parse", `{"nosubtype":true}`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := &protoFakeHandler{}
			loop, out := protoLoopOver(t, h,
				fmt.Sprintf(`{"type":"control_request","request_id":"r-1","request":%s}`, tc.request),
			)
			if err := loop.Serve(nil); err != nil {
				t.Fatalf("Serve: %v", err)
			}
			lines := protoLines(t, out)
			if len(lines) != 1 {
				t.Fatalf("wrote %d lines, want 1:\n%s", len(lines), out.String())
			}
			var reply ControlResponse
			if err := json.Unmarshal([]byte(lines[0]), &reply); err != nil {
				t.Fatalf("unmarshal reply: %v", err)
			}
			if reply.Type != TypeControlResponse || reply.Response.Subtype != "success" || reply.Response.RequestID != "r-1" {
				t.Fatalf("reply = %+v, want a success for r-1", reply)
			}
			if h.interrupts != 0 || len(h.sent) != 0 {
				t.Fatalf("control request touched the tmux side: %+v", h)
			}
		})
	}
}

func TestServeInterrupt(t *testing.T) {
	h := &protoFakeHandler{}
	loop, out := protoLoopOver(t, h,
		`{"type":"control_request","request_id":"i-1","request":{"subtype":"interrupt"}}`,
	)
	if err := loop.Serve(nil); err != nil {
		t.Fatalf("Serve: %v", err)
	}
	if h.interrupts != 1 {
		t.Fatalf("interrupts = %d, want 1", h.interrupts)
	}
	lines := protoLines(t, out)
	if len(lines) != 1 || !strings.Contains(lines[0], `"subtype":"success"`) {
		t.Fatalf("interrupt reply = %v, want one success", lines)
	}
}

// A Stop button that could not stop anything must not report success — the
// operator would believe the turn was cancelled when it is still running.
func TestServeInterruptFailureRepliesError(t *testing.T) {
	h := &protoFakeHandler{intErr: fmt.Errorf("no such session")}
	loop, out := protoLoopOver(t, h,
		`{"type":"control_request","request_id":"i-2","request":{"subtype":"interrupt"}}`,
	)
	if err := loop.Serve(nil); err != nil {
		t.Fatalf("Serve: %v", err)
	}
	lines := protoLines(t, out)
	if len(lines) != 1 {
		t.Fatalf("wrote %d lines, want 1", len(lines))
	}
	var reply ControlResponse
	if err := json.Unmarshal([]byte(lines[0]), &reply); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if reply.Response.Subtype != "error" || !strings.Contains(reply.Response.Error, "no such session") {
		t.Fatalf("reply = %+v, want an error naming the cause", reply.Response)
	}
}

func TestServeDeliversBothUserContentShapes(t *testing.T) {
	h := &protoFakeHandler{}
	loop, _ := protoLoopOver(t, h,
		`{"type":"user","session_id":"","message":{"role":"user","content":[{"type":"text","text":"blocks"}]},"parent_tool_use_id":null}`,
		`{"type":"user","message":{"role":"user","content":"string"}}`,
	)
	if err := loop.Serve(nil); err != nil {
		t.Fatalf("Serve: %v", err)
	}
	if want := []string{"blocks", "string"}; !equalStrings(h.sent, want) {
		t.Fatalf("sent = %q, want %q", h.sent, want)
	}
}

func TestServeDeliversPendingFramesFirst(t *testing.T) {
	h := &protoFakeHandler{}
	loop, _ := protoLoopOver(t, h, `{"type":"user","message":"second"}`)
	var early Inbound
	if err := json.Unmarshal([]byte(`{"type":"user","message":"first"}`), &early); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if err := loop.Serve([]Inbound{early}); err != nil {
		t.Fatalf("Serve: %v", err)
	}
	if want := []string{"first", "second"}; !equalStrings(h.sent, want) {
		t.Fatalf("sent = %q, want %q", h.sent, want)
	}
}

// The syncer's warm-up turn exists to make T3 spawn the bridge. Pasting it
// would put a stray line into somebody's live session.
func TestServeSwallowsTheSentinel(t *testing.T) {
	h := &protoFakeHandler{}
	loop, out := protoLoopOver(t, h,
		fmt.Sprintf(`{"type":"user","message":{"role":"user","content":%s}}`, mustJSON(t, SentinelPrompt)),
	)
	if err := loop.Serve(nil); err != nil {
		t.Fatalf("Serve: %v", err)
	}
	if len(h.sent) != 0 {
		t.Fatalf("sentinel reached the pane: %q", h.sent)
	}
	// It still has to close the turn it opened: nothing in the transcript will
	// ever settle a turn that never reached Claude.
	lines := protoLines(t, out)
	if len(lines) != 1 {
		t.Fatalf("wrote %d lines, want the closing result:\n%s", len(lines), out.String())
	}
	var result ResultFrame
	if err := json.Unmarshal([]byte(lines[0]), &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if result.Type != TypeResult || result.IsError || result.SessionID != "sess-1" {
		t.Fatalf("result = %+v, want a clean close for sess-1", result)
	}
}

func TestServeLogsFramesItCannotMap(t *testing.T) {
	var logged bytes.Buffer
	log.SetOutput(&logged)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })

	h := &protoFakeHandler{}
	loop, out := protoLoopOver(t, h,
		`{"type":"stream_event","event":{"type":"content_block_delta"}}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AA=="}}]}}`,
	)
	if err := loop.Serve(nil); err != nil {
		t.Fatalf("Serve: %v", err)
	}
	if len(h.sent) != 0 {
		t.Fatalf("an unmappable frame reached the pane: %q", h.sent)
	}
	if out.Len() != 0 {
		t.Fatalf("an unmappable frame produced output: %s", out.String())
	}
	for _, want := range []string{"stream_event", "image"} {
		if !strings.Contains(logged.String(), want) {
			t.Fatalf("stderr log %q does not mention %q", logged.String(), want)
		}
	}
}

func TestServeReturnsAtEOF(t *testing.T) {
	h := &protoFakeHandler{}
	loop, _ := protoLoopOver(t, h)
	if err := loop.Serve(nil); err != nil {
		t.Fatalf("Serve at EOF = %v, want nil: a closed pipe is how a bridge is told to exit", err)
	}
}

// The translation the whole mirror rests on: a transcript record is already the
// SDK's shape, so this is a key mapping and must not rewrite the message.
func TestFrameForRecord(t *testing.T) {
	tests := []struct {
		name      string
		line      string
		replay    bool
		wantFrame string // "" means the record must be dropped
		wantJSON  string
	}{
		{
			name:      "assistant text",
			line:      `{"type":"assistant","uuid":"u-1","sessionId":"s-1","message":{"id":"msg_1","role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"hello"}],"stop_reason":"end_turn","usage":{"input_tokens":3}}}`,
			wantFrame: TypeAssistant,
			wantJSON:  `{"type":"assistant","message":{"id":"msg_1","role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"hello"}],"stop_reason":"end_turn","usage":{"input_tokens":3}},"parent_tool_use_id":null,"uuid":"u-1","session_id":"s-1"}`,
		},
		{
			name:      "assistant tool_use is preserved exactly",
			line:      `{"type":"assistant","uuid":"u-2","sessionId":"s-1","message":{"id":"msg_2","role":"assistant","content":[{"type":"tool_use","id":"toolu_9","name":"Bash","input":{"command":"ls -la","description":"list"}}],"stop_reason":"tool_use"}}`,
			wantFrame: TypeAssistant,
			wantJSON:  `{"type":"assistant","message":{"id":"msg_2","role":"assistant","content":[{"type":"tool_use","id":"toolu_9","name":"Bash","input":{"command":"ls -la","description":"list"}}],"stop_reason":"tool_use"},"parent_tool_use_id":null,"uuid":"u-2","session_id":"s-1"}`,
		},
		{
			name:      "user tool_result is preserved exactly",
			line:      `{"type":"user","uuid":"u-3","sessionId":"s-1","timestamp":"2026-08-15T22:30:00.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_9","content":"total 0\n","is_error":false}]}}`,
			wantFrame: TypeUser,
			wantJSON:  `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_9","content":"total 0\n","is_error":false}]},"parent_tool_use_id":null,"uuid":"u-3","session_id":"s-1","timestamp":"2026-08-15T22:30:00.000Z"}`,
		},
		{
			name:      "replay marks the frame",
			line:      `{"type":"user","uuid":"u-4","sessionId":"s-1","message":{"role":"user","content":"what changed?"}}`,
			replay:    true,
			wantFrame: TypeUser,
			wantJSON:  `{"type":"user","message":{"role":"user","content":"what changed?"},"parent_tool_use_id":null,"uuid":"u-4","session_id":"s-1","isReplay":true}`,
		},
		{
			// Older transcripts spell it session_id; newer ones write both.
			name:      "snake_case session id",
			line:      `{"type":"assistant","uuid":"u-5","session_id":"s-9","message":{"role":"assistant","content":[]}}`,
			wantFrame: TypeAssistant,
			wantJSON:  `{"type":"assistant","message":{"role":"assistant","content":[]},"parent_tool_use_id":null,"uuid":"u-5","session_id":"s-9"}`,
		},
		{"attachment is dropped", `{"type":"attachment","uuid":"u-6","attachment":{"type":"file"}}`, false, "", ""},
		{"last-prompt is dropped", `{"type":"last-prompt","uuid":"u-7","prompt":"hi"}`, false, "", ""},
		{"queue-operation is dropped", `{"type":"queue-operation","uuid":"u-8","operation":"enqueue"}`, false, "", ""},
		{"system is dropped", `{"type":"system","uuid":"u-9","content":"hook fired"}`, false, "", ""},
		{"an unknown future type is dropped", `{"type":"worktree-state","uuid":"u-10"}`, false, "", ""},
		{"a conversational record with no message is dropped", `{"type":"assistant","uuid":"u-11","sessionId":"s-1"}`, false, "", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rec, ok := sessionio.DecodeRecord([]byte(tc.line))
			if !ok {
				t.Fatalf("DecodeRecord refused %s", tc.line)
			}
			frame, ok := protoFrameFor(rec, "", tc.replay)
			if tc.wantFrame == "" {
				if ok {
					t.Fatalf("record was mirrored, want dropped: %+v", frame)
				}
				return
			}
			if !ok {
				t.Fatalf("record was dropped, want a %s frame", tc.wantFrame)
			}
			if frame.frameType() != tc.wantFrame {
				t.Fatalf("frameType = %q, want %q", frame.frameType(), tc.wantFrame)
			}
			got, err := json.Marshal(frame)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			if string(got) != tc.wantJSON {
				t.Fatalf("frame =\n%s\nwant\n%s", got, tc.wantJSON)
			}
		})
	}
}

// The bridge speaks with one session identity per invocation — the one it
// declared in system/init — so a caller-supplied id wins over the record's.
func TestFrameForPrefersTheCallersSessionID(t *testing.T) {
	rec, ok := sessionio.DecodeRecord([]byte(`{"type":"assistant","uuid":"u-1","sessionId":"from-record","message":{"role":"assistant","content":[]}}`))
	if !ok {
		t.Fatal("DecodeRecord refused the line")
	}
	frame, ok := protoFrameFor(rec, "from-bridge", false)
	if !ok {
		t.Fatal("record was dropped")
	}
	got, ok := frame.(AssistantFrame)
	if !ok {
		t.Fatalf("frame is %T, want AssistantFrame", frame)
	}
	if got.SessionID != "from-bridge" {
		t.Fatalf("session_id = %q, want the bridge's own", got.SessionID)
	}
}

func TestResultFrames(t *testing.T) {
	ok := protoResult("s-1", "end_turn")
	got, err := json.Marshal(ok)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	line := protoSubstituteUUID(t, string(got))
	want := `{"type":"result","subtype":"success","is_error":false,"duration_ms":0,"duration_api_ms":0,"num_turns":1,"result":"","stop_reason":"end_turn","total_cost_usd":0,"uuid":"<uuid>","session_id":"s-1"}`
	if line != want {
		t.Fatalf("result =\n%s\nwant\n%s", line, want)
	}

	// stop_reason is required and nullable: an unknown reason is null, never
	// an empty string.
	got, err = json.Marshal(protoResult("s-1", ""))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(got), `"stop_reason":null`) {
		t.Fatalf("result = %s, want a null stop_reason", got)
	}

	bad := protoResultError("s-1", "tmux session vanished")
	got, err = json.Marshal(bad)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, want := range []string{`"subtype":"error_during_execution"`, `"is_error":true`, `"result":"tmux session vanished"`} {
		if !strings.Contains(string(got), want) {
			t.Fatalf("error result = %s, want it to contain %s", got, want)
		}
	}
}

// Empty slices must marshal as [] and not null: T3 maps over them.
func TestSystemInitNeverEmitsNullArrays(t *testing.T) {
	got, err := json.Marshal(protoSystemInit(Config{SessionID: "s"}, "9.9.9"))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(got), "null") {
		t.Fatalf("system/init = %s, want no null", got)
	}
	for _, want := range []string{`"tools":[]`, `"slash_commands":[]`, `"skills":[]`, `"mcp_servers":[]`, `"plugins":[]`} {
		if !strings.Contains(string(got), want) {
			t.Fatalf("system/init = %s, want it to contain %s", got, want)
		}
	}
}

func TestSystemInitDefaults(t *testing.T) {
	init := protoSystemInit(Config{Resume: "s-1"}, "")
	if init.PermissionMode != "default" {
		t.Fatalf("permissionMode = %q, want default", init.PermissionMode)
	}
	if init.ClaudeCodeVersion != protoUnknownVersion {
		t.Fatalf("claude_code_version = %q, want %q", init.ClaudeCodeVersion, protoUnknownVersion)
	}
	if init.SessionID != "s-1" {
		t.Fatalf("session_id = %q, want the resume cursor", init.SessionID)
	}
}

func TestUUIDIsAFreshV4(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 100; i++ {
		u := protoUUID()
		if !protoUUIDRe.MatchString(u) {
			t.Fatalf("uuid %q is not a v4 uuid", u)
		}
		if seen[u] {
			t.Fatalf("uuid %q repeated", u)
		}
		seen[u] = true
	}
}

func TestClaudeVersion(t *testing.T) {
	tests := []struct {
		name   string
		script string
		want   string
	}{
		{"the real format", "#!/bin/sh\necho '2.1.233 (Claude Code)'\n", "2.1.233"},
		{"trailing whitespace", "#!/bin/sh\nprintf '2.1.233 (Claude Code)  \\n'\n", "2.1.233"},
		{"a binary that fails", "#!/bin/sh\nexit 3\n", protoUnknownVersion},
		{"a binary that says nothing", "#!/bin/sh\nexit 0\n", protoUnknownVersion},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("TL_REAL_CLAUDE", protoStubBinary(t, tc.script))
			if got := protoClaudeVersion(); got != tc.want {
				t.Fatalf("protoClaudeVersion() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestClaudeVersionWithNoClaudeAtAll(t *testing.T) {
	t.Setenv("TL_REAL_CLAUDE", filepath.Join(t.TempDir(), "absent"))
	if got := protoClaudeVersion(); got != protoUnknownVersion {
		t.Fatalf("protoClaudeVersion() = %q, want %q", got, protoUnknownVersion)
	}
}

// The control replies and the transcript tail write from different goroutines.
// Two interleaved half-lines are two malformed frames.
func TestEncoderIsLineAtomic(t *testing.T) {
	var buf bytes.Buffer
	enc := NewEncoder(&buf)

	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if i%2 == 0 {
				if err := enc.ControlSuccess(fmt.Sprintf("r-%d", i), nil); err != nil {
					t.Errorf("ControlSuccess: %v", err)
				}
				return
			}
			if err := enc.Emit(protoResult("s-1", "end_turn")); err != nil {
				t.Errorf("Emit: %v", err)
			}
		}(i)
	}
	wg.Wait()

	lines := protoLines(t, &buf)
	if len(lines) != 32 {
		t.Fatalf("wrote %d lines, want 32", len(lines))
	}
	for _, l := range lines {
		var probe map[string]json.RawMessage
		if err := json.Unmarshal([]byte(l), &probe); err != nil {
			t.Fatalf("interleaved line %q: %v", l, err)
		}
	}
}

// protoStubBinary writes an executable shell script and returns its path. The
// bridge never runs the real claude in a test.
func protoStubBinary(t *testing.T, script string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "claude")
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatalf("write stub: %v", err)
	}
	return path
}

func mustJSON(t *testing.T, v string) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
