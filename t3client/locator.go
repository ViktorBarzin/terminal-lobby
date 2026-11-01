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
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

// DefaultConfigDir holds t3-serve's per-user env files and dispatch.json.
const DefaultConfigDir = "/etc/t3-serve"

// PortLookup returns the loopback port of a user's t3 serve.
type PortLookup func(user string) (int, error)

// PortFromFiles reads T3_PORT from <dir>/<user>.env, and falls back to
// <dir>/dispatch.json when that file is missing or unreadable. On the devvm
// the env files are root-only (0600), so a lobby service running as its own
// user reads the port from dispatch.json, which t3-dispatch also reads and
// which is world-readable.
func PortFromFiles(dir string) PortLookup {
	return func(user string) (int, error) {
		if err := validUser(user); err != nil {
			return 0, err
		}
		b, envErr := os.ReadFile(filepath.Join(dir, user+".env"))
		if envErr == nil {
			return portFromEnv(b, user)
		}
		b, err := os.ReadFile(filepath.Join(dir, "dispatch.json"))
		if err != nil {
			return 0, fmt.Errorf("t3client: no T3 port for %s: %v; %v", user, envErr, err)
		}
		var routes map[string]struct {
			OSUser string `json:"os_user"`
			Port   int    `json:"port"`
		}
		if err := json.Unmarshal(b, &routes); err != nil {
			return 0, fmt.Errorf("t3client: parse dispatch.json: %w", err)
		}
		for _, r := range routes {
			if r.OSUser == user && r.Port > 0 && r.Port < 65536 {
				return r.Port, nil
			}
		}
		return 0, fmt.Errorf("t3client: user %s has no T3 server", user)
	}
}

func portFromEnv(b []byte, user string) (int, error) {
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		k, v, ok := strings.Cut(strings.TrimSpace(sc.Text()), "=")
		if !ok || k != "T3_PORT" {
			continue
		}
		p, err := strconv.Atoi(strings.Trim(v, `"'`))
		if err != nil || p <= 0 || p >= 65536 {
			return 0, fmt.Errorf("t3client: bad T3_PORT %q for %s", v, user)
		}
		return p, nil
	}
	return 0, fmt.Errorf("t3client: no T3_PORT in %s.env", user)
}

// Location is where one user's T3 server is.
type Location struct {
	User          string
	Port          int
	BaseURL       string // http://127.0.0.1:<port>
	EnvironmentID string
	Host          string // public host, no scheme
}

// Locator finds users' T3 servers. The zero value reads DefaultConfigDir and
// has no public hosts. Safe for concurrent use.
type Locator struct {
	Ports PortLookup
	Hosts Hosts
	HTTP  *http.Client

	mu  sync.Mutex
	env map[string]envEntry // by user
}

type envEntry struct {
	port int
	id   string
}

// BaseURL is the loopback URL of the user's server, without a trailing slash.
func (l *Locator) BaseURL(user string) (string, error) {
	p, err := l.port(user)
	if err != nil {
		return "", err
	}
	return "http://127.0.0.1:" + strconv.Itoa(p), nil
}

func (l *Locator) port(user string) (int, error) {
	if err := validUser(user); err != nil {
		return 0, err
	}
	ports := l.Ports
	if ports == nil {
		ports = PortFromFiles(DefaultConfigDir)
	}
	return ports(user)
}

// Locate returns the user's Location. The environment id is fetched once per
// user and port, since a server keeps it for its whole life.
func (l *Locator) Locate(ctx context.Context, user string) (Location, error) {
	p, err := l.port(user)
	if err != nil {
		return Location{}, err
	}
	loc := Location{User: user, Port: p, BaseURL: "http://127.0.0.1:" + strconv.Itoa(p), Host: l.Hosts.Host(user)}
	l.mu.Lock()
	e, ok := l.env[user]
	l.mu.Unlock()
	if ok && e.port == p {
		loc.EnvironmentID = e.id
		return loc, nil
	}
	id, err := fetchEnvironmentID(ctx, httpClient(l.HTTP), loc.BaseURL)
	if err != nil {
		return Location{}, err
	}
	l.mu.Lock()
	if l.env == nil {
		l.env = map[string]envEntry{}
	}
	l.env[user] = envEntry{port: p, id: id}
	l.mu.Unlock()
	loc.EnvironmentID = id
	return loc, nil
}

// Forget drops the cached environment id, for a caller that learned the
// server was replaced.
func (l *Locator) Forget(user string) {
	l.mu.Lock()
	delete(l.env, user)
	l.mu.Unlock()
}

func fetchEnvironmentID(ctx context.Context, hc *http.Client, base string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/.well-known/t3/environment", nil)
	if err != nil {
		return "", err
	}
	resp, err := hc.Do(req)
	if err != nil {
		return "", fmt.Errorf("t3client: environment: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", fmt.Errorf("t3client: environment: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("t3client: environment: HTTP %d", resp.StatusCode)
	}
	var d struct {
		EnvironmentID string `json:"environmentId"`
	}
	if err := json.Unmarshal(body, &d); err != nil {
		return "", fmt.Errorf("t3client: environment: %w", err)
	}
	if d.EnvironmentID == "" {
		return "", errors.New("t3client: environment: no environmentId")
	}
	return d.EnvironmentID, nil
}

func httpClient(c *http.Client) *http.Client {
	if c != nil {
		return c
	}
	return http.DefaultClient
}
