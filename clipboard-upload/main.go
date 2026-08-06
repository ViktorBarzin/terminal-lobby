package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"terminal-lobby/telemetry"
)

const (
	fileDir   = "/tmp/clipboard-files"
	storeRoot = "/var/lib/clipboard-store"
	maxUpload = 100 << 20 // 100MB
	// maxRegister bounds files accepted via /register — big enough for any
	// real screenshot or photo, small enough that a stray path can't
	// balloon the store.
	maxRegister = 25 << 20 // 25MB
	listenAddr  = "0.0.0.0:7683"
	mapPath     = "/etc/ttyd-user-map"
	authHeader  = "X-Authentik-Username"
	// unsortedSession is the store bucket for writes that arrive without a
	// (valid) session name. Nothing ties its contents to a session's
	// lifetime, so the cleaner (devvm/clipboard-store-clean) ages it out on
	// a fixed clock instead.
	unsortedSession = "_unsorted"
)

// Session names: same charset as tmux-api and the frontend's NAME_RE.
var sessionNameRe = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,32}$`)

// Stored image names as accepted by /img: strictly a clean basename ('/'
// cannot match; '..' and leading dots are rejected separately in
// handleImage).
var imageNameRe = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

func main() {
	if err := os.MkdirAll(fileDir, 0755); err != nil {
		log.Fatalf("Failed to create upload dir %s: %v", fileDir, err)
	}
	// deploy.sh installs the store root with the right ownership; creating
	// it here too keeps a local `go run .` usable. A failure (unwritable
	// /var/lib on a dev box) only disables the store routes, so warn
	// instead of dying.
	if err := os.MkdirAll(storeRoot, 0755); err != nil {
		log.Printf("WARNING: cannot create store root %s (%v) — store writes will fail until it exists", storeRoot, err)
	}

	http.HandleFunc("/upload", handleUpload)
	http.HandleFunc("/telemetry", handleTelemetry)
	http.HandleFunc("/register", handleRegister)
	http.HandleFunc("/list", handleList)
	http.HandleFunc("/img/", handleImage)
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	})

	// CLIPBOARD_UPLOAD_ADDR: scratch-build override for the dev harness
	// (dev-harness.py --clipboard-port documents testing a local build,
	// which can't bind 7683 while the production service holds it).
	// The systemd unit sets no environment — production stays :7683.
	addr := listenAddr
	if a := os.Getenv("CLIPBOARD_UPLOAD_ADDR"); a != "" {
		addr = a
	}
	log.Printf("Clipboard upload service listening on %s (store=%s files=%s assets=%s)", addr, storeRoot, fileDir, assetDir())
	// The public-asset dispatcher rides ahead of the mux (see
	// withPublicAssets); every existing route falls through untouched.
	log.Fatal(http.ListenAndServe(addr, withPublicAssets(http.DefaultServeMux)))
}

// --- Static assets served by exact path --------------------------------------
//
// PWA install needs /manifest.webmanifest and the icons fetchable WITHOUT
// credentials (Android WebAPK / iOS icon fetchers run server-side and carry
// no session cookies), and the vendored webfonts are self-hosted same-origin.
// The ingress carves these EXACT paths out of Authentik and routes them to
// this service with the path unstripped, so they are served unauthenticated
// by design: fixed public files only (OFL fonts, manifest, icons), no user
// data, no directory serving.
//
// AUTH LIVES AT THE INGRESS, NOT HERE. This table decides WHICH file a path
// serves; Traefik decides WHO may ask. The PWA carve-out
// (module.ingress_assets*, auth = "none") lists exactly ten paths — the
// manifest, three icons, sw.js and five fonts — and every other route on
// both hosts, including Path(`/term.html`), keeps
// the authentik-forward-auth middleware. So a path in this table is not
// thereby public: /term.html is routed here by BOTH hosts' ingresses and stays
// gated, exactly as infra/stacks/terminal/{main,terminal-dev}.tf says. What
// the table does grant is a direct unauthenticated hit on :7683 from the box
// or the cluster network, which bypasses the ingress in the first place —
// acceptable for term.html on the same grounds as the other entries: a fixed
// file from the repo, byte-identical for every user, carrying no user data
// (the page fetches everything it shows through the authed APIs at runtime).

// defaultAssetDir is the deploy scripts' shared install target: manifest +
// icons sit next to index.html, the woff2 files under fonts/. deploy.sh puts
// everything here except term.html, which deploy-v2.sh installs alongside them
// (it is built from frontend-v2, not frontend).
const defaultAssetDir = "/usr/local/share/ttyd"

// publicAsset describes one servable file — every field fixed at compile time.
type publicAsset struct {
	file         string // path relative to assetDir()
	contentType  string
	cacheControl string
}

// publicAssets is the EXACT-path whitelist. A request path is only ever a
// KEY into this table — never joined into a filesystem path — so traversal
// is impossible by construction. A whitelisted path whose file isn't
// installed degrades to a clean 404 (how /icon-512-maskable.png rode the
// whitelist one task ahead of M.9 shipping the artwork).
// fonts/tl-symbols.woff2 is deliberately NOT listed: the page embeds it as a
// data: URI and never fetches it by URL. Icons + manifest may change with a
// deploy (1h cache); the fonts are versioned by content, not path (7d).
// sw.js (the push service worker) is served no-cache: the browser re-fetches
// the worker bytes on every update check, so a deploy must never be masked
// by a cached copy.
// /term.html gets the SAME no-cache treatment for the same reason, one level
// up: it is the terminal-mode page the v2 SPA frames (config.TERMINAL_BASE),
// it is redeployed by scripts/deploy-v2.sh, and it carries the zero-touch
// self-update healer — a browser holding a cached copy would pin a stale
// terminal that can never notice its own replacement. no-cache is revalidate,
// not re-download: ServeContent answers a conditional request with 304 while
// the file is untouched (deploy-v2.sh skips byte-identical installs precisely
// to keep that mtime stable), so the ~800 KB body only crosses the wire when
// it actually changed.
var publicAssets = map[string]publicAsset{
	"/manifest.webmanifest":  {"manifest.webmanifest", "application/manifest+json", "public,max-age=3600"},
	"/icon-192.png":          {"icon-192.png", "image/png", "public,max-age=3600"},
	"/icon-512.png":          {"icon-512.png", "image/png", "public,max-age=3600"},
	"/icon-512-maskable.png": {"icon-512-maskable.png", "image/png", "public,max-age=3600"},
	"/sw.js":                 {"sw.js", "application/javascript", "no-cache"},
	"/term.html":             {"term.html", "text/html; charset=utf-8", "no-cache"},

	"/fonts/JetBrainsMono-Regular.woff2":     {"fonts/JetBrainsMono-Regular.woff2", "font/woff2", "public,max-age=604800"},
	"/fonts/JetBrainsMono-Bold.woff2":        {"fonts/JetBrainsMono-Bold.woff2", "font/woff2", "public,max-age=604800"},
	"/fonts/JetBrainsMono-Italic.woff2":      {"fonts/JetBrainsMono-Italic.woff2", "font/woff2", "public,max-age=604800"},
	"/fonts/JetBrainsMono-BoldItalic.woff2":  {"fonts/JetBrainsMono-BoldItalic.woff2", "font/woff2", "public,max-age=604800"},
	"/fonts/dm-sans-latin-wght-normal.woff2": {"fonts/dm-sans-latin-wght-normal.woff2", "font/woff2", "public,max-age=604800"},
}

// assetDir resolves the on-disk root the whitelist reads from.
// CLIPBOARD_UPLOAD_ASSET_DIR: scratch-build override for the dev harness and
// tests (point it at the repo's frontend/ — same layout). The systemd unit
// sets no environment — production stays /usr/local/share/ttyd.
func assetDir() string {
	if d := os.Getenv("CLIPBOARD_UPLOAD_ASSET_DIR"); d != "" {
		return d
	}
	return defaultAssetDir
}

// withPublicAssets routes the public-asset namespace ahead of the mux: the
// whitelisted paths AND every near-miss inside the namespace (traversal
// shapes like "/icon-../…" or "/fonts/../../…") reach handleAsset and get
// its clean 404, instead of ServeMux's canonicalize-and-301 bounce.
// Everything else falls through to next untouched.
func withPublicAssets(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if _, listed := publicAssets[p]; listed ||
			strings.HasPrefix(p, "/fonts/") ||
			strings.HasPrefix(p, "/icon-") ||
			strings.HasPrefix(p, "/manifest.") {
			handleAsset(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// handleAsset serves one whitelisted public file. GET/HEAD only (the infra
// acceptance checks and the walloff probe use HEAD `curl -sI`); no auth —
// these files carry no user data. Anything not in the table 404s, as does a
// whitelisted path whose file isn't installed (yet).
func handleAsset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	spec, ok := publicAssets[r.URL.Path]
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	f, err := os.Open(filepath.Join(assetDir(), spec.file))
	if err != nil {
		// ErrNotExist is expected for whitelisted-but-not-installed
		// files (a fresh host before deploy.sh copies them); anything
		// else is a deploy gap worth a log line.
		if !errors.Is(err, os.ErrNotExist) {
			log.Printf("asset open %s failed: %v", spec.file, err)
		}
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	// Content-Type is fixed by the table; setting it here keeps
	// ServeContent from sniffing. ServeContent supplies Last-Modified,
	// conditional-request and HEAD handling.
	w.Header().Set("Content-Type", spec.contentType)
	w.Header().Set("Cache-Control", spec.cacheControl)
	http.ServeContent(w, r, "", info.ModTime(), f)
}

// loadUserMap reads /etc/ttyd-user-map → map[authentik_local]os_user.
// Format: "<auth>=<os_user>[:<cwd>]" per line. Comments (#) and blanks
// ignored. Re-read on every request — file is small and changes are rare.
// (Mirrors tmux-api/main.go.)
func loadUserMap() map[string]string {
	m := map[string]string{}
	f, err := os.Open(mapPath)
	if err != nil {
		log.Printf("loadUserMap: %v", err)
		return m
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq <= 0 {
			continue
		}
		auth := strings.TrimSpace(line[:eq])
		rhs := strings.TrimSpace(line[eq+1:])
		if c := strings.IndexByte(rhs, ':'); c > 0 {
			rhs = rhs[:c]
		}
		if auth != "" && rhs != "" {
			m[auth] = rhs
		}
	}
	return m
}

// resolveOSUser → mapped OS user from the Authentik header, or "" after
// writing the appropriate 401/403 to w. The store is keyed per OS user, so
// an unauthenticated request has no directory to touch. (Mirrors
// tmux-api/main.go minus the user.Lookup — this service never execs as the
// user, it only needs a directory name.)
func resolveOSUser(w http.ResponseWriter, r *http.Request) string {
	authUser := r.Header.Get(authHeader)
	if authUser == "" {
		log.Printf("auth: missing %s header (%s %s)", authHeader, r.Method, r.URL.Path)
		http.Error(w, "missing "+authHeader, http.StatusUnauthorized)
		return ""
	}
	local := authUser
	if i := strings.IndexByte(local, '@'); i > 0 {
		local = local[:i]
	}
	osUser := loadUserMap()[local]
	if osUser == "" {
		log.Printf("auth: no terminal account for %q (local=%q, %s %s)", authUser, local, r.Method, r.URL.Path)
		http.Error(w, fmt.Sprintf("no terminal account for '%s'", authUser), http.StatusForbidden)
		return ""
	}
	return osUser
}

// osUserKnown reports whether name is a mapped OS user (a right-hand side
// in /etc/ttyd-user-map). /register's localhost callers self-report their
// user; only real terminal accounts are accepted.
func osUserKnown(name string) bool {
	if name == "" {
		return false
	}
	for _, osUser := range loadUserMap() {
		if osUser == name {
			return true
		}
	}
	return false
}

// storeSession maps a client-supplied session name onto a store bucket:
// valid names key their own directory, everything else (absent, oversize,
// bad charset) collapses to the shared "_unsorted" bucket.
func storeSession(name string) string {
	if sessionNameRe.MatchString(name) {
		return name
	}
	return unsortedSession
}

// handleUpload accepts a multipart POST with EITHER a generic "file" field
// (drag-dropped files of any type — transfer conveniences saved under
// fileDir keeping the original name, NOT gallery content) OR an "image"
// field (clipboard image paste/upload, must be image/*, persisted into the
// caller's per-session store for the gallery; optional "session" field
// picks the bucket). Responds {"path": "..."} — the frontend types that
// path into the PTY, so the shape is load-bearing.
func handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxUpload)
	// Keep a modest amount in memory; larger parts spill to temp files on disk.
	if err := r.ParseMultipartForm(16 << 20); err != nil {
		http.Error(w, "File too large (max 100MB)", http.StatusRequestEntityTooLarge)
		return
	}

	// Generic dropped file — any content type, keep the (sanitized) original name.
	if file, header, err := r.FormFile("file"); err == nil {
		defer file.Close()
		name := fmt.Sprintf("%s-%s-%s", stamp(), randToken(), sanitizeName(header.Filename))
		path, err := save(fileDir, name, file)
		if err != nil {
			http.Error(w, "Failed to save", http.StatusInternalServerError)
			return
		}
		log.Printf("Saved dropped file: %s (%d bytes)", path, header.Size)
		events.Emit("file.transferred", osUserQuiet(r), telemetry.Attrs{
			"tl.count": header.Size, "tl.client": "api",
		})
		writePath(w, path)
		return
	}

	// Clipboard image — must be image/*, lands in the per-(user, session)
	// store so the gallery can list and re-serve it.
	file, header, err := r.FormFile("image")
	if err != nil {
		http.Error(w, "Missing 'file' or 'image' field", http.StatusBadRequest)
		return
	}
	defer file.Close()

	// A store write needs an owner: the Authentik header is mandatory here
	// (the ingress always adds it; 401 covers direct unauthenticated hits).
	osUser := resolveOSUser(w, r)
	if osUser == "" {
		return
	}

	ct := header.Header.Get("Content-Type")
	if !strings.HasPrefix(ct, "image/") {
		http.Error(w, "Not an image", http.StatusBadRequest)
		return
	}
	session := storeSession(r.FormValue("session"))
	name := fmt.Sprintf("pasted-%s-%s%s", stamp(), randToken(), imageExt(ct))
	path, err := saveToStore(osUser, session, name, file)
	if err != nil {
		log.Printf("save pasted image for %s/%s failed: %v", osUser, session, err)
		http.Error(w, "Failed to save", http.StatusInternalServerError)
		return
	}
	log.Printf("Saved clipboard image: %s (%s, %d bytes)", path, ct, header.Size)
	events.Emit("image.uploaded", osUser, telemetry.Attrs{
		"tl.session": session, "tl.kind": ct, "tl.count": header.Size, "tl.client": "api",
	})
	writePath(w, path)
}

// handleRegister (POST /register, fields user/session/path) records an
// image that show-image just rendered so the gallery can re-serve it. The
// call arrives via localhost from the user's own shell, so there is
// normally no forward-auth header to lean on: the caller self-reports its
// OS user, which must be mapped in /etc/ttyd-user-map. When the header IS
// present (a request that rode the ingress after all), the mapped header
// identity wins and the user field is ignored. The path must name an
// absolute, existing, regular image file ≤ 25MB; paths already inside the
// store are answered as-is (no duplicate copy), anything else is copied to
// store/<user>/<session>/displayed-<timestamp>-<basename>. Responds
// {"path": "..."} like /upload.
func handleRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	// Fields only — the image itself never rides this request.
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := r.ParseMultipartForm(64 << 10); err != nil && !errors.Is(err, http.ErrNotMultipart) {
		http.Error(w, "invalid form", http.StatusBadRequest)
		return
	}

	var osUser string
	if r.Header.Get(authHeader) != "" {
		osUser = resolveOSUser(w, r)
		if osUser == "" {
			return
		}
	} else {
		osUser = r.FormValue("user")
		if !osUserKnown(osUser) {
			log.Printf("register: unknown user %q", osUser)
			http.Error(w, "unknown user", http.StatusForbidden)
			return
		}
	}
	session := storeSession(r.FormValue("session"))

	src := filepath.Clean(r.FormValue("path"))
	if !filepath.IsAbs(src) {
		http.Error(w, "path must be absolute", http.StatusBadRequest)
		return
	}
	info, err := os.Stat(src)
	if err != nil || !info.Mode().IsRegular() {
		http.Error(w, "not an existing regular file", http.StatusBadRequest)
		return
	}
	if info.Size() > maxRegister {
		http.Error(w, "file too large (max 25MB)", http.StatusRequestEntityTooLarge)
		return
	}
	f, err := os.Open(src)
	if err != nil {
		http.Error(w, "cannot read file", http.StatusBadRequest)
		return
	}
	defer f.Close()
	if !isImage(f, src) {
		http.Error(w, "not an image", http.StatusBadRequest)
		return
	}

	// Already persisted (e.g. show-image on a previously pasted file) —
	// nothing to copy, answer with the path unchanged.
	if strings.HasPrefix(src, storeRoot+string(os.PathSeparator)) {
		events.Emit("image.shown", osUser, telemetry.Attrs{
			"tl.session": session, "tl.kind": "in-store", "tl.client": "api",
		})
		writePath(w, src)
		return
	}

	if _, err := f.Seek(0, io.SeekStart); err != nil {
		log.Printf("register: rewind %s failed: %v", src, err)
		http.Error(w, "Failed to save", http.StatusInternalServerError)
		return
	}
	name := fmt.Sprintf("displayed-%s-%s", stamp(), sanitizeName(filepath.Base(src)))
	path, err := saveToStore(osUser, session, name, f)
	if err != nil {
		log.Printf("register %s for %s/%s failed: %v", src, osUser, session, err)
		http.Error(w, "Failed to save", http.StatusInternalServerError)
		return
	}
	log.Printf("Registered displayed image: %s -> %s (%d bytes)", src, path, info.Size())
	events.Emit("image.shown", osUser, telemetry.Attrs{
		"tl.session": session, "tl.kind": "copied", "tl.client": "api",
	})
	writePath(w, path)
}

// isImage sniffs the first 512 bytes (http.DetectContentType) and falls
// back to the filename extension — covering formats the sniffer doesn't
// know (e.g. SVG). The reader is left mid-file; callers rewind before
// copying.
func isImage(f *os.File, path string) bool {
	head := make([]byte, 512)
	n, err := f.Read(head)
	if err != nil && !errors.Is(err, io.EOF) {
		return false
	}
	if strings.HasPrefix(http.DetectContentType(head[:n]), "image/") {
		return true
	}
	return strings.HasPrefix(mime.TypeByExtension(filepath.Ext(path)), "image/")
}

// storedImage is one /list entry. Kind derives from the filename prefix the
// store writes ("pasted-" / "displayed-"); legacy names count as pasted.
type storedImage struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"`
	Kind  string `json:"kind"`
}

