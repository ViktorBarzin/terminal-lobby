package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"terminal-lobby/telemetry"
)

// A guest is an account reaching a session it does not own, through a share
// or a project (ADR-0043). The request names the owner with ?owner=, and every
// route then runs as that owner, the way an administrator's ?as= does: the
// transcript is read through the owner's read child, and a prompt is typed
// into the owner's pane. tmux-api decides whether the caller may, so the
// terminal, the Text view and the composer answer the same question in one
// place (tmux-api/access.go).

// guestModeKey carries the mode a guest holds ("ro" or "rw") for the rest of
// the request. Empty on the owner's own requests.
const guestModeKey ctxKey = 100

func guestModeFrom(ctx context.Context) string {
	s, _ := ctx.Value(guestModeKey).(string)
	return s
}

// guestOwnerRe is the shape of an OS user name, which is all ?owner= may hold.
var guestOwnerRe = regexp.MustCompile(`^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,31}$`)

// guestAccess asks tmux-api how far caller may reach into owner's session:
// "rw", "ro", or "" for not at all. A var as a test seam.
var guestAccess = askTmuxAPIAccess

// guestRecheckEvery is how often a guest's open stream asks again, so a revoke
// ends their Text view and presence within this long. A var for the tests.
var guestRecheckEvery = 5 * time.Second

var (
	tmuxAPIAccessURL   = "http://127.0.0.1:7684/internal/access"
	tmuxAPITokenPath   = "/var/lib/tmux-api/internal.token"
	tmuxAPIAccessHTTP  = &http.Client{Timeout: 3 * time.Second}
	errAccessAnswerBad = errors.New("tmux-api access answer unreadable")
)

// askTmuxAPIAccess is guestAccess in production: tmux-api's loopback route,
// with the token file both services can read, since both run as one account.
func askTmuxAPIAccess(ctx context.Context, owner, name, caller string) (string, error) {
	tok, err := os.ReadFile(tmuxAPITokenPath)
	if err != nil {
		return "", fmt.Errorf("internal token: %w", err)
	}
	body, _ := json.Marshal(map[string]string{"owner": owner, "name": name, "caller": caller})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tmuxAPIAccessURL, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("X-Internal-Token", strings.TrimSpace(string(tok)))
	req.Header.Set("Content-Type", "application/json")
	resp, err := tmuxAPIAccessHTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("tmux-api access: HTTP %d", resp.StatusCode)
	}
	var got struct {
		Mode string `json:"mode"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		return "", errAccessAnswerBad
	}
	switch got.Mode {
	case "", shareModeRO, shareModeRW:
		return got.Mode, nil
	}
	return "", errAccessAnswerBad
}

// guestTarget resolves ?owner= for one request. With no owner, or the caller's
// own name, it returns ok and no guest. Otherwise it checks access and returns
// the owner and the mode, or the status to refuse with.
//
// The browser relay is left out: it reads ?owner= itself (browser.go), because
// whether a viewer may take control depends on the caller being the caller.
func guestTarget(r *http.Request, eff, real string) (owner, mode string, status int) {
	owner = r.URL.Query().Get("owner")
	if owner == "" || owner == eff || strings.HasPrefix(r.URL.Path, "/browser/") {
		return "", "", 0
	}
	if eff != real {
		// A Lens already acts as someone; a guest's owner on top of that would
		// be a third account nobody asked about.
		return "", "", http.StatusBadRequest
	}
	session := sessionOf(r.URL.Path)
	if !guestOwnerRe.MatchString(owner) || session == "" || strings.HasPrefix(session, "_") {
		return "", "", http.StatusBadRequest
	}
	mode, err := guestAccess(r.Context(), owner, session, real)
	if err != nil {
		log.Printf("guest: access check %s/%s for %s: %v", owner, session, real, err)
		return "", "", http.StatusServiceUnavailable
	}
	switch {
	case mode == "":
		return "", "", http.StatusForbidden
	case r.Method != http.MethodGet && mode != shareModeRW:
		return "", "", http.StatusForbidden
	}
	return owner, mode, 0
}

// isGuestStream is a request that stays open: the transcript stream, an
// agent's stream, and the presence socket. Each re-checks its grant while it
// lasts.
func isGuestStream(r *http.Request) bool {
	if r.Method != http.MethodGet {
		return false
	}
	seg := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if seg[0] != "events" {
		return false
	}
	switch len(seg) {
	case 2:
		return true
	case 3:
		return seg[2] == "presence"
	case 4:
		return seg[2] == "agents"
	}
	return false
}

// watchGuestGrant cancels ctx once the guest's grant is gone or narrowed below
// what they hold. A failed check is not a revoke: tmux-api restarting must not
// cut every guest's stream.
func watchGuestGrant(ctx context.Context, cancel context.CancelFunc, owner, session, caller, mode string) {
	t := time.NewTicker(guestRecheckEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		got, err := guestAccess(ctx, owner, session, caller)
		if err != nil {
			continue
		}
		if got == "" || mode == shareModeRW && got != shareModeRW {
			log.Printf("guest: %s's grant on %s/%s ended; closing their stream", caller, owner, session)
			cancel()
			return
		}
	}
}

// auditGuest records a guest's writes and stream opens under the caller, the
// way act-as is recorded.
func auditGuest(r *http.Request, real, owner, mode string) {
	if r.Method == http.MethodGet && !isGuestStream(r) {
		return
	}
	log.Printf("guest: %s on %s's session (%s) — %s %s", real, owner, mode, r.Method, r.URL.Path)
	events.Emit("share.guest", real, telemetry.Attrs{
		"tl.to": owner, "tl.session": sessionOf(r.URL.Path), "tl.mode": mode, "tl.client": "text",
	})
}
