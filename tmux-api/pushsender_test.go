package main

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"

	webpush "github.com/SherClockHolmes/webpush-go"
)

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
	sender := newPushSender(store, stub, testVAPID(t))

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
	sender := newPushSender(store, stub, testVAPID(t))

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
	sender := newPushSender(store, stub, testVAPID(t))
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
