package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

const liveTranscript = "/home/w/.claude/projects/p/live.jsonl"

// linkWorld is one hermetic box for the link tests: a temp store, a tmux that
// answers from a map, and a clock the test moves.
type linkWorld struct {
	t    *testing.T
	me   string
	live map[string][]liveSession
	now  time.Time
}

func newLinkWorld(t *testing.T) *linkWorld {
	t.Helper()
	me, _ := twoLocalUsers(t)
	withUserMap(t, me+"="+me+"\n")
	w := &linkWorld{
		t: t, me: me, now: time.Unix(1_800_000_000, 0),
		live: map[string][]liveSession{
			me: {{ID: "$3", Created: 1000, Name: "deploy", Title: "Deploy the thing", Transcript: liveTranscript}},
		},
	}
	oldStore, oldList, oldNow := linkStoreInstance, listLiveSessions, linkNow
	oldViews, oldLimiter := views, redeemLimiter
	linkStoreInstance = newLinkStore(t.TempDir() + "/links.json")
	listLiveSessions = func(owner string) ([]liveSession, error) { return w.live[owner], nil }
	linkNow = func() time.Time { return w.now }
	views = &viewBook{m: map[string]view{}}
	redeemLimiter = &rateLimiter{window: time.Minute, perKey: 30, global: 600, counts: map[string]int{}}
	t.Cleanup(func() {
		linkStoreInstance, listLiveSessions, linkNow = oldStore, oldList, oldNow
		views, redeemLimiter = oldViews, oldLimiter
	})
	return w
}

