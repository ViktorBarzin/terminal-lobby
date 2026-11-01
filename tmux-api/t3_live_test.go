package main

import (
	"encoding/json"
	"net"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// GET /sessions against a REAL T3: the caller's own `t3 serve`, found the
// way production finds it (/etc/t3-serve/dispatch.json), signed in the way
// production signs in (sudo t3-mint, then T3's headless MCP sign-in). It
// reads and never writes: no launch, rename or archive.
//
//	TL_T3_LIVE=1 go test -run TestT3LiveSessionsList -v .
//
// tmux is stubbed down, so the list holds the T3 rows alone and no tmux
// session is renamed or stamped by the poll. The token is kept in a temp
// directory deleted afterwards, but the sign-in stays listed in the user's
// T3 under Settings > Access, labelled terminal-lobby.
func TestT3LiveSessionsList(t *testing.T) {
	if os.Getenv("TL_T3_LIVE") != "1" {
		t.Skip("TL_T3_LIVE=1 runs this against the caller's own T3")
	}
	me, _ := twoLocalUsers(t)
	withUserMap(t, "authself="+me+"\n")
	oldP, oldS := projectStoreInstance, shareStoreInstance
	projectStoreInstance = newProjectStore(t.TempDir() + "/projects.json")
	shareStoreInstance = newShareStore(t.TempDir() + "/shares.json")
	t.Cleanup(func() { projectStoreInstance, shareStoreInstance = oldP, oldS })
	withTmuxStub(t, "exit 1")

	tokens := t.TempDir()
	env := map[string]string{
		"TMUX_API_T3_DIR":     tokens,
		"TL_T3_HOSTS":         os.Getenv("TL_T3_HOSTS"),
		"TL_T3_DOMAIN":        os.Getenv("TL_T3_DOMAIN"),
		"TL_T3_DEFAULT_USERS": me,
	}
	getenv := func(k string) string { return env[k] }
	old := t3PollerInstance
	t3PollerInstance = newT3Poller(t3ClientAPI{newT3Client(getenv)})
	t3PollerInstance.changed = func(u string) { sessionsCacheInstance.invalidate(u) }
	t.Cleanup(func() { t3PollerInstance = old })
	oldDefaults := t3DefaultUsers
	t3DefaultUsers = parseT3DefaultUsers(getenv("TL_T3_DEFAULT_USERS"))
	t.Cleanup(func() { t3DefaultUsers = oldDefaults })

	mux := http.NewServeMux()
	registerRoutes(mux)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: mux}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	base := "http://" + ln.Addr().String()
	t.Logf("serving on %s", base)

	get := func(path string, into any) {
		req, _ := http.NewRequest(http.MethodGet, base+path, nil)
		req.Header.Set(authHeader, "authself")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET %s: %d", path, resp.StatusCode)
		}
		if err := json.NewDecoder(resp.Body).Decode(into); err != nil {
			t.Fatal(err)
		}
	}

	var who map[string]any
	get("/whoami", &who)
	t.Logf("whoami: t3=%v claudeBackend=%v", who["t3"], who["claudeBackend"])

	var rows []Session
	deadline := time.Now().Add(30 * time.Second)
	for {
		get("/sessions", &rows)
		if len(rows) > 0 || time.Now().After(deadline) {
			break
		}
		time.Sleep(500 * time.Millisecond)
		sessionsCacheInstance.invalidate(me)
	}
	if len(rows) == 0 {
		t.Fatal("no T3 rows within 30 s")
	}
	states := map[string]int{}
	for i, r := range rows {
		states[r.State]++
		if r.Backend != "t3" || !sessionNameRe.MatchString(r.Name) || !strings.HasPrefix(r.URL, "https://") ||
			!strings.HasPrefix(r.AppURL, "t3code://threads/") || r.T3ThreadID == "" {
			t.Errorf("row %d is not a sane T3 row: %+v", i, r)
		}
		if i < 8 {
			t.Logf("%-16s %-8s project=%-14q title=%q\n    url=%s\n    app=%s", r.Name, r.State, r.Project, r.Title, r.URL, r.AppURL)
		}
	}
	t.Logf("%d T3 rows; states %v", len(rows), states)
}
