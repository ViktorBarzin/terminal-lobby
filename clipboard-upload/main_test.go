package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// --- public PWA / webfont assets (Task 3.1) ---------------------------------

// fixtureAssetDir builds an on-disk mirror of deploy.sh's install layout
// (/usr/local/share/ttyd): manifest + icons at the root, woff2 files under
// fonts/. icon-512-maskable.png is deliberately ABSENT — the whitelisted-
// but-not-installed scenario (it rode the whitelist one task ahead of M.9
// shipping the file, and a fresh host sees the same shape) must 404
// cleanly. tl-symbols.woff2 IS installed (deploy.sh ships every repo
// woff2) but must never be served: the page embeds it as a data: URI, and
// it is not in the public whitelist.
func fixtureAssetDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	files := map[string]string{
		"manifest.webmanifest":                  `{"name":"Terminal","description":"Web tmux sessions."}`,
		"icon-192.png":                          "png-192-bytes",
		"icon-512.png":                          "png-512-bytes",
		"sw.js":                                 "sw-js-bytes",
		"fonts/JetBrainsMono-Regular.woff2":     "woff2-regular",
		"fonts/JetBrainsMono-Bold.woff2":        "woff2-bold",
		"fonts/JetBrainsMono-Italic.woff2":      "woff2-italic",
		"fonts/JetBrainsMono-BoldItalic.woff2":  "woff2-bolditalic",
		"fonts/dm-sans-latin-wght-normal.woff2": "woff2-dmsans",
		"fonts/tl-symbols.woff2":                "woff2-symbols-NEVER-SERVED",
	}
	for name, content := range files {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("CLIPBOARD_UPLOAD_ASSET_DIR", dir)
	return dir
}

// assetServe runs one request through the same handler chain the real
// listener uses (asset dispatcher in front of a fall-through handler).
func assetServe(t *testing.T, method, target string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "fell through to mux", http.StatusTeapot)
	})
	withPublicAssets(next).ServeHTTP(rec, httptest.NewRequest(method, target, nil))
	return rec
}

// Every whitelisted-and-installed asset is served with its exact content
// type and cache policy, with NO X-Authentik-Username on the request — the
// whole point of the carve-out is that WebAPK/iOS icon fetchers and font
// loads carry no credentials.
func TestPublicAssetsServedWithoutAuth(t *testing.T) {
	fixtureAssetDir(t)
	cases := []struct {
		path, contentType, cacheControl, body string
	}{
		{"/manifest.webmanifest", "application/manifest+json", "public,max-age=3600", `{"name":"Terminal","description":"Web tmux sessions."}`},
		{"/icon-192.png", "image/png", "public,max-age=3600", "png-192-bytes"},
		{"/icon-512.png", "image/png", "public,max-age=3600", "png-512-bytes"},
		{"/fonts/JetBrainsMono-Regular.woff2", "font/woff2", "public,max-age=604800", "woff2-regular"},
		{"/fonts/JetBrainsMono-Bold.woff2", "font/woff2", "public,max-age=604800", "woff2-bold"},
		{"/fonts/JetBrainsMono-Italic.woff2", "font/woff2", "public,max-age=604800", "woff2-italic"},
		{"/fonts/JetBrainsMono-BoldItalic.woff2", "font/woff2", "public,max-age=604800", "woff2-bolditalic"},
		{"/fonts/dm-sans-latin-wght-normal.woff2", "font/woff2", "public,max-age=604800", "woff2-dmsans"},
		{"/sw.js", "application/javascript", "no-cache", "sw-js-bytes"},
	}
	for _, c := range cases {
		t.Run(c.path, func(t *testing.T) {
			rec := assetServe(t, http.MethodGet, c.path)
			if rec.Code != http.StatusOK {
				t.Fatalf("GET %s: got %d, want 200 (body %q)", c.path, rec.Code, rec.Body.String())
			}
			if ct := rec.Header().Get("Content-Type"); ct != c.contentType {
				t.Fatalf("GET %s content-type: got %q, want %q", c.path, ct, c.contentType)
			}
			if cc := rec.Header().Get("Cache-Control"); cc != c.cacheControl {
				t.Fatalf("GET %s cache-control: got %q, want %q", c.path, cc, c.cacheControl)
			}
			if got, err := io.ReadAll(rec.Result().Body); err != nil || string(got) != c.body {
				t.Fatalf("GET %s body: got %q (err %v), want %q", c.path, got, err, c.body)
			}
		})
	}
}

// A spoofed auth header on a public asset request is simply ignored — the
// handlers never read it.
func TestPublicAssetsIgnoreAuthHeader(t *testing.T) {
	fixtureAssetDir(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/manifest.webmanifest", nil)
	req.Header.Set(authHeader, "eve")
	withPublicAssets(http.NotFoundHandler()).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET with stray auth header: got %d, want 200", rec.Code)
	}
}

// /icon-512-maskable.png entered the whitelist one task before M.9 shipped
// the file: a whitelisted path with no installed file must 404 cleanly,
// then serve 200 with no code change once the file lands.
func TestPublicAssetMaskableIconPreShipped(t *testing.T) {
	dir := fixtureAssetDir(t)

	rec := assetServe(t, http.MethodGet, "/icon-512-maskable.png")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("GET maskable icon before M.9 ships it: got %d, want 404", rec.Code)
	}

	if err := os.WriteFile(filepath.Join(dir, "icon-512-maskable.png"), []byte("png-maskable"), 0o644); err != nil {
		t.Fatal(err)
	}
	rec = assetServe(t, http.MethodGet, "/icon-512-maskable.png")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET maskable icon after shipping: got %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "image/png" {
		t.Fatalf("maskable icon content-type: got %q, want image/png", ct)
	}
}

