package main

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"

	"terminal-lobby/slug"
)

// stubPrefs is a prefsLoader returning a fixed prefs document (empty ⇒ "{}",
// i.e. the server defaults, both notify kinds on). Lets a sender test choose
// the caller's notify gating without a real prefs store on disk.
type stubPrefs struct{ doc string }

func (s stubPrefs) load(string) ([]byte, error) {
	if s.doc == "" {
		return []byte("{}"), nil
	}
	return []byte(s.doc), nil
}

// captureLog redirects the standard logger to a buffer for fn's duration and
// returns everything it wrote — the observability lines are plain log.Printf.
func captureLog(t *testing.T, fn func()) string {
	t.Helper()
	var buf bytes.Buffer
	old := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(old)
	fn()
	return buf.String()
}

// genSubKeys produces a VALID browser keypair so webpush-go's RFC-8291
// encryption succeeds and the POST actually reaches the stub endpoint — an
// invalid p256dh would error inside SendNotification, before any HTTP call, so
// the test would never exercise fan-out or prune.
func genSubKeys(t *testing.T) pushKeys {
	t.Helper()
	priv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("ecdh key: %v", err)
	}
	auth := make([]byte, 16)
	if _, err := rand.Read(auth); err != nil {
		t.Fatalf("auth secret: %v", err)
	}
	return pushKeys{
		P256dh: base64.RawURLEncoding.EncodeToString(priv.PublicKey().Bytes()),
		Auth:   base64.RawURLEncoding.EncodeToString(auth),
	}
}

// stubStater returns a COPY of the current state map so tick's stored `last`
// snapshot never aliases what the next tick reads (aliasing would erase the
// very transition the edge detector looks for).
type stubStater struct {
	mu     sync.Mutex
	m      map[string]string
	titles map[string]string
	act    map[string]int64
	system map[string]bool
}

func (s *stubStater) set(m map[string]string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m = m
}

func (s *stubStater) setTitles(m map[string]string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.titles = m
}

func (s *stubStater) read(string) (map[string]string, map[string]string, map[string]int64, map[string]bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := make(map[string]string, len(s.m))
	for k, v := range s.m {
		cp[k] = v
	}
	titles := make(map[string]string, len(s.titles))
	for k, v := range s.titles {
		titles[k] = v
	}
	act := make(map[string]int64, len(s.act))
	for k, v := range s.act {
		act[k] = v
	}
	system := make(map[string]bool, len(s.system))
	for k, v := range s.system {
		system[k] = v
	}
	return cp, titles, act, system
}

func (s *stubStater) setAct(m map[string]int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.act = m
}

// pushRecorder is a stub push service: it counts POSTs per endpoint path and
// returns 410 Gone for one nominated path so the prune branch is exercised.
type pushRecorder struct {
	mu     sync.Mutex
	hits   map[string]int
	goneAt string
}

func (rec *pushRecorder) server(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec.mu.Lock()
		rec.hits[r.URL.Path]++
		gone := r.URL.Path == rec.goneAt
		rec.mu.Unlock()
		if gone {
			w.WriteHeader(http.StatusGone)
			return
		}
		w.WriteHeader(http.StatusCreated)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func (rec *pushRecorder) hit(path string) int {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	return rec.hits[path]
}

func (rec *pushRecorder) total() int {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	n := 0
	for _, c := range rec.hits {
		n += c
	}
	return n
}

func testVAPID(t *testing.T) vapidConfig {
	t.Helper()
	priv, pub, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		t.Fatalf("GenerateVAPIDKeys: %v", err)
	}
	return vapidConfig{publicKey: pub, privateKey: priv, subject: "mailto:me@viktorbarzin.me"}
}

// The end-to-end edge behaviour: seed silently on first observation, fire once
// on the running→awaiting edge to EVERY device, prune a Gone endpoint, and
// never re-fire while the session stays awaiting — then re-arm on the next
// running→awaiting edge.
func TestPushSenderEdgeFanoutPruneRearm(t *testing.T) {
	rec := &pushRecorder{hits: map[string]int{}}
	srv := rec.server(t)
	rec.goneAt = "/gone"

	store := newPushStore(t.TempDir())
	if err := store.upsert("alice", pushSubscription{Endpoint: srv.URL + "/live", Keys: genSubKeys(t)}); err != nil {
		t.Fatalf("upsert live: %v", err)
	}
	if err := store.upsert("alice", pushSubscription{Endpoint: srv.URL + "/gone", Keys: genSubKeys(t)}); err != nil {
		t.Fatalf("upsert gone: %v", err)
	}

	stub := &stubStater{}
	sender := newPushSender(store, stubPrefs{}, stub, testVAPID(t))

	// tick 1 — first observation of alice: seed, send nothing.
	stub.set(map[string]string{"main": stateRunning})
	sender.tick()
	if rec.total() != 0 {
		t.Fatalf("seed tick sent %d, want 0", rec.total())
	}

	// tick 2 — running→awaiting edge: fan out to BOTH devices.
	stub.set(map[string]string{"main": stateAwaiting})
	sender.tick()
	if rec.hit("/live") != 1 || rec.hit("/gone") != 1 {
		t.Fatalf("edge fan-out: live=%d gone=%d, want 1/1", rec.hit("/live"), rec.hit("/gone"))
	}

	// The 410 endpoint is pruned; the live one remains.
	subs, _ := store.list("alice")
	if len(subs) != 1 || subs[0].Endpoint != srv.URL+"/live" {
		t.Fatalf("after prune: %+v, want only /live", subs)
	}

	// tick 3 — still awaiting: no re-send (edge already fired).
	stub.set(map[string]string{"main": stateAwaiting})
	sender.tick()
	if rec.hit("/live") != 1 {
		t.Fatalf("re-send while awaiting: got %d, want 1", rec.hit("/live"))
	}

	// tick 4 (awaiting→running) then tick 5 (running→awaiting) re-arms the edge.
	stub.set(map[string]string{"main": stateRunning})
	sender.tick()
	stub.set(map[string]string{"main": stateAwaiting})
	sender.tick()
	if rec.hit("/live") != 2 {
		t.Fatalf("re-armed edge: got %d, want 2", rec.hit("/live"))
	}
}

// Seeding fix (mirrors the frontend): a session first SEEN on a later poll
// while ALREADY awaiting is a transition and fires — only the very first
// observation of the user is silent.
func TestPushSenderNewlyAppearedAwaitingFires(t *testing.T) {
	rec := &pushRecorder{hits: map[string]int{}}
	srv := rec.server(t)

	store := newPushStore(t.TempDir())
	_ = store.upsert("alice", pushSubscription{Endpoint: srv.URL + "/d", Keys: genSubKeys(t)})

	stub := &stubStater{}
	sender := newPushSender(store, stubPrefs{}, stub, testVAPID(t))

	// Seed with an unrelated running session.
	stub.set(map[string]string{"other": stateRunning})
	sender.tick()
	if rec.total() != 0 {
		t.Fatalf("seed tick sent %d, want 0", rec.total())
	}

	// A brand-new session appears already awaiting → fires once.
	stub.set(map[string]string{"other": stateRunning, "fresh": stateAwaiting})
	sender.tick()
	if rec.hit("/d") != 1 {
		t.Fatalf("newly-appeared awaiting: got %d, want 1", rec.hit("/d"))
	}
}

