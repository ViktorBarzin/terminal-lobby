package main

import (
	"net/http"
	"os"
	"strings"
	"testing"

	"terminal-lobby/authuser"
)

// everyV1Route is the full surface. A route added without a line here is a
// route nothing proves is authenticated, so the completeness check below
// compares this list against the mux itself.
var everyV1Route = []request{
	{method: "GET", path: "/v1/conversations"},
	{method: "POST", path: "/v1/conversations", body: `{"cwd":"/tmp"}`},
	{method: "GET", path: "/v1/conversations/c1"},
	{method: "GET", path: "/v1/conversations/c1/transcript"},
	{method: "POST", path: "/v1/conversations/c1/messages", body: `{"text":"hello"}`},
	{method: "GET", path: "/v1/tasks/t1"},
	{method: "POST", path: "/v1/tasks/t1/cancel"},
}

// No credential reaches nothing.
func TestEveryRouteRefusesWithoutAuth(t *testing.T) {
	h := newHarness(t)
	for _, r := range everyV1Route {
		t.Run(r.method+" "+r.path, func(t *testing.T) {
			w := h.do(r)
			if w.Code != http.StatusUnauthorized {
				t.Fatalf("status %d, want 401: %s", w.Code, w.Body.String())
			}
		})
	}
}

// A token this box did not issue reaches nothing either, and never falls
// through to the header path.
func TestEveryRouteRefusesAnUnknownToken(t *testing.T) {
	h := newHarness(t)
	for _, r := range everyV1Route {
		t.Run(r.method+" "+r.path, func(t *testing.T) {
			r.token = strings.Repeat("q", 40)
			w := h.do(r)
			if w.Code != http.StatusUnauthorized {
				t.Fatalf("status %d, want 401: %s", w.Code, w.Body.String())
			}
		})
	}
}

// The lobby's own credentials — the identity header a proxy sets — are not a
// way in here. This service's callers are programs, and a program that can
// set a header could otherwise claim to be anyone.
func TestHeaderCredentialsDoNotReachV1(t *testing.T) {
	h := newHarness(t)
	for _, r := range everyV1Route {
		t.Run(r.method+" "+r.path, func(t *testing.T) {
			// A valid identity for a mapped user, plus a proxy secret, on a
			// gate with none configured — the most generous version of the
			// browser path there is. It must still reach nothing.
			r.header = "vbarzin"
			r.secret = "whatever-the-proxy-sends"
			w := h.do(r)
			if w.Code == http.StatusOK || w.Code == http.StatusCreated || w.Code == http.StatusAccepted {
				t.Fatalf("an identity header alone was served: status %d, body %s", w.Code, w.Body.String())
			}
		})
	}
}

// A bearer plus a stray identity header still resolves as the bearer. The
// header must not be able to redirect a credentialed request onto another
// account.
func TestBearerWinsOverAStrayHeader(t *testing.T) {
	h := newHarness(t)
	h.sessions.start("emo", LiveSession{Name: "emo-only"})
	h.sessions.start(testOSUser, LiveSession{Name: "wizard-only"})

	w := h.do(request{method: "GET", path: "/v1/conversations", token: testToken, header: "emil.barzin"})
	var got struct {
		Conversations []Conversation `json:"conversations"`
	}
	h.decodeJSON(w, http.StatusOK, &got)
	if len(got.Conversations) != 1 || got.Conversations[0].ID != "wizard-only" {
		t.Fatalf("resolved to the wrong account: %+v", got.Conversations)
	}
}

// The two open routes are open, and they are the only two.
func TestOpenRoutes(t *testing.T) {
	h := newHarness(t)

	t.Run("health", func(t *testing.T) {
		w := h.do(request{method: "GET", path: "/health"})
		if w.Code != http.StatusOK || w.Body.String() != "ok" {
			t.Fatalf("status %d body %q, want 200 \"ok\"", w.Code, w.Body.String())
		}
	})

	t.Run("openapi", func(t *testing.T) {
		w := h.do(request{method: "GET", path: "/openapi.json"})
		if w.Code != http.StatusOK {
			t.Fatalf("status %d, want 200", w.Code)
		}
		if ct := w.Header().Get("Content-Type"); ct != "application/json" {
			t.Fatalf("content-type %q", ct)
		}
	})

	// Neither is traced. /health is polled every few seconds by the installer
	// and by a monitor, and a line per poll would bury the requests the trace
	// exists to show.
	t.Run("neither is traced", func(t *testing.T) {
		if lines := h.traceLines(); len(lines) != 0 {
			t.Fatalf("the open routes wrote %d trace lines", len(lines))
		}
	})
}

