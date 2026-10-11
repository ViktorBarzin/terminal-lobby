package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// stubGuestAccess answers the access check from a table keyed
// "owner/name/caller", the way tmux-api's /internal/access would.
func stubGuestAccess(t *testing.T, grants map[string]string) *sync.Mutex {
	t.Helper()
	var mu sync.Mutex
	old := guestAccess
	guestAccess = func(_ context.Context, owner, name, caller string) (string, error) {
		mu.Lock()
		defer mu.Unlock()
		return grants[owner+"/"+name+"/"+caller], nil
	}
	t.Cleanup(func() { guestAccess = old })
	return &mu
}

// A guest reaches the owner's session: every route runs as the owner, and the
// caller is kept as the real user, so a prompt can be attributed to them.
func TestGuestReachesTheRoutesAsTheOwner(t *testing.T) {
	mapPath, me, other := actAsEnv(t)
	stubGuestAccess(t, map[string]string{other + "/main/" + me: "rw"})
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/events/main"},
		{http.MethodGet, "/result/main/t1"},
		{http.MethodPost, "/prompt/main"},
		{http.MethodPost, "/answer/main"},
	} {
		var seen, real, mode string
		h := authMiddleware(mapPath, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			seen, real, mode = osUserFrom(r.Context()), realOSUserFrom(r.Context()), guestModeFrom(r.Context())
			w.WriteHeader(http.StatusOK)
		}))
		req := httptest.NewRequest(tc.method, tc.path+"?owner="+other, nil)
		req.Header.Set(authHeader, "adminauth")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s %s: status %d, want 200", tc.method, tc.path, rec.Code)
		}
		if seen != other || real != me || mode != "rw" {
			t.Fatalf("%s %s: ran as %q (real %q, mode %q), want %q (real %q, rw)", tc.method, tc.path, seen, real, mode, other, me)
		}
	}
}

func TestGuestRefusals(t *testing.T) {
	mapPath, me, other := actAsEnv(t)
	stubGuestAccess(t, map[string]string{other + "/main/" + me: "ro"})
	for _, tc := range []struct {
		name, method, url string
		want              int
	}{
		{"a watcher reads", http.MethodGet, "/events/main?owner=" + other, http.StatusOK},
		{"a watcher cannot send", http.MethodPost, "/prompt/main?owner=" + other, http.StatusForbidden},
		{"a watcher cannot stop the turn", http.MethodPost, "/cancel/main?owner=" + other, http.StatusForbidden},
		{"no grant for this session", http.MethodGet, "/events/other?owner=" + other, http.StatusForbidden},
		{"a route with no session", http.MethodGet, "/commands/_new?owner=" + other, http.StatusBadRequest},
		// A Lens acting as `other` opening a session of mine: the grant that
		// counts is `other`'s, and the stub gives them none (ADR-0043).
		{"a Lens on a session its target cannot reach", http.MethodGet, "/events/main?owner=" + me + "&as=" + other, http.StatusForbidden},
		{"the act-as target named as owner is the Lens", http.MethodGet, "/events/main?owner=" + other + "&as=" + other, http.StatusOK},
		{"a malformed owner", http.MethodGet, "/events/main?owner=a%20b", http.StatusBadRequest},
		{"an escaped slash in the session", http.MethodPost, "/prompt/main%2Fother?owner=" + other, http.StatusBadRequest},
		{"your own name is your own session", http.MethodPost, "/prompt/main?owner=" + me, http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ran := false
			h := authMiddleware(mapPath, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				ran = true
				w.WriteHeader(http.StatusOK)
			}))
			req := httptest.NewRequest(tc.method, tc.url, nil)
			req.Header.Set(authHeader, "adminauth")
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("status %d, want %d", rec.Code, tc.want)
			}
			if ran != (tc.want == http.StatusOK) {
				t.Fatalf("handler ran = %v for status %d", ran, rec.Code)
			}
		})
	}
}

