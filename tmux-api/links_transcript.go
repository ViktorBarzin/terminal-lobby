package main

// Public links that outlive their session (ADR-0040).
//
// A link used to end with its session. Viktor, 2026-10-06: once he kills a
// session, a link to it should still show a read-only transcript until it
// expires or he revokes it, so he can share a conversation without keeping
// it in his sidebar. So a link now records, while its session runs, every
// Claude transcript that session writes (a session can run several, one per
// /clear), and when the session ends the link keeps that list instead of
// being deleted. A session with no transcript (a plain shell) ends its links
// as before.
//
// An ended link is read through four routes, all of them anonymous:
//
//   - POST /link/redeem answers {mode: "transcript", ...} for an ended link
//     and sets a VIEW cookie, scoped to /s/api/link/ and to this link.
//   - GET /link/transcript?l=<id>   every conversation, as Text-view events
//   - GET /link/result?l=<id>&tool= one tool result in full
//   - GET /link/image?l=<id>&...    one picture block from a transcript
//   - GET /link/picture?l=<id>&p=   one picture from the clipboard store that
//     a transcript names
//
// The view key travels in a cookie rather than the URL because pictures are
// <img> GETs, and a URL is what access logs record. It is random, bound to
// one link, held in memory, and dropped when the link is revoked or expires.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"terminal-lobby/sessionio"
)

const (
	// viewTTL is how long a view key lasts. Long enough to read a long
	// conversation; a reload redeems again and gets a fresh one.
	viewTTL = 6 * time.Hour
	// maxLinkTranscripts bounds how many conversations one link records.
	maxLinkTranscripts = 50
	// maxTranscriptEvents bounds what one /link/transcript answer carries.
	// Older events are dropped from the front, with a row saying so.
	maxTranscriptEvents = 6000
	// clipboardStoreRoot is where pasted and shown pictures live
	// (clipboard-upload, ADR-0005): <root>/<owner>/<session>/<name>.
	defaultClipboardStoreRoot = "/var/lib/clipboard-store"
)

// --- view keys ---

type view struct {
	linkID  string
	expires time.Time
}

type viewBook struct {
	mu sync.Mutex
	m  map[string]view // keyed by hashToken(key)
}

var views = &viewBook{m: map[string]view{}}

func (b *viewBook) mint(linkID string, now time.Time) (string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for k, v := range b.m {
		if !now.Before(v.expires) {
			delete(b.m, k)
		}
	}
	if len(b.m) >= maxTickets {
		return "", errTicketBookFull
	}
	k := randomToken(24)
	b.m[hashToken(k)] = view{linkID: linkID, expires: now.Add(viewTTL)}
	return k, nil
}

// check reports whether key is a live view of linkID. Unlike a ticket it is
// not spent: one page load reads the transcript and every picture in it.
func (b *viewBook) check(key, linkID string, now time.Time) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	v, ok := b.m[hashToken(key)]
	return ok && v.linkID == linkID && now.Before(v.expires)
}

func (b *viewBook) dropLink(linkID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for k, v := range b.m {
		if v.linkID == linkID {
			delete(b.m, k)
		}
	}
}

// viewCookieName is per link, so two links open in one browser do not
// overwrite each other's key.
func viewCookieName(linkID string) string { return "tl_lv_" + linkID }

// setViewCookie hands the visitor's browser the key for an ended link. Path
// keeps it off every route but the link reads, HttpOnly keeps it out of page
// script, and SameSite=Strict keeps another site from riding it.
func setViewCookie(w http.ResponseWriter, linkID, key string) {
	http.SetCookie(w, &http.Cookie{
		Name:     viewCookieName(linkID),
		Value:    key,
		Path:     "/s/api/link/",
		MaxAge:   int(viewTTL / time.Second),
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteStrictMode,
	})
}

// --- recording transcripts while the session runs ---

// appendTranscript adds path to the link's list once, keeping the order the
// conversations ran in. Reports whether anything changed.
func (l *Link) appendTranscript(path string) bool {
	if path == "" || !filepath.IsAbs(path) || filepath.Ext(path) != ".jsonl" {
		return false
	}
	for _, p := range l.Transcripts {
		if p == path {
			return false
		}
	}
	if len(l.Transcripts) >= maxLinkTranscripts {
		return false
	}
	l.Transcripts = append(l.Transcripts, path)
	return true
}

