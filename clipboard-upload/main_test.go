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
// fonts/. icon-512-maskable.png is deliberately ABSENT — Task M.9 ships it;
// until then the whitelisted path must 404. tl-symbols.woff2 IS installed
// (deploy.sh ships every repo woff2) but must never be served: the page
// embeds it as a data: URI, and it is not in the public whitelist.
func fixtureAssetDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	files := map[string]string{
		"manifest.webmanifest":                  `{"name":"Terminal","description":"Web tmux sessions."}`,
		"icon-192.png":                          "png-192-bytes",
		"icon-512.png":                          "png-512-bytes",
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

// /icon-512-maskable.png is whitelisted NOW; the file ships with Task M.9.
// Until then: clean 404. Once the file exists: 200 with no code change.
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
