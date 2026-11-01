package main

// /mcp: the MCP pass-through to the caller's own T3 Code server.
//
// Callers (Muse, the WhatsApp bot) speak T3's own MCP tools here, with the
// agent-api bearer they already hold. agent-api resolves the credential's OS
// user, applies the caller's pins (mcppins.go), and hands the message to
// t3client.Forward, which sends it to that user's `t3 serve` with agent-api's
// T3 token and maps the MCP session. The caller never holds a T3 credential.
// Design: docs/plans/2026-10-31-t3-hosts-claude-design.md, "agent-api's MCP
// pass-through".
//
// Streamable HTTP, as T3 serves it:
//
//   - POST carries one JSON-RPC message. The answer is T3's status, body and
//     content-type, with agent-api's session id in mcp-session-id.
//   - DELETE ends the caller's session.
//   - GET is 405: T3 has no server-to-client stream to offer.
//
// The handlers answer in MCP's terms rather than this API's: a failure is a
// JSON-RPC error object, because an MCP client reads that and would not read
// {"error": "..."}. Each request still writes one trace line, as /v1 does,
// with the caller's request verbatim and a summary of the answer instead of
// the answer: a t3_thread_read page runs to megabytes.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"terminal-lobby/t3client"
)

// mcpForwarder is the part of *t3client.Client the pass-through uses.
type mcpForwarder interface {
	Forward(ctx context.Context, r t3client.ForwardRequest) (t3client.ForwardResponse, error)
	EndForward(ctx context.Context, callerID, user, sessionID string)
}

// mcpForwardTimeout bounds one forwarded message. Waits are capped at
// maxWaitSeconds (mcppins.go), so T3 answers inside this; it stays under the
// 330 s the edge's long-poll transport allows and under serverWriteTimeout.
const mcpForwardTimeout = maxWaitSeconds*time.Second + 25*time.Second

// mcpEndTimeout bounds the upstream DELETE when a caller ends a session.
const mcpEndTimeout = 10 * time.Second

// mcpTraceErrorChars bounds the tool error text a trace line keeps.
const mcpTraceErrorChars = 500

// mcpMessage is what the trace needs from a caller's message.
type mcpMessage struct {
	ID       json.RawMessage
	Method   string
	Tool     string
	ThreadID string
}

func parseMCPMessage(body []byte) mcpMessage {
	var m struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params struct {
			Name      string `json:"name"`
			Arguments struct {
				ThreadID string `json:"threadId"`
			} `json:"arguments"`
		} `json:"params"`
	}
	if json.Unmarshal(body, &m) != nil {
		// A batch, or not JSON. Forward refuses both; the trace keeps the
		// raw request.
		return mcpMessage{}
	}
	out := mcpMessage{ID: m.ID, Method: m.Method}
	if m.Method == "tools/call" {
		out.Tool = m.Params.Name
		out.ThreadID = m.Params.Arguments.ThreadID
	}
	return out
}

func (s *Server) mcpPost(w http.ResponseWriter, r *http.Request) {
	start := s.now()
	id, _ := identityFrom(r.Context())
	entry := TraceEntry{TraceID: s.IDs.New(), Actor: id.Header, Verb: "POST /mcp"}

	body, err := readBody(r)
	if err != nil {
		entry.Request = marshalOrNote(map[string]string{"unread": err.Error()})
		s.mcpFail(w, entry, start, nil, http.StatusBadRequest, "http_error", err.Error())
		return
	}
	entry.Request = requestRecord(r, body)
	msg := parseMCPMessage(body)
	entry.MCPMethod, entry.Tool, entry.ThreadID = msg.Method, msg.Tool, msg.ThreadID

	switch {
	case id.OSUser == "":
		s.mcpFail(w, entry, start, msg.ID, http.StatusForbidden, "http_error", "this credential names no OS user")
		return
	case s.T3 == nil:
		s.mcpFail(w, entry, start, msg.ID, http.StatusServiceUnavailable, "unreachable",
			"the T3 pass-through is not configured on this box")
		return
	}

	var pin *callerPin
	if p, ok := s.CallerPins[id.Header]; ok {
		pin = &p
	}
	forward, rewritten := rewriteMCPBody(body, pin, maxWaitSeconds*1000)
	entry.Rewritten = rewritten
	if msg.Tool == "t3_thread_launch" && len(rewritten) > 0 {
		logf("agent-api: %s's t3_thread_launch pinned: %s", id.Header, strings.Join(rewritten, ", "))
	}

	ctx, cancel := context.WithTimeout(r.Context(), mcpForwardTimeout)
	defer cancel()
	resp, err := s.T3.Forward(ctx, t3client.ForwardRequest{
		CallerID:        id.Header,
		User:            id.OSUser,
		SessionID:       r.Header.Get("Mcp-Session-Id"),
		ProtocolVersion: r.Header.Get("Mcp-Protocol-Version"),
		Body:            forward,
	})
	if err != nil {
		status, result, text := forwardFailure(id.OSUser, err)
		logf("agent-api: /mcp for %s (%s): %v", id.Header, id.OSUser, err)
		s.mcpFail(w, entry, start, msg.ID, status, result, text)
		return
	}

	for _, k := range []string{"Content-Type", "Mcp-Session-Id", "Mcp-Protocol-Version"} {
		if v := resp.Header.Get(k); v != "" {
			w.Header().Set(k, v)
		}
	}
	w.WriteHeader(resp.Status)
	w.Write(resp.Body)

	summary := summarizeMCPResponse(resp)
	entry.Result = summary.result
	if entry.ThreadID == "" {
		entry.ThreadID = summary.threadID
	}
	entry.Response = marshalOrNote(summary.record)
	s.mcpTrace(entry, start, resp.Status)
}