// handleList (GET /list?session=<name>) returns the caller's stored images
// for one session, newest first. Header required — resolving it is the
// per-user isolation boundary.
func handleList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	osUser := resolveOSUser(w, r)
	if osUser == "" {
		return
	}
	session := r.URL.Query().Get("session")
	if !sessionNameRe.MatchString(session) {
		http.Error(w, "invalid session", http.StatusBadRequest)
		return
	}

	entries, err := os.ReadDir(filepath.Join(storeRoot, osUser, session))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("list %s/%s failed: %v", osUser, session, err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	images := make([]storedImage, 0, len(entries))
	for _, e := range entries {
		// Skip subdirectories and dotfiles (the cleaner's .deleted-at marker).
		if !e.Type().IsRegular() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		kind := "pasted"
		if strings.HasPrefix(e.Name(), "displayed-") {
			kind = "displayed"
		}
		images = append(images, storedImage{
			Name:  e.Name(),
			Path:  filepath.Join(storeRoot, osUser, session, e.Name()),
			Size:  info.Size(),
			Mtime: info.ModTime().Unix(),
			Kind:  kind,
		})
	}
	sort.Slice(images, func(i, j int) bool { return images[i].Mtime > images[j].Mtime })

	// no-store: the gallery re-fetches on every open and must see new
	// pastes immediately.
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	events.Emit("gallery.opened", osUser, telemetry.Attrs{
		"tl.session": session, "tl.count": len(images), "tl.client": "api",
	})
	json.NewEncoder(w).Encode(images)
}

