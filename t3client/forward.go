package t3client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// How the pass-through works (agent-api's POST /mcp).
//
// A caller (Muse, the WhatsApp bot) speaks MCP to agent-api with its own
// agent-api bearer, and agent-api forwards each JSON-RPC message to the
// caller's OS user's T3 with agent-api's T3 token. The bodies go through
// unchanged; three things do not:
//
//   - The bearer. The caller never holds a T3 credential.
//   - The session id. The caller's initialize opens an upstream session, and
//     the caller is handed an id of ours that maps to it. The map is keyed by
//     that id and records the caller and user it belongs to, so each caller
//     has its own T3 session and cannot use another's.
//   - Recovery. T3 keeps sessions in memory. When a forwarded message gets a
//     404 after a T3 restart, the client replays the caller's own initialize
//     params upstream, sends notifications/initialized, points the caller's
//     id at the new upstream session and retries once. The caller never sees
//     the restart. A 401 renews agent-api's token and retries once.
//
// The alternative, rewriting the caller's messages into Client.Call, would
// have meant re-implementing every MCP method T3 serves (tools/list,
// completions, logging) and following T3 as it adds more. Forwarding bodies
// as they are keeps T3's tool set and its schema errors exactly as T3 states
// them.

const (
	fwdIdle      = 24 * time.Hour
	fwdPerCaller = 32
)

// ForwardRequest is one message a caller sent to POST /mcp.
type ForwardRequest struct {
	// CallerID identifies the authenticated caller; sessions never cross it.
	CallerID string
	// User is the OS user whose T3 the caller reaches.
	User string
	// SessionID is the caller's mcp-session-id header, empty on initialize.
	SessionID string
	// ProtocolVersion is the caller's mcp-protocol-version header, if any.
	ProtocolVersion string
	Body            []byte
}

// ForwardResponse is what to send back to the caller.
type ForwardResponse struct {
	Status int
	// Header carries content-type, mcp-session-id (the caller's id, not
	// T3's) and mcp-protocol-version when T3 sent them.
	Header http.Header
	Body   []byte

	local bool  // answered here without reaching T3
	cause error // overrides how the metrics classify the answer
}

type fwdSession struct {
	mu       sync.Mutex
	caller   string
	user     string
	upstream string
	params   json.RawMessage // the caller's initialize params, for replay
	proto    string
	last     time.Time
}

type forwardSessions struct {
	mu sync.Mutex
	m  map[string]*fwdSession
}

var toolLabelRe = regexp.MustCompile(`^t3_[a-z0-9_]{1,48}$`)

// Forward sends one caller message to the user's T3. It returns an error only
// when T3 could not be reached or no credential could be had; protocol
// failures come back as a response for the caller.
func (c *Client) Forward(ctx context.Context, r ForwardRequest) (ForwardResponse, error) {
	ctx, cancel := c.withTimeout(ctx)
	defer cancel()

	var msg struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	trimmed := bytes.TrimSpace(r.Body)
	if len(trimmed) > 0 && trimmed[0] == '[' {
		return rpcFailure(http.StatusBadRequest, nil, -32600, "batched JSON-RPC is not supported"), nil
	}
	if err := json.Unmarshal(trimmed, &msg); err != nil || msg.Method == "" {
		return rpcFailure(http.StatusBadRequest, nil, -32700, "a JSON-RPC message with a method is required"), nil
	}
	label := methodLabel(msg.Method, msg.Params)

	var (
		resp ForwardResponse
		err  error
	)
	if msg.Method == "initialize" {
		resp, err = c.forwardInitialize(ctx, r, msg.Params)
	} else {
		resp, err = c.forwardMessage(ctx, r, msg.ID)
	}
	if !resp.local {
		c.recordForward(r.User, label, resp, err)
	}
	return resp, err
}

