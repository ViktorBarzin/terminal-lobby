package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// linkWorld is one hermetic box for the link tests: a temp store, a tmux that
// answers from a map, a clock the test moves, and recorders for the three
// side effects (pin, detach, push).
type linkWorld struct {
	t        *testing.T
	me       string
	live     map[string][]liveSession
	now      time.Time
	pinned   []string
	mu       sync.Mutex
	detached []string
	pushed   []string
}

// got reads one of the two recorders the background goroutines write, waiting
// up to two seconds for it to reach n entries.
func (w *linkWorld) got(which *[]string, n int) []string {
	deadline := time.Now().Add(2 * time.Second)
	for {
		w.mu.Lock()
		out := append([]string(nil), (*which)...)
		w.mu.Unlock()
		if len(out) >= n || time.Now().After(deadline) {
			return out
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func newLinkWorld(t *testing.T) *linkWorld {
	t.Helper()
	me, _ := twoLocalUsers(t)
	withUserMap(t, me+"="+me+"\n")
	w := &linkWorld{
		t: t, me: me, now: time.Unix(1_800_000_000, 0),
		live: map[string][]liveSession{
			me: {{ID: "$3", Created: 1000, Name: "deploy", Title: "Deploy the thing"}},
		},
	}
	oldStore, oldList, oldNow := linkStoreInstance, listLiveSessions, linkNow
	oldPin, oldDetach, oldSleep, oldPush := pinGrid, detachVisitor, linkSleep, notifyLinkDriver
	oldTickets, oldGrants, oldVisitors, oldLimiter := tickets, grants, visitors, redeemLimiter
	linkStoreInstance = newLinkStore(t.TempDir() + "/links.json")
	listLiveSessions = func(owner string) ([]liveSession, error) { return w.live[owner], nil }
	linkNow = func() time.Time { return w.now }
	pinGrid = func(o, n string) error { w.pinned = append(w.pinned, o+"/"+n); return nil }
	detachVisitor = func(v visitor) { w.mu.Lock(); w.detached = append(w.detached, v.Tty); w.mu.Unlock() }
	linkSleep = func(time.Duration) {}
	notifyLinkDriver = func(o string, s liveSession) { w.mu.Lock(); w.pushed = append(w.pushed, o+"/"+s.Name); w.mu.Unlock() }
	tickets = &ticketBook{m: map[string]ticket{}}
	grants = &grantBook{m: map[string]grant{}}
	visitors = &visitorBook{lastPush: map[string]time.Time{}, path: t.TempDir() + "/v.json"}
	redeemLimiter = &rateLimiter{window: time.Minute, perKey: 30, global: 600, counts: map[string]int{}}
	t.Cleanup(func() {
		linkStoreInstance, listLiveSessions, linkNow = oldStore, oldList, oldNow
		pinGrid, detachVisitor, linkSleep, notifyLinkDriver = oldPin, oldDetach, oldSleep, oldPush
		tickets, grants, visitors, redeemLimiter = oldTickets, oldGrants, oldVisitors, oldLimiter
	})
	return w
}

// create makes a link as the owner and returns the token.
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

func (w *linkWorld) redeem(token string) (int, map[string]any) {
	w.t.Helper()
	rec := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/link/redeem", strings.NewReader(`{"token":"`+token+`"}`))
	handleLinkRedeem(rec, r)
	var got map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	return rec.Code, got
}

func loopbackPost(path, body string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:40000"
	return r
}

func (w *linkWorld) attach(ticket, tty, mode string) (int, map[string]string) {
	rec := httptest.NewRecorder()
	handleInternalLinkAttach(rec, loopbackPost("/internal/link-attach",
		`{"ticket":"`+ticket+`","tty":"`+tty+`","mode":"`+mode+`"}`))
	var got map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	return rec.Code, got
}

func (w *linkWorld) join(g, user, tty string) (int, map[string]string) {
	rec := httptest.NewRecorder()
	handleInternalLinkJoin(rec, loopbackPost("/internal/link-join",
		`{"grant":"`+g+`","user":"`+user+`","tty":"`+tty+`"}`))
	var got map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	return rec.Code, got
}

// visit runs the whole visitor path and returns the join answer.
func (w *linkWorld) visit(token, tty, mode string) (int, map[string]string) {
	w.t.Helper()
	code, red := w.redeem(token)
	if code != http.StatusOK {
		return code, nil
	}
	code, att := w.attach(red["ticket"].(string), tty, mode)
	if code != http.StatusOK {
		return code, nil
	}
	return w.join(att["grant"], att["owner"], tty)
}

func TestLinkLifetimes(t *testing.T) {
	for _, tc := range []struct {
		mode, ttl string
		ok        bool
	}{
		{"ro", "1h", true}, {"ro", "24h", true}, {"ro", "7d", true}, {"ro", "never", true},
		{"rw", "1h", true}, {"rw", "24h", true}, {"rw", "7d", false}, {"rw", "never", false},
		{"ro", "2h", false}, {"rw", "", false},
	} {
		if got := linkTTLAllowed(tc.mode, tc.ttl); got != tc.ok {
			t.Errorf("%s %s: got %v, want %v", tc.mode, tc.ttl, got, tc.ok)
		}
	}
}

func TestCreateLinkStoresOnlyAHash(t *testing.T) {
	w := newLinkWorld(t)
	code, token, view := w.create(`{"name":"deploy","mode":"ro","ttl":"24h","note":"for the\nteam"}`)
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
	if !strings.Contains(string(raw), hashToken(token)) {
		t.Fatal("the token hash is missing from the store")
	}
}

func TestCreateLinkRejects(t *testing.T) {
	w := newLinkWorld(t)
	for _, tc := range []struct {
		name, body string
		want       int
	}{
		{"not running", `{"name":"other","mode":"ro","ttl":"1h"}`, http.StatusNotFound},
		{"rw forever", `{"name":"deploy","mode":"rw","ttl":"never"}`, http.StatusBadRequest},
		{"rw a week", `{"name":"deploy","mode":"rw","ttl":"7d"}`, http.StatusBadRequest},
		{"bad mode", `{"name":"deploy","mode":"admin","ttl":"1h"}`, http.StatusBadRequest},
		{"bad name", `{"name":"a b","mode":"ro","ttl":"1h"}`, http.StatusBadRequest},
	} {
		if code, _, _ := w.create(tc.body); code != tc.want {
			t.Errorf("%s: got %d, want %d", tc.name, code, tc.want)
		}
	}
}

// A lens tab watches; it does not hand out a bearer URL to someone's shell.
func TestALensCannotManageLinks(t *testing.T) {
	w := newLinkWorld(t)
	rec := httptest.NewRecorder()
	handleLinks(rec, projectsReq(http.MethodPost, "/links?as=bob", `{"name":"deploy","mode":"ro","ttl":"1h"}`, w.me))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("got %d, want 403", rec.Code)
	}
}

func TestAVisitWalksTicketGrantJoin(t *testing.T) {
	w := newLinkWorld(t)
	_, token, _ := w.create(`{"name":"deploy","mode":"ro","ttl":"1h"}`)
	code, red := w.redeem(token)
	if code != http.StatusOK || red["mode"] != "ro" || red["title"] != "Deploy the thing" {
		t.Fatalf("redeem: %d %v", code, red)
	}
	ticket := red["ticket"].(string)
	code, att := w.attach(ticket, "/dev/pts/9", "ro")
	if code != http.StatusOK || att["owner"] != w.me || att["grant"] == "" {
		t.Fatalf("attach: %d %v", code, att)
	}
	// A ticket is spent once.
	if code, _ := w.attach(ticket, "/dev/pts/9", "ro"); code != http.StatusForbidden {
		t.Fatalf("second spend of a ticket: %d", code)
	}
	code, join := w.join(att["grant"], w.me, "/dev/pts/9")
	if code != http.StatusOK || join["target"] != "$3" || join["mode"] != "ro" {
		t.Fatalf("join: %d %v", code, join)
	}
	// And a grant is spent once.
	if code, _ := w.join(att["grant"], w.me, "/dev/pts/9"); code != http.StatusForbidden {
		t.Fatalf("second spend of a grant: %d", code)
	}
	if len(w.pinned) != 1 || w.pinned[0] != w.me+"/deploy" {
		t.Fatalf("a read-only visit pins the grid: %v", w.pinned)
	}
	time.Sleep(20 * time.Millisecond)
	if p := w.got(&w.pushed, 0); len(p) != 0 {
		t.Fatalf("a read-only visit pushes nothing: %v", p)
	}
}

func TestAGrantIsBoundToItsOwner(t *testing.T) {
	w := newLinkWorld(t)
	_, token, _ := w.create(`{"name":"deploy","mode":"ro","ttl":"1h"}`)
	_, red := w.redeem(token)
	_, att := w.attach(red["ticket"].(string), "/dev/pts/9", "ro")
	if code, _ := w.join(att["grant"], "someone-else", "/dev/pts/9"); code != http.StatusForbidden {
		t.Fatalf("a grant spent from another account: %d, want 403", code)
	}
}

// sudo runs with use_pty here, so the owner's half sees a different tty from
// tl-link's half. The visitor is recorded under the join side's tty, which is
// the one its tmux client attaches from and the one a revoke has to detach.
func TestTheVisitorIsRecordedUnderTheJoinSidesTty(t *testing.T) {
	w := newLinkWorld(t)
	_, token, _ := w.create(`{"name":"deploy","mode":"ro","ttl":"1h"}`)
	_, red := w.redeem(token)
	_, att := w.attach(red["ticket"].(string), "/dev/pts/47", "ro")
	if code, _ := w.join(att["grant"], w.me, "/dev/pts/51"); code != http.StatusOK {
		t.Fatalf("join from sudo's own pty: %d, want 200", code)
	}
	if vs := visitors.v; len(vs) != 1 || vs[0].Tty != "/dev/pts/51" {
		t.Fatalf("visitor recorded as %+v, want /dev/pts/51", vs)
	}
}

// ttyd-link-ro takes no input, so a read-write link must never be served there,
// and a read-only link never on the instance that takes input.
func TestALinkIsServedOnlyByItsOwnInstance(t *testing.T) {
	w := newLinkWorld(t)
	_, ro, _ := w.create(`{"name":"deploy","mode":"ro","ttl":"1h"}`)
	_, rw, _ := w.create(`{"name":"deploy","mode":"rw","ttl":"1h"}`)
	for _, tc := range []struct{ token, instance string }{{ro, "rw"}, {rw, "ro"}} {
		_, red := w.redeem(tc.token)
		if code, _ := w.attach(red["ticket"].(string), "/dev/pts/9", tc.instance); code != http.StatusForbidden {
			t.Errorf("link on the %s instance: got %d, want 403", tc.instance, code)
		}
	}
}

func TestTheInternalRoutesAreLoopbackOnly(t *testing.T) {
	newLinkWorld(t)
	for path, h := range map[string]http.HandlerFunc{
		"/internal/link-attach": handleInternalLinkAttach,
		"/internal/link-join":   handleInternalLinkJoin,
	} {
		r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{}`))
		r.RemoteAddr = "10.0.20.102:5000"
		rec := httptest.NewRecorder()
		h(rec, r)
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s from the network: got %d", path, rec.Code)
		}
	}
}

func TestRedeemAnswersTheSame404ForEveryFailure(t *testing.T) {
	w := newLinkWorld(t)
	_, expiring, _ := w.create(`{"name":"deploy","mode":"ro","ttl":"1h"}`)
	_, ending, _ := w.create(`{"name":"deploy","mode":"ro","ttl":"never"}`)

	if code, _ := w.redeem("AAAAAAAAAAAAAAAAAAAAAA"); code != http.StatusNotFound {
		t.Errorf("unknown token: %d", code)
	}
	if code, _ := w.redeem("not a token"); code != http.StatusNotFound {
		t.Errorf("malformed token: %d", code)
	}
	w.now = w.now.Add(2 * time.Hour)
	if code, _ := w.redeem(expiring); code != http.StatusNotFound {
		t.Errorf("expired: %d", code)
	}
	// The session ends: same id, but tmux numbered a new session $3 after a
	// restart, so created differs. That is a different session.
	w.live[w.me] = []liveSession{{ID: "$3", Created: 5000, Name: "deploy"}}
	if code, _ := w.redeem(ending); code != http.StatusNotFound {
		t.Errorf("session ended: %d", code)
	}
	ls, _ := linkStoreInstance.load()
	if len(ls.Links) != 0 {
		t.Fatalf("ended links stay in the store: %+v", ls.Links)
	}
}

func TestARenameKeepsTheLink(t *testing.T) {
	w := newLinkWorld(t)
	_, token, _ := w.create(`{"name":"deploy","mode":"ro","ttl":"1h"}`)
	w.live[w.me] = []liveSession{{ID: "$3", Created: 1000, Name: "deploy-prod", Title: "Deploy prod"}}
	if code, red := w.redeem(token); code != http.StatusOK || red["title"] != "Deploy prod" {
		t.Fatalf("after rename: %d %v", code, red)
	}
}

func TestRedeemIsRateLimited(t *testing.T) {
	w := newLinkWorld(t)
	redeemLimiter.perKey = 3
	for i := 0; i < 3; i++ {
		if code, _ := w.redeem("AAAAAAAAAAAAAAAAAAAAAA"); code != http.StatusNotFound {
			t.Fatalf("request %d: %d", i, code)
		}
	}
	if code, _ := w.redeem("AAAAAAAAAAAAAAAAAAAAAA"); code != http.StatusTooManyRequests {
		t.Fatalf("over the limit: %d", code)
	}
	w.now = w.now.Add(time.Minute)
	if code, _ := w.redeem("AAAAAAAAAAAAAAAAAAAAAA"); code != http.StatusNotFound {
		t.Fatalf("next window: %d", code)
	}
}

func TestRedeemNeedsTheProxySecretWhenOneIsSet(t *testing.T) {
	w := newLinkWorld(t)
	_, token, _ := w.create(`{"name":"deploy","mode":"ro","ttl":"1h"}`)
	old := actAsGate.Config.ProxySecret
	actAsGate.Config.ProxySecret = "s3cret"
	t.Cleanup(func() { actAsGate.Config.ProxySecret = old })
	if code, _ := w.redeem(token); code != http.StatusUnauthorized {
		t.Fatalf("without the secret: %d", code)
	}
}

func TestRevokeDetachesAndKillsOutstandingTickets(t *testing.T) {
	w := newLinkWorld(t)
	_, token, view := w.create(`{"name":"deploy","mode":"rw","ttl":"1h"}`)
	if code, _ := w.visit(token, "/dev/pts/7", "rw"); code != http.StatusOK {
		t.Fatalf("visit: %d", code)
	}
	if p := w.got(&w.pushed, 1); len(p) != 1 {
		t.Fatalf("a read-write visit pushes once: %v", p)
	}
	_, red := w.redeem(token) // a ticket minted just before the revoke

	rec := httptest.NewRecorder()
	handleLinkByID(rec, projectsReq(http.MethodDelete, "/links/"+view.ID, "", w.me))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("revoke: %d", rec.Code)
	}
	if d := w.got(&w.detached, len(detachRetries)); len(d) != len(detachRetries) || d[0] != "/dev/pts/7" {
		t.Fatalf("detached %v, want /dev/pts/7 once per retry", d)
	}
	if code, _ := w.attach(red["ticket"].(string), "/dev/pts/8", "rw"); code != http.StatusForbidden {
		t.Fatalf("a ticket minted before the revoke still works: %d", code)
	}
}

func TestStopRevokesEveryLinkOnTheSession(t *testing.T) {
	w := newLinkWorld(t)
	w.create(`{"name":"deploy","mode":"ro","ttl":"1h"}`)
	w.create(`{"name":"deploy","mode":"rw","ttl":"1h"}`)
	rec := httptest.NewRecorder()
	handleLinks(rec, projectsReq(http.MethodDelete, "/links?session=deploy", "", w.me))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"revoked":2`) {
		t.Fatalf("stop: %d %s", rec.Code, rec.Body.String())
	}
}

func TestReadWritePushIsThrottledPerLink(t *testing.T) {
	w := newLinkWorld(t)
	_, token, _ := w.create(`{"name":"deploy","mode":"rw","ttl":"1h"}`)
	w.visit(token, "/dev/pts/7", "rw")
	w.visit(token, "/dev/pts/8", "rw")
	w.now = w.now.Add(linkPushEvery)
	w.visit(token, "/dev/pts/9", "rw")
	time.Sleep(20 * time.Millisecond) // the push runs on its own goroutine
	if p := w.got(&w.pushed, 2); len(p) != 2 {
		t.Fatalf("pushed %v, want two (first visit, then after the throttle)", p)
	}
}

func TestGuestsAreNumberedFromOne(t *testing.T) {
	w := newLinkWorld(t)
	_, token, _ := w.create(`{"name":"deploy","mode":"ro","ttl":"1h"}`)
	w.visit(token, "/dev/pts/1", "ro")
	w.visit(token, "/dev/pts/2", "ro")
	rec := httptest.NewRecorder()
	handleLinks(rec, projectsReq(http.MethodGet, "/links", "", w.me))
	var got []LinkView
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if len(got) != 1 || len(got[0].Visitors) != 2 || got[0].Visitors[0].Guest != 1 || got[0].Visitors[1].Guest != 2 {
		t.Fatalf("visitors: %+v", got)
	}
	// Guest 1 leaves; the next visitor takes number 1 again.
	visitors.reconcile(w.me, []client{{Session: "deploy", Flags: "attached,focused,ignore-size,read-only,UTF-8", Name: "/dev/pts/2"}}, w.now.Add(time.Minute))
	w.now = w.now.Add(time.Minute)
	w.visit(token, "/dev/pts/3", "ro")
	vs := visitors.forLink(got[0].ID)
	if len(vs) != 2 || vs[1].Guest != 1 {
		t.Fatalf("after a guest left: %+v", vs)
	}
}

func TestVisitorCountsComeFromTheClientList(t *testing.T) {
	w := newLinkWorld(t)
	_, ro, _ := w.create(`{"name":"deploy","mode":"ro","ttl":"1h"}`)
	_, rw, _ := w.create(`{"name":"deploy","mode":"rw","ttl":"1h"}`)
	w.visit(ro, "/dev/pts/1", "ro")
	w.visit(rw, "/dev/pts/2", "rw")
	w.visit(ro, "/dev/pts/3", "ro") // recorded, but tmux never listed it

	clients := []client{
		{Session: "deploy", Flags: "attached,focused,ignore-size,read-only,UTF-8", Name: "/dev/pts/1"},
		{Session: "deploy", Flags: "attached", Name: "/dev/pts/2"},
		{Session: "deploy", Flags: "attached", Name: "/dev/pts/5"}, // the owner
	}
	// Inside the settle window the unlisted visitor is kept but not counted.
	counts := visitors.reconcile(w.me, clients, w.now.Add(time.Second))
	if counts["$3"] != (VisitorCount{Total: 2, Driving: 1}) {
		t.Fatalf("counts: %+v", counts)
	}
	if n := len(visitors.v); n != 3 {
		t.Fatalf("settling visitor dropped early: %d records", n)
	}
	visitors.reconcile(w.me, clients, w.now.Add(visitorSettle+time.Second))
	if n := len(visitors.v); n != 2 {
		t.Fatalf("a visitor tmux never listed outlived the settle window: %d records", n)
	}
}

func TestVisitorsSurviveARestart(t *testing.T) {
	w := newLinkWorld(t)
	_, token, _ := w.create(`{"name":"deploy","mode":"rw","ttl":"1h"}`)
	w.visit(token, "/dev/pts/7", "rw")
	reloaded := &visitorBook{lastPush: map[string]time.Time{}, path: visitors.path}
	reloaded.loadVisitors()
	if len(reloaded.v) != 1 || reloaded.v[0].Tty != "/dev/pts/7" || reloaded.v[0].Owner != w.me {
		t.Fatalf("reloaded: %+v", reloaded.v)
	}
}

func TestSweepEndsExpiredLinks(t *testing.T) {
	w := newLinkWorld(t)
	swapShareStore(t)
	_, token, _ := w.create(`{"name":"deploy","mode":"rw","ttl":"1h"}`)
	w.visit(token, "/dev/pts/7", "rw")
	w.now = w.now.Add(time.Hour)
	sweepLinksOnce()
	ls, _ := linkStoreInstance.load()
	if len(ls.Links) != 0 {
		t.Fatalf("expired link survived the sweep")
	}
	if len(w.got(&w.detached, 1)) == 0 {
		t.Fatal("the expired link's visitor was not detached")
	}
}

func TestSameClient(t *testing.T) {
	rec := time.Unix(1000, 0)
	for _, tc := range []struct {
		created int64
		want    bool
	}{{1000, true}, {1001, true}, {998, true}, {997, false}, {1031, false}} {
		if got := sameClient(tc.created, rec); got != tc.want {
			t.Errorf("created %d: got %v", tc.created, got)
		}
	}
}

func TestParseLiveSessions(t *testing.T) {
	out := "$1\t1000\tdeploy\t120\t32\tDeploy\tthe thing\n$2\t1001\tbare\t80\t24\t\ngarbage\n$x\t1\tbad\t1\t1\t\n"
	got := parseLiveSessions([]byte(out))
	want := liveSession{ID: "$1", Created: 1000, Name: "deploy", Title: "Deploy\tthe thing", Cols: 120, Rows: 32}
	if len(got) != 2 || got[0] != want || got[1].Name != "bare" || got[1].Cols != 80 {
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

// The visitor page polls with peek for the window size; a peek must never
// mint a ticket, or polling would be a way to fill the ticket book.
func TestAPeekReportsTheWindowAndMintsNoTicket(t *testing.T) {
	w := newLinkWorld(t)
	w.live[w.me][0].Cols, w.live[w.me][0].Rows = 120, 32
	_, token, _ := w.create(`{"name":"deploy","mode":"ro","ttl":"1h"}`)
	rec := httptest.NewRecorder()
	handleLinkRedeem(rec, httptest.NewRequest(http.MethodPost, "/link/redeem",
		strings.NewReader(`{"token":"`+token+`","peek":true}`)))
	var got map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if rec.Code != http.StatusOK || got["cols"] != float64(120) || got["rows"] != float64(32) {
		t.Fatalf("peek: %d %v", rec.Code, got)
	}
	if _, has := got["ticket"]; has || len(tickets.m) != 0 {
		t.Fatalf("a peek minted a ticket: %v, book %d", got, len(tickets.m))
	}
}
