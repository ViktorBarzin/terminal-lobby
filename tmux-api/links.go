package main

// Public links (docs/plans/2026-10-06-public-links-design.md, ADR-0039 as
// amended by ADR-0040 and ADR-0041).
//
// A Link is a bearer URL to one session's CONVERSATION: whoever holds it reads
// the session's Claude transcript, read-only, with no account and no sign-in.
// While the session runs the page follows the conversation as it grows; once
// the session ends the link keeps showing it until it expires or is revoked.
// There is no terminal behind a link (ADR-0041): an earlier version attached a
// tmux client through two ttyd instances, and Viktor found the conversation was
// the useful half.
//
// This file is the only place in the service where a request with no identity
// reaches a session, so each step is narrow:
//
//   - The token is 128 random bits, shown to the owner once and stored only as
//     a SHA-256. It never travels in a URL: the visitor page holds it in the
//     fragment and POSTs it to /link/redeem.
//   - Redeeming sets a VIEW cookie bound to the link (links_transcript.go),
//     which the read routes take, so nothing in a request line can be replayed.
//
// A link is pinned to tmux's #{session_id} AND #{session_created}. The id alone
// is reused from $0 after a server restart, so it could name a different
// session after a reboot; the pair cannot.

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"terminal-lobby/sessionio"
	"terminal-lobby/telemetry"
)

// Link is one public link, as stored.
type Link struct {
	// ID names the link to its owner (list, revoke) and to the read routes. It
	// is not a secret and cannot be redeemed: only the token can.
	ID string `json:"id"`
	// TokenHash is hex SHA-256 of the token. The token itself is never stored.
	TokenHash      string `json:"tokenHash"`
	Owner          string `json:"owner"`
	SessionID      string `json:"sessionId"`
	SessionCreated int64  `json:"sessionCreated"`
	Note           string `json:"note,omitempty"`
	CreatedAt      int64  `json:"createdAt"`
	// ExpiresAt is a unix second; 0 means until revoked.
	ExpiresAt int64 `json:"expiresAt"`
	// Transcripts are the Claude transcripts the session wrote while this link
	// existed, oldest first (links_transcript.go). What the link shows.
	Transcripts []string `json:"transcripts,omitempty"`
	// Title is the session's title as last seen, kept for after it ends.
	Title string `json:"title,omitempty"`
	// EndedAt is when the session ended, 0 while it runs.
	EndedAt int64 `json:"endedAt,omitempty"`
}

// LinkSet is the whole link document.
type LinkSet struct {
	Version int    `json:"version"`
	Links   []Link `json:"links"`
}

const (
	linksVersion = 1
	linksPath    = "/var/lib/tmux-api/links.json"

	// maxViews bounds the in-memory view-key book, so a flood of redeems
	// cannot grow it without limit. Past it, a redeem answers 503.
	maxViews = 2000
	// maxLinksPerOwner keeps one account's store small enough to read whole.
	maxLinksPerOwner = 100
	// maxNoteRunes bounds the owner's private note.
	maxNoteRunes = 80
)

// linkTTLs are the lifetimes the owner may pick (decision 3).
var linkTTLs = map[string]time.Duration{
	"1h":    time.Hour,
	"24h":   24 * time.Hour,
	"7d":    7 * 24 * time.Hour,
	"never": 0,
}

var (
	linkIDRe = regexp.MustCompile(`^[0-9a-f]{16}$`)
	// linkTokenRe is 16 random bytes, base64url without padding: 22 chars.
	linkTokenRe = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)
	// viewKeyRe is 24 random bytes, base64url without padding: 32 chars.
	viewKeyRe = regexp.MustCompile(`^[A-Za-z0-9_-]{32}$`)
)

func randomToken(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		// Same stance as newMintedName: a predictable token is worse than a
		// crash, because it would be a working credential to a conversation.
		panic("randomToken: " + err.Error())
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func newLinkID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		panic("newLinkID: " + err.Error())
	}
	return hex.EncodeToString(b)
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// cleanNote keeps a note printable and short. It is shown only to its owner,
// but it is stored on disk and rendered in the lobby, so control characters
// and newlines are dropped rather than kept.
func cleanNote(s string) string {
	var b strings.Builder
	n := 0
	for _, r := range strings.TrimSpace(s) {
		if n >= maxNoteRunes {
			break
		}
		if unicode.IsControl(r) {
			continue
		}
		b.WriteRune(r)
		n++
	}
	return b.String()
}

