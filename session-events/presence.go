package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"terminal-lobby/telemetry"
)

// Presence is who has a session open right now, and what each of them is
// typing (ADR-0043). Every lobby tab showing a session holds one WebSocket to
// GET /events/{session}/presence, guests naming the owner with ?owner= like
// every other route. The server keeps the set in memory per (owner, session)
// and sends each socket the whole room whenever anything in it changes: a
// person arriving or leaving, or a draft changing. A room is a handful of
// people, so the whole room is a few hundred bytes and nothing has to be
// merged on the client.
//
// The same socket carries who sent each prompt. A composer send records its
// sender (recordSender); a socket gets every record for its session on
// connect and each new one as it happens, and the Text view matches them to
// the user messages by text and time. Records are kept on disk, a bounded
// number per session, so labels survive a restart.

const (
	// maxPresenceDraft bounds the draft a person publishes. The preview is a
	// few lines above the composer, and a socket should not carry a novel at
	// every keystroke.
	maxPresenceDraft = 2000
	// maxPresenceFrame bounds what a client may send in one frame.
	maxPresenceFrame = 16 << 10
	// maxSenderRecords is how many sends a session remembers.
	maxSenderRecords  = 500
	presencePingEvery = 25 * time.Second
	presenceReadWait  = 60 * time.Second
)

// presencePerson is one socket in a room, as everyone in it sees it.
type presencePerson struct {
	ID   string `json:"id"`
	User string `json:"user"`
	Name string `json:"name"`
	// Mode is "rw" for the owner and a driving guest, "ro" for a watcher.
	Mode  string `json:"mode"`
	Draft string `json:"draft,omitempty"`
	// DraftAt is when the draft last changed, in ms on the server's clock. A
	// client compares it with the frame's Now, so its own clock never enters.
	DraftAt int64 `json:"draftAt,omitempty"`
}

// senderRecord is one prompt sent from a composer: its text, when, and by whom.
type senderRecord struct {
	Text string `json:"text"`
	At   int64  `json:"at"`
	User string `json:"user"`
	Name string `json:"name"`
}

// presenceFrame is every message the server sends. T is "hello", "room" or
// "senders".
type presenceFrame struct {
	T       string           `json:"t"`
	ID      string           `json:"id,omitempty"`
	Now     int64            `json:"now,omitempty"`
	People  []presencePerson `json:"people,omitempty"`
	Senders []senderRecord   `json:"senders,omitempty"`
}

type presenceConn struct {
	person presencePerson
	out    chan []byte
}

type presenceRoom struct {
	conns map[*presenceConn]bool
}

type presenceHub struct {
	mu    sync.Mutex
	rooms map[string]*presenceRoom
	// dir holds one senders file per session; "" keeps them in memory only
	// (the tests), in mem.
	dir string
	mem map[string][]senderRecord
	// ident names the session a sender record belongs to: tmux's session id
	// and creation time, which a rename keeps and no later session of the
	// same name shares. Records keyed by the name would carry one session's
	// prompts to the next one that takes the name, and lose them at a rename.
	ident func(owner, session string) (string, error)
	now   func() time.Time
}

func newPresenceHub(dir string) *presenceHub {
	return &presenceHub{
		rooms: map[string]*presenceRoom{},
		dir:   dir,
		mem:   map[string][]senderRecord{},
		ident: func(owner, session string) (string, error) { return owner + "." + session, nil },
		now:   time.Now,
	}
}

func roomKey(owner, session string) string { return owner + "\x00" + session }

var presenceUpgrader = websocket.Upgrader{
	ReadBufferSize:  4 << 10,
	WriteBufferSize: 16 << 10,
	CheckOrigin:     sameOrigin,
}

// handle serves GET /events/{session}/presence.
func (h *presenceHub) handle() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		owner, session := osUserFrom(r.Context()), r.PathValue("session")
		mode := guestModeFrom(r.Context())
		if mode == "" {
			mode = shareModeRW
		}
		conn, err := presenceUpgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		conn.SetReadLimit(maxPresenceFrame)

		c := &presenceConn{
			person: presencePerson{
				ID:   newPresenceID(),
				User: realOSUserFrom(r.Context()),
				Name: displayNameFrom(r.Context()),
				Mode: mode,
			},
			// Room frames replace each other, so a slow socket only needs
			// the newest few.
			out: make(chan []byte, 16),
		}
		key := roomKey(owner, session)
		hello, _ := json.Marshal(presenceFrame{T: "hello", ID: c.person.ID})
		c.out <- hello
		// "" when the session cannot be named (it has gone): no records.
		ident, _ := h.ident(owner, session)
		h.join(owner, session, ident, c)
		defer h.leave(key, c)

		done := make(chan struct{})
		go h.writeLoop(r, conn, c, done)
		conn.SetReadDeadline(time.Now().Add(presenceReadWait))
		conn.SetPongHandler(func(string) error {
			conn.SetReadDeadline(time.Now().Add(presenceReadWait))
			return nil
		})
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				break
			}
			conn.SetReadDeadline(time.Now().Add(presenceReadWait))
			var msg struct {
				T    string `json:"t"`
				Text string `json:"text"`
			}
			if json.Unmarshal(raw, &msg) != nil || msg.T != "draft" || c.person.Mode != shareModeRW {
				continue
			}
			h.setDraft(key, c, msg.Text)
		}
		close(done)
	}
}

