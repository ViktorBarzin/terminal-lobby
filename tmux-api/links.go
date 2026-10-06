package main

// Public links (docs/plans/2026-10-06-public-links-design.md, ADR-0039).
//
// A Link is a bearer URL to one session: whoever holds it can watch (ro) or
// drive (rw) that session as its owner, with no account and no sign-in. That
// makes this file the only place in the service where a request with no
// identity reaches a session, so each step is narrow on purpose:
//
//   - The token is 128 random bits, shown to the owner once and stored only as
//     a SHA-256. It never travels in a URL: the visitor page holds it in the
//     fragment and POSTs it to /link/redeem.
//   - Redeeming mints a TICKET: single use, 30 seconds, held in memory. Only
//     the ticket appears in a request URL (the ttyd-link /token and /ws query),
//     so an access log holds nothing that can be replayed.
//   - The ttyd-link attach script spends the ticket at /internal/link-attach,
//     loopback and internal-token gated like /internal/attach, and gets back
//     the owner, tmux's session id and the mode. It attaches exactly that.
//
// A link is pinned to tmux's #{session_id} AND #{session_created}. The id alone
// is reused from $0 after a server restart, so it could name a different
// session after a reboot; the pair cannot. A link whose session has ended is
// dropped, which is decision 7: a link dies with its session.

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

	"terminal-lobby/authuser"
	"terminal-lobby/telemetry"
)

// Link is one public link, as stored.
type Link struct {
	// ID names the link to its owner (list, revoke). It is not a secret and
	// cannot be redeemed: only the token can.
	ID string `json:"id"`
	// TokenHash is hex SHA-256 of the token. The token itself is never stored.
	TokenHash      string `json:"tokenHash"`
	Owner          string `json:"owner"`
	SessionID      string `json:"sessionId"`
	SessionCreated int64  `json:"sessionCreated"`
	Mode           string `json:"mode"`
	Note           string `json:"note,omitempty"`
	CreatedAt      int64  `json:"createdAt"`
	// ExpiresAt is a unix second; 0 means until revoked (read-only links only).
	ExpiresAt int64 `json:"expiresAt"`
}

// LinkSet is the whole link document.
type LinkSet struct {
	Version int    `json:"version"`
	Links   []Link `json:"links"`
}

const (
	linksVersion = 1
	linksPath    = "/var/lib/tmux-api/links.json"

	// ticketTTL is how long a minted ticket may wait to be spent. The visitor
	// page spends it within a second of minting it; 30 s covers a slow phone.
	ticketTTL = 30 * time.Second
	// maxTickets bounds the in-memory book, so a flood of redeems cannot grow
	// it without limit. Past it, a redeem answers 503 until tickets expire.
	maxTickets = 2000
	// maxLinksPerOwner keeps one account's store small enough to read whole.
	maxLinksPerOwner = 100
	// maxNoteRunes bounds the owner's private note.
	maxNoteRunes = 80
	// linkPushEvery throttles the read-write visitor push per link, so a
	// visitor on a flaky connection does not notify on every reconnect.
	linkPushEvery = 10 * time.Minute
	// visitorSettle is how long a freshly recorded visitor is kept even when
	// tmux does not list its client yet: the attach script records the tty and
	// THEN execs tmux, so the first poll can land in between.
	visitorSettle = 15 * time.Second
	kindLink      = "link"
)

// linkTTLs are the lifetimes the owner may pick (decision 3). "never" is
// read-only only; a read-write link is capped at 24h.
var linkTTLs = map[string]time.Duration{
	"1h":    time.Hour,
	"24h":   24 * time.Hour,
	"7d":    7 * 24 * time.Hour,
	"never": 0,
}

func linkTTLAllowed(mode, ttl string) bool {
	d, ok := linkTTLs[ttl]
	if !ok {
		return false
	}
	if mode == shareModeRW && (d == 0 || d > 24*time.Hour) {
		return false
	}
	return true
}

var (
	linkIDRe = regexp.MustCompile(`^[0-9a-f]{16}$`)
	// linkTokenRe is 16 random bytes, base64url without padding: 22 chars.
	linkTokenRe = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)
	// ticketRe is 24 random bytes, base64url without padding: 32 chars. The
	// attach script applies the same pattern before it ever reaches here.
	ticketRe = regexp.MustCompile(`^[A-Za-z0-9_-]{32}$`)
)