// noteLinkTranscripts records, for every live link of owner, the transcript
// its session is writing now and its current title. Called by the sweep, by
// the owner's list, and by the kill path just before tmux loses the stamp.
func noteLinkTranscripts(owner string, live []liveSession) {
	err := linkStoreInstance.update(func(ls *LinkSet) error {
		changed := false
		for i := range ls.Links {
			l := &ls.Links[i]
			if l.Owner != owner || l.EndedAt != 0 {
				continue
			}
			s, ok := findLiveByID(live, l.SessionID, l.SessionCreated)
			if !ok {
				continue
			}
			if l.appendTranscript(s.Transcript) {
				changed = true
			}
			if t := titleOrName(s); t != l.Title {
				l.Title = t
				changed = true
			}
		}
		if !changed {
			return errNoLinkChange
		}
		return nil
	})
	if err != nil && !errors.Is(err, errNoLinkChange) {
		log.Printf("link: noting transcripts for %s failed: %v", owner, err)
	}
}

// noteLinkTranscriptsBeforeKill is the kill path's hook: the transcript stamp
// is a tmux option, so it has to be read while the session still exists.
//
// It reads the store first and asks tmux only when the owner has a live link,
// so a kill with no links pays nothing for this.
func noteLinkTranscriptsBeforeKill(owner string) {
	ls, err := linkStoreInstance.load()
	if err != nil {
		return
	}
	has := false
	for _, l := range ls.Links {
		if l.Owner == owner && l.EndedAt == 0 {
			has = true
			break
		}
	}
	if !has {
		return
	}
	live, err := listLiveSessions(owner)
	if err != nil {
		return
	}
	noteLinkTranscripts(owner, live)
}

// --- reading a link's transcripts as the owner ---

// transcriptReader reads one owner's transcript files. The owner's
// ~/.claude/projects is 0700, so for anyone but the service user the work
// runs in session-events' own privileged child, `sudo -u <owner>
// session-events -privop`, which bounds every path to that user's projects
// tree. The same grant session-events uses; tmux-api adds no new one.
type transcriptReader interface {
	lines(path string) ([]string, error)
	fullResult(path, toolID string) (string, error)
	image(path string, addr sessionio.ImageAddr) (sessionio.ImageData, error)
	close()
}

var newTranscriptReader = func(owner string) (transcriptReader, error) {
	if owner == selfUser {
		return localTranscripts{}, nil
	}
	return startPrivTranscripts(owner)
}

type localTranscripts struct{}

func (localTranscripts) lines(path string) ([]string, error) {
	l, _, err := sessionio.LocalReader{}.ReadFrom(path, 0)
	return l, err
}

func (localTranscripts) fullResult(path, toolID string) (string, error) {
	body, _, err := sessionio.LocalReader{}.FullResult(path, toolID)
	return body, err
}

func (localTranscripts) image(path string, addr sessionio.ImageAddr) (sessionio.ImageData, error) {
	return sessionio.LocalReader{}.ImageBlock(path, addr)
}

func (localTranscripts) close() {}

// privTranscripts speaks session-events' privop protocol (session-events/
// privop.go): one JSON request per line in, one JSON response per line out.
type privTranscripts struct {
	cmd *exec.Cmd
	in  io.WriteCloser
	enc *json.Encoder
	dec *json.Decoder
}

type privopRequest struct {
	Op     string `json:"op"`
	Path   string `json:"path,omitempty"`
	Off    int64  `json:"off,omitempty"`
	ToolID string `json:"toolId,omitempty"`
	Record string `json:"record,omitempty"`
	N      int    `json:"n,omitempty"`
}

type privopResponse struct {
	OK    bool   `json:"ok"`
	Err   string `json:"err,omitempty"`
	Blob  []byte `json:"blob,omitempty"`
	Media string `json:"media,omitempty"`
	Body  string `json:"body,omitempty"`
}

const sessionEventsBinary = "/usr/local/bin/session-events"

func startPrivTranscripts(owner string) (*privTranscripts, error) {
	cmd := exec.Command(sudoBinary, "-n", "-u", owner, sessionEventsBinary, "-privop")
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("starting a transcript reader for %s: %w", owner, err)
	}
	return &privTranscripts{cmd: cmd, in: in, enc: json.NewEncoder(in), dec: json.NewDecoder(bufio.NewReader(out))}, nil
}

func (p *privTranscripts) do(req privopRequest) (privopResponse, error) {
	if err := p.enc.Encode(req); err != nil {
		return privopResponse{}, err
	}
	var resp privopResponse
	if err := p.dec.Decode(&resp); err != nil {
		return privopResponse{}, err
	}
	if !resp.OK {
		return resp, errors.New(resp.Err)
	}
	return resp, nil
}

