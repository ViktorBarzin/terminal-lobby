package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

// Share is a grant letting a non-owner attach one of the owner's sessions.
// A shared session is attached AS the owner (the guest's keystrokes run as the
// owner — see the design doc's security model), so a share is a deliberate,
// per-(owner,name,guest) grant. Mode is "ro" (tmux attach -r, watch) or "rw"
// (drive = full shell as owner). ClientTty is captured server-side when the
// guest actually attaches, so a revoke can detach exactly their tmux client.
type Share struct {
	Owner     string `json:"owner"`
	Name      string `json:"name"`
	Guest     string `json:"guest"`
	Mode      string `json:"mode"`
	ClientTty string `json:"clientTty,omitempty"`
}

// ShareSet is the whole global share document.
type ShareSet struct {
	Version int     `json:"version"`
	Shares  []Share `json:"shares"`
}

const (
	sharesVersion = 1
	shareModeRO   = "ro"
	shareModeRW   = "rw"
	sharesPath    = "/var/lib/tmux-api/shares.json"
)

// ttyRe bounds a recorded client tty so it can never inject extra argv into
// `tmux detach-client -t <tty>`. Real values look like /dev/pts/5 or /dev/ttys003.
var ttyRe = regexp.MustCompile(`^/dev/[a-zA-Z0-9/]{1,60}$`)

var shareStoreInstance = newShareStore(sharesPath)

type shareStore struct {
	mu   sync.Mutex
	path string
}

func newShareStore(path string) *shareStore { return &shareStore{path: path} }

func emptyShareSet() ShareSet { return ShareSet{Version: sharesVersion, Shares: []Share{}} }

func (s *shareStore) load() (ShareSet, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadLocked()
}

func (s *shareStore) loadLocked() (ShareSet, error) {
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return emptyShareSet(), nil
	}
	if err != nil {
		return ShareSet{}, err
	}
	var ss ShareSet
	if err := json.Unmarshal(raw, &ss); err != nil {
		return ShareSet{}, fmt.Errorf("corrupt share store: %w", err)
	}
	if ss.Shares == nil {
		ss.Shares = []Share{}
	}
	return ss, nil
}

func (s *shareStore) saveLocked(ss ShareSet) error {
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	raw, err := json.Marshal(ss)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "shares.*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(raw, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), s.path)
}

// update loads, applies fn, validates, saves — atomically under the lock.
func (s *shareStore) update(fn func(*ShareSet) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	ss, err := s.loadLocked()
	if err != nil {
		return err
	}
	if err := fn(&ss); err != nil {
		return err
	}
	if err := validateShareSet(ss); err != nil {
		return err
	}
	return s.saveLocked(ss)
}

// validateShareSet enforces: known version; owner/name/guest in the tmux name
// charset; mode ro/rw; owner != guest; a safe client tty when set; and each
// (owner,name,guest) grant listed once.
func validateShareSet(ss ShareSet) error {
	if ss.Version != sharesVersion {
		return fmt.Errorf("unsupported share set version %d", ss.Version)
	}
	seen := map[Share]bool{}
	for _, sh := range ss.Shares {
		if !sessionNameRe.MatchString(sh.Owner) || !sessionNameRe.MatchString(sh.Name) || !sessionNameRe.MatchString(sh.Guest) {
			return fmt.Errorf("invalid share ref %+v", sh)
		}
		if sh.Owner == sh.Guest {
			return fmt.Errorf("cannot share with yourself: %+v", sh)
		}
		if sh.Mode != shareModeRO && sh.Mode != shareModeRW {
			return fmt.Errorf("invalid share mode %q", sh.Mode)
		}
		if sh.ClientTty != "" && !ttyRe.MatchString(sh.ClientTty) {
			return fmt.Errorf("invalid client tty %q", sh.ClientTty)
		}
		key := Share{Owner: sh.Owner, Name: sh.Name, Guest: sh.Guest}
		if seen[key] {
			return fmt.Errorf("duplicate share %+v", key)
		}
		seen[key] = true
	}
	return nil
}

// handleShares: GET lists shares involving the caller (as owner or guest);
// POST creates/updates a share of the caller's own session.
func handleShares(w http.ResponseWriter, r *http.Request) {
	osUser := resolveOSUser(w, r)
	if osUser == "" {
		return
	}
	switch r.Method {
	case http.MethodGet:
		listShares(w, osUser)
	case http.MethodPost:
		createShare(w, r, osUser)
	default:
		http.Error(w, "GET or POST only", http.StatusMethodNotAllowed)
	}
}

