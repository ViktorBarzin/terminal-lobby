package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"terminal-lobby/sessionio"
)

// fakeTranscripts answers for transcript files from memory.
type fakeTranscripts struct {
	files  map[string][]string // path → jsonl lines
	result map[string]string   // toolId → body
	images map[string][]byte   // toolId or record → bytes
}

func (f fakeTranscripts) lines(path string) ([]string, error) {
	l, ok := f.files[path]
	if !ok {
		return nil, errors.New("no such transcript")
	}
	return l, nil
}

func (f fakeTranscripts) fullResult(path, toolID string) (string, error) {
	if b, ok := f.result[toolID]; ok {
		return b, nil
	}
	return "", errors.New("not here")
}

func (f fakeTranscripts) image(path string, addr sessionio.ImageAddr) (sessionio.ImageData, error) {
	key := addr.ToolID + addr.Record
	if b, ok := f.images[key]; ok {
		return sessionio.ImageData{Data: b}, nil
	}
	return sessionio.ImageData{}, errors.New("no image")
}

func (fakeTranscripts) close() {}

const (
	convA = "/home/w/.claude/projects/p/aaaa.jsonl"
	convB = "/home/w/.claude/projects/p/bbbb.jsonl"
)

func userLine(uuid, text string) string {
	return `{"type":"user","uuid":"` + uuid + `","timestamp":"2026-10-06T10:00:00Z","message":{"role":"user","content":"` + text + `"}}`
}

func stubTranscripts(t *testing.T, f fakeTranscripts) {
	t.Helper()
	old := newTranscriptReader
	newTranscriptReader = func(string) (transcriptReader, error) { return f, nil }
	t.Cleanup(func() { newTranscriptReader = old })
}

// A pixel of PNG, enough for http.DetectContentType.
var onePNG = []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89")

// redeemFull redeems and returns the answer plus the cookie it set, if any.
func (w *linkWorld) redeemFull(token string, peek bool) (int, map[string]any, *http.Cookie) {
	w.t.Helper()
	body := `{"token":"` + token + `"}`
	if peek {
		body = `{"token":"` + token + `","peek":true}`
	}
	rec := httptest.NewRecorder()
	handleLinkRedeem(rec, httptest.NewRequest(http.MethodPost, "/link/redeem", strings.NewReader(body)))
	var got map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	var c *http.Cookie
	if cs := rec.Result().Cookies(); len(cs) > 0 {
		c = cs[0]
	}
	return rec.Code, got, c
}

func linkGet(path string, c *http.Cookie) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodGet, path, nil)
	if c != nil {
		r.AddCookie(c)
	}
	rec := httptest.NewRecorder()
	switch {
	case strings.HasPrefix(path, "/link/transcript"):
		handleLinkTranscript(rec, r)
	case strings.HasPrefix(path, "/link/result"):
		handleLinkResult(rec, r)
	case strings.HasPrefix(path, "/link/image"):
		handleLinkImage(rec, r)
	case strings.HasPrefix(path, "/link/picture"):
		handleLinkPicture(rec, r)
	}
	return rec
}

// endedLink makes a link, lets the sweep record two conversations, then ends
// the session.
func endedLink(t *testing.T, w *linkWorld) (token string, id string) {
	t.Helper()
	w.live[w.me][0].Transcript = convA
	_, token, view := w.create(`{"name":"deploy","mode":"rw","ttl":"24h"}`)
	w.live[w.me][0].Transcript = convB // the person ran /clear
	sweepLinksOnce()
	w.live[w.me] = nil // the session is killed
	sweepLinksOnce()
	return token, view.ID
}

func TestALinkRecordsEveryConversationAndOutlivesItsSession(t *testing.T) {
	w := newLinkWorld(t)
	swapShareStore(t)
	_, id := endedLink(t, w)
	ls, _ := linkStoreInstance.load()
	if len(ls.Links) != 1 {
		t.Fatalf("the ended link was deleted: %+v", ls.Links)
	}
	l := ls.Links[0]
	if l.ID != id || l.EndedAt == 0 || strings.Join(l.Transcripts, ",") != convA+","+convB || l.Title != "Deploy the thing" {
		t.Fatalf("ended link: %+v", l)
	}
}

func TestAShellLinkStillEndsWithItsSession(t *testing.T) {
	w := newLinkWorld(t)
	swapShareStore(t)
	w.create(`{"name":"deploy","mode":"ro","ttl":"1h"}`) // no transcript stamp
	w.live[w.me] = nil
	sweepLinksOnce()
	if ls, _ := linkStoreInstance.load(); len(ls.Links) != 0 {
		t.Fatalf("a link with nothing to show survived its session: %+v", ls.Links)
	}
}