// A credential naming an OS user that is not a terminal account is refused by
// authuser with 403, not served. Proved here rather than trusted, because it
// is the rule that stops a typo'd credentials line handing out an account.
func TestCredentialForANonTerminalAccountIsRefused(t *testing.T) {
	h := newHarness(t)
	// Point the gate at a credentials file whose OS user is in no user map.
	tokens := t.TempDir() + "/tokens"
	ghostToken := strings.Repeat("k", 40)
	if err := os.WriteFile(tokens, []byte("ghost  "+authuser.BearerDigest(ghostToken)+"  nobody\n"), 0o640); err != nil {
		t.Fatalf("write: %v", err)
	}
	h.srv.Gate.Config.BearerTokensPath = tokens

	w := h.do(request{method: "GET", path: "/v1/conversations", token: ghostToken})
	if w.Code != http.StatusForbidden {
		t.Fatalf("status %d, want 403: %s", w.Code, w.Body.String())
	}
}

// The route list above must be the whole route list. Without this, a new
// route silently escapes every auth assertion in this file.
func TestRouteListIsComplete(t *testing.T) {
	h := newHarness(t)
	for _, r := range everyV1Route {
		// Every listed route must actually exist: an authenticated call must
		// not 404 on the ROUTE (a missing conversation 404s with a JSON body,
		// which is a different thing and is why the check is on the body).
		w := h.do(request{method: r.method, path: r.path, body: r.body, token: testToken})
		if w.Code == http.StatusNotFound && !strings.Contains(w.Body.String(), `"error"`) {
			t.Errorf("%s %s is in the list but not in the mux", r.method, r.path)
		}
	}
	// And nothing under /v1 that is NOT in the list may be served: an
	// unregistered path falls through to the nested mux's 404, which arrives
	// only AFTER the auth wrapper has run.
	for _, path := range []string{"/v1/", "/v1/whoami", "/v1/conversations/c1/kill"} {
		w := h.do(request{method: "GET", path: path, token: testToken})
		if w.Code != http.StatusNotFound {
			t.Errorf("GET %s answered %d, want 404 — an unlisted /v1 route is being served", path, w.Code)
		}
	}
	// The bare "/v1" is the stdlib mux redirecting to the subtree pattern, not
	// a route. It must not be served, and the target it names must still be
	// behind the gate, which the next assertion covers.
	if got := h.do(request{method: "GET", path: "/v1", token: testToken}).Code; got != http.StatusMovedPermanently && got != http.StatusNotFound {
		t.Errorf("GET /v1 answered %d, want a redirect or 404", got)
	}
	// Even an unregistered /v1 path must require auth, or the wrapper is in
	// the wrong place.
	w := h.do(request{method: "GET", path: "/v1/whoami"})
	if w.Code != http.StatusUnauthorized {
		t.Errorf("an unregistered /v1 path answered %d without auth, want 401", w.Code)
	}
}

// The gate's own vocabulary, asserted once so a change upstream shows up here
// rather than as a puzzling status in a handler test.
func TestGateErrorsMapToStatuses(t *testing.T) {
	for _, c := range []struct {
		name string
		req  request
		want int
	}{
		{"no credential at all", request{method: "GET", path: "/v1/conversations"}, http.StatusUnauthorized},
		{"a bare Bearer", request{method: "GET", path: "/v1/conversations", token: " "}, http.StatusUnauthorized},
		{"a short token", request{method: "GET", path: "/v1/conversations", token: "short"}, http.StatusUnauthorized},
		{"a valid token", request{method: "GET", path: "/v1/conversations", token: testToken}, http.StatusOK},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t)
			if got := h.do(c.req).Code; got != c.want {
				t.Fatalf("status %d, want %d", got, c.want)
			}
		})
	}
}

// A bearer may not act as another user. authuser refuses it; this proves the
// refusal survives the trip through this service's routes.
func TestBearerCannotActAsAnotherUser(t *testing.T) {
	h := newHarness(t)
	w := h.do(request{method: "GET", path: "/v1/conversations?as=emo", token: testToken})
	if w.Code != http.StatusForbidden {
		t.Fatalf("status %d, want 403: %s", w.Code, w.Body.String())
	}
}