// --- store ---

var linkStoreInstance = newLinkStore(linksPath)

type linkStore struct {
	mu   sync.Mutex
	path string
}

func newLinkStore(path string) *linkStore { return &linkStore{path: path} }

func emptyLinkSet() LinkSet { return LinkSet{Version: linksVersion, Links: []Link{}} }

func (s *linkStore) load() (LinkSet, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadLocked()
}

func (s *linkStore) loadLocked() (LinkSet, error) {
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return emptyLinkSet(), nil
	}
	if err != nil {
		return LinkSet{}, err
	}
	var ls LinkSet
	if err := json.Unmarshal(raw, &ls); err != nil {
		return LinkSet{}, fmt.Errorf("corrupt link store: %w", err)
	}
	if ls.Links == nil {
		ls.Links = []Link{}
	}
	return ls, nil
}

// update loads, applies fn, validates and saves under the lock. fn returning
// errNoLinkChange skips the write.
func (s *linkStore) update(fn func(*LinkSet) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	ls, err := s.loadLocked()
	if err != nil {
		return err
	}
	if err := fn(&ls); err != nil {
		return err
	}
	if err := validateLinkSet(ls); err != nil {
		return err
	}
	// The file holds token hashes, which are not credentials, but it also maps
	// every live link to its owner and session. 0600 like its neighbours.
	return writeAtomicJSON(filepath.Dir(s.path), "links.*.tmp", s.path, ls)
}

var errNoLinkChange = errors.New("no link change")

func validateLinkSet(ls LinkSet) error {
	if ls.Version != linksVersion {
		return fmt.Errorf("unsupported link set version %d", ls.Version)
	}
	seen := map[string]bool{}
	for _, l := range ls.Links {
		if !linkIDRe.MatchString(l.ID) || seen[l.ID] {
			return fmt.Errorf("invalid or duplicate link id %q", l.ID)
		}
		seen[l.ID] = true
		if len(l.TokenHash) != 64 {
			return fmt.Errorf("invalid token hash on link %s", l.ID)
		}
		if !sessionNameRe.MatchString(l.Owner) || !sessionIDRe.MatchString(l.SessionID) {
			return fmt.Errorf("invalid link ref on %s", l.ID)
		}
		for _, p := range l.Transcripts {
			if !filepath.IsAbs(p) || filepath.Ext(p) != ".jsonl" {
				return fmt.Errorf("invalid transcript path on link %s", l.ID)
			}
		}
	}
	return nil
}

func (l Link) expired(now time.Time) bool {
	return l.ExpiresAt != 0 && now.Unix() >= l.ExpiresAt
}

// --- live session identity ---

// liveSession is the slice of a session a link needs: who it is (id + created),
// what to call it, and the transcript its Claude is writing.
type liveSession struct {
	ID      string
	Created int64
	Name    string
	Title   string
	// Transcript is the session's @claude_transcript stamp: the transcript its
	// Claude is writing now, "" for a plain shell.
	Transcript string
}

// The title goes last: it is free text and the only field that could hold a
// tab, so SplitN keeps it whole.
const liveSessionFmt = "#{session_id}\t#{session_created}\t#{session_name}\t" +
	"#{" + sessionio.OptionTranscript + "}\t#{" + sessionTitleOption + "}"

// listLiveSessions reads one owner's sessions. A server that is not running
// has no sessions, which is an answer (every link on it has ended); any other
// failure is an error, and callers keep what they have rather than prune on it.
var listLiveSessions = func(owner string) ([]liveSession, error) {
	out, err := tmuxCmd(owner, "list-sessions", "-F", liveSessionFmt).CombinedOutput()
	if err != nil {
		msg := string(out)
		if strings.Contains(msg, "no server running") || strings.Contains(msg, "error connecting to") {
			return []liveSession{}, nil
		}
		return nil, fmt.Errorf("list-sessions for %s: %v: %s", owner, err, strings.TrimSpace(msg))
	}
	return parseLiveSessions(out), nil
}

