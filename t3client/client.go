package t3client

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ProtocolVersion is the MCP revision T3 v0.1.5 speaks.
const ProtocolVersion = "2025-06-18"

// DefaultTimeout bounds a call whose context has no deadline.
const DefaultTimeout = 30 * time.Second

// maxBody bounds a response read into memory. t3_thread_read pages are the
// largest answers and stay well under this.
const maxBody = 16 << 20

// Metric names, the same for every service that embeds the client.
const (
	MetricCalls       = "tl_t3_calls_total"
	MetricLastSuccess = "tl_t3_last_success_timestamp_seconds"
)

// Metrics is the part of telemetry.Metrics the client writes to.
type Metrics interface {
	AddCounter(name string, labels map[string]string)
	SetGauge(name string, labels map[string]string, v float64)
}

// Config wires a Client.
type Config struct {
	// Service is the calling service ("tmux-api", "agent-api"). It labels
	// the metrics and, when Credentials.Label is empty, the T3 token.
	Service     string
	Locator     *Locator
	Credentials *Credentials
	HTTP        *http.Client
	Metrics     Metrics // optional
	Now         func() time.Time
	// Timeout applies when a call's context has no deadline; default
	// DefaultTimeout.
	Timeout time.Duration
	// Toplevel resolves a directory to the workspace root ProjectForDir
	// looks up; default GitToplevel.
	Toplevel func(ctx context.Context, user, dir string) (string, error)
}

// Client talks to users' T3 servers over MCP. Safe for concurrent use.
type Client struct {
	cfg    Config
	nextID atomic.Int64

	mu       sync.Mutex
	sessions map[string]*session // by user
}

type session struct {
	mu sync.Mutex // held across initialize, so one user initializes once
	id string
}

// New returns a Client. It sets cfg.Credentials.Label to cfg.Service when
// the label is empty.
func New(cfg Config) *Client {
	if cfg.Locator == nil {
		cfg.Locator = &Locator{}
	}
	if cfg.Credentials == nil {
		cfg.Credentials = &Credentials{Minter: SudoMinter()}
	}
	if cfg.Credentials.Label == "" {
		cfg.Credentials.Label = cfg.Service
	}
	if cfg.Credentials.HTTP == nil {
		cfg.Credentials.HTTP = cfg.HTTP
	}
	if cfg.Toplevel == nil {
		cfg.Toplevel = GitToplevel
	}
	return &Client{cfg: cfg, sessions: map[string]*session{}}
}

// Service is the service name the client reports as.
func (c *Client) Service() string { return c.cfg.Service }

// Locator is the client's Locator, for callers that need links.
func (c *Client) Locator() *Locator { return c.cfg.Locator }

// ToolError is a tool call T3 answered with isError, carrying T3's
// OrchestratorMcpFailure code and message.
type ToolError struct {
	Tool    string
	Code    string
	Message string
}

func (e *ToolError) Error() string {
	return fmt.Sprintf("t3client: %s: %s: %s", e.Tool, e.Code, e.Message)
}

// IsToolError reports whether err is a ToolError with the given code.
func IsToolError(err error, code string) bool {
	var te *ToolError
	return errors.As(err, &te) && te.Code == code
}

// RPCError is a JSON-RPC error, which T3 returns for unknown tools and
// arguments that fail its schema.
type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *RPCError) Error() string { return fmt.Sprintf("t3client: JSON-RPC %d: %s", e.Code, e.Message) }

// HTTPError is a /mcp answer that was not a JSON-RPC response.
type HTTPError struct {
	Status  int
	Message string
}

func (e *HTTPError) Error() string { return fmt.Sprintf("t3client: HTTP %d: %s", e.Status, e.Message) }

// AuthError is a failure to get a token at all (t3-mint or sign-in failed).
type AuthError struct{ Err error }

func (e *AuthError) Error() string { return "t3client: credentials: " + e.Err.Error() }
func (e *AuthError) Unwrap() error { return e.Err }

func (c *Client) now() time.Time {
	if c.cfg.Now != nil {
		return c.cfg.Now()
	}
	return time.Now()
}

func (c *Client) withTimeout(ctx context.Context) (context.Context, context.CancelFunc) {
	if _, ok := ctx.Deadline(); ok {
		return ctx, func() {}
	}
	d := c.cfg.Timeout
	if d <= 0 {
		d = DefaultTimeout
	}
	return context.WithTimeout(ctx, d)
}

// Call runs one T3 tool for user and returns its structuredContent.
func (c *Client) Call(ctx context.Context, user, tool string, args any) (json.RawMessage, error) {
	ctx, cancel := c.withTimeout(ctx)
	defer cancel()
	out, err := c.call(ctx, user, tool, args)
	c.record(user, tool, err)
	return out, err
}