// The user-activity gate (Viktor, 2026-07-13: "send only once the turn
// completes, not when any subagent completes"): once a client-activity
// timestamp is known for a session, an edge only pushes if the user typed
// into it SINCE our previous push. Internal turn boundaries (wakeups,
// subagent reports) flip running→done without keystrokes and stay silent.
func TestPushSenderActivityGateSuppressesAgentBounces(t *testing.T) {
	rec := &pushRecorder{hits: map[string]int{}}
	srv := rec.server(t)
	store := newPushStore(t.TempDir())
	_ = store.upsert("alice", pushSubscription{Endpoint: srv.URL + "/d", Keys: genSubKeys(t)})

	stub := &stubStater{}
	sender := newPushSender(store, stubPrefs{}, stub, testVAPID(t))

	// Seed; user typed at T=100 (the prompt that started the turn).
	stub.set(map[string]string{"main": stateRunning})
	stub.setAct(map[string]int64{"main": 100})
	sender.tick()

	// First running→done after the prompt: pushes.
	stub.set(map[string]string{"main": stateDone})
	sender.tick()
	if rec.hit("/d") != 1 {
		t.Fatalf("first done after user prompt: got %d pushes, want 1", rec.hit("/d"))
	}

	// Agent bounce: done→running→done with NO new keystrokes — silent.
	stub.set(map[string]string{"main": stateRunning})
	sender.tick()
	stub.set(map[string]string{"main": stateDone})
	sender.tick()
	if rec.hit("/d") != 1 {
		t.Fatalf("agent bounce without user input pushed: got %d, want still 1", rec.hit("/d"))
	}

	// User types again (T=200) → the next completion pushes again.
	//
	// The done→running tick below is also what clears the "one outstanding
	// notification per session" flag: submitting to a session is the
	// engagement that lets it ring again.
	stub.setAct(map[string]int64{"main": 200})
	stub.set(map[string]string{"main": stateRunning})
	sender.tick()
	stub.set(map[string]string{"main": stateDone})
	sender.tick()
	if rec.hit("/d") != 2 {
		t.Fatalf("done after fresh user input: got %d pushes, want 2", rec.hit("/d"))
	}
}

// The watermark is SHARED across kinds: an awaiting push consumes the
// activity credit, so the done that follows the same user prompt stays
// silent — but the user's approval keystrokes re-arm it. One push per
// human interaction, whichever kind fires first.
func TestPushSenderActivityGateSharedAcrossKinds(t *testing.T) {
	rec := &pushRecorder{hits: map[string]int{}}
	srv := rec.server(t)
	store := newPushStore(t.TempDir())
	_ = store.upsert("alice", pushSubscription{Endpoint: srv.URL + "/d", Keys: genSubKeys(t)})

	stub := &stubStater{}
	sender := newPushSender(store, stubPrefs{}, stub, testVAPID(t))

	stub.set(map[string]string{"main": stateRunning})
	stub.setAct(map[string]int64{"main": 100})
	sender.tick()

	// Permission ask mid-turn: running→awaiting pushes (fresh prompt credit).
	stub.set(map[string]string{"main": stateAwaiting})
	sender.tick()
	if rec.hit("/d") != 1 {
		t.Fatalf("awaiting after prompt: got %d, want 1", rec.hit("/d"))
	}

	// Turn completes with no further input — done suppressed (credit spent).
	stub.set(map[string]string{"main": stateRunning})
	sender.tick()
	stub.set(map[string]string{"main": stateDone})
	sender.tick()
	if rec.hit("/d") != 1 {
		t.Fatalf("done after awaiting, no new input: got %d, want still 1", rec.hit("/d"))
	}

	// The user's approval was typed input (T=150): next completion pushes.
	stub.setAct(map[string]int64{"main": 150})
	stub.set(map[string]string{"main": stateRunning})
	sender.tick()
	stub.set(map[string]string{"main": stateDone})
	sender.tick()
	if rec.hit("/d") != 2 {
		t.Fatalf("done after approval keystrokes: got %d, want 2", rec.hit("/d"))
	}
}

// A user with no subscription file is never polled — no seed, no crash.
func TestPushSenderIgnoresUsersWithoutSubs(t *testing.T) {
	store := newPushStore(t.TempDir())
	stub := &stubStater{m: map[string]string{"main": stateAwaiting}}
	sender := newPushSender(store, stubPrefs{}, stub, testVAPID(t))
	sender.tick() // must not panic; nobody subscribed
}

// The marshaled payload is EXACTLY the shape frontend-v2/public/sw.js parses: keys
// title, body, tag, session, badge and nothing else. A drift here breaks
// background notifications silently, so pin it.
func TestBuildPushPayloadMatchesServiceWorker(t *testing.T) {
	var got map[string]any
	if err := json.Unmarshal(buildPushPayload("Worktree cleanup", "k7m2q9x4tp0v", 3, nil, ""), &got); err != nil {
		t.Fatalf("payload not JSON: %v", err)
	}
	want := map[string]any{
		// The LABEL is what a person reads; the name is the address the tap
		// lands on.
		"title":   "Worktree cleanup needs input",
		"body":    "Claude is awaiting your input.",
		"tag":     "tl-k7m2q9x4tp0v",
		"session": "k7m2q9x4tp0v",
		"badge":   float64(3),
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("push payload shape drift:\n got %v\nwant %v", got, want)
	}
}

// The running→done "finished" payload has the same shape sw.js parses
// (title/body/tag/session), the finished wording, AND — critically — the
// SAME tag as the awaiting payload for a session, so a later awaiting push
// replaces a finished one instead of stacking (coalesce by tag; sw.js omits
// renotify).
func TestBuildDonePayloadMatchesServiceWorker(t *testing.T) {
	var got map[string]any
	if err := json.Unmarshal(buildDonePayload("Worktree cleanup", "k7m2q9x4tp0v", 1, nil, ""), &got); err != nil {
		t.Fatalf("payload not JSON: %v", err)
	}
	want := map[string]any{
		"title":   "Worktree cleanup finished",
		"body":    "Claude finished its turn.",
		"tag":     "tl-k7m2q9x4tp0v",
		"session": "k7m2q9x4tp0v",
		"badge":   float64(1),
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("done payload shape drift:\n got %v\nwant %v", got, want)
	}
	var aw map[string]any
	_ = json.Unmarshal(buildPushPayload("Worktree cleanup", "k7m2q9x4tp0v", 1, nil, ""), &aw)
	if got["tag"] != aw["tag"] {
		t.Fatalf("done tag %q != awaiting tag %q — coalescing would break", got["tag"], aw["tag"])
	}
}