// create makes a link as the owner and returns the status, token and view.
func (w *linkWorld) create(body string) (int, string, LinkView) {
	w.t.Helper()
	rec := httptest.NewRecorder()
	handleLinks(rec, projectsReq(http.MethodPost, "/links", body, w.me))
	var got struct {
		Link  LinkView `json:"link"`
		Token string   `json:"token"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	return rec.Code, got.Token, got.Link
}

// redeem redeems a token and returns the status, the answer and the view
// cookie it set, if any.
func (w *linkWorld) redeem(token string) (int, map[string]any, *http.Cookie) {
	w.t.Helper()
	rec := httptest.NewRecorder()
	handleLinkRedeem(rec, httptest.NewRequest(http.MethodPost, "/link/redeem", strings.NewReader(`{"token":"`+token+`"}`)))
	var got map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	var c *http.Cookie
	if cs := rec.Result().Cookies(); len(cs) > 0 {
		c = cs[0]
	}
	return rec.Code, got, c
}

func TestLinkLifetimes(t *testing.T) {
	w := newLinkWorld(t)
	for ttl, want := range map[string]int{
		"1h": http.StatusCreated, "24h": http.StatusCreated, "7d": http.StatusCreated,
		"never": http.StatusCreated, "2h": http.StatusBadRequest, "": http.StatusBadRequest,
	} {
		if code, _, _ := w.create(`{"name":"deploy","ttl":"` + ttl + `"}`); code != want {
			t.Errorf("ttl %q: got %d, want %d", ttl, code, want)
		}
	}
}

func TestCreateLinkStoresOnlyAHash(t *testing.T) {
	w := newLinkWorld(t)
	code, token, view := w.create(`{"name":"deploy","ttl":"24h","note":"for the\nteam"}`)
	if code != http.StatusCreated {
		t.Fatalf("create: %d", code)
	}
	if !linkTokenRe.MatchString(token) {
		t.Fatalf("token %q has the wrong shape", token)
	}
	if view.SessionID != "$3" || view.Title != "Deploy the thing" || view.Note != "for theteam" {
		t.Fatalf("view: %+v", view)
	}
	if view.ExpiresAt != w.now.Add(24*time.Hour).Unix() {
		t.Fatalf("expiry %d", view.ExpiresAt)
	}
	raw, _ := os.ReadFile(linkStoreInstance.path)
	if strings.Contains(string(raw), token) {
		t.Fatal("the token itself was written to the store")
	}
	if !strings.Contains(string(raw), hashToken(token)) || !strings.Contains(string(raw), liveTranscript) {
		t.Fatal("the store is missing the token hash or the session's transcript")
	}
}

func TestCreateLinkRejects(t *testing.T) {
	w := newLinkWorld(t)
	w.live[w.me] = append(w.live[w.me], liveSession{ID: "$4", Created: 1001, Name: "shell"})
	for _, tc := range []struct {
		name, body string
		want       int
	}{
		{"not running", `{"name":"other","ttl":"1h"}`, http.StatusNotFound},
		// A link shares a conversation; a plain shell has none (ADR-0041).
		{"plain shell", `{"name":"shell","ttl":"1h"}`, http.StatusConflict},
		{"bad name", `{"name":"a b","ttl":"1h"}`, http.StatusBadRequest},
	} {
		if code, _, _ := w.create(tc.body); code != tc.want {
			t.Errorf("%s: got %d, want %d", tc.name, code, tc.want)
		}
	}
}

// A lens tab watches; it does not hand out a bearer URL to someone's work.
func TestALensCannotManageLinks(t *testing.T) {
	w := newLinkWorld(t)
	rec := httptest.NewRecorder()
	handleLinks(rec, projectsReq(http.MethodPost, "/links?as=bob", `{"name":"deploy","ttl":"1h"}`, w.me))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("got %d, want 403", rec.Code)
	}
}

func TestRedeemSetsAViewCookieForALiveLink(t *testing.T) {
	w := newLinkWorld(t)
	_, token, view := w.create(`{"name":"deploy","ttl":"1h"}`)
	code, got, c := w.redeem(token)
	if code != http.StatusOK || got["link"] != view.ID || got["title"] != "Deploy the thing" || got["endedAt"] != float64(0) {
		t.Fatalf("redeem: %d %v", code, got)
	}
	if c == nil || c.Name != "tl_lv_"+view.ID || !c.HttpOnly || !c.Secure || c.Path != "/s/api/link/" || c.SameSite != http.SameSiteStrictMode {
		t.Fatalf("view cookie: %+v", c)
	}
}

func TestRedeemAnswersTheSame404ForEveryFailure(t *testing.T) {
	w := newLinkWorld(t)
	_, expiring, _ := w.create(`{"name":"deploy","ttl":"1h"}`)
	if code, _, _ := w.redeem("AAAAAAAAAAAAAAAAAAAAAA"); code != http.StatusNotFound {
		t.Errorf("unknown token: %d", code)
	}
	if code, _, _ := w.redeem("not a token"); code != http.StatusNotFound {
		t.Errorf("malformed token: %d", code)
	}
	w.now = w.now.Add(2 * time.Hour)
	if code, _, _ := w.redeem(expiring); code != http.StatusNotFound {
		t.Errorf("expired: %d", code)
	}
	if ls, _ := linkStoreInstance.load(); len(ls.Links) != 0 {
		t.Fatalf("an expired link stays in the store: %+v", ls.Links)
	}
}

func TestARenameKeepsTheLink(t *testing.T) {
	w := newLinkWorld(t)
	_, token, _ := w.create(`{"name":"deploy","ttl":"1h"}`)
	w.live[w.me][0].Name, w.live[w.me][0].Title = "deploy-prod", "Deploy prod"
	if code, _, _ := w.redeem(token); code != http.StatusOK {
		t.Fatalf("after rename: %d", code)
	}
}

func TestRedeemIsRateLimited(t *testing.T) {
	w := newLinkWorld(t)
	redeemLimiter.perKey = 3
	for i := 0; i < 3; i++ {
		if code, _, _ := w.redeem("AAAAAAAAAAAAAAAAAAAAAA"); code != http.StatusNotFound {
			t.Fatalf("request %d: %d", i, code)
		}
	}
	if code, _, _ := w.redeem("AAAAAAAAAAAAAAAAAAAAAA"); code != http.StatusTooManyRequests {
		t.Fatalf("over the limit: %d", code)
	}
	w.now = w.now.Add(time.Minute)
	if code, _, _ := w.redeem("AAAAAAAAAAAAAAAAAAAAAA"); code != http.StatusNotFound {
		t.Fatalf("next window: %d", code)
	}
}

func TestRedeemNeedsTheProxySecretWhenOneIsSet(t *testing.T) {
	w := newLinkWorld(t)
	_, token, _ := w.create(`{"name":"deploy","ttl":"1h"}`)
	old := actAsGate.Config.ProxySecret
	actAsGate.Config.ProxySecret = "s3cret"
	t.Cleanup(func() { actAsGate.Config.ProxySecret = old })
	if code, _, _ := w.redeem(token); code != http.StatusUnauthorized {
		t.Fatalf("without the secret: %d", code)
	}
}

func TestStopRevokesEveryLinkOnTheSession(t *testing.T) {
	w := newLinkWorld(t)
	w.create(`{"name":"deploy","ttl":"1h"}`)
	w.create(`{"name":"deploy","ttl":"never"}`)
	rec := httptest.NewRecorder()
	handleLinks(rec, projectsReq(http.MethodDelete, "/links?session=deploy", "", w.me))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"revoked":2`) {
		t.Fatalf("stop: %d %s", rec.Code, rec.Body.String())
	}
}