func TestAnEndedLinkStillExpires(t *testing.T) {
	w := newLinkWorld(t)
	swapShareStore(t)
	token, _ := endedLink(t, w)
	w.now = w.now.Add(25 * 60 * 60 * 1e9)
	if code, _, _ := w.redeemFull(token, false); code != http.StatusNotFound {
		t.Fatalf("an expired ended link redeemed: %d", code)
	}
}

func TestRedeemingAnEndedLinkAnswersATranscriptAndAViewCookie(t *testing.T) {
	w := newLinkWorld(t)
	swapShareStore(t)
	token, id := endedLink(t, w)

	code, got, c := w.redeemFull(token, true)
	if code != http.StatusOK || got["mode"] != "transcript" || c != nil {
		t.Fatalf("peek: %d %v cookie=%v", code, got, c)
	}
	code, got, c = w.redeemFull(token, false)
	if code != http.StatusOK || got["mode"] != "transcript" || got["link"] != id || got["ticket"] != nil {
		t.Fatalf("redeem: %d %v", code, got)
	}
	if c == nil || c.Name != "tl_lv_"+id || !c.HttpOnly || !c.Secure || c.Path != "/s/api/link/" || c.SameSite != http.SameSiteStrictMode {
		t.Fatalf("view cookie: %+v", c)
	}
}

func TestAnEndedLinkAttachesNoTerminal(t *testing.T) {
	w := newLinkWorld(t)
	swapShareStore(t)
	_, id := endedLink(t, w)
	// A ticket minted before the session ended was dropped with it.
	tk, _ := tickets.mint(id, w.now)
	if code, _ := w.attach(tk, "/dev/pts/3", "rw"); code != http.StatusForbidden {
		t.Fatalf("attach through an ended link: %d", code)
	}
}

