package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Web Push subscriptions (Notifications Part 2) are the server-side half of
// the browser push flow: one JSON document per OS user holding a LIST of the
// user's push subscriptions (one per device/browser). The background sender
// (pushsender.go) fans a notification out to every entry on a session's
// transition into "awaiting". The store shape mirrors /prefs and /layout —
// per-user file, atomic writes, private mode — but the operations are
// UPSERT/DELETE by endpoint rather than whole-document PUT, because devices
// come and go independently and a stale endpoint must be prunable in place
// (both by the user's DELETE and by the sender on a 404/410 from the push
// service).
const (
	pushDir     = "/var/lib/tmux-api/push-subs"
	maxPushBody = 16 * 1024
)

// pushKeys are the base64url values from the browser's
// PushSubscription.getKey() — the material webpush-go needs to encrypt a
// payload for this endpoint. Field names/tags match both the browser's
// toJSON() output and webpush.Keys.
type pushKeys struct {
	P256dh string `json:"p256dh"`
	Auth   string `json:"auth"`
}

// pushSubscription is one device's Web Push registration. added_at is
// server-stamped on first insert (the client's value, if any, is ignored)
// and preserved across re-subscribes at the same endpoint.
type pushSubscription struct {
	Endpoint string   `json:"endpoint"`
	Keys     pushKeys `json:"keys"`
	AddedAt  string   `json:"added_at"`
}

type pushStore struct {
	mu  sync.Mutex
	dir string
	// now is a test seam for the added_at timestamp (see cache.go's now).
	now func() time.Time
}

func newPushStore(dir string) *pushStore {
	return &pushStore{dir: dir, now: time.Now}
}

// TMUX_API_PUSH_DIR: scratch-build override for the dev harness (same
// rationale as TMUX_API_PREFS_DIR — a battery run against a local build must
// not write the production store). The systemd unit sets no environment.
var pushStoreInstance = newPushStore(func() string {
	if d := os.Getenv("TMUX_API_PUSH_DIR"); d != "" {
		return d
	}
	return pushDir
}())

func (s *pushStore) path(osUser string) string {
	return filepath.Join(s.dir, osUser+".json")
}

// loadLocked reads the user's subscription list; a missing file is an empty
// list (never subscribed), a corrupt file is an error. Callers hold s.mu.
func (s *pushStore) loadLocked(osUser string) ([]pushSubscription, error) {
	raw, err := os.ReadFile(s.path(osUser))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var subs []pushSubscription
	if err := json.Unmarshal(raw, &subs); err != nil {
		return nil, fmt.Errorf("corrupt push subs for %s: %w", osUser, err)
	}
	return subs, nil
}

// saveLocked writes atomically (tmp + rename), private per user. An empty
// list still writes "[]" so the file's presence marks a user the sender must
// poll — until the user's last device is removed, at which point the file is
// deleted (removeLocked). Callers hold s.mu.
func (s *pushStore) saveLocked(osUser string, subs []pushSubscription) error {
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return err
	}
	doc, err := json.Marshal(subs)
	if err != nil {
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

func (s *pushStore) list(osUser string) ([]pushSubscription, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadLocked(osUser)
}

// upsert adds sub, or replaces the keys of an existing entry with the same
// endpoint in place — never a duplicate. added_at is stamped for a new entry
// and preserved for an existing one.
func (s *pushStore) upsert(osUser string, sub pushSubscription) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	subs, err := s.loadLocked(osUser)
	if err != nil {
		return err
	}
	for i := range subs {
		if subs[i].Endpoint == sub.Endpoint {
			sub.AddedAt = subs[i].AddedAt // preserve first-seen time
			subs[i] = sub
			return s.saveLocked(osUser, subs)
		}
	}
	sub.AddedAt = s.now().UTC().Format(time.RFC3339)
	subs = append(subs, sub)
	return s.saveLocked(osUser, subs)
}

// remove drops the entry with the given endpoint. Returns whether anything
// was removed (absent = no-op, not an error — DELETE is idempotent, and the
// sender prunes best-effort). When the last device goes, the file is deleted
// so users() stops polling this user entirely.
func (s *pushStore) remove(osUser, endpoint string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	subs, err := s.loadLocked(osUser)
	if err != nil {
		return false, err
	}
	kept := subs[:0:0]
	for _, sub := range subs {
		if sub.Endpoint != endpoint {
			kept = append(kept, sub)
		}
	}
	if len(kept) == len(subs) {
		return false, nil
	}
	if len(kept) == 0 {
		if err := os.Remove(s.path(osUser)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return true, err
		}
		return true, nil
	}
	return true, s.saveLocked(osUser, kept)
}

// users lists the OS users holding a subscription document — the exact set
// the background sender polls. A missing store dir means nobody has
// subscribed yet (not an error).
func (s *pushStore) users() ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entries, err := os.ReadDir(s.dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var users []string
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".json") {
			continue // skip tmp files from an in-flight atomic write
		}
		users = append(users, strings.TrimSuffix(name, ".json"))
	}
	return users, nil
}

