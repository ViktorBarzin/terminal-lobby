package main

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"

	webpush "github.com/SherClockHolmes/webpush-go"
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
	mu sync.Mutex
	m  map[string]string
}

func (s *stubStater) set(m map[string]string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m = m
}

func (s *stubStater) states(string) map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := make(map[string]string, len(s.m))
	for k, v := range s.m {
		cp[k] = v
	}
	return cp
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

// A user with no subscription file is never polled — no seed, no crash.
func TestPushSenderIgnoresUsersWithoutSubs(t *testing.T) {
	store := newPushStore(t.TempDir())
	stub := &stubStater{m: map[string]string{"main": stateAwaiting}}
	sender := newPushSender(store, stubPrefs{}, stub, testVAPID(t))
	sender.tick() // must not panic; nobody subscribed
}

// The marshaled payload is EXACTLY the shape frontend/sw.js parses: keys
// title, body, tag, session and nothing else. A drift here breaks background
// notifications silently, so pin it.
func TestBuildPushPayloadMatchesServiceWorker(t *testing.T) {
	var got map[string]any
	if err := json.Unmarshal(buildPushPayload("worktree"), &got); err != nil {
		t.Fatalf("payload not JSON: %v", err)
	}
	want := map[string]any{
		"title":   "worktree needs input",
		"body":    "Claude is awaiting your input.",
		"tag":     "tl-worktree",
		"session": "worktree",
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
	if err := json.Unmarshal(buildDonePayload("worktree"), &got); err != nil {
		t.Fatalf("payload not JSON: %v", err)
	}
	want := map[string]any{
		"title":   "worktree finished",
		"body":    "Claude finished its turn.",
		"tag":     "tl-worktree",
		"session": "worktree",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("done payload shape drift:\n got %v\nwant %v", got, want)
	}
	var aw map[string]any
	_ = json.Unmarshal(buildPushPayload("worktree"), &aw)
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

// --- Web Push HTTP client: force IPv4 (devvm v6→Apple blackhole, 2026-07-12) ---
//
// The devvm's IPv6 route to Apple's push range (2620:149::/32) completes the TCP
// handshake then blackholes — no response headers ever arrive — so a v6 send
// hangs until the client timeout and the iPhone never gets the push (v4 answers
// in ~165ms). The push HTTP client forces every connection over IPv4; these pin
// that behaviour so a regression can't silently route pushes back over v6.

// forceTCP4 must substitute network "tcp4" for whatever network the transport
// requests, so no push send is ever attempted over IPv6. Spy on the wrapped
// dialer to read back the network it is actually handed.
func TestForceTCP4OverridesRequestedNetwork(t *testing.T) {
	errSpy := errors.New("spy dial reached")
	for _, requested := range []string{"tcp", "tcp4", "tcp6"} {
		var got string
		spy := func(_ context.Context, network, _ string) (net.Conn, error) {
			got = network
			return nil, errSpy
		}
		_, err := forceTCP4(spy)(context.Background(), requested, "web.push.apple.com:443")
		if !errors.Is(err, errSpy) {
			t.Fatalf("requested %q: inner dialer was not called (err=%v)", requested, err)
		}
		if got != "tcp4" {
			t.Fatalf("requested %q: inner dialer got network %q, want tcp4", requested, got)
		}
	}
}

// dialForcesTCP4 proves client's transport overrides the requested network to
// tcp4: it asks the transport to dial an IPv4-only listener over "tcp6" and
// requires the connection to succeed. An un-forced dial would try to resolve
// the v4 literal 127.0.0.1 as IPv6 and fail, so a successful connect is only
// possible if "tcp6" was rewritten to "tcp4" — the exact override the fix
// installs, checked on the real transport the client uses.
func dialForcesTCP4(t *testing.T, client *http.Client) {
	t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen tcp4: %v", err)
	}
	defer ln.Close()
	tr, ok := client.Transport.(*http.Transport)
	if !ok || tr.DialContext == nil {
		t.Fatalf("transport = %T with no DialContext; want the tcp4-forcing transport", client.Transport)
	}
	conn, err := tr.DialContext(context.Background(), "tcp6", ln.Addr().String())
	if err != nil {
		t.Fatalf("dial of IPv4 listener %s over requested tcp6 failed — network not forced to tcp4: %v", ln.Addr(), err)
	}
	_ = conn.Close()
}

// The shared push client bounds a whole send at pushClientTimeout and forces
// IPv4 on the transport that every SendNotification goes through.
func TestNewPushHTTPClientForcesIPv4AndTimeout(t *testing.T) {
	client := newPushHTTPClient()
	if client.Timeout != pushClientTimeout {
		t.Fatalf("client.Timeout = %s, want %s", client.Timeout, pushClientTimeout)
	}
	dialForcesTCP4(t, client)
}

// Both send paths — the background loop (tick→notify→send) and the on-demand
// /push/test (handlePushTest→sender.send) — funnel through pushSender.send,
// the single webpush.SendNotification call site, which uses p.client. So the
// sender's client MUST be the shared IPv4-forcing client, not a default that
// would let a send escape over the blackholed v6 path.
func TestPushSenderUsesSharedIPv4Client(t *testing.T) {
	sender := newPushSender(newPushStore(t.TempDir()), nil, nil, testVAPID(t))
	hc, ok := sender.client.(*http.Client)
	if !ok {
		t.Fatalf("sender.client = %T, want *http.Client", sender.client)
	}
	if hc.Timeout != pushClientTimeout {
		t.Fatalf("sender.client.Timeout = %s, want %s", hc.Timeout, pushClientTimeout)
	}
	dialForcesTCP4(t, hc)
}