func randomToken(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		// Same stance as newMintedName: a predictable token is worse than a
		// crash, because it would be a working credential to someone's shell.
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
		if l.Mode != shareModeRO && l.Mode != shareModeRW {
			return fmt.Errorf("invalid link mode %q", l.Mode)
		}
		if l.Mode == shareModeRW && l.ExpiresAt == 0 {
			return fmt.Errorf("read-write link %s has no expiry", l.ID)
		}
	}
	return nil
}

func (l Link) expired(now time.Time) bool {
	return l.ExpiresAt != 0 && now.Unix() >= l.ExpiresAt
}

// --- live session identity ---

// liveSession is the slice of a session a link needs: who it is (id + created)
// and what to call it.
type liveSession struct {
	ID      string
	Created int64
	Name    string
	Title   string
	// Cols and Rows are the session's window: what a read-only visitor's
	// terminal is drawn at, since a watcher never sizes the window itself.
	Cols int
	Rows int
}

// The title goes last: it is free text and the only field that could hold a
// tab, so SplitN keeps it whole.
const liveSessionFmt = "#{session_id}\t#{session_created}\t#{session_name}\t" +
	"#{window_width}\t#{window_height}\t#{" + sessionTitleOption + "}"

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
		col := strings.SplitN(strings.TrimRight(line, "\r"), "\t", 6)
		if len(col) < 3 || !sessionIDRe.MatchString(col[0]) {
			continue
		}
		created, err := strconv.ParseInt(col[1], 10, 64)
		if err != nil {
			continue
		}
		s := liveSession{ID: col[0], Created: created, Name: col[2]}
		if len(col) >= 5 {
			s.Cols, _ = strconv.Atoi(col[3])
			s.Rows, _ = strconv.Atoi(col[4])
		}
		if len(col) == 6 {
			s.Title = col[5]
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

// --- tickets ---

type ticket struct {
	linkID  string
	expires time.Time
}

type ticketBook struct {
	mu sync.Mutex
	m  map[string]ticket // keyed by hashToken(ticket)
}

var tickets = &ticketBook{m: map[string]ticket{}}

var errTicketBookFull = errors.New("ticket book full")

func (b *ticketBook) mint(linkID string, now time.Time) (string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.sweepLocked(now)
	if len(b.m) >= maxTickets {
		return "", errTicketBookFull
	}
	t := randomToken(24)
	b.m[hashToken(t)] = ticket{linkID: linkID, expires: now.Add(ticketTTL)}
	return t, nil
}

// spend consumes a ticket. It answers the link id once, and never again.
func (b *ticketBook) spend(t string, now time.Time) (string, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	k := hashToken(t)
	tk, ok := b.m[k]
	if !ok {
		return "", false
	}
	delete(b.m, k)
	if !now.Before(tk.expires) {
		return "", false
	}
	return tk.linkID, true
}

func (b *ticketBook) sweepLocked(now time.Time) {
	for k, tk := range b.m {
		if !now.Before(tk.expires) {
			delete(b.m, k)
		}
	}
}

// dropLink forgets every outstanding ticket for a revoked link, so a ticket
// minted a second before the revoke cannot be spent after it.
func (b *ticketBook) dropLink(linkID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for k, tk := range b.m {
		if tk.linkID == linkID {
			delete(b.m, k)
		}
	}
}

// --- visitors ---

// visitor is one live link attach: the tmux client a ttyd-link connection
// became, recorded by tty so a revoke or an expiry can detach exactly it.
type visitor struct {
	LinkID    string    `json:"linkId"`
	Owner     string    `json:"owner"`
	SessionID string    `json:"sessionId"`
	Tty       string    `json:"tty"`
	Mode      string    `json:"mode"`
	Guest     int       `json:"guest"`
	Since     time.Time `json:"since"`
}

type visitorBook struct {
	mu sync.Mutex
	v  []visitor
	// lastPush is per link, for linkPushEvery.
	lastPush map[string]time.Time
	path     string
}

var visitors = &visitorBook{lastPush: map[string]time.Time{}, path: linkVisitorsPath}

// linkVisitorsPath keeps the visitor records across a tmux-api restart. The
// visitors' tmux clients belong to ttyd-link and outlive this process, so
// without the file a revoke after a deploy would have nothing to detach.
const linkVisitorsPath = "/var/lib/tmux-api/link-visitors.json"

// saveLocked writes the records. Best effort: a failed write costs only the
// ability to detach after a restart, and is logged.
func (b *visitorBook) saveLocked() {
	if b.path == "" {
		return
	}
	v := b.v
	if v == nil {
		v = []visitor{}
	}
	if err := writeAtomicJSON(filepath.Dir(b.path), "link-visitors.*.tmp", b.path, v); err != nil {
		log.Printf("link: saving visitors: %v", err)
	}
}

// loadVisitors reads the records written before a restart. Called once at
// startup; the first session poll then drops any whose client has gone.
func (b *visitorBook) loadVisitors() {
	b.mu.Lock()
	defer b.mu.Unlock()
	raw, err := os.ReadFile(b.path)
	if err != nil {
		return
	}
	var v []visitor
	if json.Unmarshal(raw, &v) == nil {
		b.v = v
	}
}

// add records a visitor and numbers it: the lowest guest number not held by
// another live visitor of the same session, so the owner reads "guest 1",
// "guest 2" rather than a number that climbs forever.
func (b *visitorBook) add(v visitor) visitor {
	b.mu.Lock()
	defer b.mu.Unlock()
	used := map[int]bool{}
	out := b.v[:0]
	for _, o := range b.v {
		if o.Owner == v.Owner && o.Tty == v.Tty {
			continue // the pty was reused; the old record is stale
		}
		out = append(out, o)
		if o.Owner == v.Owner && o.SessionID == v.SessionID {
			used[o.Guest] = true
		}
	}
	b.v = out
	n := 1
	for used[n] {
		n++
	}
	v.Guest = n
	b.v = append(b.v, v)
	b.saveLocked()
	return v
}

func (b *visitorBook) forLink(linkID string) []visitor {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []visitor
	for _, v := range b.v {
		if v.LinkID == linkID {
			out = append(out, v)
		}
	}
	return out
}

func (b *visitorBook) removeLink(linkID string) []visitor {
	b.mu.Lock()
	defer b.mu.Unlock()
	var gone []visitor
	out := b.v[:0]
	for _, v := range b.v {
		if v.LinkID == linkID {
			gone = append(gone, v)
			continue
		}
		out = append(out, v)
	}
	b.v = out
	delete(b.lastPush, linkID)
	if len(gone) > 0 {
		b.saveLocked()
	}
	return gone
}

// shouldPush reports whether a read-write visit to this link should notify the
// owner now, and records that it did.
func (b *visitorBook) shouldPush(linkID string, now time.Time) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if last, ok := b.lastPush[linkID]; ok && now.Sub(last) < linkPushEvery {
		return false
	}
	b.lastPush[linkID] = now
	return true
}

