package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"path/filepath"
	"sort"
	"strings"
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

// /assets/ is where the lobby's content-hashed output lives: the SPA's chunks
// and an immutable copy of the terminal page. Two things matter here — that the
// answer is unconditionally cacheable (a name's bytes never change, so a client
// must never have to revalidate), and that a name is VALIDATED rather than
// cleaned, so nothing outside that one flat directory is reachable.
func TestHashedAssetsAreImmutableAndConfined(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLIPBOARD_UPLOAD_ASSET_DIR", dir)
	if err := os.MkdirAll(filepath.Join(dir, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	const body = "console.log(1)"
	if err := os.WriteFile(filepath.Join(dir, "assets", "index-abc123.js"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	// A secret one directory up: a traversal that resolved would read this.
	if err := os.WriteFile(filepath.Join(dir, "term.html"), []byte("SHOULD NOT LEAK"), 0o644); err != nil {
		t.Fatal(err)
	}

	rec := assetServe(t, http.MethodGet, "/assets/index-abc123.js")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /assets/index-abc123.js: got %d, want 200", rec.Code)
	}
	if rec.Body.String() != body {
		t.Fatalf("body = %q", rec.Body.String())
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "public, max-age=31536000, immutable" {
		t.Fatalf("Cache-Control = %q — a hashed name must never need revalidating", cc)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/javascript; charset=utf-8" {
		t.Fatalf("Content-Type = %q", ct)
	}

	// An immutable copy of the terminal page rides the same path.
	if err := os.WriteFile(filepath.Join(dir, "assets", "term-b40edcd054b4.html"), []byte("<!doctype html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	rec = assetServe(t, http.MethodGet, "/assets/term-b40edcd054b4.html")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET the hashed terminal page: got %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "text/html; charset=utf-8" {
		t.Fatalf("Content-Type = %q", ct)
	}

	for _, bad := range []string{
		"/assets/../term.html",
		"/assets/..%2Fterm.html",
		"/assets/sub/dir.js",
		"/assets/",
		"/assets/.env",
		"/assets/index-abc123.sh",   // extension not in the table
		"/assets/index-abc123.js.x", // nor this one
		"/assets/missing-000000.js",
	} {
		rec := assetServe(t, http.MethodGet, bad)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("GET %s: got %d, want 404", bad, rec.Code)
		}
		if strings.Contains(rec.Body.String(), "SHOULD NOT LEAK") {
			t.Fatalf("GET %s reached outside the assets directory", bad)
		}
	}
}

// /build-id is the lobby's build stamp on its own path. The healer used to read
// that fingerprint out of a full GET of "/" every 5 seconds: 1.43 MB a time, and
// on iOS Safari 1,279 full bodies to 2 revalidations in 24h — 1.83 GB/day from
// one phone. Serving ~12 bytes instead is the whole point, so this pins that the
// path is whitelisted, answers the file's exact bytes, and is small.
func TestBuildIDStampIsServed(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLIPBOARD_UPLOAD_ASSET_DIR", dir)

	rec := assetServe(t, http.MethodGet, "/build-id")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("GET /build-id before deploy-v2.sh installs it: got %d, want 404", rec.Code)
	}

	const stamp = "4a01bfff1d16"
	if err := os.WriteFile(filepath.Join(dir, "build-id"), []byte(stamp), 0o644); err != nil {
		t.Fatal(err)
	}
	rec = assetServe(t, http.MethodGet, "/build-id")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /build-id: got %d, want 200", rec.Code)
	}
	if got := rec.Body.String(); got != stamp {
		t.Fatalf("body = %q, want %q", got, stamp)
	}
	if got := len(rec.Body.Bytes()); got > 64 {
		t.Fatalf("stamp is %d bytes; the point is that it is tiny", got)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "text/plain; charset=utf-8" {
		t.Fatalf("Content-Type = %q", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Fatalf("Cache-Control = %q, want no-cache (it must revalidate)", cc)
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

// --- /upload: the bytes must actually be an image ----------------------------
//
// /upload's image branch trusted the multipart part's Content-Type, which the
// browser fills in from the file's extension and a client can set to anything.
// So 39 bytes of plain text labelled image/png were accepted, written into the
// per-(user, session) store, and listed by /list forever — the gallery then
// drew them as a dead thumbnail with no way to remove them. These tests pin the
// content check that closes that, and record which shapes it does and does not
// catch.

// withUserMap points resolveOSUser's map file (mapPath — a var purely for this
// seam) at a fixture, so upload tests run the REAL X-Authentik-Username →
// OS-user path hermetically instead of depending on /etc/ttyd-user-map.
func withUserMap(t *testing.T, content string) {
	t.Helper()
	f := filepath.Join(t.TempDir(), "user-map")
	if err := os.WriteFile(f, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	old := mapPath
	mapPath = f
	t.Cleanup(func() { mapPath = old })
}

// withStore redirects the image store (storeRoot — a var for the same reason)
// at a temp dir, so a test upload can never land in the real
// /var/lib/clipboard-store next to a user's actual screenshots.
// withFileDir points the ephemeral-transfer directory at a temporary one, so a
// test neither depends on the real path existing nor writes into the directory
// a live service is using.
func withFileDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	old := fileDir
	fileDir = dir
	t.Cleanup(func() { fileDir = old })
	return dir
}

func withStore(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	old := storeRoot
	storeRoot = dir
	t.Cleanup(func() { storeRoot = old })
	return dir
}

// realPNG is a complete, valid 1x1 PNG — encoded rather than hard-coded so the
// signature, IHDR, IDAT and IEND are all genuine.
func realPNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 1, 1))
	img.Set(0, 0, color.RGBA{R: 10, G: 20, B: 30, A: 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// imageUpload builds exactly what the SPA sends for a clipboard paste or an
// image drop (frontend-v2/src/clipboard/upload.ts): a multipart POST whose
// "image" part carries the BROWSER-DECLARED content type — the value the bug
// trusted — alongside the session field and the ingress's identity header.
func imageUpload(t *testing.T, session, filename, declaredType string, body []byte) *http.Request {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="image"; filename=%q`, filename))
	h.Set("Content-Type", declaredType)
	part, err := mw.CreatePart(h)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(body); err != nil {
		t.Fatal(err)
	}
	if err := mw.WriteField("session", session); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/upload", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set(authHeader, "qa.tester")
	return req
}

// storedNames lists what actually landed in the store for one (user, session)
// — the durable damage a bad accept leaves behind.
func storedNames(t *testing.T, root, osUser, session string) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(root, osUser, session))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	return names
}

// The reported bug, measured in QA session qa-vimg3: 39 bytes of plain text
// labelled image/png were accepted on the strength of the label alone. The
// bytes must be inspected, the request refused, and NOTHING written to the
// store — a store write is the part that cannot be undone from the UI.
func TestUploadRejectsNonImageBytesLabelledAsImage(t *testing.T) {
	withUserMap(t, "qa.tester=qauser\n")
	root := withStore(t)

	body := []byte("this is definitely not a png at all :-)") // 39 bytes, as measured
	rec := httptest.NewRecorder()
	handleUpload(rec, imageUpload(t, "qa", "screenshot.png", "image/png", body))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("POST /upload, text labelled image/png: got %d, want 400 (body %q)",
			rec.Code, rec.Body.String())
	}
	// The body becomes a toast in the SPA (uploadBlob throws the response text),
	// so it has to say what was actually wrong.
	if msg := rec.Body.String(); !strings.Contains(msg, "text/plain") {
		t.Fatalf("rejection message %q should name the sniffed type", msg)
	}
	if names := storedNames(t, root, "qauser", "qa"); len(names) != 0 {
		t.Fatalf("a rejected upload still wrote to the store: %v", names)
	}
}

// The other half: a genuine PNG still uploads, still lands in the caller's
// per-session store, and still answers with the {"path": …} the frontend types
// into the pty.
func TestUploadAcceptsRealPNG(t *testing.T) {
	withUserMap(t, "qa.tester=qauser\n")
	root := withStore(t)

	rec := httptest.NewRecorder()
	handleUpload(rec, imageUpload(t, "qa", "shot.png", "image/png", realPNG(t)))

	if rec.Code != http.StatusOK {
		t.Fatalf("POST /upload with a real PNG: got %d, want 200 (body %q)",
			rec.Code, rec.Body.String())
	}
	names := storedNames(t, root, "qauser", "qa")
	if len(names) != 1 || !strings.HasSuffix(names[0], ".png") {
		t.Fatalf("stored files after a good upload: %v, want one *.png", names)
	}
	if !strings.Contains(rec.Body.String(), filepath.Join(root, "qauser", "qa", names[0])) {
		t.Fatalf("response %q should carry the stored path", rec.Body.String())
	}
}

// DOCUMENTED DECISION — a truncated PNG is ACCEPTED.
//
// The QA repro dropped the first 40 bytes of a valid PNG; its magic bytes are
// intact, so http.DetectContentType calls it image/png and this check passes.
// That is deliberate. The check answers "are these bytes an image", not "does
// this image decode": image.DecodeConfig would accept the same 40 bytes (the
// IHDR is complete by byte 33) while REJECTING webp and avif, which the
// browser renders perfectly — a strictly worse trade. Files that pass here and
// still fail to paint are the gallery's onError fallback's job
// (frontend-v2/src/components/Gallery.tsx), which is why this fix has two
// halves. If this ever flips to a reject, the failure mode to weigh is a real
// screenshot refused mid-copy, not a smarter sniff.
func TestUploadAcceptsTruncatedPNG(t *testing.T) {
	withUserMap(t, "qa.tester=qauser\n")
	root := withStore(t)

	full := realPNG(t)
	if len(full) < 40 {
		t.Fatalf("fixture PNG is only %d bytes; cannot truncate to 40", len(full))
	}
	rec := httptest.NewRecorder()
	handleUpload(rec, imageUpload(t, "qa", "trunc.png", "image/png", full[:40]))

	if rec.Code != http.StatusOK {
		t.Fatalf("POST /upload with a truncated PNG: got %d, want 200 — the magic "+
			"bytes make it image/png and this check is a sniff, not a decode (body %q)",
			rec.Code, rec.Body.String())
	}
	if names := storedNames(t, root, "qauser", "qa"); len(names) != 1 {
		t.Fatalf("stored files: %v, want exactly one", names)
	}
}

// A CONSEQUENCE worth pinning: SVG is refused, because the check has no
// filename-extension escape hatch (unlike isImage, which /register uses — the
// extension is client-supplied too, so honouring it would wave the same
// mislabelled bytes straight back in).
//
// Nothing that worked is lost. An SVG on this path could never render: /upload
// names it by imageExt(ct), which has no svg case and falls through to ".png",
// and /img re-sniffs on serve and hands the <img> tag "text/xml", which no
// browser draws. Accepting SVG here only ever produced the dead tile this lane
// is fixing. Reversing the decision means giving SVG a real path — an svg case
// in imageExt and an explicit content type on serve — not loosening this check.
func TestUploadRejectsSVGWhichCouldNeverRender(t *testing.T) {
	withUserMap(t, "qa.tester=qauser\n")
	root := withStore(t)

	svg := []byte(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" ` +
		`width="8" height="8"><rect width="8" height="8"/></svg>`)
	rec := httptest.NewRecorder()
	handleUpload(rec, imageUpload(t, "qa", "diagram.svg", "image/svg+xml", svg))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("POST /upload with an SVG: got %d, want 400 (body %q)",
			rec.Code, rec.Body.String())
	}
	if names := storedNames(t, root, "qauser", "qa"); len(names) != 0 {
		t.Fatalf("a rejected SVG still wrote to the store: %v", names)
	}
}

// realAVIF is a genuine 24x24 AVIF (Pillow 12.2 `Image.new("RGB",(24,24)).save`),
// base64'd here because there is no AVIF encoder in the standard library. Its
// first bytes are the ISO-BMFF header the check below keys on:
// 00 00 00 20 "ftyp" "avif" ... "avifmif1".
const realAVIFBase64 = `AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADrbWV0YQAAAAAAAAAhaGRscgAAAAAA` +
	`AAAAcGljdAAAAAAAAAAAAAAAAAAAAAAOcGl0bQAAAAAAAQAAAB5pbG9jAAAAAEQAAAEAAQAAAAEA` +
	`AAETAAAAJwAAAChpaW5mAAAAAAABAAAAGmluZmUCAAAAAAEAAGF2MDFDb2xvcgAAAABqaXBycAAA` +
	`AEtpcGNvAAAAFGlzcGUAAAAAAAAAGAAAABgAAAAQcGl4aQAAAAADCAgIAAAADGF2MUOBAAwAAAAA` +
	`E2NvbHJuY2x4AAEADQAGgAAAABdpcG1hAAAAAAAAAAEAAQQBAoMEAAAAL21kYXQSAAoJGBEvdogI` +
	`aDQgMhgUx4eGZQIIIJ5AAACLRzYXX0pdv6c/F6Q=`

func avifBytes(t *testing.T) []byte {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(realAVIFBase64)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// REGRESSION GUARD — AVIF must still upload.
//
// http.DetectContentType's table stops at png/jpeg/gif/webp/bmp/ico: it has no
// entry for the ISO-BMFF image family, so a real AVIF sniffs as
// application/octet-stream. Gating on the sniff alone therefore refuses a
// format every current browser decodes, and that is a live workflow — dragging
// a downloaded .avif into the terminal sets File.type "image/avif", which
// uploadField routes to this very "image" branch
// (frontend-v2/src/clipboard/upload.ts).
//
// Measured 2026-08-06 before this guard existed: the same file uploaded 200
// against the deployed service, /img served it back as application/octet-stream
// (stored extensions are advisory there), and headless chromium drew it —
// naturalWidth 24, onload fired. So refusing it loses something that worked,
// unlike the SVG and TIFF cases above, which were dead tiles either way.
//
// The rest of the ISO-BMFF image brands (heic/heif/…) ride along on the same
// container check. Where a browser cannot decode one, the gallery's onError
// placeholder covers it — which is the whole point of the client half.
func TestUploadAcceptsAVIFWhichSniffsAsOctetStream(t *testing.T) {
	withUserMap(t, "qa.tester=qauser\n")
	root := withStore(t)

	rec := httptest.NewRecorder()
	handleUpload(rec, imageUpload(t, "qa", "photo.avif", "image/avif", avifBytes(t)))

	if rec.Code != http.StatusOK {
		t.Fatalf("POST /upload with a real AVIF: got %d, want 200 — browsers "+
			"render AVIF, so this is a format the sniffer misses, not a bad file "+
			"(body %q)", rec.Code, rec.Body.String())
	}
	if names := storedNames(t, root, "qauser", "qa"); len(names) != 1 {
		t.Fatalf("stored files after an AVIF upload: %v, want exactly one", names)
	}
}

// The container check must not become the extension escape hatch by another
// name: "ftyp" alone is any ISO-BMFF file, and an MP4 is not a gallery image.
func TestUploadRejectsNonImageISOBMFF(t *testing.T) {
	withUserMap(t, "qa.tester=qauser\n")
	root := withStore(t)

	// A well-formed ftyp box with the MP4 brand, i.e. a video container.
	mp4 := []byte("\x00\x00\x00\x20ftypmp42\x00\x00\x00\x00mp42isomavc1")
	mp4 = append(mp4, make([]byte, 64)...)
	rec := httptest.NewRecorder()
	handleUpload(rec, imageUpload(t, "qa", "clip.mp4", "image/png", mp4))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("POST /upload with an MP4 labelled image/png: got %d, want 400 (body %q)",
			rec.Code, rec.Body.String())
	}
	if names := storedNames(t, root, "qauser", "qa"); len(names) != 0 {
		t.Fatalf("a rejected MP4 still wrote to the store: %v", names)
	}
}

// An empty part is not an image either — DetectContentType calls zero bytes
// text/plain — and must not create a 0-byte tile in the gallery.
func TestUploadRejectsEmptyImagePart(t *testing.T) {
	withUserMap(t, "qa.tester=qauser\n")
	root := withStore(t)

	rec := httptest.NewRecorder()
	handleUpload(rec, imageUpload(t, "qa", "empty.png", "image/png", nil))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("POST /upload with an empty image part: got %d, want 400 (body %q)",
			rec.Code, rec.Body.String())
	}
	if names := storedNames(t, root, "qauser", "qa"); len(names) != 0 {
		t.Fatalf("a rejected empty upload still wrote to the store: %v", names)
	}
}

// ---------------------------------------------------------------------------
// Attachments in the text view (docs/plans/2026-08-17-text-view-attachments-
// design.md). Decision 3 puts a non-image upload in the per-(user, session)
// store so the chat can render a chip for it, decision 11 caps that at 25MB and
// leaves anything larger as today's ephemeral /tmp transfer, and the
// consequences section restricts /list to the gallery's own prefixes.
// ---------------------------------------------------------------------------

// docUpload builds what the SPA sends for a non-image attachment: the generic
// "file" part, the session field, and the ingress's identity header. Mirrors
// imageUpload, which covers the "image" part.
func docUpload(t *testing.T, session, filename, declaredType string, body []byte) *http.Request {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename=%q`, filename))
	h.Set("Content-Type", declaredType)
	part, err := mw.CreatePart(h)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(body); err != nil {
		t.Fatal(err)
	}
	if err := mw.WriteField("session", session); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/upload", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set(authHeader, "qa.tester")
	return req
}

// uploadReply is the /upload response body. `stored` is what tells the client a
// chip is possible: a path alone cannot say whether it landed somewhere the
// chat can read back.
type uploadReply struct {
	Path   string `json:"path"`
	Stored bool   `json:"stored"`
}

func decodeUpload(t *testing.T, rec *httptest.ResponseRecorder) uploadReply {
	t.Helper()
	var got uploadReply
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("reply %q is not JSON: %v", rec.Body.String(), err)
	}
	return got
}

func TestDocUnderTheCapLandsInTheSessionStore(t *testing.T) {
	withUserMap(t, "qa.tester=qauser\n")
	root := withStore(t)

	rec := httptest.NewRecorder()
	handleUpload(rec, docUpload(t, "qa", "report.pdf", "application/pdf", []byte("%PDF-1.4 hello")))
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", rec.Code, rec.Body.String())
	}

	got := decodeUpload(t, rec)
	if !got.Stored {
		t.Errorf("a stored doc must report stored:true, got %+v", got)
	}
	want := filepath.Join(root, "qauser", "qa")
	if !strings.HasPrefix(got.Path, want+string(os.PathSeparator)) {
		t.Errorf("path %q is not inside %q", got.Path, want)
	}
	names := storedNames(t, root, "qauser", "qa")
	if len(names) != 1 {
		t.Fatalf("want exactly one stored file, got %v", names)
	}
	if !strings.HasPrefix(names[0], "file-") {
		t.Errorf("a stored doc needs the file- prefix so /list can skip it, got %q", names[0])
	}
	if !strings.HasSuffix(names[0], "report.pdf") {
		t.Errorf("the original name must survive (sanitized), got %q", names[0])
	}
}

// withAttachCap shrinks the store cap so the size fork can be exercised without
// pushing 25MB through a multipart encoder.
func withAttachCap(t *testing.T, n int64) {
	t.Helper()
	old := maxAttach
	maxAttach = n
	t.Cleanup(func() { maxAttach = old })
}

func TestDocOverTheCapStaysAnEphemeralTransfer(t *testing.T) {
	withUserMap(t, "qa.tester=qauser\n")
	root := withStore(t)
	withFileDir(t)
	withAttachCap(t, 64)

	rec := httptest.NewRecorder()
	handleUpload(rec, docUpload(t, "qa", "big.bin", "application/octet-stream",
		make([]byte, 65)))
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", rec.Code, rec.Body.String())
	}

	got := decodeUpload(t, rec)
	if got.Stored {
		t.Errorf("an over-cap doc must report stored:false so the client says 'path only', got %+v", got)
	}
	if !strings.HasPrefix(got.Path, fileDir+string(os.PathSeparator)) {
		t.Errorf("an over-cap doc belongs in %q, got %q", fileDir, got.Path)
	}
	if names := storedNames(t, root, "qauser", "qa"); len(names) != 0 {
		t.Errorf("an over-cap doc must not reach the 30-day-grace store: %v", names)
	}
	_ = os.Remove(got.Path)
}

func TestDocUploadRequiresIdentity(t *testing.T) {
	withUserMap(t, "qa.tester=qauser\n")
	withStore(t)

	req := docUpload(t, "qa", "report.pdf", "application/pdf", []byte("%PDF-1.4"))
	req.Header.Del(authHeader)
	rec := httptest.NewRecorder()
	handleUpload(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("a store write needs an owner: want 401, got %d: %s", rec.Code, rec.Body.String())
	}
}

// storeFile writes one file straight into the store, standing in for an upload
// that already happened.
func storeFile(t *testing.T, root, osUser, session, name string, body []byte) {
	t.Helper()
	dir := filepath.Join(root, osUser, session)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), body, 0o644); err != nil {
		t.Fatal(err)
	}
}

func serveStored(t *testing.T, target string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	req.Header.Set(authHeader, "qa.tester")
	rec := httptest.NewRecorder()
	handleStoredFile(rec, req)
	return rec
}

func TestStoredDocIsServedBackWithSniffingDisabled(t *testing.T) {
	withUserMap(t, "qa.tester=qauser\n")
	root := withStore(t)
	storeFile(t, root, "qauser", "qa", "file-20260817-abcd-report.pdf", []byte("%PDF-1.4 hello"))

	rec := serveStored(t, "/file/qa/file-20260817-abcd-report.pdf")
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if body := rec.Body.String(); body != "%PDF-1.4 hello" {
		t.Errorf("body = %q", body)
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q, want nosniff", got)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/pdf") {
		t.Errorf("Content-Type = %q, want application/pdf so the browser viewer opens it", ct)
	}
	if cd := rec.Header().Get("Content-Disposition"); !strings.HasPrefix(cd, "inline") {
		t.Errorf("Content-Disposition = %q, want inline for a pdf", cd)
	}
}

// An uploaded doc whose bytes are HTML must never be served in a way that lets
// it run against the authed lobby origin.
func TestStoredHTMLDocIsForcedToDownload(t *testing.T) {
	withUserMap(t, "qa.tester=qauser\n")
	root := withStore(t)
	storeFile(t, root, "qauser", "qa", "file-20260817-abcd-evil.html",
		[]byte("<html><body><script>alert(document.cookie)</script></body></html>"))

	rec := serveStored(t, "/file/qa/file-20260817-abcd-evil.html")
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if cd := rec.Header().Get("Content-Disposition"); !strings.HasPrefix(cd, "attachment") {
		t.Errorf("Content-Disposition = %q, want attachment for html", cd)
	}
	if ct := rec.Header().Get("Content-Type"); strings.Contains(ct, "html") {
		t.Errorf("Content-Type = %q must not invite the browser to render html", ct)
	}
}

func TestStoredSVGDocIsForcedToDownload(t *testing.T) {
	withUserMap(t, "qa.tester=qauser\n")
	root := withStore(t)
	storeFile(t, root, "qauser", "qa", "file-20260817-abcd-x.svg",
		[]byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`))

	rec := serveStored(t, "/file/qa/file-20260817-abcd-x.svg")
	if cd := rec.Header().Get("Content-Disposition"); !strings.HasPrefix(cd, "attachment") {
		t.Errorf("Content-Disposition = %q, want attachment for svg", cd)
	}
}

func TestStoredFileRouteGuards(t *testing.T) {
	withUserMap(t, "qa.tester=qauser\n")
	root := withStore(t)
	storeFile(t, root, "qauser", "qa", "file-20260817-abcd-report.pdf", []byte("%PDF"))

	cases := []struct {
		name, target string
		want         int
	}{
		{"missing file", "/file/qa/file-nope.pdf", http.StatusNotFound},
		{"bad session charset", "/file/has%20spaces/file-x.pdf", http.StatusBadRequest},
		// %2F decodes to a separator before the split, so it lands as three
		// segments rather than a name containing one — refused either way.
		{"encoded separator in the name", "/file/qa/..%2Fescape.pdf", http.StatusNotFound},
		{"dot-dot inside the name", "/file/qa/a..b.pdf", http.StatusBadRequest},
		{"dotfile", "/file/qa/.deleted-at", http.StatusBadRequest},
		{"too few segments", "/file/qa", http.StatusNotFound},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if rec := serveStored(t, c.target); rec.Code != c.want {
				t.Errorf("%s: want %d, got %d: %s", c.target, c.want, rec.Code, rec.Body.String())
			}
		})
	}
}