// handleImage (GET /img/<session>/<name>) serves one stored image back to
// the gallery. Traversal-proof by construction: both path elements are
// charset-pinned (no separator can pass), names containing '..' or leading
// dots are rejected, and the joined path is re-checked to sit inside the
// caller's own store directory.
func handleImage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	osUser := resolveOSUser(w, r)
	if osUser == "" {
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/img/"), "/")
	if len(parts) != 2 {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	session, name := parts[0], parts[1]
	if !sessionNameRe.MatchString(session) {
		http.Error(w, "invalid session", http.StatusBadRequest)
		return
	}
	if !imageNameRe.MatchString(name) || strings.Contains(name, "..") ||
		strings.HasPrefix(name, ".") || name != filepath.Base(name) {
		http.Error(w, "invalid name", http.StatusBadRequest)
		return
	}
	userDir := filepath.Join(storeRoot, osUser)
	path := filepath.Join(userDir, session, name)
	if !strings.HasPrefix(path, userDir+string(os.PathSeparator)) {
		http.Error(w, "invalid path", http.StatusBadRequest)
		return
	}

	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		log.Printf("img open %s failed: %v", path, err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	// Sniff the real content type — stored extensions are advisory.
	head := make([]byte, 512)
	n, err := f.Read(head)
	if err != nil && !errors.Is(err, io.EOF) {
		log.Printf("img read %s failed: %v", path, err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		log.Printf("img rewind %s failed: %v", path, err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", http.DetectContentType(head[:n]))
	// private: per-user content behind auth. An hour of browser caching
	// keeps gallery re-opens cheap without letting shared caches hold it.
	w.Header().Set("Cache-Control", "private, max-age=3600")
	http.ServeContent(w, r, "", info.ModTime(), f)
}

// saveToStore writes src into the per-(user, session) store directory,
// creating it as needed, and returns the absolute path.
func saveToStore(osUser, session, name string, src io.Reader) (string, error) {
	dir := filepath.Join(storeRoot, osUser, session)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", err
	}
	return save(dir, name, src)
}

func save(dir, name string, src io.Reader) (string, error) {
	dest := filepath.Join(dir, name)
	f, err := os.Create(dest)
	if err != nil {
		return "", err
	}
	defer f.Close()
	if _, err := io.Copy(f, src); err != nil {
		os.Remove(dest)
		return "", err
	}
	return dest, nil
}

// sanitizeName reduces an uploaded filename to a safe basename: directory
// components stripped (handling both / and \ separators), only [A-Za-z0-9._-]
// kept (others -> '_'), leading dots removed (no hidden files), length bounded.
// Falls back to "file".
func sanitizeName(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '.', r == '_', r == '-':
			return r
		default:
			return '_'
		}
	}, name)
	name = strings.TrimLeft(name, ".")
	if len(name) > 128 {
		name = name[len(name)-128:]
	}
	if name == "" {
		name = "file"
	}
	return name
}

func imageExt(ct string) string {
	switch ct {
	case "image/jpeg":
		return ".jpg"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	default:
		return ".png"
	}
}

func stamp() string { return time.Now().Format("20060102-150405") }

func randToken() string {
	b := make([]byte, 4)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func writePath(w http.ResponseWriter, path string) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"path": path})
}

