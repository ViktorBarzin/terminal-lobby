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

	"terminal-lobby/telemetry"
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
//
// Origin is the page origin this device is served from, e.g.
// "https://terminal.viktorbarzin.me". It exists because a Declarative Web Push
// message must carry an ABSOLUTE navigate URL (pushsender.go) and this server
// has no public-origin config: it sees only the ingress-forwarded request, so
// the browser is the one that knows. Absent for a subscription recorded before
// the field existed, which is what makes the sender fall back to the flat
// payload for that device. Like added_at it is preserved across re-subscribes
// at the same endpoint, because the service worker re-subscribes on its own
// (register.ts) with no page origin to send.
type pushSubscription struct {
	Endpoint string   `json:"endpoint"`
	Keys     pushKeys `json:"keys"`
	AddedAt  string   `json:"added_at"`
	Origin   string   `json:"origin,omitempty"`
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
	return writeAtomicJSON(s.dir, osUser+".*.tmp", s.path(osUser), subs)
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
			if sub.Origin == "" {
				// A re-subscribe with nothing to say about the origin (the
				// service worker's own, or a client too old to send one) keeps
				// what we know rather than dropping this device back to the
				// flat payload.
				sub.Origin = subs[i].Origin
			}
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

// validatePushOrigin checks the page origin a client sent with its
// subscription and returns it normalized. "" is valid and means "not told" —
// the sender then omits the declarative half for this device.
//
// The rules are strict because the value ends up spliced into a navigate URL
// the operating system opens. https only (a push subscription needs a secure
// context anyway, and the client withholds the value on a plain-http page), and
// nothing past the host: a path, a query or a fragment would either address the
// wrong thing or, malformed, make WebKit drop the whole message with no banner
// to explain it. A trailing slash is the one shape normalized rather than
// refused, since it names the same origin (location.origin never emits one).
func validatePushOrigin(raw string) (string, error) {
	if raw == "" {
		return "", nil
	}
	u, err := url.Parse(raw)
	if err != nil || !u.IsAbs() || u.Scheme != "https" || u.Host == "" || u.Opaque != "" || u.User != nil {
		return "", errors.New("origin must be an absolute https origin, e.g. https://lobby.example")
	}
	if u.Path != "" && u.Path != "/" {
		return "", errors.New("origin must carry no path")
	}
	if u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return "", errors.New("origin must carry no query or fragment")
	}
	return u.Scheme + "://" + u.Host, nil
}

// validatePushSubscription parses and checks a PUT body: exactly one JSON
// object with a usable https/http endpoint, both key halves, and — when the
// client sends one — a usable page origin. Unknown fields (e.g. the browser's
// expirationTime) are ignored, not rejected.
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
	origin, err := validatePushOrigin(sub.Origin)
	if err != nil {
		return sub, err
	}
	sub.Origin = origin
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
	// resolveRealOSUser, NOT resolveOSUser: push subscriptions are the one
	// surface that must not follow an act-as switch. The SPA refreshes its
	// registration on boot, so an as-<user> tab would otherwise enrol this
	// browser as one of THEIR devices and keep delivering their session
	// notifications here long after the tab closed — state that outlives the
	// switch. See actas_test.go.
	osUser := resolveRealOSUser(w, r)
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
		events.Emit("notify.push_subscribed", osUser, telemetry.Attrs{"tl.client": "api"})
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
		events.Emit("notify.push_unsubscribed", osUser, telemetry.Attrs{"tl.client": "api"})
		w.WriteHeader(http.StatusNoContent)
	}
}

// buildTestPayload is the on-demand self-diagnosis push. Its own fixed tag
// tl-test (never a tl-<session>) keeps it in a separate coalescing lane, and
// it carries no session — a tap just opens the app. Built directly rather
// than via marshalPayload, whose tag is derived from the session.
//
// It carries no badge either, and that is the point of the pointer field: a
// diagnostic must not repaint the app icon. Proving delivery works should never
// clear a count of real work the user has not dealt with yet. app_badge follows
// the same rule for the same reason — omitted, so iOS leaves the icon alone.
//
// It is a payloadBuilder so it goes out declarative on a device that recorded
// its origin, which makes the test button exercise the same delivery path the
// real notifications take. navigate is the app root, since there is no session
// to open.
func buildTestPayload(origin string) []byte {
	p := pushPayload{
		Title:   "Test notification",
		Body:    "If you can read this, push delivery works on this device.",
		Tag:     "tl-test",
		Session: "",
	}
	if origin != "" {
		p.WebPush = declarativeWebPushVersion
		p.Notification = &declarativeNotification{
			Title:    p.Title,
			Body:     p.Body,
			Navigate: navigateURL(origin, ""),
			Tag:      p.Tag,
			Data:     &declarativeData{Session: ""},
		}
	}
	b, _ := json.Marshal(p)
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
	// Real caller, like the subscription endpoints above: "Test all devices"
	// means the devices of whoever pressed it. Firing it at the act-as target
	// would push to someone else's phone from a button labelled as your own.
	osUser := resolveRealOSUser(w, r)
	if osUser == "" {
		return
	}
	sender := pushSenderInstance
	if sender == nil {
		http.Error(w, "push not configured", http.StatusServiceUnavailable)
		return
	}
	sent, pruned := sender.send(osUser, "", buildTestPayload, kindTest)
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
