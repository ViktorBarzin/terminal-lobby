package t3client

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// DefaultRenewAfter is how old a token gets before it is replaced. T3 issues
// MCP tokens for 30 days with no refresh grant, so renewing at 20 leaves ten
// days for a broken t3-mint to be noticed and fixed.
const DefaultRenewAfter = 20 * 24 * time.Hour

// redirectURI is never visited: the decision call returns the redirect as
// data, and the code is read out of it.
const redirectURI = "http://127.0.0.1:1/cb"

// Minter makes a single-use T3 pairing code for a user.
type Minter interface {
	Mint(ctx context.Context, user string) (string, error)
}

// MinterFunc adapts a function to Minter.
type MinterFunc func(ctx context.Context, user string) (string, error)

func (f MinterFunc) Mint(ctx context.Context, user string) (string, error) { return f(ctx, user) }

// ExecMinter runs a command that prints `t3 auth pairing create --json`.
type ExecMinter struct {
	Argv func(user string) []string
}

// SudoMinter runs `sudo -n /usr/local/bin/t3-mint <user>`, which checks the
// user is a mapped T3 user and mints as that user. The lobby's sudoers entry
// allows exactly this.
func SudoMinter() ExecMinter {
	return ExecMinter{Argv: func(user string) []string {
		return []string{"sudo", "-n", "/usr/local/bin/t3-mint", user}
	}}
}

func (m ExecMinter) Mint(ctx context.Context, user string) (string, error) {
	if err := validUser(user); err != nil {
		return "", err
	}
	argv := m.Argv(user)
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("t3client: mint for %s: %v: %s", user, err, strings.TrimSpace(stderr.String()))
	}
	return ParsePairing(out)
}

// ParsePairing reads the credential out of `t3 auth pairing create --json`.
func ParsePairing(out []byte) (string, error) {
	var p struct {
		Credential string `json:"credential"`
	}
	if err := json.Unmarshal(out, &p); err != nil {
		return "", fmt.Errorf("t3client: pairing output: %w", err)
	}
	if p.Credential == "" {
		return "", errors.New("t3client: pairing output has no credential")
	}
	return p.Credential, nil
}

// Token is one MCP access token as the store keeps it.
type Token struct {
	AccessToken string    `json:"access_token"`
	Label       string    `json:"label"`
	ClientID    string    `json:"client_id"`
	IssuedAt    time.Time `json:"issued_at"`
	ExpiresAt   time.Time `json:"expires_at"`
}

// ErrNoToken is returned by TokenStore.Load when the user has none.
var ErrNoToken = errors.New("t3client: no stored token")

// TokenStore keeps one token per user as <Dir>/t3-token-<user>.json, mode
// 0600, replaced atomically.
type TokenStore struct {
	Dir string
}

func (s TokenStore) path(user string) (string, error) {
	if err := validUser(user); err != nil {
		return "", err
	}
	if s.Dir == "" {
		return "", errors.New("t3client: TokenStore has no directory")
	}
	return filepath.Join(s.Dir, "t3-token-"+user+".json"), nil
}

// Load reads the user's token. A file readable by anyone but its owner is
// refused rather than trusted.
func (s TokenStore) Load(user string) (Token, error) {
	p, err := s.path(user)
	if err != nil {
		return Token{}, err
	}
	f, err := os.Open(p)
	if errors.Is(err, os.ErrNotExist) {
		return Token{}, ErrNoToken
	}
	if err != nil {
		return Token{}, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return Token{}, err
	}
	if fi.Mode().Perm()&0o077 != 0 {
		return Token{}, fmt.Errorf("t3client: %s has mode %v, want 0600", p, fi.Mode().Perm())
	}
	var t Token
	if err := json.NewDecoder(io.LimitReader(f, 1<<16)).Decode(&t); err != nil {
		return Token{}, fmt.Errorf("t3client: %s: %w", p, err)
	}
	if t.AccessToken == "" {
		return Token{}, ErrNoToken
	}
	return t, nil
}