func (c *Client) call(ctx context.Context, user, tool string, args any) (json.RawMessage, error) {
	if args == nil {
		args = map[string]any{}
	}
	params, err := json.Marshal(map[string]any{"name": tool, "arguments": args})
	if err != nil {
		return nil, err
	}
	id := c.nextID.Add(1)
	body, _ := json.Marshal(rpcRequest{JSONRPC: "2.0", ID: id, Method: "tools/call", Params: params})

	base, err := c.cfg.Locator.BaseURL(user)
	if err != nil {
		return nil, err
	}
	var renewed, reinit bool
	for {
		tok, err := c.cfg.Credentials.Token(ctx, user, base)
		if err != nil {
			return nil, &AuthError{err}
		}
		sid, err := c.session(ctx, user, base, tok)
		var he *HTTPError
		if errors.As(err, &he) && he.Status == http.StatusUnauthorized && !renewed {
			renewed = true
			if _, err := c.cfg.Credentials.Renew(ctx, user, base, tok); err != nil {
				return nil, &AuthError{err}
			}
			continue
		}
		if err != nil {
			return nil, err
		}
		resp, err := c.post(ctx, base, tok, sid, body)
		if err != nil {
			return nil, err
		}
		switch {
		case resp.status == http.StatusUnauthorized && !renewed:
			renewed = true
			c.dropSession(user, sid)
			if _, err := c.cfg.Credentials.Renew(ctx, user, base, tok); err != nil {
				return nil, &AuthError{err}
			}
			continue
		case resp.status == http.StatusNotFound && !reinit:
			reinit = true
			c.dropSession(user, sid)
			continue
		case resp.status != http.StatusOK:
			return nil, &HTTPError{resp.status, errorMessage(resp.body)}
		}
		msg, err := parseRPC(resp.header.Get("content-type"), resp.body, id)
		if err != nil {
			return nil, err
		}
		return toolResult(tool, msg)
	}
}

// session returns the user's MCP session id, initializing one if needed.
func (c *Client) session(ctx context.Context, user, base, tok string) (string, error) {
	c.mu.Lock()
	s := c.sessions[user]
	if s == nil {
		s = &session{}
		c.sessions[user] = s
	}
	c.mu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.id != "" {
		return s.id, nil
	}
	params, _ := json.Marshal(map[string]any{
		"protocolVersion": ProtocolVersion,
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "terminal-lobby/" + c.cfg.Service, "version": "1"},
	})
	sid, _, err := c.initialize(ctx, base, tok, params)
	if err != nil {
		return "", err
	}
	s.id = sid
	return sid, nil
}

func (c *Client) dropSession(user, sid string) {
	c.mu.Lock()
	s := c.sessions[user]
	c.mu.Unlock()
	if s == nil {
		return
	}
	s.mu.Lock()
	if s.id == sid {
		s.id = ""
	}
	s.mu.Unlock()
}

// initialize opens an upstream MCP session with the given initialize params
// and sends notifications/initialized. It returns the session id and the raw
// initialize response.
func (c *Client) initialize(ctx context.Context, base, tok string, params json.RawMessage) (string, rawResponse, error) {
	id := c.nextID.Add(1)
	body, _ := json.Marshal(rpcRequest{JSONRPC: "2.0", ID: id, Method: "initialize", Params: params})
	resp, err := c.post(ctx, base, tok, "", body)
	if err != nil {
		return "", resp, err
	}
	if resp.status != http.StatusOK {
		return "", resp, &HTTPError{resp.status, errorMessage(resp.body)}
	}
	msg, err := parseRPC(resp.header.Get("content-type"), resp.body, id)
	if err != nil {
		return "", resp, err
	}
	if msg.Error != nil {
		return "", resp, msg.Error
	}
	sid := resp.header.Get("mcp-session-id")
	if sid == "" {
		return "", resp, errors.New("t3client: initialize returned no mcp-session-id")
	}
	note, err := c.post(ctx, base, tok, sid, []byte(`{"jsonrpc":"2.0","method":"notifications/initialized"}`))
	if err != nil {
		return "", resp, err
	}
	if note.status/100 != 2 {
		return "", resp, &HTTPError{note.status, "notifications/initialized: " + errorMessage(note.body)}
	}
	return sid, resp, nil
}

type rawResponse struct {
	status int
	header http.Header
	body   []byte
}

