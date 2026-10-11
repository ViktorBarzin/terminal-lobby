package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// presenceServer serves the presence route behind a stand-in for the auth
// middleware: ?u= is the caller, ?o= the owner, ?m= the guest mode.
func presenceServer(t *testing.T, hub *presenceHub) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /events/{session}/presence", hub.handle())
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		owner := q.Get("o")
		if owner == "" {
			owner = q.Get("u")
		}
		ctx := context.WithValue(r.Context(), osUserKey, owner)
		ctx = context.WithValue(ctx, realOSUserKey, q.Get("u"))
		ctx = context.WithValue(ctx, displayNameKey, q.Get("u")+"-name")
		if m := q.Get("m"); m != "" {
			ctx = context.WithValue(ctx, guestModeKey, m)
		}
		mux.ServeHTTP(w, r.WithContext(ctx))
	}))
	t.Cleanup(srv.Close)
	return srv
}

type presenceClient struct {
	t    *testing.T
	conn *websocket.Conn
	id   string
}

func dialPresence(t *testing.T, srv *httptest.Server, session, query string) *presenceClient {
	t.Helper()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/events/" + session + "/presence?" + query
	h := http.Header{"Origin": []string{srv.URL}}
	conn, _, err := websocket.DefaultDialer.Dial(url, h)
	if err != nil {
		t.Fatalf("dial %s: %v", query, err)
	}
	t.Cleanup(func() { conn.Close() })
	c := &presenceClient{t: t, conn: conn}
	hello := c.next("hello")
	c.id = hello.ID
	return c
}

// next reads frames until one of kind t arrives.
func (c *presenceClient) next(kind string) presenceFrame {
	c.t.Helper()
	c.conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		_, raw, err := c.conn.ReadMessage()
		if err != nil {
			c.t.Fatalf("waiting for %q: %v", kind, err)
		}
		var f presenceFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			c.t.Fatalf("frame %s: %v", raw, err)
		}
		if f.T == kind {
			return f
		}
	}
}

// room reads room frames until one satisfies ok.
func (c *presenceClient) room(ok func(presenceFrame) bool) presenceFrame {
	c.t.Helper()
	for {
		f := c.next("room")
		if ok(f) {
			return f
		}
	}
}

func (c *presenceClient) draft(text string) {
	c.t.Helper()
	b, _ := json.Marshal(map[string]string{"t": "draft", "text": text})
	if err := c.conn.WriteMessage(websocket.TextMessage, b); err != nil {
		c.t.Fatal(err)
	}
}

func personNamed(f presenceFrame, user string) *presencePerson {
	for i := range f.People {
		if f.People[i].User == user {
			return &f.People[i]
		}
	}
	return nil
}

func TestPresenceSeesWhoIsHereAndWhatTheyType(t *testing.T) {
	hub := newPresenceHub("")
	srv := presenceServer(t, hub)

	owner := dialPresence(t, srv, "main", "u=alice")
	guest := dialPresence(t, srv, "main", "u=bob&o=alice&m=rw")

	f := owner.room(func(f presenceFrame) bool { return len(f.People) == 2 })
	if p := personNamed(f, "bob"); p == nil || p.Name != "bob-name" || p.Mode != "rw" {
		t.Fatalf("owner sees %+v", f.People)
	}

	guest.draft("can you also check the rel")
	f = owner.room(func(f presenceFrame) bool {
		p := personNamed(f, "bob")
		return p != nil && p.Draft != ""
	})
	if p := personNamed(f, "bob"); p.Draft != "can you also check the rel" || p.DraftAt == 0 || f.Now < p.DraftAt {
		t.Fatalf("draft %+v now %d", p, f.Now)
	}

	guest.draft("")
	owner.room(func(f presenceFrame) bool {
		p := personNamed(f, "bob")
		return p != nil && p.Draft == ""
	})

	guest.conn.Close()
	owner.room(func(f presenceFrame) bool { return len(f.People) == 1 })
}

// A watcher has no composer, so a draft from one is not published.
func TestPresenceIgnoresAWatchersDraft(t *testing.T) {
	hub := newPresenceHub("")
	srv := presenceServer(t, hub)
	owner := dialPresence(t, srv, "main", "u=alice")
	watcher := dialPresence(t, srv, "main", "u=carol&o=alice&m=ro")
	owner.room(func(f presenceFrame) bool { return len(f.People) == 2 })

	watcher.draft("let me in")
	owner.draft("mine")
	f := owner.room(func(f presenceFrame) bool {
		p := personNamed(f, "alice")
		return p != nil && p.Draft == "mine"
	})
	if p := personNamed(f, "carol"); p == nil || p.Draft != "" || p.Mode != "ro" {
		t.Fatalf("watcher %+v", p)
	}
}