func (p *privTranscripts) lines(path string) ([]string, error) {
	resp, err := p.do(privopRequest{Op: "readfrom", Path: path})
	if err != nil {
		return nil, err
	}
	return completeLines(resp.Blob), nil
}

func (p *privTranscripts) fullResult(path, toolID string) (string, error) {
	resp, err := p.do(privopRequest{Op: "fullresult", Path: path, ToolID: toolID})
	return resp.Body, err
}

func (p *privTranscripts) image(path string, addr sessionio.ImageAddr) (sessionio.ImageData, error) {
	resp, err := p.do(privopRequest{Op: "image", Path: path, ToolID: addr.ToolID, Record: addr.Record, N: addr.N})
	return sessionio.ImageData{Data: resp.Blob, MediaType: resp.Media}, err
}

func (p *privTranscripts) close() {
	p.in.Close()
	if p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
	_ = p.cmd.Wait()
}

// completeLines splits a blob into its newline-terminated lines. A partial
// last line is a write still in flight and is left out.
func completeLines(blob []byte) []string {
	var out []string
	for len(blob) > 0 {
		i := bytes.IndexByte(blob, '\n')
		if i < 0 {
			break
		}
		if i > 0 {
			out = append(out, string(blob[:i]))
		}
		blob = blob[i+1:]
	}
	return out
}

// --- building the visitor's transcript ---

// linkEvents turns a link's transcripts into one Text-view event stream: each
// conversation through its own normalizer, a divider between conversations,
// and ids renumbered so two conversations never share one. A file that cannot
// be read is skipped with a row saying so rather than failing the page.
func linkEvents(r transcriptReader, l Link) []sessionio.Event {
	var out []sessionio.Event
	var seq int64
	push := func(e sessionio.Event) {
		seq++
		e.ID = seq
		out = append(out, e)
	}
	for i, path := range l.Transcripts {
		if i > 0 {
			push(sessionio.Event{Kind: sessionio.KindSession, Body: "A new conversation started here (/clear)"})
		}
		lines, err := r.lines(path)
		if err != nil {
			log.Printf("link %s: reading %s: %v", l.ID, path, err)
			push(sessionio.Event{Kind: sessionio.KindSession, Body: "Part of this conversation could not be read."})
			continue
		}
		n := sessionio.NewNormalizer(l.ID)
		for _, line := range lines {
			for _, e := range n.Line([]byte(line)) {
				push(e)
			}
		}
	}
	if len(out) > maxTranscriptEvents {
		out = out[len(out)-maxTranscriptEvents:]
		out = append([]sessionio.Event{{ID: 0, Kind: sessionio.KindSession, Body: "The earlier part of this conversation is not shown."}}, out...)
	}
	return out
}

// --- the anonymous read routes ---

// viewedLink resolves ?l=<id> plus that link's view cookie to an ended link.
// Every failure is the same 404, as with redeem.
func viewedLink(w http.ResponseWriter, r *http.Request) (Link, bool) {
	if err := actAsGate.CheckProxySecret(r); err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return Link{}, false
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return Link{}, false
	}
	w.Header().Set("Cache-Control", "no-store")
	id := r.URL.Query().Get("l")
	c, err := r.Cookie(viewCookieName(id))
	if !linkIDRe.MatchString(id) || err != nil || !ticketRe.MatchString(c.Value) || !views.check(c.Value, id, linkNow()) {
		http.Error(w, "link not found", http.StatusNotFound)
		return Link{}, false
	}
	l, _, ok := resolveLink(func(l Link) bool { return l.ID == id })
	if !ok || l.EndedAt == 0 {
		http.Error(w, "link not found", http.StatusNotFound)
		return Link{}, false
	}
	return l, true
}

func handleLinkTranscript(w http.ResponseWriter, r *http.Request) {
	l, ok := viewedLink(w, r)
	if !ok {
		return
	}
	rd, err := newTranscriptReader(l.Owner)
	if err != nil {
		logAndFail(w, "link transcript reader for %s: %v", l.Owner, err)
		return
	}
	defer rd.close()
	events := linkEvents(rd, l)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(struct {
		Title     string            `json:"title"`
		EndedAt   int64             `json:"endedAt"`
		ExpiresAt int64             `json:"expiresAt"`
		Events    []sessionio.Event `json:"events"`
	}{l.Title, l.EndedAt, l.ExpiresAt, events})
}