func (c *Client) forwardInitialize(ctx context.Context, r ForwardRequest, params json.RawMessage) (ForwardResponse, error) {
	base, err := c.cfg.Locator.BaseURL(r.User)
	if err != nil {
		return ForwardResponse{}, err
	}
	var raw rawResponse
	for renewed := false; ; renewed = true {
		tok, err := c.cfg.Credentials.Token(ctx, r.User, base)
		if err != nil {
			return ForwardResponse{}, &AuthError{err}
		}
		raw, err = c.postProto(ctx, base, tok, "", "", r.Body)
		if err != nil {
			return ForwardResponse{}, err
		}
		if raw.status == http.StatusUnauthorized && !renewed {
			if _, err := c.cfg.Credentials.Renew(ctx, r.User, base, tok); err != nil {
				return ForwardResponse{}, &AuthError{err}
			}
			continue
		}
		break
	}
	upstream := raw.header.Get("mcp-session-id")
	if raw.status != http.StatusOK || upstream == "" {
		return c.forwardResponse(raw, ""), nil
	}
	id := "tl-" + randomString(24)
	c.putForward(id, &fwdSession{
		caller: r.CallerID, user: r.User, upstream: upstream, params: params,
		proto: raw.header.Get("mcp-protocol-version"), last: c.now(),
	})
	return c.forwardResponse(raw, id), nil
}

func (c *Client) forwardMessage(ctx context.Context, r ForwardRequest, id json.RawMessage) (ForwardResponse, error) {
	if r.SessionID == "" {
		return rpcFailure(http.StatusBadRequest, id, -32000, "mcp-session-id is required; send initialize first"), nil
	}
	s := c.getForward(r.SessionID, r.CallerID, r.User)
	if s == nil {
		return rpcFailure(http.StatusNotFound, id, -32001, "session not found; initialize again"), nil
	}
	base, err := c.cfg.Locator.BaseURL(r.User)
	if err != nil {
		return ForwardResponse{}, err
	}
	proto := r.ProtocolVersion
	var renewed, reinit bool
	for {
		tok, err := c.cfg.Credentials.Token(ctx, r.User, base)
		if err != nil {
			return ForwardResponse{}, &AuthError{err}
		}
		s.mu.Lock()
		upstream := s.upstream
		if proto == "" {
			proto = s.proto
		}
		s.mu.Unlock()
		raw, err := c.postProto(ctx, base, tok, upstream, proto, r.Body)
		if err != nil {
			return ForwardResponse{}, err
		}
		switch {
		case raw.status == http.StatusUnauthorized && !renewed:
			renewed = true
			if _, err := c.cfg.Credentials.Renew(ctx, r.User, base, tok); err != nil {
				return ForwardResponse{}, &AuthError{err}
			}
			continue
		case raw.status == http.StatusNotFound && !reinit:
			reinit = true
			if err := c.reinitForward(ctx, s, base, upstream); err != nil {
				var he *HTTPError
				if errors.As(err, &he) && he.Status == http.StatusUnauthorized && !renewed {
					renewed = true
					reinit = false
					if _, err := c.cfg.Credentials.Renew(ctx, r.User, base, tok); err != nil {
						return ForwardResponse{}, &AuthError{err}
					}
					continue
				}
				return ForwardResponse{}, err
			}
			continue
		case raw.status == http.StatusUnauthorized:
			// T3 refused agent-api's own credential twice; that is not
			// something the caller can fix by signing in again.
			f := rpcFailure(http.StatusBadGateway, id, -32603, "T3 refused the lobby's credential")
			f.local, f.cause = false, &HTTPError{Status: http.StatusUnauthorized}
			return f, nil
		}
		s.mu.Lock()
		s.last = c.now()
		s.mu.Unlock()
		return c.forwardResponse(raw, r.SessionID), nil
	}
}

// reinitForward replays the caller's initialize upstream, unless another
// request already did since stale was read.
func (c *Client) reinitForward(ctx context.Context, s *fwdSession, base, stale string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.upstream != stale {
		return nil
	}
	tok, err := c.cfg.Credentials.Token(ctx, s.user, base)
	if err != nil {
		return &AuthError{err}
	}
	sid, raw, err := c.initialize(ctx, base, tok, s.params)
	if err != nil {
		return err
	}
	s.upstream = sid
	if v := raw.header.Get("mcp-protocol-version"); v != "" {
		s.proto = v
	}
	return nil
}