// /term.html is the terminal-mode page the v2 SPA frames
// (config.TERMINAL_BASE). It reached this service before it was in the table —
// both hosts route Path(`/term.html`) here — and fell through to the mux as a
// 404, which is what left the SPA Terminal view blank. Same shape as the
// maskable icon: 404 while the file is not installed, 200 once deploy-v2.sh
// ships it, no code change in between. Served no-cache so a browser cannot pin
// a terminal page that has been replaced under it.
func TestPublicAssetTermHTML(t *testing.T) {
	dir := fixtureAssetDir(t)

	rec := assetServe(t, http.MethodGet, "/term.html")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("GET /term.html before deploy-v2.sh installs it: got %d, want 404", rec.Code)
	}

	const body = "<!DOCTYPE html><html><head><title>Terminal</title></head><body></body></html>"
	if err := os.WriteFile(filepath.Join(dir, "term.html"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	// The SPA asks for it WITH a query (`?arg=<session>`), so the lookup must
	// key off the path alone. Both spellings must serve the page.
	for _, target := range []string{"/term.html", "/term.html?arg=qa-1&arg=default"} {
		rec = assetServe(t, http.MethodGet, target)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s: got %d, want 200 (body %q)", target, rec.Code, rec.Body.String())
		}
		if ct := rec.Header().Get("Content-Type"); ct != "text/html; charset=utf-8" {
			t.Fatalf("GET %s content-type: got %q, want %q", target, ct, "text/html; charset=utf-8")
		}
		if cc := rec.Header().Get("Cache-Control"); cc != "no-cache" {
			t.Fatalf("GET %s cache-control: got %q, want no-cache", target, cc)
		}
		if got, err := io.ReadAll(rec.Result().Body); err != nil || string(got) != body {
			t.Fatalf("GET %s body: got %q (err %v), want %q", target, got, err, body)
		}
	}
}

// GET and HEAD only. HEAD must work — the infra acceptance (`curl -sI`) and
// the walloff probe use it. Everything else: 405.
func TestPublicAssetsMethodGuard(t *testing.T) {
	fixtureAssetDir(t)

	for _, m := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
		for _, p := range []string{"/manifest.webmanifest", "/icon-192.png", "/fonts/JetBrainsMono-Regular.woff2"} {
			rec := assetServe(t, m, p)
			if rec.Code != http.StatusMethodNotAllowed {
				t.Fatalf("%s %s: got %d, want 405", m, p, rec.Code)
			}
		}
	}

	rec := assetServe(t, http.MethodHead, "/manifest.webmanifest")
	if rec.Code != http.StatusOK {
		t.Fatalf("HEAD manifest: got %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/manifest+json" {
		t.Fatalf("HEAD manifest content-type: got %q", ct)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("HEAD manifest: body must be empty, got %d bytes", rec.Body.Len())
	}
}

// The whitelist is a fixed table — the request path is only ever a KEY into
// it, never joined into a filesystem path. Traversal shapes and any
// non-listed file in the namespace get a straight 404 (no ServeMux
// canonicalize-and-301, no directory serving).
func TestPublicAssetsTraversalAndNonWhitelisted404(t *testing.T) {
	fixtureAssetDir(t)
	probes := []string{
		"/icon-../etc/passwd",
		"/fonts/../../etc/passwd",
		"/fonts/%2e%2e/%2e%2e/etc/passwd",
		"/fonts/JetBrainsMono-Regular.woff2/../../../etc/passwd",
		"/fonts/tl-symbols.woff2", // installed but data-URI-embedded: not public
		"/fonts/",
		"/fonts/does-not-exist.woff2",
		"/icon-512.png.bak",
		"/manifest.webmanifest2",
	}
	for _, p := range probes {
		rec := assetServe(t, http.MethodGet, p)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("GET %s: got %d, want 404", p, rec.Code)
		}
	}
}

// Non-asset routes are untouched: the dispatcher forwards everything outside
// the asset namespace to the next handler (the real mux with /upload, /img/,
// /health, …) — and never forwards whitelisted paths.
func TestPublicAssetsFallthrough(t *testing.T) {
	fixtureAssetDir(t)
	for _, c := range []struct {
		method, path string
		fallsThrough bool
	}{
		{http.MethodGet, "/health", true},
		{http.MethodPost, "/upload", true},
		{http.MethodGet, "/list", true},
		{http.MethodGet, "/img/sess/pic.png", true},
		{http.MethodPost, "/register", true},
		{http.MethodPost, "/telemetry", true},
		{http.MethodGet, "/manifest.webmanifest", false},
		{http.MethodGet, "/fonts/JetBrainsMono-Bold.woff2", false},
		{http.MethodGet, "/sw.js", false},
		// The regression itself: /term.html used to fall through to the mux.
		{http.MethodGet, "/term.html", false},
	} {
		called := false
		next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			called = true
			w.WriteHeader(http.StatusOK)
		})
		rec := httptest.NewRecorder()
		withPublicAssets(next).ServeHTTP(rec, httptest.NewRequest(c.method, c.path, nil))
		if called != c.fallsThrough {
			t.Fatalf("%s %s: fell through = %v, want %v", c.method, c.path, called, c.fallsThrough)
		}
	}
}