func TestSweepEndsExpiredLinks(t *testing.T) {
	w := newLinkWorld(t)
	swapShareStore(t)
	w.create(`{"name":"deploy","ttl":"1h"}`)
	w.now = w.now.Add(time.Hour)
	sweepLinksOnce()
	if ls, _ := linkStoreInstance.load(); len(ls.Links) != 0 {
		t.Fatalf("expired link survived the sweep")
	}
}

// The session bar's "N viewing": a read marks the key seen, and only recent
// reads count.
func TestViewersAreTheKeysThatReadRecently(t *testing.T) {
	w := newLinkWorld(t)
	_, token, view := w.create(`{"name":"deploy","ttl":"1h"}`)
	w.redeem(token)
	w.redeem(token)
	sessions := []Session{{ID: "$3", Created: 1000, Name: "deploy"}, {ID: "$9", Created: 5, Name: "other"}}
	annotateViewers(w.me, sessions)
	if sessions[0].Viewers != 2 || sessions[1].Viewers != 0 {
		t.Fatalf("viewers: %+v", sessions)
	}
	w.now = w.now.Add(viewerWindow)
	if n := views.viewers(view.ID, w.now); n != 0 {
		t.Fatalf("stale readers counted: %d", n)
	}
}

func TestParseLiveSessions(t *testing.T) {
	out := "$1\t1000\tdeploy\t/home/w/.claude/projects/p/u.jsonl\tDeploy\tthe thing\n" +
		"$2\t1001\tbare\t\t\ngarbage\n$x\t1\tbad\t\t\n"
	got := parseLiveSessions([]byte(out))
	want := liveSession{ID: "$1", Created: 1000, Name: "deploy", Title: "Deploy\tthe thing",
		Transcript: "/home/w/.claude/projects/p/u.jsonl"}
	if len(got) != 2 || got[0] != want || got[1].Name != "bare" || got[1].Transcript != "" {
		t.Fatalf("parsed %+v", got)
	}
}

// --- named shares pinned to one session -----------------------------------

// The bug decision 14 closes: a grant made for one session used to pass to the
// next session that took the same name.
func TestAShareDoesNotPassToTheNextSessionWithItsName(t *testing.T) {
	swapShareStore(t)
	me, other := twoLocalUsers(t)
	withUserMap(t, me+"="+me+"\n"+other+"="+other+"\n")
	withInternalToken(t, "tok")
	stubGrid(t, me+"/main")

	rec := httptest.NewRecorder()
	handleShares(rec, projectsReq(http.MethodPost, "/shares", `{"name":"main","guest":"`+other+`","mode":"rw"}`, me))
	if rec.Code != http.StatusCreated {
		t.Fatalf("share: %d %s", rec.Code, rec.Body.String())
	}
	// The session dies and a new one takes the name.
	stubLiveByName(t, func(owner, name string) (liveSession, bool, error) {
		return liveSession{ID: "$9", Created: 2000, Name: name}, true, nil
	})
	rec = httptest.NewRecorder()
	handleInternalAttach(rec, internalAttachReq(`{"owner":"`+me+`","name":"main","guest":"`+other+`","tty":"/dev/pts/4"}`, "tok"))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("attach to the new session under the old grant: %d, want 403", rec.Code)
	}
}

func TestPruneAndStampShares(t *testing.T) {
	swapShareStore(t)
	_ = shareStoreInstance.update(func(ss *ShareSet) error {
		ss.Shares = []Share{
			{Owner: "wizard", Name: "kept", Guest: "bob", Mode: "ro", SessionID: "$1", SessionCreated: 10},
			{Owner: "wizard", Name: "ended", Guest: "bob", Mode: "ro", SessionID: "$2", SessionCreated: 20},
			{Owner: "wizard", Name: "legacy", Guest: "bob", Mode: "ro"},
			{Owner: "wizard", Name: "legacy-gone", Guest: "bob", Mode: "ro"},
			{Owner: "emo", Name: "other-owner", Guest: "bob", Mode: "ro", SessionID: "$7", SessionCreated: 70},
		}
		return nil
	})
	live := []liveSession{{ID: "$1", Created: 10, Name: "kept"}, {ID: "$4", Created: 40, Name: "legacy"}}
	stampLegacySharesFor("wizard", live)
	pruneShares("wizard", live)
	ss, _ := shareStoreInstance.load()
	names := []string{}
	for _, sh := range ss.Shares {
		names = append(names, sh.Name+":"+sh.SessionID)
	}
	if strings.Join(names, ",") != "kept:$1,legacy:$4,other-owner:$7" {
		t.Fatalf("after stamp+prune: %v", names)
	}
}