// The running→done edge fires the finished push to every device exactly once,
// with the done KIND (asserted via the observability line). Seeding stays
// silent in every guise: the user's first observation, a session first SEEN
// already done (prev absent — SessionStart→done must not fire), and a
// done→done re-poll all send nothing; only a genuine running→done turn
// completion fires.
func TestPushSenderDoneEdgeFiresAndSeedsSilently(t *testing.T) {
	rec := &pushRecorder{hits: map[string]int{}}
	srv := rec.server(t)
	store := newPushStore(t.TempDir())
	_ = store.upsert("alice", pushSubscription{Endpoint: srv.URL + "/d", Keys: genSubKeys(t)})
	stub := &stubStater{}
	sender := newPushSender(store, stubPrefs{}, stub, testVAPID(t))

	// tick 1 — first observation of alice, with a session ALREADY done:
	// whole-user seed, silent.
	stub.set(map[string]string{"main": stateDone})
	sender.tick()
	if rec.total() != 0 {
		t.Fatalf("seed tick sent %d, want 0", rec.total())
	}

	// tick 2 — a fresh session appears already done (prev[name]=="", not
	// running): the done edge requires prev==running, so it stays silent.
	stub.set(map[string]string{"main": stateDone, "fresh": stateDone})
	sender.tick()
	if rec.total() != 0 {
		t.Fatalf("newly-appeared done fired %d, want 0 (prev not running)", rec.total())
	}

	// tick 3 — main goes done→running: not the done edge (cur is running).
	stub.set(map[string]string{"main": stateRunning, "fresh": stateDone})
	sender.tick()
	if rec.total() != 0 {
		t.Fatalf("done→running fired %d, want 0", rec.total())
	}

	// tick 4 — running→done: THE edge. Fires once, logs kind=done.
	stub.set(map[string]string{"main": stateDone, "fresh": stateDone})
	out := captureLog(t, sender.tick)
	if rec.hit("/d") != 1 {
		t.Fatalf("running→done edge: got %d, want 1", rec.hit("/d"))
	}
	if !strings.Contains(out, "sent done to alice") {
		t.Fatalf("observability line missing done kind:\n%s", out)
	}

	// tick 5 — still done: done→done is silent (no re-fire).
	sender.tick()
	if rec.hit("/d") != 1 {
		t.Fatalf("done→done re-fired: got %d, want 1", rec.hit("/d"))
	}
}

// The two notification kinds gate INDEPENDENTLY on the caller's roamed notify
// prefs: onDone=false suppresses the done push but leaves awaiting alone, and
// onAwaiting=false does the mirror. Each leg is a single-session run so the
// endpoint hit count is exactly whether that kind fired.
func TestPushSenderPrefsGateKindsIndependently(t *testing.T) {
	fire := func(t *testing.T, prefsDoc, fromState, toState string) int {
		rec := &pushRecorder{hits: map[string]int{}}
		srv := rec.server(t)
		store := newPushStore(t.TempDir())
		_ = store.upsert("alice", pushSubscription{Endpoint: srv.URL + "/d", Keys: genSubKeys(t)})
		stub := &stubStater{}
		sender := newPushSender(store, stubPrefs{doc: prefsDoc}, stub, testVAPID(t))
		stub.set(map[string]string{"s": fromState})
		sender.tick() // seed
		stub.set(map[string]string{"s": toState})
		sender.tick() // edge under test
		return rec.hit("/d")
	}
	if got := fire(t, `{"notify":{"onDone":false}}`, stateRunning, stateDone); got != 0 {
		t.Fatalf("onDone=false but done fired %d, want 0", got)
	}
	if got := fire(t, `{"notify":{"onDone":false}}`, stateRunning, stateAwaiting); got != 1 {
		t.Fatalf("onDone=false must not touch awaiting: got %d, want 1", got)
	}
	if got := fire(t, `{"notify":{"onAwaiting":false}}`, stateRunning, stateAwaiting); got != 0 {
		t.Fatalf("onAwaiting=false but awaiting fired %d, want 0", got)
	}
	if got := fire(t, `{"notify":{"onAwaiting":false}}`, stateRunning, stateDone); got != 1 {
		t.Fatalf("onAwaiting=false must not touch done: got %d, want 1", got)
	}
}

// Every accepted push logs exactly one observability line naming the OS user,
// session, kind and HTTP status — the operator's proof a push left the box
// (the forensics gap that made "notifications don't work" un-diagnosable).
func TestPushSenderLogsAcceptedSends(t *testing.T) {
	rec := &pushRecorder{hits: map[string]int{}}
	srv := rec.server(t)
	store := newPushStore(t.TempDir())
	_ = store.upsert("alice", pushSubscription{Endpoint: srv.URL + "/live", Keys: genSubKeys(t)})
	stub := &stubStater{}
	sender := newPushSender(store, stubPrefs{}, stub, testVAPID(t))

	stub.set(map[string]string{"main": stateRunning})
	sender.tick() // seed
	stub.set(map[string]string{"main": stateAwaiting})
	out := captureLog(t, sender.tick)
	if !strings.Contains(out, "sent awaiting to alice") ||
		!strings.Contains(out, "session=main") ||
		!strings.Contains(out, "status=201") {
		t.Fatalf("awaiting observability line missing/wrong:\n%s", out)
	}
}

// --- Web Push HTTP client: dual-stack (site v6 path fixed 2026-07-13) ---
//
// History: the site's IPv6 path to Apple's push range (2620:149::/32) used to
// blackhole after the TCP handshake (HE tunnel MTU 1280, LAN RA advertising
// 1500, Apple's LBs ignoring Packet-Too-Big), so the client forced tcp4 as a
// service-level workaround (2026-07-12). The root cause is fixed at the router
// (pfSense MSS clamping 1280 on the HE_IPv6 gif interface, 2026-07-13), the
// workaround is removed, and these pin the restored dual-stack behaviour: the
// transport must dial whatever network it is asked for, both families.

// dialHonorsRequestedNetwork proves the client's transport does NOT rewrite the
// requested network family: it must reach an IPv6-only loopback listener over
// "tcp6" (impossible if tcp6 were still rewritten to tcp4 — [::1] does not
// resolve as IPv4) and an IPv4-only listener over "tcp4".
func dialHonorsRequestedNetwork(t *testing.T, client *http.Client) {
	t.Helper()
	tr, ok := client.Transport.(*http.Transport)
	if !ok || tr.DialContext == nil {
		t.Fatalf("transport = %T with no DialContext; want the cloned default transport with a bounded dialer", client.Transport)
	}
	for _, tc := range []struct{ network, addr string }{
		{"tcp6", "[::1]:0"},
		{"tcp4", "127.0.0.1:0"},
	} {
		ln, err := net.Listen(tc.network, tc.addr)
		if err != nil {
			t.Fatalf("listen %s: %v", tc.network, err)
		}
		conn, err := tr.DialContext(context.Background(), tc.network, ln.Addr().String())
		if err != nil {
			ln.Close()
			t.Fatalf("dial %s listener %s failed — network family not honored: %v", tc.network, ln.Addr(), err)
		}
		_ = conn.Close()
		ln.Close()
	}
}

