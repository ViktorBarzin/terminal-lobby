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

	"terminal-lobby/sessionio"
	"terminal-lobby/telemetry"
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
	events.Emit("share.granted", osUser, telemetry.Attrs{
		"tl.session": name, "tl.to": guest, "tl.kind": mode, "tl.client": "api",
	})
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
	events.Emit("share.revoked", osUser, telemetry.Attrs{
		"tl.session": name, "tl.to": guest, "tl.client": "api",
	})
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

// effectiveMode resolves what a client actually gets from what the server
// allows (ceiling) and what the client asked for (requested).
//
// The rule is DOWNGRADE-ONLY: a client may ask for less access than the server
// grants, never more. That is what lets Watch mode be a client-side toggle
// without weakening anything — tmux-attach.sh's exact-argv discipline exists to
// stop a guest promoting themselves to read-write, and a request to *drop* to
// read-only cannot promote anyone. Anything other than a literal "ro" request
// is simply no request at all, so a malformed or hostile value falls through to
// the ceiling rather than to a guess.
func effectiveMode(ceiling, requested string) string {
	if requested == shareModeRO {
		return shareModeRO
	}
	return ceiling
}

// The two tmux-touching seams, as vars so the handler's tests stay pure units.
var (
	gridInjector  = sessionio.NewInjector(selfUser)
	sessionExists = func(osUser, name string) bool { return gridInjector.HasSession(osUser, name) }
	pinGrid       = func(osUser, name string) error { return gridInjector.PinGrid(osUser, name) }
)

// handleInternalAttach is the devvm attach path's single authorization call:
// given (owner,name,guest,tty,requested) it decides whether the attach may
// happen at all (else 403 — DENY), records the guest's client tty for later
// kick, pins the grid when the attach is read-only, and returns the effective
// mode ({"mode":"ro"|"rw"}) so tmux-attach.sh can source `-r` from the server,
// never a client argument. Token-gated; localhost-only in practice.
//
// Two callers, two authorization stories:
//
//   - owner != guest — a shared attach. A share row must exist; its mode is the
//     ceiling. Unchanged behaviour.
//   - owner == guest — the owner's own session, reached from a second device.
//     Owning it IS the authorization, so no share row is required or created,
//     and the ceiling is rw. This is the path Watch mode adds; without it there
//     would be no way to attach your own session read-only, and a phone opening
//     a session you are driving on a desktop would reflow it.
//
// A read-only attach also pins the session's grid on the way in, which is what
// keeps the owner's size theirs after their last read-write client drops (see
// sessionio.PinGrid). A session that does not exist yet cannot be watched — for
// YOUR OWN session the mode falls back to rw so the ordinary create path brings
// it into being; for anyone else's it does not, and the attach fails.
//
// The answer never asks the script to CREATE a session in another account: an
// attach authorized by administering the box can watch or drive what is running
// there, and nothing more.
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
		// Requested is the client's Watch-mode ask: "ro" to attach without
		// driving, anything else (including absent) to take the ceiling.
		Requested string `json:"requested"`
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
	selfAttach := body.Owner == body.Guest
	// actAs records that this attach was authorized by administering the box
	// rather than by owning the session, so the audit line and the telemetry
	// event below can name the mode it resolved to.
	actAs := false
	switch {
	case selfAttach:
		// Self attach. There is no share row to match, and matching one is what
		// used to validate these two values before they reached a tmux command
		// — so check them here instead.
		if !sessionNameRe.MatchString(body.Owner) || !sessionNameRe.MatchString(body.Name) {
			http.Error(w, "invalid owner or session name", http.StatusBadRequest)
			return
		}
		mode = shareModeRW
	case actAsGate.IsAdmin(body.Guest) && isMappedOSUser(body.Owner):
		// Admin acting as the owner. Being an administrator IS the
		// authorization, so no share row is required and none is created —
		// which is why the empty share store stays empty. The same two values
		// still get validated, for the same reason as the self branch.
		if !sessionNameRe.MatchString(body.Owner) || !sessionNameRe.MatchString(body.Name) {
			http.Error(w, "invalid owner or session name", http.StatusBadRequest)
			return
		}
		mode = shareModeRW
		actAs = true
	default:
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
	}

	mode = effectiveMode(mode, body.Requested)

	// Recorded after the mode is final, and naming it: with the ceiling enforced
	// on the client, the journal is where "did anyone type in their session, or
	// only watch it" gets answered. A read-write act-as attach says so in words
	// so it is greppable on its own.
	if actAs {
		what := "watching"
		if mode == shareModeRW {
			what = "DRIVING (read-write)"
		}
		log.Printf("act-as attach: %s attaching %s/%s as owner — %s",
			body.Guest, body.Owner, body.Name, what)
		events.Emit("admin.actas", body.Guest, telemetry.Attrs{
			"tl.to": body.Owner, "tl.session": body.Name,
			"tl.client": "attach", "tl.mode": mode,
		})
	}

	// Whether the session is live decides all three things below. A self
	// attach at rw needs none of them: it never reaches the script's attach
	// branch, falling through to tmux-user-attach, which is attach-or-create
	// already — so it does not pay for the lookup.
	exists := false
	if !selfAttach || mode == shareModeRO {
		exists = sessionExists(body.Owner, body.Name)
	}

	if mode == shareModeRO {
		switch {
		case exists:
			if err := pinGrid(body.Owner, body.Name); err != nil {
				// Non-fatal: the attach is still read-only, and tmux still
				// ignores a read-only client's size while a read-write one is
				// attached. What is lost is only the protection after the last
				// read-write client drops.
				log.Printf("pin grid %s/%s: %v", body.Owner, body.Name, err)
			}
		case selfAttach:
			// YOUR OWN session, not started yet: there is nothing to watch, so
			// hand back rw and let the create path bring it into being rather
			// than failing the attach.
			//
			// SELF ONLY. Two other callers reach this line and neither may take
			// it. A guest holding a share would be raised from the ro their
			// share grants to rw whenever the owner's session happened to be
			// missing: an escalation, and a racy one, since the session could
			// appear between this check and the attach. An administrator acting
			// as the owner has no session of their own to start here — asking to
			// watch would have come back read-write, in someone else's account.
			// Both simply fail instead, which is the safe outcome.
			mode = shareModeRW
		}
	}

	// NO create ANSWER. It used to be returned when the caller held the owner's
	// own access and the session was missing, which is reachable only from the
	// act-as branch — a self attach creates by another route. On 2026-08-17 that
	// spawned a session inside another user's account from a remembered session
	// name (`Council-tax` under bob, 08:02:24), read-write, indistinguishable
	// from their own work. Watching a session that is not running is not
	// something to arrange by starting one, so the answer carries no instruction
	// to spawn and the attach fails. Starting a session in someone's account is
	// done by that account.
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(struct {
		Mode string `json:"mode"`
	}{mode})
}

var errShareNotFound = errors.New("share not found")