// writeLoop sends the socket its frames and pings it, until the read side
// ends, the request's context ends (a revoked guest, watchGuestGrant), or a
// write fails.
func (h *presenceHub) writeLoop(r *http.Request, conn *websocket.Conn, c *presenceConn, done chan struct{}) {
	ping := time.NewTicker(presencePingEvery)
	defer ping.Stop()
	for {
		select {
		case <-done:
			return
		case <-r.Context().Done():
			conn.WriteControl(websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "access changed"),
				time.Now().Add(time.Second))
			conn.Close()
			return
		case b := <-c.out:
			conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if conn.WriteMessage(websocket.TextMessage, b) != nil {
				conn.Close()
				return
			}
		case <-ping.C:
			if conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(10*time.Second)) != nil {
				conn.Close()
				return
			}
		}
	}
}

// join adds c to its room. The senders snapshot goes out under the same lock
// recordSender takes, so a send cannot land between the snapshot and the join.
func (h *presenceHub) join(owner, session, ident string, c *presenceConn) {
	key := roomKey(owner, session)
	h.mu.Lock()
	defer h.mu.Unlock()
	if recs := h.loadSendersLocked(ident); len(recs) > 0 {
		b, _ := json.Marshal(presenceFrame{T: "senders", Senders: recs})
		c.out <- b
	}
	room := h.rooms[key]
	if room == nil {
		room = &presenceRoom{conns: map[*presenceConn]bool{}}
		h.rooms[key] = room
	}
	room.conns[c] = true
	h.broadcastLocked(room)
}

func (h *presenceHub) leave(key string, c *presenceConn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	room := h.rooms[key]
	if room == nil {
		return
	}
	delete(room.conns, c)
	if len(room.conns) == 0 {
		delete(h.rooms, key)
		return
	}
	h.broadcastLocked(room)
}

func (h *presenceHub) setDraft(key string, c *presenceConn, text string) {
	if r := []rune(text); len(r) > maxPresenceDraft {
		text = string(r[:maxPresenceDraft])
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	room := h.rooms[key]
	if room == nil || !room.conns[c] || c.person.Draft == text {
		return
	}
	c.person.Draft = text
	c.person.DraftAt = 0
	if text != "" {
		c.person.DraftAt = h.now().UnixMilli()
	}
	h.broadcastLocked(room)
}

// broadcastLocked sends every socket in room the whole room. A socket whose
// buffer is full drops its oldest frame: the next one supersedes it anyway.
func (h *presenceHub) broadcastLocked(room *presenceRoom) {
	people := make([]presencePerson, 0, len(room.conns))
	for c := range room.conns {
		people = append(people, c.person)
	}
	sort.Slice(people, func(i, j int) bool { return people[i].ID < people[j].ID })
	b, _ := json.Marshal(presenceFrame{T: "room", Now: h.now().UnixMilli(), People: people})
	for c := range room.conns {
		offer(c.out, b)
	}
}

func offer(ch chan []byte, b []byte) {
	for {
		select {
		case ch <- b:
			return
		default:
		}
		select {
		case <-ch:
		default:
		}
	}
}

// recordSender notes who sent a prompt into owner's session, and tells every
// socket on it.
func (h *presenceHub) recordSender(owner, session, text, user, name string) {
	ident, err := h.ident(owner, session)
	if err != nil {
		log.Printf("presence: cannot name %s/%s to record its sender: %v", owner, session, err)
		return
	}
	rec := senderRecord{Text: text, At: h.now().UnixMilli(), User: user, Name: name}
	key := roomKey(owner, session)
	h.mu.Lock()
	defer h.mu.Unlock()
	recs := append(h.loadSendersLocked(ident), rec)
	if len(recs) > maxSenderRecords {
		recs = recs[len(recs)-maxSenderRecords:]
	}
	h.saveSendersLocked(ident, recs)
	if room := h.rooms[key]; room != nil {
		b, _ := json.Marshal(presenceFrame{T: "senders", Senders: []senderRecord{rec}})
		for c := range room.conns {
			// Not offer: a sender record must not be dropped for a room frame.
			select {
			case c.out <- b:
			default:
				log.Printf("presence: a socket on %s/%s missed a sender record", owner, session)
			}
		}
	}
}

// senders is every record kept for owner's session as it is now, oldest
// first.
func (h *presenceHub) senders(owner, session string) []senderRecord {
	ident, err := h.ident(owner, session)
	if err != nil {
		return nil
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]senderRecord(nil), h.loadSendersLocked(ident)...)
}