// Save writes the user's token through a temp file and a rename.
func (s TokenStore) Save(user string, t Token) error {
	p, err := s.path(user)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return err
	}
	b, err := json.Marshal(t)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(s.Dir, ".t3-token-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// Credentials hands out a live MCP token per user, minting one when there is
// none, renewing it after RenewAfter, and renewing at once when the server
// refuses it. Safe for concurrent use; one user mints at most once at a time.
type Credentials struct {
	// Label names the token in the user's T3 (Settings > Access). Use the
	// service name.
	Label  string
	Minter Minter
	Store  TokenStore
	HTTP   *http.Client
	// Now defaults to time.Now; RenewAfter to DefaultRenewAfter.
	Now        func() time.Time
	RenewAfter time.Duration
	// Logf, when set, hears about renewals that failed but left a live
	// token in place.
	Logf func(format string, args ...any)

	mu    sync.Mutex
	users map[string]*userCreds
}

type userCreds struct {
	mu  sync.Mutex
	tok *Token
}

func (c *Credentials) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

func (c *Credentials) renewAfter() time.Duration {
	if c.RenewAfter > 0 {
		return c.RenewAfter
	}
	return DefaultRenewAfter
}

func (c *Credentials) user(user string) *userCreds {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.users == nil {
		c.users = map[string]*userCreds{}
	}
	u := c.users[user]
	if u == nil {
		u = &userCreds{}
		c.users[user] = u
	}
	return u
}

// load returns the cached or stored token. Caller holds u.mu.
func (c *Credentials) load(u *userCreds, user string) *Token {
	if u.tok != nil {
		return u.tok
	}
	t, err := c.Store.Load(user)
	if err != nil {
		if !errors.Is(err, ErrNoToken) && c.Logf != nil {
			c.Logf("t3client: ignoring stored token for %s: %v", user, err)
		}
		return nil
	}
	u.tok = &t
	return u.tok
}

// Token returns a live access token for the user's server at baseURL.
func (c *Credentials) Token(ctx context.Context, user, baseURL string) (string, error) {
	if err := validUser(user); err != nil {
		return "", err
	}
	u := c.user(user)
	u.mu.Lock()
	defer u.mu.Unlock()
	now := c.now()
	t := c.load(u, user)
	if t != nil && now.Sub(t.IssuedAt) < c.renewAfter() && now.Before(t.ExpiresAt) {
		return t.AccessToken, nil
	}
	fresh, err := c.mint(ctx, user, baseURL)
	if err == nil {
		u.tok = &fresh
		return fresh.AccessToken, nil
	}
	if t != nil && now.Before(t.ExpiresAt) {
		if c.Logf != nil {
			c.Logf("t3client: renewing the token for %s failed, keeping the current one until %s: %v", user, t.ExpiresAt.Format(time.RFC3339), err)
		}
		return t.AccessToken, nil
	}
	return "", err
}

// Renew replaces a token the server refused. stale is the token that was
// refused: when another goroutine has already replaced it, the replacement is
// returned and nothing is minted.
func (c *Credentials) Renew(ctx context.Context, user, baseURL, stale string) (string, error) {
	if err := validUser(user); err != nil {
		return "", err
	}
	u := c.user(user)
	u.mu.Lock()
	defer u.mu.Unlock()
	if t := c.load(u, user); t != nil && t.AccessToken != stale && c.now().Before(t.ExpiresAt) {
		return t.AccessToken, nil
	}
	fresh, err := c.mint(ctx, user, baseURL)
	if err != nil {
		return "", err
	}
	u.tok = &fresh
	return fresh.AccessToken, nil
}

// mint runs the whole sign-in and stores the result. Caller holds u.mu.
func (c *Credentials) mint(ctx context.Context, user, baseURL string) (Token, error) {
	if c.Minter == nil {
		return Token{}, errors.New("t3client: no Minter")
	}
	code, err := c.Minter.Mint(ctx, user)
	if err != nil {
		return Token{}, err
	}
	t, err := Authorize(ctx, c.HTTP, baseURL, c.Label, code, c.now())
	if err != nil {
		return Token{}, err
	}
	if err := c.Store.Save(user, t); err != nil {
		return Token{}, fmt.Errorf("t3client: store token for %s: %w", user, err)
	}
	return t, nil
}

// Authorize turns a pairing code into a full-access MCP token without a
// browser: register a public client, approve the authorization request with
// the pairing code, and exchange the returned code with PKCE. The client is
// registered every time, which costs nothing: T3's client ids are signed,
// stateless descriptions of the registration.
func Authorize(ctx context.Context, hc *http.Client, baseURL, label, pairingCode string, now time.Time) (Token, error) {
	hc = httpClient(hc)
	if label == "" {
		label = "t3client"
	}
	resource := baseURL + "/mcp"

	var reg struct {
		ClientID string `json:"client_id"`
	}
	if err := postJSON(ctx, hc, baseURL+"/oauth/mcp/register", map[string]any{
		"client_name":                label,
		"redirect_uris":              []string{redirectURI},
		"token_endpoint_auth_method": "none",
	}, &reg); err != nil {
		return Token{}, fmt.Errorf("t3client: register: %w", err)
	}
	if reg.ClientID == "" {
		return Token{}, errors.New("t3client: register returned no client_id")
	}

	verifier := randomString(48)
	sum := sha256.Sum256([]byte(verifier))
	state := randomString(16)
	var dec struct {
		RedirectTo string `json:"redirectTo"`
	}
	if err := postJSON(ctx, hc, baseURL+"/oauth/mcp/decision", map[string]any{
		"authorization": map[string]any{
			"response_type":         "code",
			"client_id":             reg.ClientID,
			"redirect_uri":          redirectURI,
			"code_challenge":        base64.RawURLEncoding.EncodeToString(sum[:]),
			"code_challenge_method": "S256",
			"state":                 state,
			"resource":              resource,
		},
		"decision": map[string]any{"_tag": "pairing-code", "access": "full-access", "code": pairingCode},
	}, &dec); err != nil {
		return Token{}, fmt.Errorf("t3client: decision: %w", err)
	}
	ru, err := url.Parse(dec.RedirectTo)
	if err != nil {
		return Token{}, fmt.Errorf("t3client: decision redirect: %w", err)
	}
	q := ru.Query()
	if q.Get("state") != state || q.Get("code") == "" {
		return Token{}, errors.New("t3client: decision redirect has no code or a different state")
	}

	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {q.Get("code")},
		"redirect_uri":  {redirectURI},
		"client_id":     {reg.ClientID},
		"code_verifier": {verifier},
		"resource":      {resource},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/oauth/mcp/token", strings.NewReader(form.Encode()))
	if err != nil {
		return Token{}, err
	}
	req.Header.Set("content-type", "application/x-www-form-urlencoded")
	var tr struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
	}
	if err := doJSON(hc, req, &tr); err != nil {
		return Token{}, fmt.Errorf("t3client: token: %w", err)
	}
	if tr.AccessToken == "" || tr.ExpiresIn <= 0 {
		return Token{}, errors.New("t3client: token response has no access_token or expires_in")
	}
	return Token{
		AccessToken: tr.AccessToken,
		Label:       label,
		ClientID:    reg.ClientID,
		IssuedAt:    now.UTC(),
		ExpiresAt:   now.Add(time.Duration(tr.ExpiresIn) * time.Second).UTC(),
	}, nil
}

func postJSON(ctx context.Context, hc *http.Client, u string, in, out any) error {
	b, err := json.Marshal(in)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	return doJSON(hc, req, out)
}

func doJSON(hc *http.Client, req *http.Request, out any) error {
	resp, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, errorMessage(body))
	}
	return json.Unmarshal(body, out)
}

// errorMessage pulls a readable message out of an error body without echoing
// anything that could be a credential.
func errorMessage(body []byte) string {
	var e struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if json.Unmarshal(body, &e) == nil && (e.Message != "" || e.Error != "") {
		return strings.TrimSpace(e.Error + " " + e.Message)
	}
	if len(body) > 200 {
		body = body[:200]
	}
	return strings.TrimSpace(string(body))
}

func randomString(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