func (c *Client) post(ctx context.Context, base, tok, sid string, body []byte) (rawResponse, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/mcp", bytes.NewReader(body))
	if err != nil {
		return rawResponse{}, err
	}
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("content-type", "application/json")
	req.Header.Set("authorization", "Bearer "+tok)
	if sid != "" {
		req.Header.Set("mcp-session-id", sid)
		req.Header.Set("mcp-protocol-version", ProtocolVersion)
	}
	resp, err := httpClient(c.cfg.HTTP).Do(req)
	if err != nil {
		return rawResponse{}, fmt.Errorf("t3client: %w", err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return rawResponse{}, fmt.Errorf("t3client: read /mcp: %w", err)
	}
	return rawResponse{status: resp.StatusCode, header: resp.Header, body: b}, nil
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int64           `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcMessage struct {
	ID     json.RawMessage `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *RPCError       `json:"error"`
}

// parseRPC finds the response with the given id in a JSON or an SSE body. T3
// answers in JSON mode, and the SSE path is there in case a later version
// streams.
func parseRPC(contentType string, body []byte, id int64) (rpcMessage, error) {
	want := fmt.Sprint(id)
	if strings.HasPrefix(strings.ToLower(contentType), "text/event-stream") {
		sc := bufio.NewScanner(bytes.NewReader(body))
		sc.Buffer(make([]byte, 64<<10), maxBody)
		for sc.Scan() {
			line, ok := strings.CutPrefix(sc.Text(), "data:")
			if !ok {
				continue
			}
			var m rpcMessage
			if json.Unmarshal([]byte(strings.TrimSpace(line)), &m) == nil && string(m.ID) == want {
				return m, nil
			}
		}
		return rpcMessage{}, errors.New("t3client: no response in the event stream")
	}
	var m rpcMessage
	if err := json.Unmarshal(body, &m); err != nil {
		return rpcMessage{}, fmt.Errorf("t3client: parse /mcp response: %w", err)
	}
	if string(m.ID) != want {
		return rpcMessage{}, fmt.Errorf("t3client: response id %s, want %s", m.ID, want)
	}
	return m, nil
}

func toolResult(tool string, msg rpcMessage) (json.RawMessage, error) {
	if msg.Error != nil {
		return nil, msg.Error
	}
	var r struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		StructuredContent json.RawMessage `json:"structuredContent"`
		IsError           bool            `json:"isError"`
	}
	if err := json.Unmarshal(msg.Result, &r); err != nil {
		return nil, fmt.Errorf("t3client: %s result: %w", tool, err)
	}
	text := ""
	if len(r.Content) > 0 {
		text = r.Content[0].Text
	}
	if r.IsError {
		var f struct {
			Tag     string `json:"_tag"`
			Code    string `json:"code"`
			Message string `json:"message"`
		}
		if json.Unmarshal([]byte(text), &f) == nil && (f.Code != "" || f.Message != "") {
			return nil, &ToolError{Tool: tool, Code: f.Code, Message: f.Message}
		}
		return nil, &ToolError{Tool: tool, Message: text}
	}
	if len(r.StructuredContent) > 0 && string(r.StructuredContent) != "null" {
		return r.StructuredContent, nil
	}
	if json.Valid([]byte(text)) {
		return json.RawMessage(text), nil
	}
	b, _ := json.Marshal(text)
	return b, nil
}

// resultOf is the result label for a call: a small fixed set, so the label
// never carries anything a caller typed.
func resultOf(err error) string {
	var (
		te *ToolError
		re *RPCError
		he *HTTPError
		ae *AuthError
		ue *url.Error
	)
	switch {
	case err == nil:
		return "ok"
	case errors.As(err, &te):
		return "tool_error"
	case errors.As(err, &re):
		return "rpc_error"
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.As(err, &ue):
		// Before AuthError: a sign-in that could not reach T3 is T3 being
		// down, not a credential problem.
		return "unreachable"
	case errors.As(err, &ae):
		return "auth_error"
	case errors.As(err, &he) && he.Status == http.StatusUnauthorized:
		return "auth_error"
	case errors.As(err, &he):
		return "http_error"
	default:
		return "unreachable"
	}
}

func (c *Client) record(user, tool string, err error) {
	if c.cfg.Metrics == nil {
		return
	}
	result := resultOf(err)
	c.cfg.Metrics.AddCounter(MetricCalls, map[string]string{
		"service": c.cfg.Service, "user": user, "tool": tool, "result": result,
	})
	if result == "ok" {
		c.cfg.Metrics.SetGauge(MetricLastSuccess, map[string]string{"service": c.cfg.Service, "user": user},
			float64(c.now().Unix()))
	}
}