// identRe is the shape a sender file's name may take.
var identRe = regexp.MustCompile(`^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$`)

// loadSendersLocked reads one session's records. Read from disk each time
// rather than cached: a send and a connect are both rare, and a cache keyed by
// every session anyone ever opened would only grow.
func (h *presenceHub) loadSendersLocked(ident string) []senderRecord {
	if !identRe.MatchString(ident) {
		return nil
	}
	if h.dir == "" {
		return h.mem[ident]
	}
	var recs []senderRecord
	if raw, err := os.ReadFile(filepath.Join(h.dir, ident+".json")); err == nil {
		_ = json.Unmarshal(raw, &recs)
	}
	return recs
}

func (h *presenceHub) saveSendersLocked(ident string, recs []senderRecord) {
	if !identRe.MatchString(ident) {
		return
	}
	if h.dir == "" {
		h.mem[ident] = recs
		return
	}
	if err := os.MkdirAll(h.dir, 0o700); err != nil {
		log.Printf("presence: senders dir: %v", err)
		return
	}
	b, _ := json.Marshal(recs)
	path := filepath.Join(h.dir, ident+".json")
	if err := os.WriteFile(path+".tmp", b, 0o600); err != nil {
		log.Printf("presence: senders write: %v", err)
		return
	}
	if err := os.Rename(path+".tmp", path); err != nil {
		log.Printf("presence: senders rename: %v", err)
	}
}

// tmuxSessionIdent is presenceHub.ident in production: the owner, tmux's
// session id without its `$`, and the session's creation time. The pair is
// unique for the life of the box (ADR-0039 pins shares and links the same
// way), and a rename keeps it.
func tmuxSessionIdent(cmd func(osUser string, args ...string) *exec.Cmd) func(owner, session string) (string, error) {
	return func(owner, session string) (string, error) {
		out, err := cmd(owner, "display-message", "-p", "-t", "="+session+":", "#{session_id}-#{session_created}").Output()
		if err != nil {
			return "", err
		}
		id := strings.TrimPrefix(strings.TrimSpace(string(out)), "$")
		ident := owner + "." + id
		if !identRe.MatchString(ident) {
			return "", fmt.Errorf("unexpected session id %q", id)
		}
		return ident, nil
	}
}

func newPresenceID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// statusRecorder keeps the status a handler wrote.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	if s.status == 0 {
		s.status = code
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	return s.ResponseWriter.Write(b)
}

// recordingSenders wraps POST /prompt/{session}: a prompt the session took is
// recorded with the account that sent it. A guest's send is also recorded in
// telemetry under the guest, since prompt_sent is under the owner.
func (h *presenceHub) recordingSenders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4<<20))
		if err != nil {
			http.Error(w, "body too large", http.StatusRequestEntityTooLarge)
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(raw))
		rec := &statusRecorder{ResponseWriter: w}
		next.ServeHTTP(rec, r)
		if rec.status < 200 || rec.status >= 300 {
			return
		}
		var body struct {
			Text string `json:"text"`
		}
		if json.Unmarshal(raw, &body) != nil || body.Text == "" {
			return
		}
		owner, session, real := osUserFrom(r.Context()), r.PathValue("session"), realOSUserFrom(r.Context())
		h.recordSender(owner, session, body.Text, real, displayNameFrom(r.Context()))
		if real != owner {
			events.Emit("share.prompt_sent", real, telemetry.Attrs{
				"tl.to": owner, "tl.session": session, "tl.count": len(body.Text),
			})
		}
	})
}

// sendersDir keeps the sender records beside the held prompts, in the
// service's own cache directory. No held directory means memory only.
func sendersDir(heldDir string) string {
	if heldDir == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(heldDir), "senders")
}