func TestStoredFileRouteRequiresAuth(t *testing.T) {
	withUserMap(t, "qa.tester=qauser\n")
	root := withStore(t)
	storeFile(t, root, "qauser", "qa", "file-20260817-abcd-report.pdf", []byte("%PDF"))

	req := httptest.NewRequest(http.MethodGet, "/file/qa/file-20260817-abcd-report.pdf", nil)
	rec := httptest.NewRecorder()
	handleStoredFile(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", rec.Code)
	}
}

// The gallery grid is images. A doc sharing the directory must not become an
// undecodable tile — the same failure byte-sniffing was added to the upload
// path to prevent.
func TestListSkipsStoredDocs(t *testing.T) {
	withUserMap(t, "qa.tester=qauser\n")
	root := withStore(t)
	storeFile(t, root, "qauser", "qa", "pasted-20260817-abcd.png", realPNG(t))
	storeFile(t, root, "qauser", "qa", "displayed-20260817-plot.png", realPNG(t))
	storeFile(t, root, "qauser", "qa", "file-20260817-abcd-report.pdf", []byte("%PDF"))

	req := httptest.NewRequest(http.MethodGet, "/list?session=qa", nil)
	req.Header.Set(authHeader, "qa.tester")
	rec := httptest.NewRecorder()
	handleList(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var listed []storedImage
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatalf("reply is not JSON: %v", err)
	}
	for _, e := range listed {
		if strings.HasPrefix(e.Name, "file-") {
			t.Errorf("a stored doc leaked into the gallery listing: %q", e.Name)
		}
	}
	if len(listed) != 2 {
		t.Errorf("want the two images, got %d: %+v", len(listed), listed)
	}
}