// EndForward forgets a caller's session (the caller's DELETE /mcp) and closes
// the upstream one. A session that is not the caller's is left alone.
func (c *Client) EndForward(ctx context.Context, callerID, user, sessionID string) {
	s := c.getForward(sessionID, callerID, user)
	if s == nil {
		return
	}
	c.fwd.mu.Lock()
	delete(c.fwd.m, sessionID)
	c.fwd.mu.Unlock()
	base, err := c.cfg.Locator.BaseURL(user)
	if err != nil {
		return
	}
	tok, err := c.cfg.Credentials.Token(ctx, user, base)
	if err != nil {
		return
	}
	s.mu.Lock()
	upstream := s.upstream
	s.mu.Unlock()
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, base+"/mcp", nil)
	if err != nil {
		return
	}
	req.Header.Set("authorization", "Bearer "+tok)
	req.Header.Set("mcp-session-id", upstream)
	if resp, err := httpClient(c.cfg.HTTP).Do(req); err == nil {
		resp.Body.Close()
	}
}

func (c *Client) getForward(id, caller, user string) *fwdSession {
	c.fwd.mu.Lock()
	defer c.fwd.mu.Unlock()
	s := c.fwd.m[id]
	if s == nil || s.caller != caller || s.user != user {
		return nil
	}
	return s
}

// putForward stores a session, dropping ones idle for a day and keeping each
// caller to its fwdPerCaller most recent.
func (c *Client) putForward(id string, s *fwdSession) {
	c.fwd.mu.Lock()
	defer c.fwd.mu.Unlock()
	if c.fwd.m == nil {
		c.fwd.m = map[string]*fwdSession{}
	}
	now := c.now()
	type aged struct {
		id   string
		last time.Time
	}
	var mine []aged
	for k, v := range c.fwd.m {
		v.mu.Lock()
		last := v.last
		v.mu.Unlock()
		if now.Sub(last) > fwdIdle {
			delete(c.fwd.m, k)
			continue
		}
		if v.caller == s.caller {
			mine = append(mine, aged{k, last})
		}
	}
	if over := len(mine) + 1 - fwdPerCaller; over > 0 {
		sort.Slice(mine, func(i, j int) bool { return mine[i].last.Before(mine[j].last) })
		for _, a := range mine[:over] {
			delete(c.fwd.m, a.id)
		}
	}
	c.fwd.m[id] = s
}

func (c *Client) forwardResponse(raw rawResponse, sessionID string) ForwardResponse {
	h := http.Header{}
	for _, k := range []string{"content-type", "mcp-protocol-version"} {
		if v := raw.header.Get(k); v != "" {
			h.Set(k, v)
		}
	}
	if sessionID != "" {
		h.Set("mcp-session-id", sessionID)
	}
	return ForwardResponse{Status: raw.status, Header: h, Body: raw.body}
}

func rpcFailure(status int, id json.RawMessage, code int, message string) ForwardResponse {
	if len(id) == 0 {
		id = json.RawMessage("null")
	}
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": message}})
	h := http.Header{}
	h.Set("content-type", "application/json")
	return ForwardResponse{Status: status, Header: h, Body: b, local: true}
}

// methodLabel bounds the metric's tool label: a T3-shaped tool name, a known
// MCP method, or "other". Callers choose these strings, so nothing else
// reaches a label.
func methodLabel(method string, params json.RawMessage) string {
	switch {
	case method == "tools/call":
		var p struct {
			Name string `json:"name"`
		}
		json.Unmarshal(params, &p)
		if toolLabelRe.MatchString(p.Name) {
			return p.Name
		}
		return "other"
	case strings.HasPrefix(method, "notifications/"):
		return "notifications"
	}
	switch method {
	case "initialize", "ping", "tools/list", "resources/list", "prompts/list", "completion/complete", "logging/setLevel":
		return method
	}
	return "other"
}

func (c *Client) recordForward(user, label string, resp ForwardResponse, err error) {
	switch {
	case err != nil:
	case resp.cause != nil:
		err = resp.cause
	default:
		err = forwardOutcome(resp)
	}
	c.record(user, label, err)
}

// forwardOutcome classifies a response for the metrics the same way Call's
// errors are classified.
func forwardOutcome(r ForwardResponse) error {
	if r.Status == http.StatusAccepted {
		return nil
	}
	if r.Status != http.StatusOK {
		return &HTTPError{Status: r.Status}
	}
	var m struct {
		Error  *RPCError `json:"error"`
		Result struct {
			IsError bool `json:"isError"`
		} `json:"result"`
	}
	if json.Unmarshal(r.Body, &m) != nil {
		return nil // an event stream; T3 answered
	}
	if m.Error != nil {
		return m.Error
	}
	if m.Result.IsError {
		return &ToolError{}
	}
	return nil
}
