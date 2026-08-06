package main

import (
	"bytes"
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