// The shared push client bounds a whole send at pushClientTimeout and dials
// dual-stack on the transport that every SendNotification goes through.
func TestNewPushHTTPClientDualStackAndTimeout(t *testing.T) {
	client := newPushHTTPClient()
	if client.Timeout != pushClientTimeout {
		t.Fatalf("client.Timeout = %s, want %s", client.Timeout, pushClientTimeout)
	}
	dialHonorsRequestedNetwork(t, client)
}

// Both send paths — the background loop (tick→notify→send) and the on-demand
// /push/test (handlePushTest→sender.send) — funnel through pushSender.send,
// the single webpush.SendNotification call site, which uses p.client. So the
// sender's client MUST be the shared bounded-timeout client, not a bare
// default that would let a send hang unbounded.
func TestPushSenderUsesSharedClient(t *testing.T) {
	sender := newPushSender(newPushStore(t.TempDir()), nil, nil, testVAPID(t))
	hc, ok := sender.client.(*http.Client)
	if !ok {
		t.Fatalf("sender.client = %T, want *http.Client", sender.client)
	}
	if hc.Timeout != pushClientTimeout {
		t.Fatalf("sender.client.Timeout = %s, want %s", hc.Timeout, pushClientTimeout)
	}
	dialHonorsRequestedNetwork(t, hc)
}

// A zero badge is a real value, not an absent one: it is what CLEARS the app
// icon, and `omitempty` on the field would drop it from the wire and leave a
// stale count on the user's home screen.
func TestPushPayloadCarriesZeroBadge(t *testing.T) {
	var got map[string]any
	if err := json.Unmarshal(buildPushPayload("Worktree cleanup", "k7m2q9x4tp0v", 0, nil, ""), &got); err != nil {
		t.Fatalf("payload not JSON: %v", err)
	}
	if _, ok := got["badge"]; !ok {
		t.Fatal("badge:0 dropped from the payload — the icon would keep a stale count")
	}
	if got["badge"] != float64(0) {
		t.Fatalf("badge = %v, want 0", got["badge"])
	}
}

// waitingCount counts the sessions asking for attention — awaiting or done —
// and nothing else. A running session is busy, not waiting.
func TestWaitingCountCountsOnlyAttentionStates(t *testing.T) {
	for _, tc := range []struct {
		name   string
		states map[string]string
		want   int
	}{
		{"empty", map[string]string{}, 0},
		{"only running", map[string]string{"a": stateRunning, "b": stateRunning}, 0},
		{"awaiting counts", map[string]string{"a": stateAwaiting}, 1},
		{"done counts", map[string]string{"a": stateDone}, 1},
		{"mixed", map[string]string{
			"a": stateAwaiting, "b": stateRunning, "c": stateDone, "d": stateDone,
		}, 3},
		{"unknown state ignored", map[string]string{"a": "", "b": "weird"}, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := waitingCount(tc.states); got != tc.want {
				t.Fatalf("waitingCount(%v) = %d, want %d", tc.states, got, tc.want)
			}
		})
	}
}

// waitingList names the same set waitingCount totals, so the device can subtract
// what it has already shown the user instead of trusting a server-side total
// that cannot know. Sorted, so a payload is stable for a given state map.
func TestWaitingListSplitsAwaitingAndDone(t *testing.T) {
	got := waitingList(map[string]string{
		"zeta": stateDone, "alpha": stateAwaiting, "mid": stateRunning,
		"beta": stateDone, "yak": stateAwaiting, "blank": "",
	})
	if got == nil {
		t.Fatal("waitingList returned nil under the cap")
	}
	if !reflect.DeepEqual(got.Awaiting, []string{"alpha", "yak"}) {
		t.Fatalf("awaiting = %v, want [alpha yak]", got.Awaiting)
	}
	if !reflect.DeepEqual(got.Done, []string{"beta", "zeta"}) {
		t.Fatalf("done = %v, want [beta zeta]", got.Done)
	}
}

// The named list and the total must always agree about the size of the set, or
// a device that falls back to Badge draws a different number from one that does
// not.
func TestWaitingListAgreesWithWaitingCount(t *testing.T) {
	states := map[string]string{
		"a": stateAwaiting, "b": stateDone, "c": stateRunning,
		"d": stateDone, "e": "", "f": stateAwaiting,
	}
	w := waitingList(states)
	if got, want := len(w.Awaiting)+len(w.Done), waitingCount(states); got != want {
		t.Fatalf("waitingList holds %d names, waitingCount says %d", got, want)
	}
}

// Past the cap the payload carries the total alone rather than an oversized
// list: a Web Push body is small, and falling back to today's behaviour beats a
// push the browser refuses to decrypt.
func TestWaitingListReturnsNilPastTheCap(t *testing.T) {
	states := map[string]string{}
	for i := 0; i <= waitingListCap; i++ {
		states[fmt.Sprintf("s%03d", i)] = stateDone
	}
	if got := waitingList(states); got != nil {
		t.Fatalf("over the cap: got %d+%d names, want nil", len(got.Awaiting), len(got.Done))
	}
	states = map[string]string{}
	for i := 0; i < waitingListCap; i++ {
		states[fmt.Sprintf("s%03d", i)] = stateDone
	}
	if waitingList(states) == nil {
		t.Fatal("exactly at the cap must still send the list")
	}
}

// An awaiting push carries the named set, and it matches the wire keys sw.js
// reads ("waiting" -> {"a": [...], "d": [...]}).
func TestPushPayloadCarriesTheNamedSet(t *testing.T) {
	var got map[string]any
	w := waitingList(map[string]string{"one": stateAwaiting, "two": stateDone})
	if err := json.Unmarshal(buildPushPayload("One", "one", 2, w, ""), &got); err != nil {
		t.Fatalf("payload not JSON: %v", err)
	}
	wait, ok := got["waiting"].(map[string]any)
	if !ok {
		t.Fatalf("no waiting object in %v", got)
	}
	if !reflect.DeepEqual(wait["a"], []any{"one"}) {
		t.Fatalf("waiting.a = %v, want [one]", wait["a"])
	}
	if !reflect.DeepEqual(wait["d"], []any{"two"}) {
		t.Fatalf("waiting.d = %v, want [two]", wait["d"])
	}
}