// The browser relay decides its own access from ?owner= (browser.go); the
// middleware must hand it the caller untouched.
func TestGuestLeavesTheBrowserRelayAlone(t *testing.T) {
	mapPath, me, other := actAsEnv(t)
	stubGuestAccess(t, nil)
	var seen string
	h := authMiddleware(mapPath, probeHandler(&seen))
	req := httptest.NewRequest(http.MethodGet, "/browser/main/stream?owner="+other, nil)
	req.Header.Set(authHeader, "adminauth")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || seen != me {
		t.Fatalf("status %d as %q, want 200 as %q", rec.Code, seen, me)
	}
}

func TestGuestAccessErrorIsNotAGrant(t *testing.T) {
	mapPath, _, other := actAsEnv(t)
	old := guestAccess
	guestAccess = func(context.Context, string, string, string) (string, error) {
		return "", errors.New("tmux-api down")
	}
	t.Cleanup(func() { guestAccess = old })
	h := authMiddleware(mapPath, probeHandler(new(string)))
	req := httptest.NewRequest(http.MethodGet, "/events/main?owner="+other, nil)
	req.Header.Set(authHeader, "adminauth")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d, want 503", rec.Code)
	}
}

// A guest's open stream ends once the grant is gone, so a revoke stops the
// Text view as it detaches the terminal.
func TestGuestStreamEndsOnRevoke(t *testing.T) {
	mapPath, me, other := actAsEnv(t)
	grants := map[string]string{other + "/main/" + me: "ro"}
	mu := stubGuestAccess(t, grants)
	old := guestRecheckEvery
	guestRecheckEvery = 20 * time.Millisecond
	t.Cleanup(func() { guestRecheckEvery = old })

	ended := make(chan struct{})
	h := authMiddleware(mapPath, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
		close(ended)
	}))
	req := httptest.NewRequest(http.MethodGet, "/events/main?owner="+other, nil)
	req.Header.Set(authHeader, "adminauth")
	go h.ServeHTTP(httptest.NewRecorder(), req)

	select {
	case <-ended:
		t.Fatal("stream ended while the grant stood")
	case <-time.After(100 * time.Millisecond):
	}
	mu.Lock()
	delete(grants, other+"/main/"+me)
	mu.Unlock()
	select {
	case <-ended:
	case <-time.After(2 * time.Second):
		t.Fatal("stream outlived its revoked grant")
	}
}

func TestIsGuestStream(t *testing.T) {
	for path, want := range map[string]bool{
		"/events/main":                    true,
		"/events/main/presence":           true,
		"/events/main/agents/a1":          true,
		"/events/main/agents/a1/earlier":  false,
		"/events/main/agents/a1/result/x": false,
		"/result/main/t1":                 false,
		"/earlier/main":                   false,
	} {
		if got := isGuestStream(httptest.NewRequest(http.MethodGet, path, nil)); got != want {
			t.Errorf("%s: %v, want %v", path, got, want)
		}
	}
}

// A Lens acting as a guest sees what the guest sees: a session shared with
// the target opens, as its owner, with the target's mode. Before this it was
// refused with 400, and the Lens's Text view retried forever (2026-10-11).
func TestALensReachesWhatItsTargetCanReach(t *testing.T) {
	mapPath, me, other := actAsEnv(t)
	// me is the administrator; other is the Lens target; the session is me's,
	// shared with other.
	stubGuestAccess(t, map[string]string{me + "/main/" + other: "rw"})
	var seen, real, mode string
	h := authMiddleware(mapPath, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen, real, mode = osUserFrom(r.Context()), realOSUserFrom(r.Context()), guestModeFrom(r.Context())
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodGet, "/events/main?as="+other+"&owner="+me, nil)
	req.Header.Set(authHeader, "adminauth")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || seen != me || real != me || mode != "rw" {
		t.Fatalf("status %d, ran as %q real %q mode %q", rec.Code, seen, real, mode)
	}
}