// handleTelemetry ingests selection-diagnostics events from the terminal
// page (default-on; ?seldebug=0 opts a tab out). Events are appended as
// JSONL under _telemetry/<osUser>.jsonl for on-host analysis — this is
// what lets a selection bug on a user's physical trackpad be diagnosed
// from the devvm. Body is capped and the file size-guarded.
func handleTelemetry(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	osUser := resolveOSUser(w, r)
	if osUser == "" {
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 64*1024))
	if err != nil || len(body) == 0 {
		http.Error(w, "empty body", http.StatusBadRequest)
		return
	}
	if !json.Valid(body) {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	dir := filepath.Join(storeRoot, "_telemetry")
	if err := os.MkdirAll(dir, 0755); err != nil {
		http.Error(w, "store unavailable", http.StatusInternalServerError)
		return
	}
	path := filepath.Join(dir, osUser+".jsonl")
	if st, err := os.Stat(path); err == nil && st.Size() > 50*1024*1024 {
		os.Rename(path, path+".1") // simple single-slot rotation
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		http.Error(w, "store unavailable", http.StatusInternalServerError)
		return
	}
	defer f.Close()
	line, _ := json.Marshal(map[string]any{
		"at":   time.Now().UTC().Format(time.RFC3339Nano),
		"user": osUser,
		"ev":   json.RawMessage(body),
	})
	f.Write(append(line, '\n'))
	w.WriteHeader(http.StatusNoContent)
}