// ONE NOTIFICATION PER THREAD (Viktor, 2026-09-02: "I'd like 1 notification per
// thread at most"). A session that has already rung and has not been engaged
// with says nothing new by ringing again — the sidebar marks it unread and the
// app icon counts it. The notification reports a CHANGE.
func TestPushSenderOneOutstandingNotificationPerSession(t *testing.T) {
	rec := &pushRecorder{hits: map[string]int{}}
	srv := rec.server(t)
	store := newPushStore(t.TempDir())
	if err := store.upsert("alice", pushSubscription{Endpoint: srv.URL + "/d", Keys: genSubKeys(t)}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	stub := &stubStater{}
	sender := newPushSender(store, stubPrefs{}, stub, testVAPID(t))

	// No client attached, so there is NO activity reading — the case that used
	// to fail open and ring on every single turn boundary.
	stub.set(map[string]string{"main": stateRunning})
	sender.tick()
	stub.set(map[string]string{"main": stateDone})
	sender.tick()
	if rec.hit("/d") != 1 {
		t.Fatalf("first completion: got %d, want 1", rec.hit("/d"))
	}

	// It finishes twice more with nobody engaging. Silent both times.
	for i := 0; i < 2; i++ {
		stub.set(map[string]string{"main": stateAwaiting})
		sender.tick()
		stub.set(map[string]string{"main": stateDone})
		sender.tick()
	}
	if got := rec.hit("/d"); got != 1 {
		t.Fatalf("unengaged session rang again: got %d, want still 1", got)
	}

	// Submitting to it is engagement: the next completion may ring.
	stub.set(map[string]string{"main": stateRunning})
	sender.tick()
	stub.set(map[string]string{"main": stateDone})
	sender.tick()
	if got := rec.hit("/d"); got != 2 {
		t.Fatalf("after engaging: got %d, want 2", got)
	}
}

// A session finishing while the person is typing into it does not ring: they
// are watching it. The activity gate cannot express this, because typing is
// what ARMS a push — so the fastest turns were exactly the ones interrupting.
// The session you have on screen does not buzz the phone in your hand — and it
// does not stop the OTHER device from telling you either. Viktor, 2026-09-06:
// "I want to still receive them but only for sessions that I'm not focused on
// right now."
func TestPushSenderSkipsOnlyTheDeviceLookingAtIt(t *testing.T) {
	rec := &pushRecorder{hits: map[string]int{}}
	srv := rec.server(t)
	store := newPushStore(t.TempDir())
	for _, d := range []string{"/phone", "/desk"} {
		if err := store.upsert("alice", pushSubscription{Endpoint: srv.URL + d, Keys: genSubKeys(t)}); err != nil {
			t.Fatalf("upsert %s: %v", d, err)
		}
	}
	stub := &stubStater{}
	sender := newPushSender(store, stubPrefs{}, stub, testVAPID(t))
	sender.focus = newFocusStore()
	// The desktop is showing "main". The phone is showing the lobby list.
	sender.focus.report("alice", srv.URL+"/desk", "main")
	sender.focus.report("alice", srv.URL+"/phone", "")

	stub.set(map[string]string{"main": stateRunning})
	sender.tick()
	stub.set(map[string]string{"main": stateDone})
	sender.tick()

	if got := rec.hit("/desk"); got != 0 {
		t.Errorf("the device with it on screen was told anyway: got %d, want 0", got)
	}
	if got := rec.hit("/phone"); got != 1 {
		t.Errorf("the device that could not see it was not told: got %d, want 1", got)
	}
}

// Looking at one session says nothing about another one finishing.
func TestPushSenderStillTellsYouAboutTheOtherSessions(t *testing.T) {
	rec := &pushRecorder{hits: map[string]int{}}
	srv := rec.server(t)
	store := newPushStore(t.TempDir())
	if err := store.upsert("alice", pushSubscription{Endpoint: srv.URL + "/phone", Keys: genSubKeys(t)}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	stub := &stubStater{}
	sender := newPushSender(store, stubPrefs{}, stub, testVAPID(t))
	sender.focus = newFocusStore()
	sender.focus.report("alice", srv.URL+"/phone", "main")

	stub.set(map[string]string{"main": stateRunning, "other": stateRunning})
	sender.tick()
	stub.set(map[string]string{"main": stateDone, "other": stateDone})
	sender.tick()

	if got := rec.hit("/phone"); got != 1 {
		t.Fatalf("got %d pushes, want exactly 1 — the session that was not on screen", got)
	}
}

// A device that never reports is told everything: an old build, or a phone with
// the app shut, must not go quiet.
func TestPushSenderTellsADeviceThatReportsNothing(t *testing.T) {
	rec := &pushRecorder{hits: map[string]int{}}
	srv := rec.server(t)
	store := newPushStore(t.TempDir())
	if err := store.upsert("alice", pushSubscription{Endpoint: srv.URL + "/quiet", Keys: genSubKeys(t)}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	stub := &stubStater{}
	sender := newPushSender(store, stubPrefs{}, stub, testVAPID(t))
	sender.focus = newFocusStore()

	stub.set(map[string]string{"main": stateRunning})
	sender.tick()
	stub.set(map[string]string{"main": stateDone})
	sender.tick()

	if got := rec.hit("/quiet"); got != 1 {
		t.Fatalf("got %d, want 1", got)
	}
}

// Attaching is not typing, and opening the app attaches every session you have
// visited today. The whole chain has to hold that line: a client whose activity
// stamp is its attach stamp must not silence anything.
func TestPushSenderRingsForASessionYouOnlyReattached(t *testing.T) {
	rec := &pushRecorder{hits: map[string]int{}}
	srv := rec.server(t)
	store := newPushStore(t.TempDir())
	if err := store.upsert("alice", pushSubscription{Endpoint: srv.URL + "/phone", Keys: genSubKeys(t)}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	stub := &stubStater{}
	sender := newPushSender(store, stubPrefs{}, stub, testVAPID(t))
	sender.focus = newFocusStore()

	// What the stater reports for a session the lobby just re-attached: nothing,
	// because latestActivity drops a client that has never been typed into.
	stub.set(map[string]string{"main": stateRunning})
	stub.setAct(map[string]int64{})
	sender.tick()
	stub.set(map[string]string{"main": stateDone})
	sender.tick()

	if got := rec.hit("/phone"); got != 1 {
		t.Fatalf("a re-attached session stayed silent: got %d, want 1", got)
	}
}

// The throttle decides on its own inputs, so the rule can be read without a
// tmux or a push server.
func TestThrottledReasons(t *testing.T) {
	now := time.Now()
	p := &pushSender{
		// Typed into two seconds ago, and that no longer withholds anything:
		// where the person is LOOKING is a report from the device, not a guess
		// from a keystroke (pushfocus.go).
		seenAct:     map[string]map[string]int64{"u": {"warm": now.Add(-2 * time.Second).Unix()}},
		outstanding: map[string]map[string]bool{"u": {"rung": true}},
	}
	for _, tc := range []struct{ name, session, want string }{
		{"already has a notification", "rung", "already-notified"},
		{"touched a moment ago, but nothing outstanding", "warm", ""},
		{"never seen at all", "fresh", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := p.throttled("u", tc.session); got != tc.want {
				t.Fatalf("throttled(%s) = %q, want %q", tc.session, got, tc.want)
			}
		})
	}
}

// A push body says which session it is about, and a session name stopped being
// readable when it became an opaque id (ADR-0019). The title is what every
// other surface shows, so it is what the phone reads too.
func TestPushLabel(t *testing.T) {
	cases := []struct {
		name    string
		session string
		title   string
		want    string
	}{
		{"a titled session reads its title", "k7m2q9x4tp0v", "Tashkent trip planning", "Tashkent trip planning"},
		{"an untitled one falls back to the name", "k7m2q9x4tp0v", "", "k7m2q9x4tp0v"},
		{"whitespace is not a title", "k7m2q9x4tp0v", "   ", "k7m2q9x4tp0v"},
		{"a name from before ids still reads", "authentik", "", "authentik"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := pushLabel(c.session, c.title); got != c.want {
				t.Errorf("pushLabel(%q, %q) = %q, want %q", c.session, c.title, got, c.want)
			}
		})
	}
}

// The sender reads titles off the same list build it reads states from, so a
// title stamped by the auto-title rule is on the very next push.
func TestStatesAndTitles(t *testing.T) {
	states, titles := statesAndTitles([]Session{
		{Name: "k7m2q9x4tp0v", State: stateAwaiting, Title: "Tashkent trip planning"},
		{Name: "q4m8vwx2rt5n", State: stateRunning},
	})
	if states["k7m2q9x4tp0v"] != stateAwaiting || states["q4m8vwx2rt5n"] != stateRunning {
		t.Errorf("states = %v", states)
	}
	if titles["k7m2q9x4tp0v"] != "Tashkent trip planning" {
		t.Errorf("titles = %v, want the summary", titles)
	}
	if _, ok := titles["q4m8vwx2rt5n"]; ok {
		t.Errorf("an untitled session is in the titles map: %v", titles)
	}
}

// --- Declarative Web Push (iOS/iPadOS 18.4+, Safari 18.4+) -------------------

// The origin the tests navigate to: the live deployment, so the assertions read
// like the wire does.
const testPushOrigin = "https://terminal.viktorbarzin.me"

// A subscription recorded before this change carries no origin, and every such
// device must keep getting EXACTLY the bytes it got before. This pins the whole
// document, not a key set: a stray declarative key, or a reordered flat one,
// fails here.
func TestPayloadWithoutAnOriginIsUnchangedOnTheWire(t *testing.T) {
	const want = `{"title":"Worktree cleanup needs input","body":"Claude is awaiting your input.","tag":"tl-k7m2q9x4tp0v","session":"k7m2q9x4tp0v","badge":3}`
	if got := string(buildPushPayload("Worktree cleanup", "k7m2q9x4tp0v", 3, nil, "")); got != want {
		t.Fatalf("origin-less payload drifted:\n got %s\nwant %s", got, want)
	}
}

// With an origin the message ALSO carries the declarative half, which is what
// lets iOS 18.4+ open the session itself. Every key is pinned: WebKit drops the
// whole message (banner included) on a navigate it cannot parse, and the worker
// reads its own fields back off event.notification.data because event.data is
// null on that path.
func TestPushPayloadIsDeclarativeWhenTheOriginIsKnown(t *testing.T) {
	w := waitingList(map[string]string{"k7m2q9x4tp0v": stateAwaiting, "b3n8h1x5r2wq": stateDone})
	var got map[string]any
	raw := buildPushPayload("Worktree cleanup", "k7m2q9x4tp0v", 2, w, testPushOrigin)
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("payload not JSON: %v", err)
	}
	if got["web_push"] != float64(8030) {
		t.Fatalf("web_push = %v, want 8030 (the only version WebKit accepts)", got["web_push"])
	}
	// mutable must be ABSENT. With it true, WebKit starts the worker and then
	// waits for that worker to show a REPLACEMENT banner before displaying
	// anything; sw.js deliberately shows nothing on the declarative path, so
	// the notification was never displayed at all. Measured on Viktor's iPhone
	// 2026-09-08..10: every push accepted by Apple with a 201 and not one
	// banner. Absent means WebKit draws the payload's own banner, which is the
	// whole point of a declarative message. The cost is the device-side badge
	// subtraction (ADR-0015), which needs a worker WebKit no longer starts.
	if _, ok := got["mutable"]; ok {
		t.Fatalf("mutable = %v, want it absent — a mutable message WebKit shows nothing for", got["mutable"])
	}
	note, ok := got["notification"].(map[string]any)
	if !ok {
		t.Fatalf("no notification object in %v", got)
	}
	want := map[string]any{
		"title":     "Worktree cleanup needs input",
		"body":      "Claude is awaiting your input.",
		"navigate":  testPushOrigin + "/?session=k7m2q9x4tp0v",
		"tag":       "tl-k7m2q9x4tp0v",
		"app_badge": float64(2),
		"data": map[string]any{
			"session": "k7m2q9x4tp0v",
			"waiting": map[string]any{
				"a": []any{"k7m2q9x4tp0v"},
				"d": []any{"b3n8h1x5r2wq"},
			},
		},
	}
	if !reflect.DeepEqual(note, want) {
		t.Fatalf("declarative notification drift:\n got %v\nwant %v", note, want)
	}
	// The flat keys stay exactly as they are: they serve Chrome, Android and
	// every Apple device below 18.4, none of which read the nested copy.
	for k, v := range map[string]any{
		"title":   "Worktree cleanup needs input",
		"body":    "Claude is awaiting your input.",
		"tag":     "tl-k7m2q9x4tp0v",
		"session": "k7m2q9x4tp0v",
		"badge":   float64(2),
	} {
		if !reflect.DeepEqual(got[k], v) {
			t.Fatalf("flat %q = %v, want %v", k, got[k], v)
		}
	}
}

// The finished wording navigates to the same session and keeps the shared tag,
// so a later awaiting push still replaces a finished one on the declarative
// path as well as the classic one.
func TestDonePayloadNavigatesToTheSession(t *testing.T) {
	var got map[string]any
	if err := json.Unmarshal(buildDonePayload("Worktree cleanup", "k7m2q9x4tp0v", 1, nil, testPushOrigin), &got); err != nil {
		t.Fatalf("payload not JSON: %v", err)
	}
	note := got["notification"].(map[string]any)
	if note["navigate"] != testPushOrigin+"/?session=k7m2q9x4tp0v" {
		t.Fatalf("navigate = %v", note["navigate"])
	}
	if note["title"] != "Worktree cleanup finished" || note["body"] != "Claude finished its turn." {
		t.Fatalf("done wording drift: %v", note)
	}
	if note["tag"] != got["tag"] {
		t.Fatalf("nested tag %v != flat tag %v", note["tag"], got["tag"])
	}
}

// app_badge omitted leaves the icon alone, so CLEARING it needs an explicit
// zero — the same three-state rule the flat badge pointer already encodes.
func TestDeclarativeBadgeCarriesAnExplicitZero(t *testing.T) {
	var got map[string]any
	if err := json.Unmarshal(buildPushPayload("Worktree cleanup", "k7m2q9x4tp0v", 0, nil, testPushOrigin), &got); err != nil {
		t.Fatalf("payload not JSON: %v", err)
	}
	note := got["notification"].(map[string]any)
	v, ok := note["app_badge"]
	if !ok {
		t.Fatal("app_badge absent at zero — the icon would keep a stale count")
	}
	if v != float64(0) {
		t.Fatalf("app_badge = %v, want 0", v)
	}
}

// fullWaitingSet is a name list at the cap: every name the NAME_RE maximum of
// 32 bytes, split evenly between awaiting and done.
func fullWaitingSet() (*waitList, []string) {
	states := map[string]string{}
	names := make([]string, 0, waitingListCap)
	for i := 0; i < waitingListCap; i++ {
		name := fmt.Sprintf("%s%03d", strings.Repeat("w", 29), i) // 32 bytes, the NAME_RE max
		names = append(names, name)
		if i%2 == 0 {
			states[name] = stateAwaiting
		} else {
			states[name] = stateDone
		}
	}
	return waitingList(states), names
}

// A payload has to fit whatever a session is CALLED, and a title is bounded in
// runes (slug.MaxTitleRunes, 64) rather than in bytes. encoding/json escapes
// `<`, `>` and `&` to six bytes each and CleanTitle keeps all three, so 64 of
// them cost 384 bytes where 64 emoji cost 256 — and the declarative half repeats
// the title and the whole waiting list. RFC 8291 guarantees only 4096 bytes of
// ENCRYPTED body and aes128gcm spends 103 of those on framing, so anything past
// maxPushPayloadBytes is a push a service may refuse: send() logs the failure
// and the notification never arrives.
func TestWorstCasePayloadFitsTheEncryptedBudget(t *testing.T) {
	w, names := fullWaitingSet()
	if w == nil {
		t.Fatal("a full-cap set must still send the list")
	}
	titles := map[string]string{
		"emoji":     strings.Repeat("\U0001f6e0", slug.MaxTitleRunes), // 64 runes of 4 bytes
		"escaped":   strings.Repeat("<", slug.MaxTitleRunes),          // 6 bytes each once marshalled
		"ampersand": strings.Repeat("&", slug.MaxTitleRunes),
	}
	for kind, title := range titles {
		for _, build := range []struct {
			name string
			fn   func(string) []byte
		}{
			{"awaiting", func(tt string) []byte { return buildPushPayload(tt, names[0], 999, w, testPushOrigin) }},
			{"done", func(tt string) []byte { return buildDonePayload(tt, names[0], 999, w, testPushOrigin) }},
			{"flat", func(tt string) []byte { return buildPushPayload(tt, names[0], 999, w, "") }},
		} {
			t.Run(kind+"/"+build.name, func(t *testing.T) {
				if got := len(build.fn(title)); got > maxPushPayloadBytes {
					t.Fatalf("worst-case %s payload is %d bytes, over the %d-byte budget", build.name, got, maxPushPayloadBytes)
				}
			})
		}
	}
}

// What the sender gives up when a payload will not fit: the name list, and only
// the name list. The notification itself still goes out, and the device draws
// the server's total instead of subtracting what it has already read (ADR-0015)
// — counting high rather than not arriving.
func TestOversizePayloadDropsTheWaitingListAndStillSends(t *testing.T) {
	w, names := fullWaitingSet()
	title := strings.Repeat("<", slug.MaxTitleRunes)
	got := buildPushPayload(title, names[0], 999, w, testPushOrigin)
	if len(got) > maxPushPayloadBytes {
		t.Fatalf("payload is %d bytes, over the %d-byte budget", len(got), maxPushPayloadBytes)
	}
	var p struct {
		Title        string    `json:"title"`
		Session      string    `json:"session"`
		Badge        *int      `json:"badge"`
		Waiting      *waitList `json:"waiting"`
		Notification *struct {
			Navigate string `json:"navigate"`
			Data     *struct {
				Waiting *waitList `json:"waiting"`
			} `json:"data"`
		} `json:"notification"`
	}
	if err := json.Unmarshal(got, &p); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if p.Waiting != nil {
		t.Error("the flat waiting list should have been dropped")
	}
	if p.Notification == nil || p.Notification.Data == nil {
		t.Fatal("the declarative half must survive: it carries the navigate URL")
	}
	if p.Notification.Data.Waiting != nil {
		t.Error("the declarative waiting list should have been dropped too")
	}
	if p.Badge == nil || *p.Badge != 999 {
		t.Errorf("badge = %v, want the server total to take over", p.Badge)
	}
	if p.Session != names[0] || p.Notification.Navigate == "" {
		t.Errorf("the tap must still route: session=%q navigate=%q", p.Session, p.Notification.Navigate)
	}
}

// A device that never recorded an origin gets the flat payload alone, which is
// half the bytes, so the same set of names that overflows a declarative message
// fits there. Capping by name count for everyone took the badge subtraction off
// those devices for nothing.
func TestFlatPayloadKeepsTheWaitingListAtTheCap(t *testing.T) {
	w, names := fullWaitingSet()
	title := strings.Repeat("<", slug.MaxTitleRunes)
	var p struct {
		Waiting *waitList `json:"waiting"`
	}
	if err := json.Unmarshal(buildPushPayload(title, names[0], 999, w, ""), &p); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if p.Waiting == nil {
		t.Fatalf("a flat payload of %d names should still carry the list", waitingListCap)
	}
	if len(p.Waiting.Awaiting)+len(p.Waiting.Done) != waitingListCap {
		t.Errorf("carried %d names, want %d", len(p.Waiting.Awaiting)+len(p.Waiting.Done), waitingListCap)
	}
}

// The origin is per SUBSCRIPTION, not per user: one person's phone may know it
// while a browser that subscribed before this change does not. So the payload
// is built inside the fan-out loop, once per device, with that device's origin.
func TestSendBuildsOnePayloadPerSubscriptionOrigin(t *testing.T) {
	rec := &pushRecorder{hits: map[string]int{}}
	srv := rec.server(t)
	store := newPushStore(t.TempDir())
	if err := store.upsert("alice", pushSubscription{Endpoint: srv.URL + "/phone", Keys: genSubKeys(t), Origin: testPushOrigin}); err != nil {
		t.Fatalf("upsert phone: %v", err)
	}
	if err := store.upsert("alice", pushSubscription{Endpoint: srv.URL + "/legacy", Keys: genSubKeys(t)}); err != nil {
		t.Fatalf("upsert legacy: %v", err)
	}
	sender := newPushSender(store, stubPrefs{}, &stubStater{}, testVAPID(t))

	var seen []string
	sent, _ := sender.send("alice", "k7m2q9x4tp0v", func(origin string) []byte {
		seen = append(seen, origin)
		return buildPushPayload("Worktree cleanup", "k7m2q9x4tp0v", 1, nil, origin)
	}, kindDone)
	if sent != 2 {
		t.Fatalf("sent %d, want 2", sent)
	}
	sort.Strings(seen)
	if !reflect.DeepEqual(seen, []string{"", testPushOrigin}) {
		t.Fatalf("origins seen = %v, want [\"\" %s]", seen, testPushOrigin)
	}
}

// --- system sessions never push (docs/plans/2026-09-06-test-session-origin-design.md) ---
//
// The QA fleet drives the real deployed lobby on purpose, so its sessions are
// wizard's sessions, and every turn one of them finishes used to be a push to
// his phone. A system session is dropped from the tick's reading BEFORE the
// edge diff, which is stricter than declining to send: nothing about it is
// remembered, so there is no stale edge left for a rescue to fire on.

// setSystem tells the stub which of its sessions belong to tooling. Production
// answers this from Session.Origin and the reserved-name prefixes
// (isSystemSession); the stub is handed the verdict directly, so a sender test
// needs no tmux.
func (s *stubStater) setSystem(names ...string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.system = map[string]bool{}
	for _, n := range names {
		s.system[n] = true
	}
}

func TestPushSenderNeverPushesForASystemSession(t *testing.T) {
	rec := &pushRecorder{hits: map[string]int{}}
	srv := rec.server(t)
	store := newPushStore(t.TempDir())
	if err := store.upsert("alice", pushSubscription{Endpoint: srv.URL + "/d", Keys: genSubKeys(t)}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	stub := &stubStater{}
	sender := newPushSender(store, stubPrefs{}, stub, testVAPID(t))

	// A harness session and a person's session, side by side, moving through
	// the same running→done edge on the same ticks.
	stub.set(map[string]string{"qa-slug": stateRunning, "main": stateRunning})
	stub.setSystem("qa-slug")
	sender.tick()
	stub.set(map[string]string{"qa-slug": stateDone, "main": stateDone})
	sender.tick()

	if got := rec.hit("/d"); got != 1 {
		t.Fatalf("got %d pushes, want exactly 1 — the person's session and not the harness's", got)
	}
	// Nothing about it is remembered: not the state it was in, not the
	// activity watermark, and above all not an outstanding notification, which
	// would otherwise silence the session for good once it were rescued.
	if _, ok := sender.last["alice"]["qa-slug"]; ok {
		t.Errorf("a system session was recorded in last: %v", sender.last["alice"])
	}
	if sender.outstanding["alice"]["qa-slug"] {
		t.Error("a system session left an outstanding notification")
	}
	if _, ok := sender.seenAct["alice"]["qa-slug"]; ok {
		t.Errorf("a system session was recorded in seenAct: %v", sender.seenAct["alice"])
	}
	if _, ok := sender.pushedAct["alice"]["qa-slug"]; ok {
		t.Errorf("a system session was recorded in pushedAct: %v", sender.pushedAct["alice"])
	}
}

// The badge and the waiting list are counted from the same reading the diff
// runs on, so dropping the session before the diff is also what keeps it off
// the app icon and out of the by-name list the device filters with.
func TestPushSenderCountsNoSystemSessionInTheBadgeOrTheWaitingList(t *testing.T) {
	store := newPushStore(t.TempDir())
	if err := store.upsert("alice", pushSubscription{Endpoint: "https://example.invalid/d", Keys: genSubKeys(t)}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	stub := &stubStater{}
	sender := newPushSender(store, stubPrefs{}, stub, testVAPID(t))

	stub.set(map[string]string{"qa-slug": stateDone, "t3e2e-7": stateAwaiting, "main": stateAwaiting})
	stub.setSystem("qa-slug", "t3e2e-7")
	sender.tick() // the seeding tick: it reads, filters and remembers, and sends nothing

	cur := sender.last["alice"]
	if got := waitingCount(cur); got != 1 {
		t.Errorf("badge = %d, want 1 — only the person's session is asking for anything", got)
	}
	w := waitingList(cur)
	if w == nil || len(w.Done) != 0 || !reflect.DeepEqual(w.Awaiting, []string{"main"}) {
		t.Errorf("waiting list = %+v, want awaiting=[main] and nothing done", w)
	}
}

// A rescued session must not fire on the edge it crossed while it was hidden.
// This is what "before the diff, not at the send" buys: the sender has no
// memory of the session at all, so its first observation after the rescue is a
// seeding one, and a session first seen already done stays silent.
func TestPushSenderDoesNotFireOnAStaleEdgeAfterARescue(t *testing.T) {
	rec := &pushRecorder{hits: map[string]int{}}
	srv := rec.server(t)
	store := newPushStore(t.TempDir())
	if err := store.upsert("alice", pushSubscription{Endpoint: srv.URL + "/d", Keys: genSubKeys(t)}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	stub := &stubStater{}
	sender := newPushSender(store, stubPrefs{}, stub, testVAPID(t))

	// It runs, and finishes, entirely while it is a system session.
	stub.set(map[string]string{"rescued": stateRunning})
	stub.setSystem("rescued")
	sender.tick()
	stub.set(map[string]string{"rescued": stateDone})
	sender.tick()

	// Dragged out of System: POST /sessions/{name}/origin stamps it `user`,
	// and the next tick sees it for the first time, already done.
	stub.setSystem()
	sender.tick()

	if got := rec.hit("/d"); got != 0 {
		t.Fatalf("a rescued session rang for an edge it crossed while hidden: got %d, want 0", got)
	}

	// It is an ordinary session from here: the next completion rings.
	stub.set(map[string]string{"rescued": stateRunning})
	sender.tick()
	stub.set(map[string]string{"rescued": stateDone})
	sender.tick()
	if got := rec.hit("/d"); got != 1 {
		t.Fatalf("a rescued session stayed silent afterwards: got %d, want 1", got)
	}
}

// The production stater's half of the same rule: the verdict comes off the
// session list it already reads, at no extra fork, and covers both halves of
// isSystemSession — the stamp and the reserved name.
func TestSystemNamesReadsBothHalvesOfTheRule(t *testing.T) {
	got := systemNames([]Session{
		{Name: "k7m2q9x4tp0v", Origin: originUser},
		{Name: "b3n8h1x5r2wq", Origin: originTest},
		{Name: "q4m8vwx2rt5n"},
		{Name: "qa-slug", Origin: originUser},
	})
	want := map[string]bool{"b3n8h1x5r2wq": true, "q4m8vwx2rt5n": true, "qa-slug": true}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("systemNames = %v, want %v", got, want)
	}
	if systemNames([]Session{{Name: "k7m2q9x4tp0v", Origin: originUser}}) != nil {
		t.Error("a list with nothing system in it should produce no map at all")
	}
}