func parseLiveSessions(out []byte) []liveSession {
	ss := []liveSession{}
	for _, line := range strings.Split(string(out), "\n") {
		col := strings.SplitN(strings.TrimRight(line, "\r"), "\t", 5)
		if len(col) < 3 || !sessionIDRe.MatchString(col[0]) {
			continue
		}
		created, err := strconv.ParseInt(col[1], 10, 64)
		if err != nil {
			continue
		}
		s := liveSession{ID: col[0], Created: created, Name: col[2]}
		if len(col) == 5 {
			s.Transcript = col[3]
			s.Title = col[4]
		}
		ss = append(ss, s)
	}
	return ss
}

func findLiveByID(ss []liveSession, id string, created int64) (liveSession, bool) {
	for _, s := range ss {
		if s.ID == id && s.Created == created {
			return s, true
		}
	}
	return liveSession{}, false
}

func findLiveByName(ss []liveSession, name string) (liveSession, bool) {
	for _, s := range ss {
		if s.Name == name {
			return s, true
		}
	}
	return liveSession{}, false
}

func titleOrName(s liveSession) string {
	if strings.TrimSpace(s.Title) != "" {
		return s.Title
	}
	return s.Name
}

// --- owner API: /links ---

// LinkView is a link as its owner sees it.
type LinkView struct {
	ID        string `json:"id"`
	Session   string `json:"session"`
	SessionID string `json:"sessionId"`
	Title     string `json:"title,omitempty"`
	Note      string `json:"note,omitempty"`
	CreatedAt int64  `json:"createdAt"`
	ExpiresAt int64  `json:"expiresAt"`
	// Viewers is how many browsers have read the link in the last
	// viewerWindow (links_transcript.go).
	Viewers int `json:"viewers"`
	// EndedAt is set once the session has ended; the owner revokes such a link
	// from Settings, since the session is gone from the sidebar.
	EndedAt int64 `json:"endedAt,omitempty"`
}

var linkNow = time.Now

// linkCaller resolves the signed-in caller for the owner API. A lens tab
// (?as=) is refused: the lens watches, and handing out a bearer URL to
// someone else's conversation is the opposite of watching.
func linkCaller(w http.ResponseWriter, r *http.Request) string {
	osUser := resolveRealOSUser(w, r)
	if osUser == "" {
		return ""
	}
	if as := strings.TrimSpace(r.URL.Query().Get("as")); as != "" && as != osUser {
		http.Error(w, "links cannot be managed while acting as another user", http.StatusForbidden)
		return ""
	}
	return osUser
}

func handleLinks(w http.ResponseWriter, r *http.Request) {
	osUser := linkCaller(w, r)
	if osUser == "" {
		return
	}
	switch r.Method {
	case http.MethodGet:
		listLinks(w, osUser)
	case http.MethodPost:
		createLink(w, r, osUser)
	case http.MethodDelete:
		// DELETE /links?session=<name>: the session bar's Stop button.
		revokeSessionLinks(w, r, osUser)
	default:
		http.Error(w, "GET, POST or DELETE only", http.StatusMethodNotAllowed)
	}
}