// validatePushSubscription parses and checks a PUT body: exactly one JSON
// object with a usable https/http endpoint and both key halves. Unknown
// fields (e.g. the browser's expirationTime) are ignored, not rejected.
func validatePushSubscription(raw []byte) (pushSubscription, error) {
	var sub pushSubscription
	dec := json.NewDecoder(bytes.NewReader(raw))
	if err := dec.Decode(&sub); err != nil {
		return sub, fmt.Errorf("not a subscription object: %w", err)
	}
	if _, err := dec.Token(); err != io.EOF {
		return sub, errors.New("trailing data after JSON document")
	}
	u, err := url.Parse(sub.Endpoint)
	if err != nil || !u.IsAbs() || (u.Scheme != "https" && u.Scheme != "http") {
		return sub, errors.New("endpoint must be an absolute http(s) URL")
	}
	if sub.Keys.P256dh == "" || sub.Keys.Auth == "" {
		return sub, errors.New("keys.p256dh and keys.auth are required")
	}
	return sub, nil
}

// handlePushSubscriptions serves the caller's push subscriptions:
//
//	GET    → the list (JSON array)
//	PUT    → upsert one subscription (body: {endpoint, keys})
//	DELETE → remove one subscription (body: {endpoint})
//
// Same no-store rationale as /prefs: the browser must not cache what it just
// changed.
func handlePushSubscriptions(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet, http.MethodPut, http.MethodDelete:
	default:
		http.Error(w, "GET, PUT or DELETE only", http.StatusMethodNotAllowed)
		return
	}
	osUser := resolveOSUser(w, r)
	if osUser == "" {
		return
	}

	switch r.Method {
	case http.MethodGet:
		subs, err := pushStoreInstance.list(osUser)
		if err != nil {
			logAndFail(w, "push subs load for %s failed: %v", osUser, err)
			return
		}
		if subs == nil {
			subs = []pushSubscription{}
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(subs)

	case http.MethodPut:
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxPushBody))
		if err != nil {
			http.Error(w, "body unreadable or too large", http.StatusBadRequest)
			return
		}
		sub, err := validatePushSubscription(raw)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := pushStoreInstance.upsert(osUser, sub); err != nil {
			logAndFail(w, "push subs upsert for %s failed: %v", osUser, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)

	case http.MethodDelete:
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxPushBody))
		if err != nil {
			http.Error(w, "body unreadable or too large", http.StatusBadRequest)
			return
		}
		var body struct {
			Endpoint string `json:"endpoint"`
		}
		if err := json.Unmarshal(raw, &body); err != nil || body.Endpoint == "" {
			http.Error(w, "body must be {\"endpoint\":\"...\"}", http.StatusBadRequest)
			return
		}
		if _, err := pushStoreInstance.remove(osUser, body.Endpoint); err != nil {
			logAndFail(w, "push subs remove for %s failed: %v", osUser, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// buildTestPayload is the on-demand self-diagnosis push. Its own fixed tag
// tl-test (never a tl-<session>) keeps it in a separate coalescing lane, and
// it carries no session — a click just focuses the app. Built directly rather
// than via marshalPayload, whose tag is derived from the session.
func buildTestPayload() []byte {
	b, _ := json.Marshal(pushPayload{
		Title:   "Test notification",
		Body:    "If you can read this, push delivery works on this device.",
		Tag:     "tl-test",
		Session: "",
	})
	return b
}

// handlePushTest fans a one-off "Test notification" through the REAL sender
// path to every one of the caller's stored subscriptions and reports how many
// were accepted and how many stale endpoints were pruned. It is the
// user-facing half of the self-diagnosis story (the settings "Send test
// notification" button): a device that never shows the notification has a
// delivery problem the {sent,pruned} counts plus the sender's per-push log
// localize — is anything subscribed, did the push service accept it, was the
// endpoint stale? Push dark (no VAPID) is a 503, not a misleading sent:0.
func handlePushTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	osUser := resolveOSUser(w, r)
	if osUser == "" {
		return
	}
	sender := pushSenderInstance
	if sender == nil {
		http.Error(w, "push not configured", http.StatusServiceUnavailable)
		return
	}
	sent, pruned := sender.send(osUser, "", buildTestPayload(), kindTest)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]int{"sent": sent, "pruned": pruned})
}

// handlePushVAPIDPublic serves the server's VAPID public key as text/plain so
// the frontend can build the applicationServerKey for pushManager.subscribe.
// The key is not secret (it is handed to every browser and push service). A
// 404 when VAPID_PUBLIC_KEY is unset is the feature-dark signal: the frontend
// then leaves the push path off and falls back to foreground notifications.
func handlePushVAPIDPublic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	key := os.Getenv("VAPID_PUBLIC_KEY")
	if key == "" {
		http.Error(w, "push not configured", http.StatusNotFound)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = io.WriteString(w, key)
}