func (s *Server) mcpDelete(w http.ResponseWriter, r *http.Request) {
	start := s.now()
	id, _ := identityFrom(r.Context())
	entry := TraceEntry{TraceID: s.IDs.New(), Actor: id.Header, Verb: "DELETE /mcp", Request: requestRecord(r, nil)}
	sid := r.Header.Get("Mcp-Session-Id")
	switch {
	case sid == "":
		s.mcpFail(w, entry, start, nil, http.StatusBadRequest, "http_error", "mcp-session-id is required")
		return
	case s.T3 == nil:
		s.mcpFail(w, entry, start, nil, http.StatusServiceUnavailable, "unreachable",
			"the T3 pass-through is not configured on this box")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), mcpEndTimeout)
	defer cancel()
	// A session that is not this caller's, or is already gone, is left
	// alone, and the answer is the same: the caller's session is over.
	s.T3.EndForward(ctx, id.Header, id.OSUser, sid)
	w.WriteHeader(http.StatusNoContent)
	entry.Result = "ok"
	entry.Response = marshalOrNote(map[string]any{})
	s.mcpTrace(entry, start, http.StatusNoContent)
}

func (s *Server) mcpGet(w http.ResponseWriter, r *http.Request) {
	start := s.now()
	id, _ := identityFrom(r.Context())
	entry := TraceEntry{TraceID: s.IDs.New(), Actor: id.Header, Verb: "GET /mcp", Request: requestRecord(r, nil)}
	w.Header().Set("Allow", "POST, DELETE")
	s.mcpFail(w, entry, start, nil, http.StatusMethodNotAllowed, "http_error",
		"T3 offers no server-to-client stream; POST each message")
}

// mcpFail answers with a JSON-RPC error and records it.
func (s *Server) mcpFail(w http.ResponseWriter, entry TraceEntry, start time.Time, id json.RawMessage, status int, result, message string) {
	if len(id) == 0 {
		id = json.RawMessage("null")
	}
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id,
		"error": map[string]any{"code": -32603, "message": message}})
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write(body)
	entry.Result = result
	entry.Response = marshalOrNote(map[string]string{"error": message})
	s.mcpTrace(entry, start, status)
}

func (s *Server) mcpTrace(entry TraceEntry, start time.Time, status int) {
	entry.TS = traceTime(start)
	entry.Status = status
	entry.Duration = float64(s.now().Sub(start)) / float64(time.Millisecond)
	s.Trace.Write(entry)
}

// forwardFailure turns a Forward error into what the caller is told. An auth
// failure is agent-api's own credential, which the caller cannot fix, so its
// detail goes to the log and not the answer.
func forwardFailure(user string, err error) (status int, result, message string) {
	var ae *t3client.AuthError
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return http.StatusGatewayTimeout, "timeout", fmt.Sprintf("%s's T3 did not answer in time", user)
	case errors.As(err, &ae):
		return http.StatusBadGateway, "auth_error", fmt.Sprintf("agent-api could not get a T3 credential for %s", user)
	default:
		return http.StatusBadGateway, "unreachable", fmt.Sprintf("%s's T3 could not be reached: %v", user, err)
	}
}

type mcpResponseSummary struct {
	result   string
	threadID string
	record   map[string]any
}

// summarizeMCPResponse reads how a forwarded call ended, for the trace. The
// body is not kept: its size is, with a JSON-RPC error or a tool error's text
// when there is one.
func summarizeMCPResponse(resp t3client.ForwardResponse) mcpResponseSummary {
	out := mcpResponseSummary{record: map[string]any{"bytes": len(resp.Body)}}
	if resp.Status == http.StatusAccepted {
		out.result = "accepted"
		return out
	}
	var m struct {
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
		Result struct {
			IsError bool `json:"isError"`
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
			Structured struct {
				ThreadID string `json:"threadId"`
			} `json:"structuredContent"`
		} `json:"result"`
	}
	parsed := json.Unmarshal(rpcPayload(resp.Header.Get("Content-Type"), resp.Body), &m) == nil
	if parsed && m.Error != nil {
		out.record["error"] = map[string]any{"code": m.Error.Code, "message": truncate(m.Error.Message, mcpTraceErrorChars)}
	}
	switch {
	case resp.Status != http.StatusOK:
		out.result = "http_error"
	case !parsed:
		out.result = "ok"
	case m.Error != nil:
		out.result = "rpc_error"
	case m.Result.IsError:
		out.result = "tool_error"
		if len(m.Result.Content) > 0 {
			out.record["tool_error"] = truncate(m.Result.Content[0].Text, mcpTraceErrorChars)
		}
	default:
		out.result = "ok"
		out.threadID = m.Result.Structured.ThreadID
	}
	return out
}

// rpcPayload is the JSON-RPC message in a response: the body itself, or the
// last data line of an event stream.
func rpcPayload(contentType string, body []byte) []byte {
	if !strings.Contains(contentType, "text/event-stream") {
		return body
	}
	var last []byte
	sc := bufio.NewScanner(bytes.NewReader(body))
	sc.Buffer(make([]byte, 64<<10), len(body)+1)
	for sc.Scan() {
		if d, ok := bytes.CutPrefix(sc.Bytes(), []byte("data:")); ok {
			last = append([]byte(nil), bytes.TrimSpace(d)...)
		}
	}
	return last
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