func listLinks(w http.ResponseWriter, osUser string) {
	live, err := listLiveSessions(osUser)
	if err != nil {
		logAndFail(w, "link list for %s failed: %v", osUser, err)
		return
	}
	noteLinkTranscripts(osUser, live)
	pruneLinks(osUser, live)
	ls, err := linkStoreInstance.load()
	if err != nil {
		logAndFail(w, "link load for %s failed: %v", osUser, err)
		return
	}
	out := []LinkView{}
	for _, l := range ls.Links {
		if l.Owner != osUser {
			continue
		}
		if l.EndedAt != 0 {
			out = append(out, viewOf(l, liveSession{Title: l.Title}))
			continue
		}
		s, ok := findLiveByID(live, l.SessionID, l.SessionCreated)
		if !ok {
			continue
		}
		out = append(out, viewOf(l, s))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

func viewOf(l Link, s liveSession) LinkView {
	return LinkView{
		ID: l.ID, Session: s.Name, SessionID: l.SessionID, Title: s.Title,
		Note: l.Note, CreatedAt: l.CreatedAt, ExpiresAt: l.ExpiresAt,
		Viewers: views.viewers(l.ID, linkNow()), EndedAt: l.EndedAt,
	}
}

func createLink(w http.ResponseWriter, r *http.Request, osUser string) {
	var body struct {
		Name string `json:"name"`
		TTL  string `json:"ttl"`
		Note string `json:"note"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	name := strings.TrimSpace(body.Name)
	ttl := strings.TrimSpace(body.TTL)
	if !sessionNameRe.MatchString(name) {
		http.Error(w, "invalid session name", http.StatusBadRequest)
		return
	}
	d, ok := linkTTLs[ttl]
	if !ok {
		http.Error(w, "invalid lifetime: 1h, 24h, 7d or never", http.StatusBadRequest)
		return
	}
	live, err := listLiveSessions(osUser)
	if err != nil {
		logAndFail(w, "link create for %s failed: %v", osUser, err)
		return
	}
	// Only your OWN running session (decision 1). listLiveSessions reads the
	// caller's own tmux server, so a session shared with you is not in it.
	s, ok := findLiveByName(live, name)
	if !ok {
		http.Error(w, "no such running session", http.StatusNotFound)
		return
	}
	// A link shares a conversation, so a session with none (a plain shell)
	// has nothing to share (ADR-0041).
	if s.Transcript == "" {
		http.Error(w, "this session is not running Claude, so it has no conversation to share", http.StatusConflict)
		return
	}
	now := linkNow()
	token := randomToken(16)
	l := Link{
		ID: newLinkID(), TokenHash: hashToken(token), Owner: osUser,
		SessionID: s.ID, SessionCreated: s.Created,
		Note: cleanNote(body.Note), CreatedAt: now.Unix(), Title: titleOrName(s),
	}
	l.appendTranscript(s.Transcript)
	if d > 0 {
		l.ExpiresAt = now.Add(d).Unix()
	}
	err = linkStoreInstance.update(func(ls *LinkSet) error {
		n := 0
		for _, o := range ls.Links {
			if o.Owner == osUser {
				n++
			}
		}
		if n >= maxLinksPerOwner {
			return errTooManyLinks
		}
		ls.Links = append(ls.Links, l)
		return nil
	})
	if errors.Is(err, errTooManyLinks) {
		http.Error(w, "too many links; revoke some first", http.StatusConflict)
		return
	}
	if err != nil {
		logAndFail(w, "link create for %s failed: %v", osUser, err)
		return
	}
	log.Printf("link: %s created link %s to %s (%s), expires %d", osUser, l.ID, s.Name, s.ID, l.ExpiresAt)
	events.Emit("link.created", osUser, telemetry.Attrs{"tl.session": s.Name, "tl.kind": ttl})
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(struct {
		Link  LinkView `json:"link"`
		Token string   `json:"token"`
	}{viewOf(l, s), token})
}

var errTooManyLinks = errors.New("too many links")

// handleLinkByID: DELETE /links/{id} revokes one link.
func handleLinkByID(w http.ResponseWriter, r *http.Request) {
	osUser := linkCaller(w, r)
	if osUser == "" {
		return
	}
	if r.Method != http.MethodDelete {
		http.Error(w, "DELETE only", http.StatusMethodNotAllowed)
		return
	}
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/links/"), "/")
	if !linkIDRe.MatchString(id) {
		http.Error(w, "invalid link id", http.StatusBadRequest)
		return
	}
	n, err := revokeLinks(func(l Link) bool { return l.ID == id && l.Owner == osUser })
	if err != nil {
		logAndFail(w, "link revoke for %s failed: %v", osUser, err)
		return
	}
	if n == 0 {
		http.Error(w, "no such link", http.StatusNotFound)
		return
	}
	events.Emit("link.revoked", osUser, telemetry.Attrs{"tl.kind": "one"})
	w.WriteHeader(http.StatusNoContent)
}

func revokeSessionLinks(w http.ResponseWriter, r *http.Request, osUser string) {
	name := strings.TrimSpace(r.URL.Query().Get("session"))
	if !sessionNameRe.MatchString(name) {
		http.Error(w, "session required", http.StatusBadRequest)
		return
	}
	live, err := listLiveSessions(osUser)
	if err != nil {
		logAndFail(w, "link revoke for %s failed: %v", osUser, err)
		return
	}
	s, ok := findLiveByName(live, name)
	if !ok {
		http.Error(w, "no such running session", http.StatusNotFound)
		return
	}
	n, err := revokeLinks(func(l Link) bool {
		return l.Owner == osUser && l.SessionID == s.ID && l.SessionCreated == s.Created
	})
	if err != nil {
		logAndFail(w, "link revoke for %s failed: %v", osUser, err)
		return
	}
	events.Emit("link.revoked", osUser, telemetry.Attrs{"tl.session": s.Name, "tl.kind": "session"})
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]int{"revoked": n})
}

// revokeLinks removes every link match selects and drops their view keys, so
// a page already open answers 404 on its next read.
func revokeLinks(match func(Link) bool) (int, error) {
	var gone []Link
	err := linkStoreInstance.update(func(ls *LinkSet) error {
		out := ls.Links[:0]
		for _, l := range ls.Links {
			if match(l) {
				gone = append(gone, l)
				continue
			}
			out = append(out, l)
		}
		if len(gone) == 0 {
			return errNoLinkChange
		}
		ls.Links = out
		return nil
	})
	if errors.Is(err, errNoLinkChange) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	for _, l := range gone {
		views.dropLink(l.ID)
		log.Printf("link: %s link %s to %s ended", l.Owner, l.ID, l.SessionID)
	}
	return len(gone), nil
}

// pruneLinks handles this owner's links whose time is up: an expired link
// goes, a link whose session ended is marked ended and keeps showing its
// conversation (ADR-0040), and a link that never recorded a transcript goes
// with its session. live must be a successful reading.
func pruneLinks(owner string, live []liveSession) {
	now := linkNow()
	gone := func(l Link) bool {
		_, ok := findLiveByID(live, l.SessionID, l.SessionCreated)
		return l.EndedAt == 0 && !ok
	}
	if _, err := revokeLinks(func(l Link) bool {
		if l.Owner != owner {
			return false
		}
		return l.expired(now) || (gone(l) && len(l.Transcripts) == 0)
	}); err != nil {
		log.Printf("link prune for %s failed: %v", owner, err)
	}
	err := linkStoreInstance.update(func(ls *LinkSet) error {
		changed := false
		for i := range ls.Links {
			l := &ls.Links[i]
			if l.Owner == owner && gone(*l) && len(l.Transcripts) > 0 {
				l.EndedAt = now.Unix()
				changed = true
				log.Printf("link: %s link %s to %s now shows its finished conversation", l.Owner, l.ID, l.SessionID)
			}
		}
		if !changed {
			return errNoLinkChange
		}
		return nil
	})
	if err != nil && !errors.Is(err, errNoLinkChange) {
		log.Printf("link: ending links for %s failed: %v", owner, err)
	}
}

// runLinkSweep records transcripts, ends expired links and marks links whose
// session has gone, without waiting for anyone to open the lobby. It also
// drops share rows whose session has ended (shares.go).
func runLinkSweep(stop <-chan struct{}) {
	t := time.NewTicker(15 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			sweepLinksOnce()
		}
	}
}

func sweepLinksOnce() {
	owners := map[string]bool{}
	if ls, err := linkStoreInstance.load(); err == nil {
		for _, l := range ls.Links {
			owners[l.Owner] = true
		}
	}
	if ss, err := shareStoreInstance.load(); err == nil {
		for _, sh := range ss.Shares {
			owners[sh.Owner] = true
		}
	}
	for owner := range owners {
		live, err := listLiveSessions(owner)
		if err != nil {
			continue // unknown is not ended: keep everything until a clean read
		}
		noteLinkTranscripts(owner, live)
		pruneLinks(owner, live)
		stampLegacySharesFor(owner, live)
		pruneShares(owner, live)
	}
}

// --- public API: /link/redeem ---

// handleLinkRedeem trades a token for a view cookie and says what the link
// shows. It carries no identity: the ingress sends it here with no
// forward-auth. Every failure answers the same 404, so a caller learns nothing
// about whether a token ever existed, expired, or was revoked.
func handleLinkRedeem(w http.ResponseWriter, r *http.Request) {
	if err := actAsGate.CheckProxySecret(r); err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	if !redeemLimiter.allow(clientIP(r), linkNow()) {
		w.Header().Set("Retry-After", "60")
		http.Error(w, "too many requests", http.StatusTooManyRequests)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	var body struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body); err != nil || !linkTokenRe.MatchString(body.Token) {
		http.Error(w, "link not found", http.StatusNotFound)
		return
	}
	l, _, ok := resolveLink(func(l Link) bool { return l.TokenHash == hashToken(body.Token) })
	if !ok {
		http.Error(w, "link not found", http.StatusNotFound)
		return
	}
	key, err := views.mint(l.ID, linkNow())
	if err != nil {
		http.Error(w, "busy", http.StatusServiceUnavailable)
		return
	}
	setViewCookie(w, l.ID, key)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(struct {
		Link      string `json:"link"`
		Title     string `json:"title"`
		ExpiresAt int64  `json:"expiresAt"`
		EndedAt   int64  `json:"endedAt"`
	}{l.ID, l.Title, l.ExpiresAt, l.EndedAt})
}

// resolveLink finds a link by match that is still valid: present, unexpired,
// and either ended or with its session running. A session that went between
// sweeps is handled on the spot by the sweep's own rule.
func resolveLink(match func(Link) bool) (Link, liveSession, bool) {
	find := func() (Link, bool) {
		ls, err := linkStoreInstance.load()
		if err != nil {
			log.Printf("link load failed: %v", err)
			return Link{}, false
		}
		for _, c := range ls.Links {
			if match(c) {
				return c, true
			}
		}
		return Link{}, false
	}
	l, found := find()
	if !found {
		return Link{}, liveSession{}, false
	}
	if l.expired(linkNow()) {
		_, _ = revokeLinks(func(c Link) bool { return c.ID == l.ID })
		return Link{}, liveSession{}, false
	}
	if l.EndedAt != 0 {
		return l, liveSession{}, true
	}
	live, err := listLiveSessions(l.Owner)
	if err != nil {
		log.Printf("link %s: %v", l.ID, err)
		return Link{}, liveSession{}, false
	}
	if s, ok := findLiveByID(live, l.SessionID, l.SessionCreated); ok {
		return l, s, true
	}
	noteLinkTranscripts(l.Owner, live)
	pruneLinks(l.Owner, live)
	if l, found = find(); found && l.EndedAt != 0 {
		return l, liveSession{}, true
	}
	return Link{}, liveSession{}, false
}

// clientIP is the visitor's address as the proxy saw it. X-Real-Ip is set by
// Traefik's real-ip middleware, overwriting anything a client sent; the peer
// address is the fallback for a deployment without it.
func clientIP(r *http.Request) string {
	if ip := strings.TrimSpace(r.Header.Get("X-Real-Ip")); net.ParseIP(ip) != nil {
		return ip
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// rateLimiter is a fixed-window counter per key plus a global ceiling. The
// token is 128 bits, so this is not what stops guessing; it keeps a flood of
// redeems from filling the view-key book or the journal.
type rateLimiter struct {
	mu        sync.Mutex
	window    time.Duration
	perKey    int
	global    int
	start     time.Time
	counts    map[string]int
	globalCnt int
}

var redeemLimiter = &rateLimiter{window: time.Minute, perKey: 30, global: 600, counts: map[string]int{}}

func (l *rateLimiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if now.Sub(l.start) >= l.window {
		l.start = now
		l.counts = map[string]int{}
		l.globalCnt = 0
	}
	if l.globalCnt >= l.global || l.counts[key] >= l.perKey {
		return false
	}
	l.globalCnt++
	l.counts[key]++
	return true
}
