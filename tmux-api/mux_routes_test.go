package main

// Can a request actually ARRIVE at these handlers?
//
// Every other test in this package answers a different question. They build a
// request with httptest.NewRequest and hand it straight to the handler —
// `handleWorkspaces(rec, workspacesReq(...))` — which proves the handler is
// correct and proves nothing whatever about the mux in front of it. A handler
// that no line of registerRoutes mentions is still a well-tested function; it
// is simply one the network cannot reach.
//
// Measured on this branch, 2026-09-12: /workspaces arrived with a complete
// store, a validating handler, an exclusivity rule and 33 green tests, 12 of
// them driving handleWorkspaces directly. No line registered it. `go build`
// exits 0 on an unreferenced package-level func and so does `go vet`, so
// nothing in the build said a word, and the first signal available to anyone
// was every workspace GET and PUT answering 404 against a running binary —
// which is to say, after deployment.
//
// Four tests, each failing for a different reason on purpose:
//
//   - TestEveryRouteReachesItsHandlerThroughTheMux drives the mux that
//     registerRoutes builds, one probe per route, and is the readable list of
//     what this service serves.
//   - TestWorkspacesServesThePathTheIngressLeavesBehind pins the path the
//     browser's URL becomes once the ingress has stripped its prefix.
//   - TestWorkspacesRoundTripOverARealSocket PUTs the document and GETs it back
//     over a real listener, through the timing.Wrap chain main serves.
//   - TestEveryHandlerFuncHasARoute reads this package's own source and fails
//     when a handler-shaped func exists that registerRoutes never names. It is
//     the one that needs no maintenance: the table above catches only what
//     somebody remembered to add to it, which is precisely what did not happen.

import (
	"bytes"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

// muxNotFoundBody is what http.NotFoundHandler writes when no pattern matched.
// A handler is allowed to answer 404 itself — /push/vapid-public does exactly
// that when VAPID_PUBLIC_KEY is unset — so the status alone cannot tell "this
// route does not exist" from "this route says no". The body can.
const muxNotFoundBody = "404 page not found"

// route is one probe: a request that must land on a named handler.
//
// probe is a path the pattern is expected to capture, which for a subtree
// pattern is a child of it rather than the pattern itself — asking Go's mux for
// "/sessions/" when "/sessions/" is registered answers with the pattern, but
// asking for "/sessions/qa-probe" also exercises the precedence against
// "/sessions/prewarm" next door.
//
// want is the func the pattern must resolve to, so a copy-paste that points two
// paths at one handler fails here rather than in production. It is nil for
// /health alone, whose handler is an inline closure with no name to compare.
type route struct {
	pattern string
	method  string
	probe   string
	want    http.HandlerFunc
}

// The routes this service serves. Adding one here without adding it to
// registerRoutes fails; the reverse fails in TestEveryHandlerFuncHasARoute.
func serviceRoutes() []route {
	return []route{
		{"/sessions", http.MethodGet, "/sessions", handleSessions},
		{"/new-commands", http.MethodGet, "/new-commands", handleNewCommands},
		{"/sessions/prewarm", http.MethodPost, "/sessions/prewarm", handlePrewarm},
		{"/sessions/", http.MethodDelete, "/sessions/qa-probe", handleSessionByName},
		{"/whoami", http.MethodGet, "/whoami", handleWhoami},
		{"/restore", http.MethodPost, "/restore", handleRestore},
		{"/snapshots", http.MethodGet, "/snapshots", handleSnapshots},
		{"/snapshots/", http.MethodGet, "/snapshots/20260912-1200", handleSnapshotByTS},
		{"/layout", http.MethodGet, "/layout", handleLayout},
		// The route this whole file exists for. GET and PUT both, because the
		// lobby reads the document on boot and writes it on every drag, and a
		// mux entry that served one and not the other would leave the feature
		// half dead in a way a GET-only probe would call healthy.
		{"/workspaces", http.MethodGet, "/workspaces", handleWorkspaces},
		{"/workspaces", http.MethodPut, "/workspaces", handleWorkspaces},
		{"/projects", http.MethodGet, "/projects", handleProjects},
		{"/projects/", http.MethodGet, "/projects/p1", handleProjectByID},
		{"/shares", http.MethodGet, "/shares", handleShares},
		{"/shares/", http.MethodDelete, "/shares/wizard/auth/bob", handleShareByPath},
		{"/internal/attach", http.MethodPost, "/internal/attach", handleInternalAttach},
		{"/users", http.MethodGet, "/users", handleUsers},
		{"/dirs", http.MethodGet, "/dirs", handleDirs},
		{"/prefs", http.MethodGet, "/prefs", handlePrefs},
		{"/netinfo", http.MethodGet, "/netinfo", handleNetinfo},
		{"/agent-spend", http.MethodGet, "/agent-spend", handleAgentSpend},
		{"/telemetry", http.MethodPost, "/telemetry", handleTelemetry},
		{"/push-subscriptions", http.MethodGet, "/push-subscriptions", handlePushSubscriptions},
		{"/push/focus", http.MethodPost, "/push/focus", handlePushFocus},
		{"/push/vapid-public", http.MethodGet, "/push/vapid-public", handlePushVAPIDPublic},
		{"/push/test", http.MethodPost, "/push/test", handlePushTest},
		{"/health", http.MethodGet, "/health", nil},
	}
}

// Every route the service serves must be reachable on the mux registerRoutes
// builds, and must reach the handler it names.
//
// The probes carry no identity header on purpose. Every handler here
// authenticates before it does anything (resolveOSUser, resolveRealOSUser, or
// the loopback check on /internal/attach), so an anonymous probe answers 401 or
// 403 having touched no store, forked no tmux and pushed to nobody's phone —
// which is what makes it safe to send one at all 27 routes in a unit test. The
// answer's CONTENT is not the point; that a route answered at all is.
func TestEveryRouteReachesItsHandlerThroughTheMux(t *testing.T) {
	mux := muxUnderTest()

	for _, rt := range serviceRoutes() {
		t.Run(rt.method+" "+rt.probe, func(t *testing.T) {
			req := httptest.NewRequest(rt.method, rt.probe, nil)

			h, pattern := mux.Handler(req)
			if pattern == "" {
				t.Fatalf("%s %s matches no pattern: registerRoutes has no line for %q, "+
					"so every request to it answers 404", rt.method, rt.probe, rt.pattern)
			}
			if pattern != rt.pattern {
				t.Fatalf("%s %s matched pattern %q, want %q", rt.method, rt.probe, pattern, rt.pattern)
			}
			if rt.want != nil {
				got, want := funcPointer(h), funcPointer(rt.want)
				if got != want {
					t.Fatalf("%s is registered to the wrong handler: %s", rt.pattern, handlerName(h))
				}
			}

			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)
			if rec.Code == http.StatusNotFound && strings.Contains(rec.Body.String(), muxNotFoundBody) {
				t.Fatalf("%s %s was answered by the mux's own not-found handler", rt.method, rt.probe)
			}
		})
	}
}

