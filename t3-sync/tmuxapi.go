package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"
)

// The lobby's own API, at 127.0.0.1:7684. The syncer reaches for it rather than
// for tmux directly whenever a change has to be VISIBLE to the lobby.
//
// Renaming is the clear case: session names are the key that layout assignments
// and project membership are stored under, so `tmux rename-session` on its own
// leaves a session silently outside its project. Killing goes the same way,
// because tmux-api's kill also drops the layout assignment and the persistence
// manifest row — a session killed behind its back would be resurrected by the
// next Restore.
//
// It is also why the syncer's own view of tmux (see tmuxSource) is READ-ONLY:
// every mutation this daemon makes to a session goes through here.

// defaultTmuxAPIEndpoint is where tmux-api listens on this box.
const defaultTmuxAPIEndpoint = "http://127.0.0.1:7684"

// tmuxAuthHeader is the header tmux-api authenticates with. The reverse proxy
// in front of the lobby sets it; a loopback client supplies it itself and is
// trusted because tmux-api is not reachable from outside the box.
//
// The name is configuration (TL_AUTH_HEADER), and this client has to agree with
// the server about it, so it reads the same variable from the same
// EnvironmentFile rather than hard-coding a second answer.
func tmuxAuthHeader() string {
	if h := strings.TrimSpace(os.Getenv("TL_AUTH_HEADER")); h != "" {
		return h
	}
	return "X-Forwarded-User"
}

// tmuxProxySecret is sent when the services are configured to require one.
// Empty means the server is not checking, which is the default.
func tmuxProxySecret() string { return os.Getenv("TL_PROXY_SECRET") }

// DefaultUserMapPath is the identity→OS-user map tmux-api itself reads. The
// syncer reads it backwards: it knows its OS user and needs the auth identity
// that maps to it.
const DefaultUserMapPath = "/etc/ttyd-user-map"

// sessionNameRe is tmux-api's own accepted session name, copied so a bad name
// fails here with a useful message instead of as a 400 from the far side.
var sessionNameRe = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,32}$`)

// TmuxAPI is a client for one user's view of tmux-api.
type TmuxAPI struct {
	endpoint string
	authUser string
	http     *http.Client
}

// NewTmuxAPI builds a client that acts as one Authentik identity.
func NewTmuxAPI(endpoint, authUser string) *TmuxAPI {
	return &TmuxAPI{
		endpoint: strings.TrimSuffix(endpoint, "/"),
		authUser: authUser,
		http:     &http.Client{Timeout: 15 * time.Second},
	}
}

// TmuxAPIError is a non-2xx answer from tmux-api.
type TmuxAPIError struct {
	Op      string
	Session string
	Status  int
	Body    string
}

func (e *TmuxAPIError) Error() string {
	return fmt.Sprintf("tmux-api %s %s: HTTP %d: %s", e.Op, e.Session, e.Status, strings.TrimSpace(e.Body))
}

// Gone reports that the session was not there. For a kill that is the intended
// end state; for a rename it means the correction has been overtaken by events.
func (e *TmuxAPIError) Gone() bool { return e.Status == http.StatusNotFound }

// Rename renames a session, carrying its layout and project assignment with it.
func (t *TmuxAPI) Rename(ctx context.Context, session, newName string) error {
	if !sessionNameRe.MatchString(session) {
		return fmt.Errorf("tmux-api rename: %q is not a valid session name", session)
	}
	if !sessionNameRe.MatchString(newName) {
		return fmt.Errorf("tmux-api rename %s: %q is not a valid session name", session, newName)
	}
	body, err := json.Marshal(struct {
		Name string `json:"name"`
	}{newName})
	if err != nil {
		return fmt.Errorf("tmux-api rename %s: %w", session, err)
	}
	return t.do(ctx, http.MethodPost, "/sessions/"+session+"/rename", "rename", session, body, nil)
}

// Kill destroys a session and everything running in it.
//
// This is the one irreversible thing the syncer does, and it happens for one
// reason: a thread was DELETED in T3, which is a deliberate destruction that
// crosses surfaces (decision 3). An archived thread, a reaped bridge and an
// OOM-killed Claude all reach here never.
//
// A session that is already gone counts as done. The syncer races tmux by
// construction — a Claude can exit between the snapshot and the dispatch — and
// a 404 means the world is already in the state the kill was asking for.
func (t *TmuxAPI) Kill(ctx context.Context, session string) error {
	if !sessionNameRe.MatchString(session) {
		return fmt.Errorf("tmux-api kill: %q is not a valid session name", session)
	}
	return t.do(ctx, http.MethodDelete, "/sessions/"+session, "kill", session, nil,
		map[int]bool{http.StatusNotFound: true})
}

// do performs one request, treating the statuses in okStatus as success.
func (t *TmuxAPI) do(ctx context.Context, method, path, op, session string, body []byte, okStatus map[int]bool) error {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, t.endpoint+path, reader)
	if err != nil {
		return fmt.Errorf("tmux-api %s %s: %w", op, session, err)
	}
	req.Header.Set(tmuxAuthHeader(), t.authUser)
	if secret := tmuxProxySecret(); secret != "" {
		req.Header.Set("X-TL-Proxy-Secret", secret)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := t.http.Do(req)
	if err != nil {
		return fmt.Errorf("tmux-api %s %s: %w", op, session, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
	if resp.StatusCode/100 == 2 || okStatus[resp.StatusCode] {
		return nil
	}
	return &TmuxAPIError{Op: op, Session: session, Status: resp.StatusCode, Body: string(raw)}
}

// AuthUserForOSUser reverses tmux-api's user map: given the OS user this syncer
// runs as, it returns the Authentik identity tmux-api will map back to it.
//
// The file is the one tmux-api itself reads, so the two cannot disagree about
// who is who. Lines are `<authentik_user>=<os_user>`, with `#` comments and an
// optional `:<extra>` suffix on the right-hand side that tmux-api strips — this
// strips it the same way, because it is not part of the OS user's name.
//
// A missing or unreadable map is not an error: it means "no mapping", and the
// caller falls back to the OS user's own name, which is right on a box where
// the two are the same.
func AuthUserForOSUser(mapPath, osUser string) (string, bool) {
	f, err := os.Open(mapPath)
	if err != nil {
		return "", false
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		auth, rhs, found := strings.Cut(line, "=")
		if !found {
			continue
		}
		auth = strings.TrimSpace(auth)
		rhs = strings.TrimSpace(rhs)
		if i := strings.IndexByte(rhs, ':'); i > 0 {
			rhs = rhs[:i]
		}
		if auth == "" || rhs == "" {
			continue
		}
		if rhs == osUser {
			return auth, true
		}
	}
	return "", false
}