// reconcile drops visitors whose client tmux no longer lists for this owner,
// past the settle window, and returns per-session counts for those remaining.
// clients is the owner's whole list-clients reading.
func (b *visitorBook) reconcile(owner string, clients []client, now time.Time) map[string]VisitorCount {
	b.mu.Lock()
	defer b.mu.Unlock()
	attached := map[string]client{}
	for _, c := range clients {
		if c.Name != "" {
			attached[c.Name] = c
		}
	}
	counts := map[string]VisitorCount{}
	before := len(b.v)
	out := b.v[:0]
	for _, v := range b.v {
		if v.Owner != owner {
			out = append(out, v)
			continue
		}
		c, ok := attached[v.Tty]
		if !ok && now.Sub(v.Since) < visitorSettle {
			out = append(out, v)
			continue
		}
		if !ok {
			continue
		}
		out = append(out, v)
		vc := counts[v.SessionID]
		vc.Total++
		if !isReadOnly(c.Flags) {
			vc.Driving++
		}
		counts[v.SessionID] = vc
	}
	b.v = out
	if len(b.v) != before {
		b.saveLocked()
	}
	return counts
}

// VisitorCount is what GET /sessions carries for a session with live link
// visitors: how many, and how many of them can type.
type VisitorCount struct {
	Total   int `json:"total"`
	Driving int `json:"driving"`
}

// annotateVisitors stamps each session with its live link visitors, from the
// client list the session poll already read. No extra tmux call.
func annotateVisitors(owner string, sessions []Session, clients []client) {
	counts := visitors.reconcile(owner, clients, time.Now())
	if len(counts) == 0 {
		return
	}
	for i := range sessions {
		if vc, ok := counts[sessions[i].ID]; ok && vc.Total > 0 {
			c := vc
			sessions[i].Visitors = &c
		}
	}
}