func TestTheTranscriptIsEveryConversationInOrder(t *testing.T) {
	w := newLinkWorld(t)
	swapShareStore(t)
	token, id := endedLink(t, w)
	stubTranscripts(t, fakeTranscripts{files: map[string][]string{
		convA: {userLine("11111111-1111", "first question")},
		convB: {userLine("22222222-2222", "after clear")},
	}})
	_, _, c := w.redeemFull(token, false)

	rec := linkGet("/link/transcript?l="+id, c)
	if rec.Code != http.StatusOK {
		t.Fatalf("transcript: %d %s", rec.Code, rec.Body.String())
	}
	var got struct {
		Title  string            `json:"title"`
		Events []sessionio.Event `json:"events"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	var bodies []string
	ids := map[int64]bool{}
	for _, e := range got.Events {
		bodies = append(bodies, string(e.Kind)+":"+e.Body)
		if ids[e.ID] {
			t.Fatalf("two events share id %d", e.ID)
		}
		ids[e.ID] = true
	}
	// Each conversation's turns are its own, and each is closed.
	turns := map[string]bool{}
	var lastKind sessionio.Kind
	for _, e := range got.Events {
		if e.TurnID != "" {
			turns[e.TurnID] = true
		}
		lastKind = e.Kind
	}
	if !turns["c1-t1"] || !turns["c2-t1"] {
		t.Fatalf("turn ids not kept apart per conversation: %v", turns)
	}
	if lastKind != sessionio.KindTurnEnd {
		t.Fatalf("the last conversation was left open: ends on %q", lastKind)
	}
	joined := strings.Join(bodies, " | ")
	a, div, b := strings.Index(joined, "first question"), strings.Index(joined, "(/clear)"), strings.Index(joined, "after clear")
	if got.Title != "Deploy the thing" || a < 0 || div < a || b < div {
		t.Fatalf("events out of order or missing: %q", joined)
	}
}

func TestTheTranscriptNeedsThisLinksViewCookie(t *testing.T) {
	w := newLinkWorld(t)
	swapShareStore(t)
	token, id := endedLink(t, w)
	stubTranscripts(t, fakeTranscripts{files: map[string][]string{convA: {}, convB: {}}})

	if rec := linkGet("/link/transcript?l="+id, nil); rec.Code != http.StatusNotFound {
		t.Fatalf("no cookie: %d", rec.Code)
	}
	forged := &http.Cookie{Name: "tl_lv_" + id, Value: strings.Repeat("A", 32)}
	if rec := linkGet("/link/transcript?l="+id, forged); rec.Code != http.StatusNotFound {
		t.Fatalf("a made-up view key: %d", rec.Code)
	}
	_, _, c := w.redeemFull(token, false)
	other := "0123456789abcdef"
	c2 := &http.Cookie{Name: "tl_lv_" + other, Value: c.Value}
	if rec := linkGet("/link/transcript?l="+other, c2); rec.Code != http.StatusNotFound {
		t.Fatalf("one link's key on another link: %d", rec.Code)
	}
	// Revoking the link kills its view keys too.
	rec := httptest.NewRecorder()
	handleLinkByID(rec, projectsReq(http.MethodDelete, "/links/"+id, "", w.me))
	if rec := linkGet("/link/transcript?l="+id, c); rec.Code != http.StatusNotFound {
		t.Fatalf("after revoke: %d", rec.Code)
	}
}

func TestResultsAndImagesComeFromTheLinksTranscripts(t *testing.T) {
	w := newLinkWorld(t)
	swapShareStore(t)
	token, id := endedLink(t, w)
	stubTranscripts(t, fakeTranscripts{
		files:  map[string][]string{convA: {}, convB: {}},
		result: map[string]string{"toolu_01": "the whole output"},
		images: map[string][]byte{"toolu_02": onePNG, "toolu_03": []byte("<svg onload=alert(1)>")},
	})
	_, _, c := w.redeemFull(token, false)

	rec := linkGet("/link/result?l="+id+"&tool=toolu_01", c)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "the whole output") {
		t.Fatalf("result: %d %s", rec.Code, rec.Body.String())
	}
	rec = linkGet("/link/image?l="+id+"&tool=toolu_02&n=0", c)
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "image/png" || rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("image: %d %v", rec.Code, rec.Header())
	}
	// Whatever a transcript calls a picture, only bytes that sniff as one go out.
	if rec := linkGet("/link/image?l="+id+"&tool=toolu_03&n=0", c); rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("non-image bytes: %d", rec.Code)
	}
	if rec := linkGet("/link/image?l="+id+"&tool=toolu_02&record=abcdefgh&n=0", c); rec.Code != http.StatusBadRequest {
		t.Fatalf("both ids: %d", rec.Code)
	}
}

func TestPicturesAreOnlyThoseATranscriptNames(t *testing.T) {
	w := newLinkWorld(t)
	swapShareStore(t)
	root := t.TempDir()
	old := clipboardStoreRoot
	clipboardStoreRoot = root
	t.Cleanup(func() { clipboardStoreRoot = old })
	dir := filepath.Join(root, w.me, "deploy")
	_ = os.MkdirAll(dir, 0o755)
	named := filepath.Join(dir, "displayed-1.png")
	unnamed := filepath.Join(dir, "pasted-2.png")
	_ = os.WriteFile(named, onePNG, 0o644)
	_ = os.WriteFile(unnamed, onePNG, 0o644)

	token, id := endedLink(t, w)
	stubTranscripts(t, fakeTranscripts{files: map[string][]string{
		convA: {userLine("33333333-3333", "look at "+named)},
		convB: {},
	}})
	_, _, c := w.redeemFull(token, false)

	if rec := linkGet("/link/picture?l="+id+"&p="+named, c); rec.Code != http.StatusOK {
		t.Fatalf("named picture: %d %s", rec.Code, rec.Body.String())
	}
	for _, p := range []string{unnamed, "/etc/passwd", root + "/someone-else/x/a.png", dir + "/../../../etc/x.png"} {
		if rec := linkGet("/link/picture?l="+id+"&p="+p, c); rec.Code != http.StatusNotFound {
			t.Errorf("%s: %d, want 404", p, rec.Code)
		}
	}
}

func TestTheOwnersListKeepsEndedLinks(t *testing.T) {
	w := newLinkWorld(t)
	swapShareStore(t)
	_, id := endedLink(t, w)
	rec := httptest.NewRecorder()
	handleLinks(rec, projectsReq(http.MethodGet, "/links", "", w.me))
	var got []LinkView
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if len(got) != 1 || got[0].ID != id || got[0].EndedAt == 0 || got[0].Title != "Deploy the thing" {
		t.Fatalf("owner's list: %+v", got)
	}
}

func TestTheKillHookAsksTmuxOnlyWhenTheOwnerHasALink(t *testing.T) {
	w := newLinkWorld(t)
	calls := 0
	old := listLiveSessions
	listLiveSessions = func(o string) ([]liveSession, error) { calls++; return old(o) }
	t.Cleanup(func() { listLiveSessions = old })
	noteLinkTranscriptsBeforeKill(w.me)
	if calls != 0 {
		t.Fatalf("a kill with no links listed sessions %d times", calls)
	}
	w.create(`{"name":"deploy","mode":"ro","ttl":"1h"}`)
	calls = 0
	noteLinkTranscriptsBeforeKill(w.me)
	if calls != 1 {
		t.Fatalf("a kill with a link listed sessions %d times, want 1", calls)
	}
}

func TestCompleteLinesDropsAPartialTail(t *testing.T) {
	got := completeLines([]byte("a\n\nb\npart"))
	if strings.Join(got, ",") != "a,b" {
		t.Fatalf("got %q", got)
	}
}
