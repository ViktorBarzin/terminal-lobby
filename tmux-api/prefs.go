package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
)

// Prefs (Task 2.6, settings panel) are a user's roaming terminal
// preferences: one JSON document per OS user, whole-document PUTs,
// last-writer-wins — the same store shape as /layout. Unlike Layout the
// FIELDS are deliberately opaque to the server: the frontend validates-
// or-defaults every value on read (garbage can never crash a client, and
// a newer frontend's fields must roam through an older server), so the
// server only guards the envelope — a single bounded JSON object,
// private per user.
const (
	prefsDir     = "/var/lib/tmux-api/prefs"
	maxPrefsBody = 16 * 1024
)

type prefsStore struct {
	mu  sync.Mutex
	dir string
}

func newPrefsStore(dir string) *prefsStore {
	return &prefsStore{dir: dir}
}

// TMUX_API_PREFS_DIR: scratch-build override for the dev harness (same
// rationale as TMUX_API_ADDR — a battery run against a local build must
// not write the production store). The systemd unit sets no environment.
var prefsStoreInstance = newPrefsStore(func() string {
	if d := os.Getenv("TMUX_API_PREFS_DIR"); d != "" {
		return d
	}
	return prefsDir
}())

func (s *prefsStore) path(osUser string) string {
	return filepath.Join(s.dir, osUser+".json")
}

// load returns the user's stored document, or "{}" when none was ever
// saved (the frontend's validate-or-default wrapper turns that into
// defaults). A corrupt file is an error — better a 500 than silently
// resetting the user's roamed settings.
func (s *prefsStore) load(osUser string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, err := os.ReadFile(s.path(osUser))
	if errors.Is(err, os.ErrNotExist) {
		return []byte("{}"), nil
	}
	if err != nil {
		return nil, err
	}
	if !json.Valid(raw) {
		return nil, fmt.Errorf("corrupt prefs for %s", osUser)
	}
	return raw, nil
}

// save writes atomically (tmp + rename) so a crash mid-write can't leave
// a truncated document behind. doc must already be validated.
func (s *prefsStore) save(osUser string, doc []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(s.dir, osUser+".*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(doc, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), s.path(osUser))
}

// validatePrefs enforces the envelope: exactly one JSON object, nothing
// else (no scalars/arrays/null, no trailing data). Returns the canonical
// compact re-marshaling; keys and values pass through untouched.
func validatePrefs(raw []byte) ([]byte, error) {
	var m map[string]json.RawMessage
	dec := json.NewDecoder(bytes.NewReader(raw))
	if err := dec.Decode(&m); err != nil {
		return nil, fmt.Errorf("not a JSON object: %w", err)
	}
	if m == nil { // "null" decodes into a nil map without error
		return nil, errors.New("prefs document must be a JSON object")
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("trailing data after JSON document")
	}
	return json.Marshal(m)
}

// notifyPrefs is the SLICE of a user's roamed prefs the push sender needs:
// which session-state transitions they want a background push for. The
// server is otherwise deliberately blind to pref fields (validatePrefs only
// guards the envelope) — this is the one exception, because gating a send
// per user must happen server-side where the sender runs, not in a browser
// that may be closed.
type notifyPrefs struct {
	onDone     bool
	onAwaiting bool
}

// parseNotifyPrefs extracts notify.{onDone,onAwaiting} from a raw prefs
// document. Both default TRUE (opt-OUT, matching the frontend's
// PREF_DEFAULTS) whenever the doc, the notify object, or an individual key is
// absent or the wrong type — so a user who never opened settings, or an older
// frontend that predates the namespace, still gets both notifications. The
// pointer fields distinguish "explicitly false" from "absent": absent keeps
// the default, present overrides it.
func parseNotifyPrefs(doc []byte) notifyPrefs {
	np := notifyPrefs{onDone: true, onAwaiting: true}
	var envelope struct {
		Notify *struct {
			OnDone     *bool `json:"onDone"`
			OnAwaiting *bool `json:"onAwaiting"`
		} `json:"notify"`
	}
	if err := json.Unmarshal(doc, &envelope); err != nil || envelope.Notify == nil {
		return np
	}
	if envelope.Notify.OnDone != nil {
		np.onDone = *envelope.Notify.OnDone
	}
	if envelope.Notify.OnAwaiting != nil {
		np.onAwaiting = *envelope.Notify.OnAwaiting
	}
	return np
}

// handlePrefs serves GET/PUT /prefs for the calling user. Same no-store
// rationale as /layout: the browser must not cache what it just changed.
func handlePrefs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPut {
		http.Error(w, "GET or PUT only", http.StatusMethodNotAllowed)
		return
	}
	osUser := resolveOSUser(w, r)
	if osUser == "" {
		return
	}

	if r.Method == http.MethodGet {
		doc, err := prefsStoreInstance.load(osUser)
		if err != nil {
			logAndFail(w, "prefs load for %s failed: %v", osUser, err)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		w.Write(doc)
		return
	}

	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxPrefsBody))
	if err != nil {
		http.Error(w, "body unreadable or too large", http.StatusBadRequest)
		return
	}
	doc, err := validatePrefs(raw)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := prefsStoreInstance.save(osUser, doc); err != nil {
		logAndFail(w, "prefs save for %s failed: %v", osUser, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