// funcPointer is the code address behind a handler value, which is what makes
// two references to the same top-level func compare equal. Closures built from
// one body share an address too, which is why /health opts out rather than
// being compared against a second copy of its literal.
func funcPointer(h http.Handler) uintptr {
	return reflect.ValueOf(h).Pointer()
}

// handlerName turns a registered handler back into something a failure can
// print — "main.handleLayout" rather than an address nobody can look up.
func handlerName(h http.Handler) string {
	fn := runtime.FuncForPC(reflect.ValueOf(h).Pointer())
	if fn == nil {
		return "an unnamed handler"
	}
	return fn.Name()
}

// A PUT and a GET to /workspaces must both survive the ingress path the browser
// actually uses. The prod ingress routes PathPrefix /api/sessions/ to this
// service and strips the WHOLE prefix, so the lobby's /api/sessions/workspaces
// arrives here as /workspaces — frontend-v2's lib/config.ts holds the same fact
// from the other side as TMUX_API_PREFIX. This asserts the service-side half of
// that contract: the path after stripping is the path registerRoutes registers.
func TestWorkspacesServesThePathTheIngressLeavesBehind(t *testing.T) {
	const ingressPrefix = "/api/sessions"
	const browserPath = ingressPrefix + "/workspaces"

	mux := muxUnderTest()
	stripped := strings.TrimPrefix(browserPath, ingressPrefix)
	req := httptest.NewRequest(http.MethodGet, stripped, nil)
	if _, pattern := mux.Handler(req); pattern != "/workspaces" {
		t.Fatalf("the lobby's %s arrives here as %s and matches %q, want %q",
			browserPath, stripped, pattern, "/workspaces")
	}
}

// The feature, end to end, over a real socket: the first split's PUT and the
// next boot's GET, against the handler chain main actually serves.
//
// The two tests above ask the mux a question. This one asks the service: a real
// TCP listener, net/http's own client, timing.Wrap in front exactly as
// ListenAndServe has it, the real identity gate, and a store on disk. Nothing
// here is a double except the store's directory and the user map.
//
// It is written against the Go types rather than a JSON literal so it follows
// the document's shape instead of pinning it — what it pins is the round trip:
// what the lobby PUT on the drag is what it GETs back when the tab reloads.
func TestWorkspacesRoundTripOverARealSocket(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osSelf+"\n")
	withTempWorkspaceStore(t)

	srv := httptest.NewServer(timing.Wrap(muxUnderTest()))
	defer srv.Close()

	// What the browser sends on the first split: two sessions, one of them
	// somebody else's, which is the case a bare name could not express.
	doc := Workspaces{
		Version: workspacesVersion,
		Workspaces: []Workspace{{ID: "w1", Members: []WorkspaceMember{
			{Name: "auth"},
			{Name: "deploy", Owner: "emo"},
		}}},
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}

	put := request(t, http.MethodPut, srv.URL+"/workspaces", bytes.NewReader(raw))
	if put.StatusCode != http.StatusNoContent {
		t.Fatalf("PUT /workspaces over the wire: got %d, want %d", put.StatusCode, http.StatusNoContent)
	}

	get := request(t, http.MethodGet, srv.URL+"/workspaces", nil)
	if get.StatusCode != http.StatusOK {
		t.Fatalf("GET /workspaces over the wire: got %d, want %d", get.StatusCode, http.StatusOK)
	}
	var back Workspaces
	if err := json.NewDecoder(get.Body).Decode(&back); err != nil {
		t.Fatalf("decoding the document the service served: %v", err)
	}
	get.Body.Close()
	if !reflect.DeepEqual(back, doc) {
		t.Fatalf("round trip = %+v, want %+v", back, doc)
	}
}