// --- detaching ---

const linkClientFmt = "#{client_name}\t#{client_created}"

// detachVisitor kicks one visitor's tmux client, after checking the client on
// that tty is still the one we recorded. ttys are reused: once a visitor has
// gone, the same /dev/pts/N can belong to the owner's own next attach, and
// detaching that would be the wrong client. client_created pins it.
var detachVisitor = func(v visitor) {
	if !ttyRe.MatchString(v.Tty) {
		return
	}
	out, err := tmuxCmd(v.Owner, "list-clients", "-F", linkClientFmt).Output()
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(out), "\n") {
		col := strings.Split(line, "\t")
		if len(col) != 2 || col[0] != v.Tty {
			continue
		}
		created, err := strconv.ParseInt(col[1], 10, 64)
		if err != nil || !sameClient(created, v.Since) {
			log.Printf("link: not detaching %s on %s: the client there is not the visitor recorded", v.Tty, v.Owner)
			return
		}
		if out, err := tmuxCmd(v.Owner, "detach-client", "-t", v.Tty).CombinedOutput(); err != nil {
			log.Printf("link: detach %s on %s: %v: %s", v.Tty, v.Owner, err, strings.TrimSpace(string(out)))
		}
		return
	}
}

// detachRetries are when a revoked visitor is detached, measured from the
// revoke. More than once because of the attach window: the visitor is recorded
// at /internal/link-join and tmux attaches a moment later, so a revoke landing
// in between finds no client yet. The later passes catch it once it is there.
var detachRetries = []time.Duration{0, time.Second, 3 * time.Second, 10 * time.Second}

var linkSleep = time.Sleep

func detachWithRetries(vs []visitor) {
	var waited time.Duration
	for _, d := range detachRetries {
		linkSleep(d - waited)
		waited = d
		for _, v := range vs {
			detachVisitor(v)
		}
	}
}

// sameClient: the client attached within a few seconds of the record. The
// record is written just before tmux attaches, so the client is a little newer.
func sameClient(clientCreated int64, recorded time.Time) bool {
	d := clientCreated - recorded.Unix()
	return d >= -2 && d <= 30
}

// --- owner API: /links ---

// LinkView is a link as its owner sees it.
type LinkView struct {
	ID        string        `json:"id"`
	Session   string        `json:"session"`
	SessionID string        `json:"sessionId"`
	Title     string        `json:"title,omitempty"`
	Mode      string        `json:"mode"`
	Note      string        `json:"note,omitempty"`
	CreatedAt int64         `json:"createdAt"`
	ExpiresAt int64         `json:"expiresAt"`
	Visitors  []VisitorView `json:"visitors"`
}

// VisitorView is one live visitor, as the owner sees it.
type VisitorView struct {
	Guest int    `json:"guest"`
	Mode  string `json:"mode"`
	Since int64  `json:"since"`
}

var linkNow = time.Now

// linkCaller resolves the signed-in caller for the owner API. A lens tab
// (?as=) is refused: the lens watches, and minting a bearer URL to someone
// else's shell is the opposite of watching.
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
	v := LinkView{
		ID: l.ID, Session: s.Name, SessionID: l.SessionID, Title: s.Title,
		Mode: l.Mode, Note: l.Note, CreatedAt: l.CreatedAt, ExpiresAt: l.ExpiresAt,
		Visitors: []VisitorView{},
	}
	for _, vis := range visitors.forLink(l.ID) {
		v.Visitors = append(v.Visitors, VisitorView{Guest: vis.Guest, Mode: vis.Mode, Since: vis.Since.Unix()})
	}
	sort.Slice(v.Visitors, func(i, j int) bool { return v.Visitors[i].Guest < v.Visitors[j].Guest })
	return v
}

