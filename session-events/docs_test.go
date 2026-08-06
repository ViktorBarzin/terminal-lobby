package main

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// DEPLOY.md ⟷ the route table.
//
// The deploy doc is an INSTRUCTION SHEET: it tells an operator which paths to
// wire a hook to and which paths to expose through the ingress. When it names a
// path the binary does not serve, following it produces a dead route — which is
// what happened after 575d4f5 removed the web-mediated permission broker and
// left the doc telling operators to POST to /hooks/permission-request and to
// route /permission through the ingress. Both still 404/401 today.
//
// So: every service path the doc names must be one main.go registers. The route
// table is parsed from the source rather than restated here, so re-adding a
// route re-permits the doc that describes it.

// registeredRoutes parses the mux registrations out of main.go. Wildcards
// ("{session}") are stripped so "/events/{session}" reads as "/events"; the
// bare "/" catch-all mount is a handler mount, not a route.
func registeredRoutes(t *testing.T) []string {
	t.Helper()
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	re := regexp.MustCompile(`Handle(?:Func)?\(\s*"(?:[A-Z]+ )?(/[^"]*)"`)
	var out []string
	for _, m := range re.FindAllStringSubmatch(string(src), -1) {
		route := strings.TrimRight(regexp.MustCompile(`\{[^}]*\}`).ReplaceAllString(m[1], ""), "/")
		if route != "" {
			out = append(out, route)
		}
	}
	return out
}

// fsRoots are absolute FILESYSTEM paths the doc legitimately names (binaries,
// unit files); they are not service routes.
var fsRoots = map[string]bool{
	"usr": true, "etc": true, "srv": true, "home": true, "tmp": true, "var": true,
	"opt": true, "dev": true, "proc": true, "bin": true, "sbin": true, "lib": true,
	"root": true, "mnt": true, "media": true, "run": true,
}

// docPaths pulls the service paths out of a doc: a leading-slash token that is
// not part of a longer word (so "./session-events" and "out/session-events" are
// not paths) and does not start at a filesystem root.
func docPaths(doc string) []string {
	re := regexp.MustCompile(`(^|[^A-Za-z._/-])(/[a-z][a-z0-9*/-]*)`)
	seen := map[string]bool{}
	var out []string
	for _, m := range re.FindAllStringSubmatch(doc, -1) {
		p := strings.TrimRight(m[2], "/")
		if p == "" || seen[p] {
			continue
		}
		if fsRoots[strings.Split(strings.TrimPrefix(p, "/"), "/")[0]] {
			continue
		}
		seen[p] = true
		out = append(out, p)
	}
	return out
}

// matches reports whether a documented path corresponds to a registered route.
// A trailing "*" is a wildcard over the routes beneath it ("/hooks/*").
func matches(documented string, routes []string) bool {
	if strings.HasSuffix(documented, "/*") {
		prefix := strings.TrimSuffix(documented, "*")
		for _, r := range routes {
			if strings.HasPrefix(r, prefix) {
				return true
			}
		}
		return false
	}
	for _, r := range routes {
		if r == documented || strings.HasPrefix(r, documented+"/") {
			return true
		}
	}
	return false
}

func TestDeployDocNamesOnlyRegisteredRoutes(t *testing.T) {
	routes := registeredRoutes(t)
	if len(routes) < 4 {
		t.Fatalf("parsed only %v out of main.go — the parser, not the doc, is wrong", routes)
	}

	doc, err := os.ReadFile("DEPLOY.md")
	if err != nil {
		t.Fatalf("read DEPLOY.md: %v", err)
	}

	for _, p := range docPaths(string(doc)) {
		if !matches(p, routes) {
			t.Errorf("DEPLOY.md tells an operator to use %s, which session-events does not serve (registered: %v)", p, routes)
		}
	}
}

func TestDocPathExtraction(t *testing.T) {
	// The extractor is load-bearing for the check above: too greedy and it
	// flags build commands, too shy and a dead route slips through.
	got := docPaths("build -o out/session-events ./session-events, install to " +
		"/usr/local/bin/session-events, curl localhost:7685/health, POST `/hooks/x`, route `/events`")
	want := []string{"/health", "/hooks/x", "/events"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("docPaths = %v, want %v", got, want)
	}
}

func TestRouteMatching(t *testing.T) {
	routes := []string{"/events", "/prompt", "/cancel", "/health", "/hooks/session-start"}
	for _, tc := range []struct {
		path string
		want bool
	}{
		{"/events", true},
		{"/hooks/session-start", true},
		{"/hooks/*", true},
		{"/hooks/permission-request", false},
		{"/permission", false},
	} {
		if got := matches(tc.path, routes); got != tc.want {
			t.Errorf("matches(%q) = %v, want %v", tc.path, got, tc.want)
		}
	}
}