// Rooms are per (owner, session): someone else's session of the same name is
// another room.
func TestPresenceRoomsAreKeyedByOwner(t *testing.T) {
	hub := newPresenceHub("")
	srv := presenceServer(t, hub)
	a := dialPresence(t, srv, "main", "u=alice")
	dialPresence(t, srv, "main", "u=bob")
	time.Sleep(50 * time.Millisecond)
	a.draft("x")
	f := a.room(func(f presenceFrame) bool {
		return personNamed(f, "alice") != nil && personNamed(f, "alice").Draft == "x"
	})
	if len(f.People) != 1 {
		t.Fatalf("alice's room holds %+v", f.People)
	}
}

func TestPresenceCapsADraft(t *testing.T) {
	hub := newPresenceHub("")
	srv := presenceServer(t, hub)
	a := dialPresence(t, srv, "main", "u=alice")
	b := dialPresence(t, srv, "main", "u=bob&o=alice&m=rw")
	b.draft(strings.Repeat("é", maxPresenceDraft+50))
	f := a.room(func(f presenceFrame) bool { p := personNamed(f, "bob"); return p != nil && p.Draft != "" })
	if n := len([]rune(personNamed(f, "bob").Draft)); n != maxPresenceDraft {
		t.Fatalf("draft of %d runes, want %d", n, maxPresenceDraft)
	}
}

// Who sent each prompt: a snapshot on connect, then each new send live, and
// the record outlives a restart.
func TestPresenceSenders(t *testing.T) {
	dir := t.TempDir()
	hub := newPresenceHub(dir)
	srv := presenceServer(t, hub)
	hub.recordSender("alice", "main", "first", "alice", "vbarzin")

	c := dialPresence(t, srv, "main", "u=bob&o=alice&m=rw")
	snap := c.next("senders")
	if len(snap.Senders) != 1 || snap.Senders[0].Text != "first" || snap.Senders[0].Name != "vbarzin" {
		t.Fatalf("snapshot %+v", snap.Senders)
	}
	hub.recordSender("alice", "main", "second", "bob", "emo")
	live := c.next("senders")
	if len(live.Senders) != 1 || live.Senders[0].User != "bob" || live.Senders[0].At == 0 {
		t.Fatalf("live %+v", live.Senders)
	}

	again := newPresenceHub(dir)
	got := again.senders("alice", "main")
	if len(got) != 2 || got[1].Text != "second" {
		t.Fatalf("after restart %+v", got)
	}
	if other := again.senders("alice", "other"); len(other) != 0 {
		t.Fatalf("another session's senders %+v", other)
	}
}

func TestPresenceSendersAreBounded(t *testing.T) {
	hub := newPresenceHub(t.TempDir())
	for i := 0; i < maxSenderRecords+5; i++ {
		hub.recordSender("alice", "main", "p", "alice", "a")
	}
	if n := len(hub.senders("alice", "main")); n != maxSenderRecords {
		t.Fatalf("%d records, want %d", n, maxSenderRecords)
	}
}

func TestRecordingSendersOnlyRecordsWhatWasSent(t *testing.T) {
	hub := newPresenceHub("")
	status := http.StatusNoContent
	h := hub.recordingSenders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Text string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Text == "" {
			t.Error("the prompt handler got an empty body")
		}
		w.WriteHeader(status)
	}))
	send := func(text string) {
		r := httptest.NewRequest(http.MethodPost, "/prompt/main", strings.NewReader(`{"text":"`+text+`"}`))
		r.SetPathValue("session", "main")
		ctx := context.WithValue(r.Context(), osUserKey, "alice")
		ctx = context.WithValue(ctx, realOSUserKey, "bob")
		ctx = context.WithValue(ctx, displayNameKey, "emo")
		h.ServeHTTP(httptest.NewRecorder(), r.WithContext(ctx))
	}
	send("hello")
	status = http.StatusConflict
	send("refused")
	got := hub.senders("alice", "main")
	if len(got) != 1 || got[0].Text != "hello" || got[0].User != "bob" || got[0].Name != "emo" {
		t.Fatalf("records %+v", got)
	}
}