func listShares(w http.ResponseWriter, osUser string) {
	ss, err := shareStoreInstance.load()
	if err != nil {
		logAndFail(w, "share load for %s failed: %v", osUser, err)
		return
	}
	mine := make([]Share, 0)
	for _, sh := range ss.Shares {
		if sh.Owner == osUser || sh.Guest == osUser {
			mine = append(mine, sh)
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(mine)
}

// createShare shares the caller's OWN session with a guest. Re-sharing the same
// (owner,name,guest) updates the mode (and clears any stale client tty).
func createShare(w http.ResponseWriter, r *http.Request, osUser string) {
	var body struct {
		Name  string `json:"name"`
		Guest string `json:"guest"`
		Mode  string `json:"mode"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxLayoutBody)).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	name := strings.TrimSpace(body.Name)
	guest := strings.TrimSpace(body.Guest)
	mode := strings.TrimSpace(body.Mode)
	if mode == "" {
		mode = shareModeRO // safe default
	}
	if !sessionNameRe.MatchString(name) {
		http.Error(w, "invalid session name", http.StatusBadRequest)
		return
	}
	if !sessionNameRe.MatchString(guest) || !isMappedOSUser(guest) {
		http.Error(w, "unknown or unmapped guest", http.StatusBadRequest)
		return
	}
	if guest == osUser {
		http.Error(w, "cannot share with yourself", http.StatusBadRequest)
		return
	}
	if mode != shareModeRO && mode != shareModeRW {
		http.Error(w, "invalid mode", http.StatusBadRequest)
		return
	}
	err := shareStoreInstance.update(func(ss *ShareSet) error {
		for i := range ss.Shares {
			if ss.Shares[i].Owner == osUser && ss.Shares[i].Name == name && ss.Shares[i].Guest == guest {
				ss.Shares[i].Mode = mode
				ss.Shares[i].ClientTty = "" // mode changed; stale live client no longer authoritative
				return nil
			}
		}
		ss.Shares = append(ss.Shares, Share{Owner: osUser, Name: name, Guest: guest, Mode: mode})
		return nil
	})
	if err != nil {
		logAndFail(w, "create share for %s failed: %v", osUser, err)
		return
	}
	w.WriteHeader(http.StatusCreated)
}

// handleShareByPath: DELETE /shares/{owner}/{name}/{guest} revokes a share. The
// owner (revoke) or the guest (leave) may delete it. Revoke removes the row
// FIRST (closing the reconnect race) then detaches the guest's live client.
func handleShareByPath(w http.ResponseWriter, r *http.Request) {
	osUser := resolveOSUser(w, r)
	if osUser == "" {
		return
	}
	if r.Method != http.MethodDelete {
		http.Error(w, "DELETE only", http.StatusMethodNotAllowed)
		return
	}
	path := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/shares/"), "/")
	parts := strings.Split(path, "/")
	if len(parts) != 3 {
		http.Error(w, "expected /shares/{owner}/{name}/{guest}", http.StatusBadRequest)
		return
	}
	owner, name, guest := parts[0], parts[1], parts[2]
	if osUser != owner && osUser != guest {
		http.Error(w, "only the owner or the guest may remove a share", http.StatusForbidden)
		return
	}
	var removedTty string
	err := shareStoreInstance.update(func(ss *ShareSet) error {
		out := ss.Shares[:0]
		for _, sh := range ss.Shares {
			if sh.Owner == owner && sh.Name == name && sh.Guest == guest {
				removedTty = sh.ClientTty
				continue
			}
			out = append(out, sh)
		}
		ss.Shares = out
		return nil
	})
	if err != nil {
		logAndFail(w, "revoke share for %s failed: %v", osUser, err)
		return
	}
	// Row is gone (a racing reconnect now fails the attach check). Now kick the
	// live client, if we recorded one.
	if removedTty != "" && ttyRe.MatchString(removedTty) {
		if out, derr := tmuxCmd(owner, "detach-client", "-t", removedTty).CombinedOutput(); derr != nil {
			// Non-fatal: the client may already be gone; the grant is revoked regardless.
			log.Printf("detach-client %s on %s after revoke: %v: %s", removedTty, owner, derr, strings.TrimSpace(string(out)))
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- internal channel: the devvm attach path records the guest's client tty ---
//
// tmux-attach.sh (running as wizard on the same host) calls these localhost
// endpoints, authenticated by a shared token file both processes can read.

const internalTokenPath = "/var/lib/tmux-api/internal.token"

var internalToken = ""

// ensureInternalToken loads or mints the localhost token used by tmux-attach.sh
// to reach the internal endpoints. Called once at startup.
func ensureInternalToken() error {
	if raw, err := os.ReadFile(internalTokenPath); err == nil {
		internalToken = strings.TrimSpace(string(raw))
		if internalToken != "" {
			return nil
		}
	}
	var b [24]byte
	if _, err := rand.Read(b[:]); err != nil {
		return err
	}
	internalToken = hex.EncodeToString(b[:])
	if err := os.MkdirAll(filepath.Dir(internalTokenPath), 0o700); err != nil {
		return err
	}
	return os.WriteFile(internalTokenPath, []byte(internalToken+"\n"), 0o600)
}

// handleInternalAttach is the devvm attach path's single authorization call:
// given (owner,name,guest,tty) it confirms a share exists (else 403 — DENY the
// attach), records the guest's client tty for later kick, and returns the mode
// ({"mode":"ro"|"rw"}) so tmux-attach.sh can source `-r` from the server, never
// a client argument. Token-gated; localhost-only in practice.
func handleInternalAttach(w http.ResponseWriter, r *http.Request) {
	if internalToken == "" || r.Header.Get("X-Internal-Token") != internalToken {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Owner string `json:"owner"`
		Name  string `json:"name"`
		Guest string `json:"guest"`
		Tty   string `json:"tty"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	if body.Tty != "" && !ttyRe.MatchString(body.Tty) {
		http.Error(w, "invalid tty", http.StatusBadRequest)
		return
	}
	mode := ""
	err := shareStoreInstance.update(func(ss *ShareSet) error {
		for i := range ss.Shares {
			if ss.Shares[i].Owner == body.Owner && ss.Shares[i].Name == body.Name && ss.Shares[i].Guest == body.Guest {
				ss.Shares[i].ClientTty = body.Tty
				mode = ss.Shares[i].Mode
				return nil
			}
		}
		return errShareNotFound
	})
	if errors.Is(err, errShareNotFound) {
		// No grant → deny the attach.
		http.Error(w, "not shared", http.StatusForbidden)
		return
	}
	if err != nil {
		logAndFail(w, "record attach failed: %v", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"mode": mode})
}

var errShareNotFound = errors.New("share not found")
