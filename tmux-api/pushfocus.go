package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// Which session each of a user's DEVICES is looking at right now.
//
// The push sender's job is to tell you about work you cannot see. Until now it
// guessed at what you could see from tmux's client_activity — "did a human type
// into this session in the last minute". That guess reads an ATTACH as typing,
// because tmux stamps client_activity at attach time and only moves it on a real
// key (measured 2026-09-06: created and activity are the same second until the
// first keystroke). The lobby keeps every session you visit mounted for a day
// (store/keepalive.ts), each holding an attached client, so simply opening the
// app made every one of those sessions look like the one under your hands. Over
// the four days to 2026-09-06 that held 118 pushes, every held push in the
// window, including four while Viktor was asleep.
//
// So the page says what it is showing instead, and this remembers it. The
// question the sender asks is per DEVICE — "is the phone looking at this?" — not
// per person: a desktop watching a session should not silence the phone in your
// pocket, because you may well walk away from the desk.
//
// Deliberately in memory only, never on disk:
//
//   - it is worthless the moment it is stale, and the TTL is 90 seconds;
//   - a restart forgets everything, which reads as "nobody is looking" and
//     therefore notifies — the direction that loses no alert;
//   - the page heartbeats while it is on screen, so the store refills itself
//     within one interval of any restart.
type focusStore struct {
	mu sync.Mutex
	// osUser -> push endpoint -> what that device last said it was showing.
	at map[string]map[string]focusRecord
	// now is the clock, injectable so the TTL is testable without sleeping.
	// Nil means time.Now.
	now func() time.Time
}

// focusRecord is one device's last report.
type focusRecord struct {
	// session is what that device is showing; "" for the lobby list, a
	// backgrounded page, or an unfocused window. "" never matches anything.
	session string
	at      time.Time
}

const (
	// focusTTL is how long a report stands without a refresh. Comfortably more
	// than the page's heartbeat (notify/focus.ts focusHeartbeatMs), so an
	// ordinary slow tick never reads as "looked away", and short enough that a
	// page killed mid-look starts notifying again within a minute and a half.
	focusTTL = 90 * time.Second
	// maxFocusDevices bounds one user's records. Browsers rotate push endpoints,
	// and a looping client must not be able to grow this map without limit. Well
	// above any real device count; the oldest report is evicted first.
	maxFocusDevices = 32
	// maxFocusBody is the biggest report accepted. An endpoint URL plus a
	// 32-byte session name is a few hundred bytes.
	maxFocusBody = 4 * 1024
)

func newFocusStore() *focusStore {
	return &focusStore{at: map[string]map[string]focusRecord{}}
}

// focusStoreInstance is the process-wide store. The handler writes it and the
// push sender reads it.
var focusStoreInstance = newFocusStore()

func (f *focusStore) clock() time.Time {
	if f.now != nil {
		return f.now()
	}
	return time.Now()
}

// report records what one device is showing, replacing whatever it said before:
// a device looks at one session at a time.
func (f *focusStore) report(osUser, endpoint, session string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	m := f.at[osUser]
	if m == nil {
		m = map[string]focusRecord{}
		f.at[osUser] = m
	}
	m[endpoint] = focusRecord{session: session, at: f.clock()}
	f.evictLocked(m)
}

// evictLocked keeps a user's map at the cap by dropping the oldest report.
// Called with f.mu held.
func (f *focusStore) evictLocked(m map[string]focusRecord) {
	for len(m) > maxFocusDevices {
		oldest, found := "", false
		for endpoint, rec := range m {
			if !found || rec.at.Before(m[oldest].at) {
				oldest, found = endpoint, true
			}
		}
		delete(m, oldest)
	}
}

// watching says whether this device said it is showing this session, recently
// enough to believe. Everything unknown answers false, so an unreported device
// is notified.
func (f *focusStore) watching(osUser, endpoint, session string) bool {
	if session == "" {
		return false // looking at nothing silences nothing
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	rec, ok := f.at[osUser][endpoint]
	if !ok || rec.session != session {
		return false
	}
	return f.clock().Sub(rec.at) <= focusTTL
}

// forget drops one device's record — used when its subscription goes away, so a
// later device at the same endpoint starts with no opinion.
func (f *focusStore) forget(osUser, endpoint string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if m := f.at[osUser]; m != nil {
		delete(m, endpoint)
		if len(m) == 0 {
			delete(f.at, osUser)
		}
	}
}

// size is how many devices this user has reported. Test-facing, and the read
// the cap is checked against.
func (f *focusStore) size(osUser string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.at[osUser])
}

// handlePushFocus takes the page's "this is what I am showing" report.
//
//	POST {"endpoint": "<push endpoint>", "session": "<name>"}
//
// An empty session means the device is showing no session — the lobby list, a
// backgrounded tab, an unfocused window — and silences nothing.
//
// resolveRealOSUser, not resolveOSUser: focus is a property of a DEVICE, and a
// device belongs to whoever is sitting at it. An act-as tab reporting under the
// lensed user would silence that user's pushes to a device they do not hold.
// Same carve-out, and the same reason, as the subscription store.
func handlePushFocus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	osUser := resolveRealOSUser(w, r)
	if osUser == "" {
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxFocusBody))
	if err != nil {
		http.Error(w, "body unreadable or too large", http.StatusBadRequest)
		return
	}
	var body struct {
		Endpoint string `json:"endpoint"`
		Session  string `json:"session"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		http.Error(w, "body must be {\"endpoint\":\"...\",\"session\":\"...\"}", http.StatusBadRequest)
		return
	}
	if !validPushEndpoint(body.Endpoint) {
		http.Error(w, "endpoint must be an absolute http(s) URL", http.StatusBadRequest)
		return
	}
	// "" is the honest report for "showing no session" and is the only value
	// outside sessionNameRe that is accepted.
	if body.Session != "" && !sessionNameRe.MatchString(body.Session) {
		http.Error(w, "session must be a session name", http.StatusBadRequest)
		return
	}
	focusStoreInstance.report(osUser, body.Endpoint, body.Session)
	w.WriteHeader(http.StatusNoContent)
}

// validPushEndpoint is the same shape check the subscription store applies: an
// absolute http(s) URL with a host. It is an opaque key here, so this only
// keeps junk out of the map.
func validPushEndpoint(endpoint string) bool {
	if endpoint == "" {
		return false
	}
	u, err := url.Parse(endpoint)
	if err != nil {
		return false
	}
	return (u.Scheme == "https" || u.Scheme == "http") && u.Host != ""
}
