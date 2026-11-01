package t3client

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
)

// fakeT3 is an in-process stand-in for `t3 serve`: the headless OAuth routes,
// the environment descriptor, and /mcp in JSON response mode, with the
// shapes v0.1.5 returns.
type fakeT3 struct {
	t   *testing.T
	srv *httptest.Server

	mu         sync.Mutex
	codes      map[string]bool // live pairing codes
	authCodes  map[string]string
	tokens     map[string]bool
	sessions   map[string]bool
	initParams []json.RawMessage
	nextID     int
	registers  int
	issued     int
	inits      int
	calls      []fakeCall
	tool       func(name string, args map[string]any) (any, *fakeToolErr)
}

type fakeCall struct {
	Name string
	Args map[string]any
}

type fakeToolErr struct{ Code, Message string }

func newFakeT3(t *testing.T) *fakeT3 {
	f := &fakeT3{
		t:         t,
		codes:     map[string]bool{},
		authCodes: map[string]string{},
		tokens:    map[string]bool{},
		sessions:  map[string]bool{},
	}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeT3) id(prefix string) string {
	f.nextID++
	return fmt.Sprintf("%s-%d", prefix, f.nextID)
}

// mint issues a pairing code the way t3-mint would.
func (f *fakeT3) mint() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.id("PAIR")
	f.codes[c] = true
	return c
}

func (f *fakeT3) minter() MinterFunc {
	return func(ctx context.Context, user string) (string, error) { return f.mint(), nil }
}

// restart drops every MCP session, as a T3 restart does.
func (f *fakeT3) restart() {
	f.mu.Lock()
	f.sessions = map[string]bool{}
	f.mu.Unlock()
}

// revoke drops every access token.
func (f *fakeT3) revoke() {
	f.mu.Lock()
	f.tokens = map[string]bool{}
	f.mu.Unlock()
}

func (f *fakeT3) counts() (registers, issued, inits int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.registers, f.issued, f.inits
}

func (f *fakeT3) toolCalls() []fakeCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]fakeCall(nil), f.calls...)
}

func (f *fakeT3) serve(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/.well-known/t3/environment":
		w.Write([]byte(`{"environmentId":"env-fake","serverVersion":"0.1.5"}`))
	case "/oauth/mcp/register":
		var req struct {
			ClientName string   `json:"client_name"`
			Redirects  []string `json:"redirect_uris"`
			AuthMethod string   `json:"token_endpoint_auth_method"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ClientName == "" || len(req.Redirects) != 1 || req.AuthMethod != "none" {
			http.Error(w, `{"error":"invalid_client_metadata"}`, 400)
			return
		}
		f.mu.Lock()
		f.registers++
		f.mu.Unlock()
		writeJSON(w, 201, map[string]any{"client_id": "cid." + req.ClientName, "client_name": req.ClientName})
	case "/oauth/mcp/decision":
		var req struct {
			Authorization struct {
				ResponseType  string `json:"response_type"`
				ClientID      string `json:"client_id"`
				State         string `json:"state"`
				Resource      string `json:"resource"`
				RedirectURI   string `json:"redirect_uri"`
				CodeChallenge string `json:"code_challenge"`
				Method        string `json:"code_challenge_method"`
			} `json:"authorization"`
			Decision struct {
				Tag    string `json:"_tag"`
				Access string `json:"access"`
				Code   string `json:"code"`
			} `json:"decision"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		a := req.Authorization
		if a.Method != "S256" || a.Resource != f.srv.URL+"/mcp" || req.Decision.Tag != "pairing-code" || req.Decision.Access != "full-access" || !strings.HasPrefix(a.ClientID, "cid.") {
			writeJSON(w, 400, map[string]any{"_tag": "AuthMcpApprovalError", "message": "bad request"})
			return
		}
		f.mu.Lock()
		ok := f.codes[req.Decision.Code]
		delete(f.codes, req.Decision.Code)
		code := f.id("AUTH")
		if ok {
			f.authCodes[code] = a.CodeChallenge
		}
		f.mu.Unlock()
		if !ok {
			writeJSON(w, 400, map[string]any{"_tag": "AuthMcpApprovalError", "message": "That pairing code is unknown, expired, or already used."})
			return
		}
		writeJSON(w, 200, map[string]any{"redirectTo": a.RedirectURI + "?code=" + code + "&state=" + url.QueryEscape(a.State)})
	case "/oauth/mcp/token":
		if err := r.ParseForm(); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		sum := sha256.Sum256([]byte(r.PostForm.Get("code_verifier")))
		f.mu.Lock()
		want, ok := f.authCodes[r.PostForm.Get("code")]
		delete(f.authCodes, r.PostForm.Get("code"))
		good := ok && r.PostForm.Get("grant_type") == "authorization_code" &&
			base64.RawURLEncoding.EncodeToString(sum[:]) == want &&
			r.PostForm.Get("resource") == f.srv.URL+"/mcp"
		tok := f.id("TOKEN")
		if good {
			f.tokens[tok] = true
			f.issued++
		}
		f.mu.Unlock()
		if !good {
			writeJSON(w, 400, map[string]any{"error": "invalid_grant"})
			return
		}
		writeJSON(w, 200, map[string]any{"access_token": tok, "token_type": "Bearer", "expires_in": 2592000})
	case "/mcp":
		f.serveMCP(w, r)
	default:
		http.NotFound(w, r)
	}
}