// muxUnderTest is the service's own route table on a fresh mux, which is what
// keeps these tests from depending on http.DefaultServeMux — a package-level
// mux one test registering twice would panic on.
func muxUnderTest() *http.ServeMux {
	mux := http.NewServeMux()
	registerRoutes(mux)
	return mux
}

// request sends one authenticated request and returns the response, failing the
// test rather than returning an error nobody would check.
func request(t *testing.T, method, url string, body io.Reader) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, url, body)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set(authHeader, "alice")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

// Every handler-shaped func this package declares must appear in
// registerRoutes.
//
// This is the test that needs nobody to remember anything. The table above
// catches a route someone listed and forgot to register; it cannot catch a
// handler someone wrote and never listed anywhere, which is exactly how
// /workspaces shipped unreachable. Reading the source is the only way to ask
// "does a func exist that nothing routes to" — Go erases unreferenced
// package-level funcs from neither the build nor the binary, and offers no way
// to enumerate them at runtime.
func TestEveryHandlerFuncHasARoute(t *testing.T) {
	// Funcs with a handler's signature that are not surfaces, and any handler
	// held back on purpose, go here with the reason. An entry is a decision
	// somebody wrote down; the alternative, when the next one turns up, is
	// somebody deleting the test.
	//
	// The match is deliberately by SHAPE rather than by a `handle` prefix, so a
	// surface named some other way is still caught. The price is these three,
	// which take a ResponseWriter because they answer the request themselves on
	// the failure path.
	unmounted := map[string]string{
		"resolveOSUser":     "identity helper; writes the 401/403 for the handler that called it",
		"resolveRealOSUser": "identity helper; the same, ignoring ?as=",
		"setNetworkHeader":  "stamps a header on a response another handler is already writing",
	}

	fset := token.NewFileSet()
	declared := map[string]token.Position{}
	var routes *ast.FuncDecl

	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, name, nil, 0)
		if err != nil {
			t.Fatalf("parsing %s: %v", name, err)
		}
		for _, decl := range file.Decls {
			fd, ok := decl.(*ast.FuncDecl)
			if !ok {
				continue
			}
			if fd.Name.Name == "registerRoutes" {
				routes = fd
			}
			if isHTTPHandlerFunc(fd) {
				declared[fd.Name.Name] = fset.Position(fd.Pos())
			}
		}
	}

	if routes == nil {
		t.Fatal("no registerRoutes in this package: the route table moved and this test went blind")
	}
	if len(declared) == 0 {
		t.Fatal("found no handler funcs at all: the signature match is broken, not the routing")
	}

	named := map[string]bool{}
	ast.Inspect(routes, func(n ast.Node) bool {
		if id, ok := n.(*ast.Ident); ok {
			named[id.Name] = true
		}
		return true
	})

	for name, pos := range declared {
		if named[name] {
			continue
		}
		if why, ok := unmounted[name]; ok {
			t.Logf("%s is deliberately unrouted: %s", name, why)
			continue
		}
		t.Errorf("%s (%s) is never named in registerRoutes: it compiles, it tests green, "+
			"and no request can reach it", name, pos)
	}
}

// isHTTPHandlerFunc reports whether a declaration has the shape every handler
// in this package has: a plain func, no receiver, taking exactly
// (http.ResponseWriter, *http.Request). Matched on the WRITTEN type rather than
// through a type check, which keeps this to one parse of the source with no
// build of the package; the cost is that a handler declared through a type
// alias would be missed, and this package declares none.
func isHTTPHandlerFunc(fd *ast.FuncDecl) bool {
	if fd.Recv != nil || fd.Type.Params == nil || len(fd.Type.Params.List) != 2 {
		return false
	}
	params := make([]string, 0, 2)
	for _, p := range fd.Type.Params.List {
		if len(p.Names) != 1 {
			return false
		}
		params = append(params, writtenType(p.Type))
	}
	return params[0] == "http.ResponseWriter" && params[1] == "*http.Request"
}

// writtenType renders the two type expressions this test has to recognise: a
// qualified name (http.ResponseWriter) and a pointer to one (*http.Request).
// Anything else answers "", which fails the match, which is the right answer
// for a func that is not a handler.
func writtenType(e ast.Expr) string {
	switch t := e.(type) {
	case *ast.StarExpr:
		inner := writtenType(t.X)
		if inner == "" {
			return ""
		}
		return "*" + inner
	case *ast.SelectorExpr:
		if pkg, ok := t.X.(*ast.Ident); ok {
			return pkg.Name + "." + t.Sel.Name
		}
	}
	return ""
}