func createLink(w http.ResponseWriter, r *http.Request, osUser string) {
	var body struct {
		Name string `json:"name"`
		Mode string `json:"mode"`
		TTL  string `json:"ttl"`
		Note string `json:"note"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	name := strings.TrimSpace(body.Name)
	mode := strings.TrimSpace(body.Mode)
	ttl := strings.TrimSpace(body.TTL)
	if !sessionNameRe.MatchString(name) {
		http.Error(w, "invalid session name", http.StatusBadRequest)
		return
	}
	if mode != shareModeRO && mode != shareModeRW {
		http.Error(w, "invalid mode", http.StatusBadRequest)
		return
	}
	if !linkTTLAllowed(mode, ttl) {
		http.Error(w, "invalid lifetime: 1h, 24h, 7d or never; a read-write link lasts at most 24h", http.StatusBadRequest)
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
	now := linkNow()
	token := randomToken(16)
	l := Link{
		ID: newLinkID(), TokenHash: hashToken(token), Owner: osUser,
		SessionID: s.ID, SessionCreated: s.Created, Mode: mode,
		Note: cleanNote(body.Note), CreatedAt: now.Unix(),
	}
	if d := linkTTLs[ttl]; d > 0 {
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
	log.Printf("link: %s created %s link %s to %s (%s), expires %d", osUser, mode, l.ID, s.Name, s.ID, l.ExpiresAt)
	events.Emit("link.created", osUser, telemetry.Attrs{
		"tl.session": s.Name, "tl.mode": mode, "tl.kind": ttl,
	})
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

// revokeLinks removes every link match selects, then detaches their visitors.
// The row goes FIRST, the same order a share revoke uses: a reconnect racing
// the revoke then fails its redeem rather than slipping in after the kick.
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
		tickets.dropLink(l.ID)
		grants.dropLink(l.ID)
		if vs := visitors.removeLink(l.ID); len(vs) > 0 {
			go detachWithRetries(vs)
		}
		log.Printf("link: %s link %s to %s ended", l.Owner, l.ID, l.SessionID)
	}
	return len(gone), nil
}

// pruneLinks ends this owner's links that have expired or whose session is no
// longer running. live must be a successful reading.
func pruneLinks(owner string, live []liveSession) {
	now := linkNow()
	if _, err := revokeLinks(func(l Link) bool {
		if l.Owner != owner {
			return false
		}
		if l.expired(now) {
			return true
		}
		_, ok := findLiveByID(live, l.SessionID, l.SessionCreated)
		return !ok
	}); err != nil {
		log.Printf("link prune for %s failed: %v", owner, err)
	}
}

// runLinkSweep ends expired links and links whose session has gone, and
// detaches their visitors, without waiting for anyone to open the lobby. It
// also drops share rows whose session has ended (shares.go).
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
		pruneLinks(owner, live)
		stampLegacySharesFor(owner, live)
		pruneShares(owner, live)
	}
}

// --- public API: /link/redeem ---

// handleLinkRedeem trades a token for a ticket. It is the one route here that
// carries no identity: the ingress sends /s/api/ to it with no forward-auth.
// Every failure answers the same 404, so a caller learns nothing about whether
// a token ever existed, expired, or outlived its session.
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
		// Peek asks about the link without minting a ticket: the visitor page
		// polls it for the window size, which moves when the owner resizes,
		// and to notice the link ending while its socket is still open.
		Peek bool `json:"peek"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body); err != nil || !linkTokenRe.MatchString(body.Token) {
		http.Error(w, "link not found", http.StatusNotFound)
		return
	}
	l, s, ok := resolveLink(func(l Link) bool { return l.TokenHash == hashToken(body.Token) })
	if !ok {
		http.Error(w, "link not found", http.StatusNotFound)
		return
	}
	t := ""
	if !body.Peek {
		var err error
		if t, err = tickets.mint(l.ID, linkNow()); err != nil {
			http.Error(w, "busy", http.StatusServiceUnavailable)
			return
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(struct {
		Ticket    string `json:"ticket,omitempty"`
		Mode      string `json:"mode"`
		Title     string `json:"title"`
		ExpiresAt int64  `json:"expiresAt"`
		Cols      int    `json:"cols"`
		Rows      int    `json:"rows"`
	}{t, l.Mode, titleOrName(s), l.ExpiresAt, s.Cols, s.Rows})
}

func titleOrName(s liveSession) string {
	if strings.TrimSpace(s.Title) != "" {
		return s.Title
	}
	return s.Name
}

// resolveLink finds a live link by match: present, unexpired, its session
// still running. A link that fails the last two is ended on the spot.
func resolveLink(match func(Link) bool) (Link, liveSession, bool) {
	ls, err := linkStoreInstance.load()
	if err != nil {
		log.Printf("link load failed: %v", err)
		return Link{}, liveSession{}, false
	}
	var l Link
	found := false
	for _, c := range ls.Links {
		if match(c) {
			l, found = c, true
			break
		}
	}
	if !found {
		return Link{}, liveSession{}, false
	}
	if l.expired(linkNow()) {
		_, _ = revokeLinks(func(c Link) bool { return c.ID == l.ID })
		return Link{}, liveSession{}, false
	}
	live, err := listLiveSessions(l.Owner)
	if err != nil {
		log.Printf("link %s: %v", l.ID, err)
		return Link{}, liveSession{}, false
	}
	s, ok := findLiveByID(live, l.SessionID, l.SessionCreated)
	if !ok {
		_, _ = revokeLinks(func(c Link) bool { return c.ID == l.ID })
		return Link{}, liveSession{}, false
	}
	return l, s, true
}

// clientIP is the visitor's address as the proxy saw it. X-Real-Ip is set by
// Traefik from the connection, overwriting anything a client sent; the peer
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
// redeems from filling the ticket book or the journal.
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

// --- internal: /internal/link-attach and /internal/link-join ---
//
// Two steps, run by two different accounts, so that neither can attach a
// session on its own:
//
//  1. devvm/tmux-link-attach.sh runs as tl-link, under ttyd-link-ro or
//     ttyd-link-rw, which take connections from anyone. It spends the visitor's
//     ticket here and gets back the owner and a GRANT.
//  2. It then runs `sudo -u <owner> tmux-link-join <grant>`. tl-link's sudo
//     grant is that one wrapper, as any user but root. The wrapper, now running
//     as the owner, spends the grant at /internal/link-join and attaches the
//     one target tmux-api names, read-only unless the link is read-write.
//
// So an attacker who takes over the tl-link account (a ttyd or libwebsockets
// bug, say) holds no credential that attaches anything: every attach needs a
// grant, every grant needs a ticket, and every ticket needs a live link token.
//
// Both routes are loopback only. Neither carries the internal token: tl-link
// cannot read it (it sits in wizard's 0700 /var/lib/tmux-api), and the ticket
// and the grant are each a single-use capability already.

// grant is what a spent ticket becomes: permission for the owner's wrapper to
// attach one target, once, within grantTTL.
//
// It is NOT bound to a tty. The two halves do not share one: sudo on this box
// runs with use_pty, so tmux-link-join gets a fresh pty and reports a
// different tty from the one tmux-link-attach.sh saw (measured 2026-10-06,
// /dev/pts/47 then /dev/pts/51). The join side's tty is the one the tmux
// client attaches from, so that is the one the visitor is recorded under.
type grant struct {
	linkID  string
	owner   string
	target  string
	mode    string
	expires time.Time
}

const grantTTL = 15 * time.Second

type grantBook struct {
	mu sync.Mutex
	m  map[string]grant // keyed by hashToken(grant)
}

var grants = &grantBook{m: map[string]grant{}}

func (b *grantBook) mint(g grant, now time.Time) (string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for k, o := range b.m {
		if !now.Before(o.expires) {
			delete(b.m, k)
		}
	}
	if len(b.m) >= maxTickets {
		return "", errTicketBookFull
	}
	t := randomToken(24)
	g.expires = now.Add(grantTTL)
	b.m[hashToken(t)] = g
	return t, nil
}

func (b *grantBook) spend(t string, now time.Time) (grant, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	k := hashToken(t)
	g, ok := b.m[k]
	if !ok {
		return grant{}, false
	}
	delete(b.m, k)
	return g, now.Before(g.expires)
}

func (b *grantBook) dropLink(linkID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for k, g := range b.m {
		if g.linkID == linkID {
			delete(b.m, k)
		}
	}
}

// handleInternalLinkAttach is step 1: ticket in, {owner, grant} out. mode is
// the ttyd instance the visitor reached: ttyd-link-ro takes no input at all
// (no -W), so a read-only link is only ever served there, and a read-write one
// only on ttyd-link-rw. A mismatch is refused rather than quietly downgraded,
// because the visitor page picked the instance from the redeem answer and a
// mismatch means something other than that page is calling.
func handleInternalLinkAttach(w http.ResponseWriter, r *http.Request) {
	if !isLoopbackPeer(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Ticket string `json:"ticket"`
		Tty    string `json:"tty"`
		Mode   string `json:"mode"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	if !ticketRe.MatchString(body.Ticket) || !ttyRe.MatchString(body.Tty) ||
		(body.Mode != shareModeRO && body.Mode != shareModeRW) {
		http.Error(w, "invalid ticket, tty or mode", http.StatusBadRequest)
		return
	}
	now := linkNow()
	linkID, ok := tickets.spend(body.Ticket, now)
	if !ok {
		http.Error(w, "no such ticket", http.StatusForbidden)
		return
	}
	l, _, ok := resolveLink(func(l Link) bool { return l.ID == linkID })
	if !ok {
		http.Error(w, "link ended", http.StatusForbidden)
		return
	}
	if l.Mode != body.Mode {
		log.Printf("link: refused %s ticket for link %s on the %s instance", l.Mode, l.ID, body.Mode)
		http.Error(w, "wrong instance for this link", http.StatusForbidden)
		return
	}
	g, err := grants.mint(grant{linkID: l.ID, owner: l.Owner, target: l.SessionID, mode: l.Mode}, now)
	if err != nil {
		http.Error(w, "busy", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(struct {
		Owner string `json:"owner"`
		Grant string `json:"grant"`
	}{l.Owner, g})
}

// handleInternalLinkJoin is step 2: grant in, {target, mode} out, for the
// wrapper running as the owner. user is what the wrapper says `id -un` is,
// and it must be the grant's owner, so a grant cannot be spent from another
// account's wrapper. The link is checked once more here, because a revoke can
// land between the two steps.
func handleInternalLinkJoin(w http.ResponseWriter, r *http.Request) {
	if !isLoopbackPeer(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Grant string `json:"grant"`
		User  string `json:"user"`
		Tty   string `json:"tty"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	if !ticketRe.MatchString(body.Grant) || !ttyRe.MatchString(body.Tty) {
		http.Error(w, "invalid grant or tty", http.StatusBadRequest)
		return
	}
	now := linkNow()
	g, ok := grants.spend(body.Grant, now)
	if !ok || g.owner != body.User {
		http.Error(w, "no such grant", http.StatusForbidden)
		return
	}
	l, s, ok := resolveLink(func(l Link) bool { return l.ID == g.linkID })
	if !ok || l.SessionID != g.target || l.Mode != g.mode {
		http.Error(w, "link ended", http.StatusForbidden)
		return
	}

	v := visitors.add(visitor{LinkID: l.ID, Owner: l.Owner, SessionID: l.SessionID, Tty: body.Tty, Mode: l.Mode, Since: now})
	if l.Mode == shareModeRO {
		// Same as a read-only share: the owner's size stays theirs.
		if err := pinGrid(l.Owner, s.Name); err != nil {
			log.Printf("link: pin grid %s/%s: %v", l.Owner, s.Name, err)
		}
	}

	what := "watching"
	if l.Mode == shareModeRW {
		what = "DRIVING (read-write)"
	}
	log.Printf("link attach: guest %d on %s/%s via link %s, %s", v.Guest, l.Owner, s.Name, l.ID, what)
	events.Emit("link.visit", l.Owner, telemetry.Attrs{
		"tl.session": s.Name, "tl.mode": l.Mode, "tl.client": "link",
	})
	if l.Mode == shareModeRW && visitors.shouldPush(l.ID, now) {
		go notifyLinkDriver(l.Owner, s)
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(struct {
		Target string `json:"target"`
		Mode   string `json:"mode"`
	}{l.SessionID, l.Mode})
}

// isLoopbackPeer is a seam over authuser.IsLoopback for tests.
var isLoopbackPeer = authuser.IsLoopback

// notifyLinkDriver tells the owner's devices that someone is driving a session
// through a link (decision 10). Throttled per link by the caller.
var notifyLinkDriver = func(owner string, s liveSession) {
	sender := pushSenderInstance
	if sender == nil {
		return
	}
	title := titleOrName(s)
	build := func(origin string) []byte {
		p := pushPayload{
			Title:   "Someone is driving " + title,
			Body:    "A visitor opened a read-write link to this session.",
			Tag:     "tl-link-" + s.Name,
			Session: s.Name,
		}
		if origin != "" {
			p.WebPush = declarativeWebPushVersion
			p.Notification = &declarativeNotification{
				Title:    p.Title,
				Body:     p.Body,
				Navigate: navigateURL(origin, s.Name),
				Tag:      p.Tag,
				Data:     &declarativeData{Session: s.Name},
			}
		}
		b, _ := json.Marshal(p)
		return b
	}
	sender.send(owner, "", build, kindLink)
}