func (f *fakeT3) serveMCP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || !strings.Contains(r.Header.Get("Accept"), "text/event-stream") || !strings.Contains(r.Header.Get("Accept"), "application/json") {
		http.Error(w, "bad request", 406)
		return
	}
	tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	f.mu.Lock()
	authed := f.tokens[tok]
	f.mu.Unlock()
	if !authed {
		writeJSON(w, 401, map[string]any{"error": "invalid_mcp_credential", "message": "A valid T3 Code MCP credential is required."})
		return
	}
	body, _ := io.ReadAll(r.Body)
	var msg struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(body, &msg); err != nil {
		http.Error(w, "parse error", 400)
		return
	}
	if msg.Method == "initialize" {
		f.mu.Lock()
		sid := f.id("sess")
		f.sessions[sid] = true
		f.inits++
		f.initParams = append(f.initParams, msg.Params)
		f.mu.Unlock()
		w.Header().Set("mcp-session-id", sid)
		writeJSON(w, 200, map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": map[string]any{
			"protocolVersion": "2025-06-18", "capabilities": map[string]any{"tools": map[string]any{}},
			"serverInfo": map[string]any{"name": "T3 Code", "version": "0.1.5"}}})
		return
	}
	f.mu.Lock()
	live := f.sessions[r.Header.Get("mcp-session-id")]
	f.mu.Unlock()
	if !live {
		w.WriteHeader(404)
		return
	}
	if r.Header.Get("mcp-protocol-version") != "2025-06-18" {
		http.Error(w, "bad protocol version", 400)
		return
	}
	if len(msg.ID) == 0 {
		w.WriteHeader(202)
		return
	}
	if msg.Method != "tools/call" {
		writeJSON(w, 200, map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": map[string]any{"tools": []any{}}})
		return
	}
	var p struct {
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	}
	json.Unmarshal(msg.Params, &p)
	f.mu.Lock()
	f.calls = append(f.calls, fakeCall{p.Name, p.Arguments})
	handler := f.tool
	f.mu.Unlock()
	if handler == nil {
		writeJSON(w, 200, map[string]any{"jsonrpc": "2.0", "id": msg.ID, "error": map[string]any{"code": -32602, "message": "Tool '" + p.Name + "' not found"}})
		return
	}
	out, terr := handler(p.Name, p.Arguments)
	if terr != nil {
		text, _ := json.Marshal(map[string]any{"_tag": "OrchestratorMcpFailure", "code": terr.Code, "message": terr.Message})
		writeJSON(w, 200, map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": map[string]any{
			"content": []any{map[string]any{"type": "text", "text": string(text)}}, "isError": true}})
		return
	}
	text, _ := json.Marshal(out)
	writeJSON(w, 200, map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": map[string]any{
		"content": []any{map[string]any{"type": "text", "text": string(text)}}, "structuredContent": out, "isError": false}})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
