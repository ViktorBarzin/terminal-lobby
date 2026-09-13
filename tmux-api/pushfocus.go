package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"slices"
	"sync"
	"time"
)

// Which sessions each of a user's DEVICES has on screen right now.
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
	// sessions is EVERYTHING that device says it has on screen, not only the
	// tile taking keystrokes. A workspace puts several live sessions in front of
	// one pair of eyes (docs/adr/0027), and the design's surface table counts
	// every one of them as open: "whatever suppression the open session gets
	// today — push, bell badge, unseen marker — applies to the whole visible
	// set". The other three suppressions shipped that way and this one did not,
	// so a push about a tile the reader was looking at still reached the phone.
	//
	// Empty means the device is showing no session — the lobby list, a
	// backgrounded page, an unfocused window — and matches nothing. "" is never
	// a member (report drops it), so no report can silence a session named ""
	// either.
	sessions []string
	at       time.Time
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
	// maxFocusBody is the biggest report accepted. An endpoint URL plus
	// maxFocusSessions names of up to 32 bytes each is under 1.5 KiB.
	maxFocusBody = 4 * 1024
	// maxFocusSessions bounds ONE report. A workspace is a handful of tiles on a
	// desktop — the design's worked example is four, and a phone shows none — so
	// this is far above any real screen and is here only to stop a hand-rolled
	// body from pinning a long slice per device.
	//
	// A report over the cap is refused rather than truncated, which is the same
	// stance the rest of this handler takes on a body it would have to guess at.
	// The page leaves its own record alone on a failed POST and tries again on
	// the next tick (notifications.ts `reportFocusNow` believes only a report
	// the server took), and until one lands this device is notified about
	// sessions it may be able to see — the direction that loses no alert.
	maxFocusSessions = 32
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

// report records what one device is showing, replacing whatever it said before.
// A report is the whole truth about that screen, so the previous set is dropped
// rather than merged into: a closed tile stops being visible the moment the
// page says so.
//
// Variadic, so the single-session call this store was born with — report(user,
// endpoint, "billing") — still says exactly what it always said, and a
// workspace says report(user, endpoint, "auth", "deploy"). Duplicates are
// dropped, and so is "": that is the legacy way of saying "showing nothing",
// never a name (sessionNameRe wants at least one character), and a stored ""
// would turn watching(…, "") into a question about a real member.
func (f *focusStore) report(osUser, endpoint string, sessions ...string) {
	onScreen := make([]string, 0, len(sessions))
	for _, s := range sessions {
		if s != "" && !slices.Contains(onScreen, s) {
			onScreen = append(onScreen, s)
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	m := f.at[osUser]
	if m == nil {
		m = map[string]focusRecord{}
		f.at[osUser] = m
	}
	m[endpoint] = focusRecord{sessions: onScreen, at: f.clock()}
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

// watching says whether this device said it has this session ON SCREEN,
// recently enough to believe.
//
// A MEMBERSHIP test, not the equality it used to be. The tile you are typing
// into and the three beside it are all things you can see, and the question the
// sender asks is "can they see this one", not "is this the one taking keys".
// Everything unknown answers false, so an unreported device is notified.
func (f *focusStore) watching(osUser, endpoint, session string) bool {
	if session == "" {
		return false // asking about nothing is silenced by nothing
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	rec, ok := f.at[osUser][endpoint]
	if !ok || !slices.Contains(rec.sessions, session) {
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
//	POST {"endpoint": "<push endpoint>", "sessions": ["auth","deploy"], "session": "auth"}
//
// TWO SHAPES, READ AS ONE SET. The page and this server ship separately (the
// SPA is a static build behind the ingress, this is a Go binary on the box), so
// for a while each will meet the other half at the wrong version:
//
//	sender      fields read            what the device is taken to be showing
//	--------    -------------------    --------------------------------------
//	old page    session                that one session; "" for none
//	new page    sessions ∪ session     every visible tile
//
// The two mixed pairs are the ones worth spelling out, and neither may lose an
// alert or swallow one:
//
//   - NEW page → OLD server. The old server never reads `sessions`
//     (encoding/json drops an unknown field), so it suppresses the focused tile
//     exactly as it does today and still pushes about the other tiles. Fewer
//     suppressions than intended, never more. That is why the new page keeps
//     sending `session` alongside the set rather than sending the set alone: a
//     set-only body would leave an old server holding "", which silences
//     nothing, and a push would arrive about the session under the reader's
//     eyes.
//   - OLD page → NEW server. No `sessions` key, so the union is the single name
//     and the record is precisely what it has always been.
//
// The union rather than a preference for one field: everything named is on
// screen either way, and a focused tile is by definition visible, so a set that
// somehow omitted it would be wrong about the one session we are surest of.
//
// An empty union means the device is showing no session — the lobby list, a
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
		Endpoint string   `json:"endpoint"`
		Session  string   `json:"session"`
		Sessions []string `json:"sessions"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		http.Error(w, "body must be {\"endpoint\":\"...\",\"sessions\":[\"...\"]}", http.StatusBadRequest)
		return
	}
	if !validPushEndpoint(body.Endpoint) {
		http.Error(w, "endpoint must be an absolute http(s) URL", http.StatusBadRequest)
		return
	}
	onScreen, reason := focusReportSet(body.Session, body.Sessions)
	if reason != "" {
		http.Error(w, reason, http.StatusBadRequest)
		return
	}
	focusStoreInstance.report(osUser, body.Endpoint, onScreen...)
	w.WriteHeader(http.StatusNoContent)
}

// focusReportSet folds the two wire shapes into the one set the store keeps,
// or returns the reason the report is refused.
//
// Every element carries the same name validation the single-name field has
// always had, because each one goes on to be compared against a real session.
// The two values outside sessionNameRe that mean something are handled here:
// `session` may be "" for "showing nothing", while an "" INSIDE the array is
// junk — an array element is a claim about a tile, and there is no tile called
// "" — so it is refused rather than quietly dropped.
func focusReportSet(session string, sessions []string) (onScreen []string, reason string) {
	if session != "" && !sessionNameRe.MatchString(session) {
		return nil, "session must be a session name"
	}
	if len(sessions) > maxFocusSessions {
		return nil, "too many sessions on screen"
	}
	onScreen = make([]string, 0, len(sessions)+1)
	for _, s := range sessions {
		if !sessionNameRe.MatchString(s) {
			return nil, "every element of sessions must be a session name"
		}
		if !slices.Contains(onScreen, s) {
			onScreen = append(onScreen, s)
		}
	}
	if session != "" && !slices.Contains(onScreen, session) {
		onScreen = append(onScreen, session)
	}
	return onScreen, ""
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