// /img shares the directory with docs now, and it serves whatever it sniffs. An
// uploaded HTML file fetched through the image route would otherwise execute on
// the authed origin.
func TestImageRouteRefusesNonImageBytes(t *testing.T) {
	withUserMap(t, "qa.tester=qauser\n")
	root := withStore(t)
	storeFile(t, root, "qauser", "qa", "file-20260817-abcd-evil.html",
		[]byte("<html><body><script>alert(document.cookie)</script></body></html>"))

	req := httptest.NewRequest(http.MethodGet, "/img/qa/file-20260817-abcd-evil.html", nil)
	req.Header.Set(authHeader, "qa.tester")
	rec := httptest.NewRecorder()
	handleImage(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("the image route must only serve images: want 404, got %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); strings.Contains(ct, "html") {
		t.Errorf("Content-Type = %q must never be html here", ct)
	}
}

func TestImageRouteStillServesRealImages(t *testing.T) {
	withUserMap(t, "qa.tester=qauser\n")
	root := withStore(t)
	storeFile(t, root, "qauser", "qa", "pasted-20260817-abcd.png", realPNG(t))

	req := httptest.NewRequest(http.MethodGet, "/img/qa/pasted-20260817-abcd.png", nil)
	req.Header.Set(authHeader, "qa.tester")
	rec := httptest.NewRecorder()
	handleImage(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "image/") {
		t.Errorf("Content-Type = %q", ct)
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q, want nosniff", got)
	}
}

func TestImageUploadAlsoReportsStored(t *testing.T) {
	withUserMap(t, "qa.tester=qauser\n")
	withStore(t)

	rec := httptest.NewRecorder()
	handleUpload(rec, imageUpload(t, "qa", "shot.png", "image/png", realPNG(t)))
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", rec.Code, rec.Body.String())
	}
	got := decodeUpload(t, rec)
	if !got.Stored {
		t.Errorf("an image always reaches the store: want stored:true, got %+v", got)
	}
	if got.Path == "" {
		t.Error("path must keep its name and position for every existing reader")
	}
}