func handleLinkResult(w http.ResponseWriter, r *http.Request) {
	l, ok := viewedLink(w, r)
	if !ok {
		return
	}
	tool := r.URL.Query().Get("tool")
	if !toolIDRe.MatchString(tool) {
		http.Error(w, "invalid tool id", http.StatusBadRequest)
		return
	}
	rd, err := newTranscriptReader(l.Owner)
	if err != nil {
		logAndFail(w, "link result reader for %s: %v", l.Owner, err)
		return
	}
	defer rd.close()
	for _, path := range l.Transcripts {
		if body, err := rd.fullResult(path, tool); err == nil {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]string{"body": body})
			return
		}
	}
	http.Error(w, "no such result", http.StatusNotFound)
}

// toolIDRe and recordIDRe bound the ids a visitor may ask about to the shapes
// Claude Code writes, so nothing odd reaches the privileged reader.
var (
	toolIDRe   = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
	recordIDRe = regexp.MustCompile(`^[0-9a-fA-F-]{8,64}$`)
)

func handleLinkImage(w http.ResponseWriter, r *http.Request) {
	l, ok := viewedLink(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	n, err := strconv.Atoi(q.Get("n"))
	addr := sessionio.ImageAddr{ToolID: q.Get("tool"), Record: q.Get("record"), N: n}
	valid := err == nil && n >= 0 && n < 1000 &&
		((addr.ToolID != "" && addr.Record == "" && toolIDRe.MatchString(addr.ToolID)) ||
			(addr.Record != "" && addr.ToolID == "" && recordIDRe.MatchString(addr.Record)))
	if !valid {
		http.Error(w, "invalid image address", http.StatusBadRequest)
		return
	}
	rd, err := newTranscriptReader(l.Owner)
	if err != nil {
		logAndFail(w, "link image reader for %s: %v", l.Owner, err)
		return
	}
	defer rd.close()
	for _, path := range l.Transcripts {
		if img, err := rd.image(path, addr); err == nil && len(img.Data) > 0 {
			servePicture(w, img.Data)
			return
		}
	}
	http.Error(w, "no such image", http.StatusNotFound)
}

// handleLinkPicture serves a picture from the owner's clipboard store, and
// only one that a transcript of this link names verbatim: what show-image
// registered or a person pasted while the conversation ran. Anything else a
// transcript mentions (a file elsewhere on disk) is not served.
func handleLinkPicture(w http.ResponseWriter, r *http.Request) {
	l, ok := viewedLink(w, r)
	if !ok {
		return
	}
	p := filepath.Clean(r.URL.Query().Get("p"))
	ownStore := clipboardStoreRoot + "/" + l.Owner + "/"
	if !strings.HasPrefix(p, ownStore) || !pictureExt[strings.ToLower(filepath.Ext(p))] {
		http.Error(w, "not a picture this link can show", http.StatusNotFound)
		return
	}
	rd, err := newTranscriptReader(l.Owner)
	if err != nil {
		logAndFail(w, "link picture reader for %s: %v", l.Owner, err)
		return
	}
	named := false
	for _, path := range l.Transcripts {
		lines, err := rd.lines(path)
		if err != nil {
			continue
		}
		for _, line := range lines {
			if strings.Contains(line, p) {
				named = true
				break
			}
		}
		if named {
			break
		}
	}
	rd.close()
	if !named {
		http.Error(w, "not a picture this link can show", http.StatusNotFound)
		return
	}
	resolved, err := filepath.EvalSymlinks(p)
	if err != nil || !strings.HasPrefix(resolved, ownStore) {
		http.Error(w, "not a picture this link can show", http.StatusNotFound)
		return
	}
	data, err := readCapped(resolved, 25<<20)
	if err != nil {
		http.Error(w, "not a picture this link can show", http.StatusNotFound)
		return
	}
	servePicture(w, data)
}

// clipboardStoreRoot is a var so the tests can point it at a temp tree.
var clipboardStoreRoot = defaultClipboardStoreRoot

var pictureExt = map[string]bool{".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true}

func readCapped(path string, max int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > max {
		return nil, fmt.Errorf("%s is over %d bytes", path, max)
	}
	return data, nil
}

// servePicture answers with bytes that sniff as a raster image, and nothing
// else: what a transcript claims a block is does not decide what is served.
func servePicture(w http.ResponseWriter, data []byte) {
	ct := http.DetectContentType(data)
	switch ct {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
	default:
		http.Error(w, "not a picture", http.StatusUnsupportedMediaType)
		return
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'")
	_, _ = w.Write(data)
}
