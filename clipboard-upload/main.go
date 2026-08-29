package main

import (
	"bufio"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"terminal-lobby/authuser"
	"terminal-lobby/telemetry"
)

// fileDir is where an over-cap document stays as a 7-day ephemeral transfer.
// A var, not a const, for the same reason storeRoot is one: a test that writes
// here must be able to point it at its own directory. Left as a const, the
// suite passed only because the running service had already created the real
// path, so it failed on any machine where the service had never run.
var fileDir = "/tmp/clipboard-files"

const (
	maxUpload = 100 << 20 // 100MB
	// maxRegister bounds files accepted via /register — big enough for any
	// real screenshot or photo, small enough that a stray path can't
	// balloon the store.
	maxRegister = 25 << 20 // 25MB
	// attachPrefix marks a stored non-image attachment. The gallery lists by
	// prefix, so this is what keeps a document out of a grid of thumbnails.
	attachPrefix = "file-"
	listenAddr   = "0.0.0.0:7683"
	authHeader   = "X-Authentik-Username"
	// unsortedSession is the store bucket for writes that arrive without a
	// (valid) session name. Nothing ties its contents to a session's
	// lifetime, so the cleaner (devvm/clipboard-store-clean) ages it out on
	// a fixed clock instead.
	unsortedSession = "_unsorted"
)

// storeRoot is the per-(user, session) image store; mapPath is the
// Authentik→OS-user map resolveOSUser reads. Vars (not consts) purely as test
// seams — the upload tests point them at temp fixtures so the real
// header→user→store path runs hermetically, without reading /etc or writing
// next to a user's real screenshots. Same seam tmux-api/main.go uses for its
// own mapPath. Production never reassigns them.
var (
	storeRoot = "/var/lib/clipboard-store"
	mapPath   = "/etc/ttyd-user-map"
	// maxAttach bounds a non-image upload that joins the per-(user, session)
	// store as a text-view attachment. Same number as maxRegister and for the
	// same reason: ADR-0005 names those caps as what bounds a store whose
	// contents are held for 30 days after a session dies, and a document is not
	// a reason to loosen that. Above it the upload stays what this field has
	// always produced — a /tmp transfer on the 7-day sweep.
	//
	// A var for the same test-seam reason as storeRoot: exercising the fork
	// otherwise means pushing 25MB through a multipart encoder on every run.
	// Production never reassigns it.
	maxAttach int64 = 25 << 20 // 25MB
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
	http.HandleFunc("/register", handleRegister)
	http.HandleFunc("/list", handleList)
	http.HandleFunc("/img/", handleImage)
	http.HandleFunc("/file/", handleStoredFile)
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
	go timing.Run(nil)
	log.Fatal(http.ListenAndServe(addr, timing.Wrap(withPublicAssets(http.DefaultServeMux))))
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
// gated, exactly as infra/stacks/terminal/main.tf says. What
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
	// The lobby's build stamp, on its own so the self-update check costs ~12
	// bytes instead of the whole page. It used to read the stamp out of a full
	// GET of "/" every 5s: measured 1,430,075-1,430,242 B per fetch, and on
	// iOS Safari 1,279 full bodies to 2 revalidations in 24h = 1.83 GB/day
	// from one phone, which is 5.7x the whole downlink of a 400kbps link.
	"/build-id": {"build-id", "text/plain; charset=utf-8", "no-cache"},
	// term.html's own stamp. Same reasoning, different fingerprint: the framed
	// page checks itself on every reconnect, which measured 502,720 B against
	// 300 B for the same 12 hex characters.
	"/term-build-id": {"term-build-id", "text/plain; charset=utf-8", "no-cache"},

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
		if strings.HasPrefix(p, hashedAssetPrefix) {
			handleHashedAsset(w, r)
			return
		}
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

// hashedAssetPrefix is where the lobby's content-hashed build output lives:
// the SPA's JS/CSS chunks and an immutable copy of the terminal page. Routed
// here by the terminal stack's IngressRoute.
const hashedAssetPrefix = "/assets/"

// hashedAssetName is what a name under /assets/ may look like: ONE flat segment
// of the characters a bundler emits. No separators and no dots-only names, so
// there is nothing to traverse with -- the whole point of validating rather
// than cleaning is that a rejected name never reaches the filesystem.
var hashedAssetName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

// hashedAssetTypes maps the extensions a build emits to their content type.
// Fixed table rather than mime.TypeByExtension: sniffing an attacker-chosen
// name into an active type is the one thing this must not do.
var hashedAssetTypes = map[string]string{
	".js":    "application/javascript; charset=utf-8",
	".mjs":   "application/javascript; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".html":  "text/html; charset=utf-8",
	".json":  "application/json",
	".woff2": "font/woff2",
	".svg":   "image/svg+xml",
	".png":   "image/png",
	".wasm":  "application/wasm",
}

// handleHashedAsset serves one file out of assetDir()/assets.
//
// Every name here is content-hashed by the build, which is what lets the answer
// be `immutable`: the bytes for a given name never change, so a client never
// revalidates and a deploy changes the NAME instead of invalidating a path. That
// is the difference between the terminal page costing a conditional round trip
// per attach (and ~474 KB after every deploy, measured on a real device) and
// costing nothing at all.
func handleHashedAsset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	name := strings.TrimPrefix(r.URL.Path, hashedAssetPrefix)
	if !hashedAssetName.MatchString(name) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	ctype, ok := hashedAssetTypes[strings.ToLower(filepath.Ext(name))]
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	f, err := os.Open(filepath.Join(assetDir(), "assets", name))
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			log.Printf("hashed asset open %s failed: %v", name, err)
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
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	http.ServeContent(w, r, "", info.ModTime(), f)
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

// actAsGate decides whether a ?as= request may proceed. A var only as a test
// seam (actas_test.go points it at a fixture admin list); production never
// reassigns it. Shared with tmux-api and file-api so the admin check has
// exactly one implementation.
var actAsGate = authuser.Default

// resolveOSUser → the OS user this request ACTS AS: normally the caller from
// the Authentik header, or an act-as target when an administrator asked for one
// and is entitled to it. Returns "" after writing the appropriate 401/403.
//
// The gallery is keyed per (OS user, session) under a service-owned store, so
// acting as someone reads and writes their directory directly — no privilege
// drop is involved here, unlike file-api's home-directory access.
func resolveOSUser(w http.ResponseWriter, r *http.Request) string {
	real := resolveRealOSUser(w, r)
	if real == "" {
		return ""
	}
	eff, err := actAsGate.Effective(real, r.URL.Query().Get("as"), osUserKnown)
	if err != nil {
		log.Printf("act-as refused: %s -> %q: %v (%s %s)",
			real, r.URL.Query().Get("as"), err, r.Method, r.URL.Path)
		http.Error(w, "not permitted to act as that user", http.StatusForbidden)
		return ""
	}
	return eff
}

// resolveRealOSUser → the CALLER's own mapped OS user from the Authentik
// header, ignoring ?as=. The store is keyed per OS user, so an unauthenticated
// request has no directory to touch. (Mirrors tmux-api/main.go minus the
// user.Lookup — this service never execs as the user, it only needs a
// directory name.)
func resolveRealOSUser(w http.ResponseWriter, r *http.Request) string {
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

// galleryPrefixes are the stored-name prefixes the 🖼 gallery lists: a
// clipboard paste/upload, and a `show-image` render registered by the script
// itself. Everything else in a store directory — today, a document attached to
// a text-view message — is chat content, reachable by its own path and never
// drawn as a thumbnail.
var galleryPrefixes = []string{"pasted-", "displayed-"}

// isGalleryName reports whether a stored file belongs in the gallery listing.
func isGalleryName(name string) bool {
	for _, p := range galleryPrefixes {
		if strings.HasPrefix(name, p) {
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
// (any content type — a document attached to a text-view message, or a plain
// transfer convenience) OR an "image" field (clipboard image paste/upload,
// must be image/*; optional "session" field picks the bucket).
//
// Responds {"path": "...", "stored": bool}. `path` is load-bearing — the
// frontend types it into the PTY, and splices it into a text-view prompt.
// `stored` says whether the bytes landed in the per-(user, session) store,
// which is the only place the chat can read them back from: a path alone
// cannot answer that, and the client needs the answer to decide between a
// clickable chip and a "path only" toast.
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

	// Generic file — any content type, keeping the (sanitized) original name.
	//
	// Two destinations, forked on size (design decision 11). Up to maxAttach it
	// joins the per-(user, session) store beside the images, so a text-view
	// message can render a chip for it and still open it days later; the store's
	// 30-day grace and the gallery's isolation come along unchanged. Anything
	// larger keeps the behaviour this field has always had — an ephemeral
	// /tmp transfer on the 7-day sweep — because the store's bound is the point
	// of the cap, and a chat bubble outlives any file that expires.
	if file, header, err := r.FormFile("file"); err == nil {
		defer file.Close()
		// A store write needs an owner, so identity is mandatory on this branch
		// too now. It always was on the image branch; the ingress adds the
		// header either way, and 401 covers a direct unauthenticated hit.
		osUser := resolveOSUser(w, r)
		if osUser == "" {
			return
		}
		clean := sanitizeName(header.Filename)
		if header.Size <= maxAttach {
			session := storeSession(r.FormValue("session"))
			name := fmt.Sprintf("%s%s-%s-%s", attachPrefix, stamp(), randToken(), clean)
			path, err := saveToStore(osUser, session, name, file)
			if err != nil {
				log.Printf("save attachment for %s/%s failed: %v", osUser, session, err)
				http.Error(w, "Failed to save", http.StatusInternalServerError)
				return
			}
			log.Printf("Saved attachment: %s (%d bytes)", path, header.Size)
			events.Emit("file.attached", osUser, telemetry.Attrs{
				"tl.session": session, "tl.count": header.Size, "tl.client": "api",
			})
			writeUpload(w, path, true)
			return
		}
		name := fmt.Sprintf("%s-%s-%s", stamp(), randToken(), clean)
		path, err := save(fileDir, name, file)
		if err != nil {
			http.Error(w, "Failed to save", http.StatusInternalServerError)
			return
		}
		log.Printf("Saved dropped file: %s (%d bytes)", path, header.Size)
		events.Emit("file.transferred", osUser, telemetry.Attrs{
			"tl.count": header.Size, "tl.client": "api",
		})
		writeUpload(w, path, false)
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
	// ...and the label alone is not evidence: the browser derives it from the
	// filename, and any client can set it outright. Trusting it let 39 bytes of
	// plain text named .png into the store, where the gallery drew it as a dead
	// thumbnail with no way to remove it. Check the bytes before writing.
	sniffed, err := sniffContentType(file)
	if err != nil {
		log.Printf("sniff pasted image for %s failed: %v", osUser, err)
		http.Error(w, "Failed to read upload", http.StatusInternalServerError)
		return
	}
	if !strings.HasPrefix(sniffed, "image/") {
		http.Error(w, fmt.Sprintf("Not an image: the file says %s but its content is %s", ct, sniffed),
			http.StatusBadRequest)
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
	// An image always reaches the store — that is the whole image branch — so
	// `stored` is unconditionally true here. Reported anyway, so one reply shape
	// answers the client's question regardless of which field it uploaded.
	writeUpload(w, path, true)
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

// sniffContentType reports what the first 512 bytes of an upload actually
// are, per http.DetectContentType, and rewinds so the caller can still copy
// the whole part. /upload's image branch gates the store write on this.
//
// No filename-extension fallback, deliberately — unlike isImage below. The
// extension is client-supplied exactly like the Content-Type header, so
// honouring it would wave the same mislabelled bytes straight back in. The one
// format that costs is SVG, which sniffs as text/xml: it could never render in
// the gallery anyway (imageExt has no svg case, so it is stored as .png, and
// /img re-sniffs on serve and hands the <img> tag text/xml).
//
// This answers "are these bytes an image", NOT "does this image decode". A
// truncated PNG keeps its magic bytes and passes; image.DecodeConfig would
// pass it too (the IHDR is complete by byte 33) while rejecting webp and avif
// that browsers render fine. Files that pass here and still fail to paint are
// handled by the gallery's onError fallback in
// frontend-v2/src/components/Gallery.tsx.
//
// DetectContentType's table is also incomplete — it knows png/jpeg/gif/webp/
// bmp/ico and nothing else — so the ISO-BMFF image brands are recognised
// separately by isoBMFFImageType. Without that, a real AVIF sniffs as
// application/octet-stream and this gate refuses a format every current
// browser decodes.
func sniffContentType(f multipart.File) (string, error) {
	head := make([]byte, 512)
	n, err := f.Read(head)
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	head = head[:n]
	if ct := http.DetectContentType(head); strings.HasPrefix(ct, "image/") {
		return ct, nil
	}
	if ct := isoBMFFImageType(head); ct != "" {
		return ct, nil
	}
	return http.DetectContentType(head), nil
}

// isoBMFFImageBrands are the ISO base media file brands that mean "this is a
// still image" — the AV1 (AVIF) and HEVC/HEIF families. Deliberately a closed
// list rather than "any ftyp": the same container carries mp4 video, which is
// not a gallery image.
var isoBMFFImageBrands = map[string]bool{
	"avif": true, "avis": true, // AV1 still image / image sequence
	"heic": true, "heix": true, "heim": true, "heis": true, // HEVC still
	"hevc": true, "hevx": true, "hevm": true, "hevs": true, // HEVC sequence
	"mif1": true, "msf1": true, // generic HEIF still / sequence
}

// isoBMFFImageType reports the content type of an ISO base media file whose
// major or compatible brands name a still-image format, or "" for anything
// else. Layout: [4-byte box size]["ftyp"][major brand][minor version][compat
// brands…], all brands four bytes.
//
// This exists because http.DetectContentType predates AVIF/HEIF and returns
// application/octet-stream for both. Measured 2026-08-06: a 24x24 AVIF served
// with that very content type still renders in chromium (naturalWidth 24) —
// browsers decode images by content, not by the declared type — so refusing
// the upload would break a format that works today. Dragging a downloaded
// .avif into the terminal sets File.type "image/avif", which
// frontend-v2/src/clipboard/upload.ts routes to the store branch.
//
// HEIF rides along on the same container check. Chromium does not decode it,
// so such a tile falls to the gallery's onError placeholder — degraded, which
// is what the client half is for, rather than refused.
func isoBMFFImageType(head []byte) string {
	if len(head) < 12 || string(head[4:8]) != "ftyp" {
		return ""
	}
	// The box size bounds the brand list; clamp to what was actually read.
	end := int(binary.BigEndian.Uint32(head[0:4]))
	if end > len(head) || end <= 0 {
		end = len(head)
	}
	brands := []string{string(head[8:12])} // major brand
	for i := 16; i+4 <= end; i += 4 {      // compatible brands
		brands = append(brands, string(head[i:i+4]))
	}
	for _, b := range brands {
		if isoBMFFImageBrands[b] {
			if strings.HasPrefix(b, "avi") {
				return "image/avif"
			}
			return "image/heif"
		}
	}
	return ""
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
		// The gallery is a grid of thumbnails, and the store now also holds
		// documents (design decision 3). Listing by the two prefixes the gallery
		// itself writes is what keeps a PDF from becoming an undecodable tile —
		// the same failure the upload path's byte-sniffing was added to prevent.
		// An allow-list rather than a `file-` deny-list, so a future writer with
		// a new prefix has to opt in instead of leaking by default.
		if !isGalleryName(e.Name()) {
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

// openStored resolves <prefix>/<session>/<name> to an open file inside the
// CALLER's own store directory, writing the HTTP error itself and returning nil
// when it cannot. Traversal-proof by construction: both path elements are
// charset-pinned (no separator can pass), names containing '..' or leading dots
// are rejected, and the joined path is re-checked to sit under the caller's own
// directory. Shared by /img and /file so the two read surfaces cannot drift
// apart on the part that enforces isolation.
//
// The caller closes the returned file. `head` is the first 512 bytes for
// sniffing, with the file already rewound.
func openStored(w http.ResponseWriter, r *http.Request, prefix, logTag string) (*os.File, os.FileInfo, []byte) {
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return nil, nil, nil
	}
	osUser := resolveOSUser(w, r)
	if osUser == "" {
		return nil, nil, nil
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, prefix), "/")
	if len(parts) != 2 {
		http.Error(w, "not found", http.StatusNotFound)
		return nil, nil, nil
	}
	session, name := parts[0], parts[1]
	if !sessionNameRe.MatchString(session) {
		http.Error(w, "invalid session", http.StatusBadRequest)
		return nil, nil, nil
	}
	if !imageNameRe.MatchString(name) || strings.Contains(name, "..") ||
		strings.HasPrefix(name, ".") || name != filepath.Base(name) {
		http.Error(w, "invalid name", http.StatusBadRequest)
		return nil, nil, nil
	}
	userDir := filepath.Join(storeRoot, osUser)
	path := filepath.Join(userDir, session, name)
	if !strings.HasPrefix(path, userDir+string(os.PathSeparator)) {
		http.Error(w, "invalid path", http.StatusBadRequest)
		return nil, nil, nil
	}

	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		http.Error(w, "not found", http.StatusNotFound)
		return nil, nil, nil
	}
	if err != nil {
		log.Printf("%s open %s failed: %v", logTag, path, err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return nil, nil, nil
	}
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		f.Close()
		http.Error(w, "not found", http.StatusNotFound)
		return nil, nil, nil
	}

	// Sniff the real content type — stored extensions are advisory.
	head := make([]byte, 512)
	n, err := f.Read(head)
	if err != nil && !errors.Is(err, io.EOF) {
		f.Close()
		log.Printf("%s read %s failed: %v", logTag, path, err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return nil, nil, nil
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		f.Close()
		log.Printf("%s rewind %s failed: %v", logTag, path, err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return nil, nil, nil
	}
	return f, info, head[:n]
}

// handleImage (GET /img/<session>/<name>) serves one stored image back to the
// gallery, the lightbox and a text-view bubble.
//
// IMAGES ONLY, verified from the bytes. The store holds documents as well now
// (design decision 3), and this route answers with whatever it sniffs — so an
// uploaded .html fetched through here would have executed against the authed
// lobby origin. Non-image content is answered 404 rather than 415: from the
// gallery's point of view there is no image at that name.
func handleImage(w http.ResponseWriter, r *http.Request) {
	f, info, head := openStored(w, r, "/img/", "img")
	if f == nil {
		return
	}
	defer f.Close()

	ct := http.DetectContentType(head)
	if !strings.HasPrefix(ct, "image/") {
		if iso := isoBMFFImageType(head); iso != "" {
			ct = iso
		} else {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// private: per-user content behind auth. An hour of browser caching
	// keeps gallery re-opens cheap without letting shared caches hold it.
	w.Header().Set("Cache-Control", "private, max-age=3600")
	http.ServeContent(w, r, "", info.ModTime(), f)
}

// activeExt are the extensions a browser may treat as executable markup.
var activeExt = map[string]bool{
	".html": true, ".htm": true, ".xhtml": true, ".xht": true,
	".svg": true, ".svgz": true, ".xml": true, ".xsl": true, ".xslt": true,
	".mhtml": true, ".mht": true,
}

// isActiveContent reports whether a stored document must be answered as a
// download rather than rendered, because a browser could execute it as markup
// against the serving — authed — origin.
//
// BOTH the sniffed type and the extension decide, because neither alone is
// enough. `http.DetectContentType` sniffs `<svg …>` as text/plain, which nosniff
// makes inert but which is not something to depend on; and an extension is only
// a claim about the bytes. Either signal being active is enough to force a
// download, so the decision degrades safely on both sides.
//
// The file preview has its own safe route for HTML — a sandboxed srcdoc iframe
// with neither allow-scripts nor allow-same-origin (HTML_SANDBOX in
// store/preview.logic.ts) — and that is where such a document is meant to be
// read.
func isActiveContent(ct, name string) bool {
	if activeExt[strings.ToLower(filepath.Ext(name))] {
		return true
	}
	base := ct
	if i := strings.IndexByte(base, ';'); i >= 0 {
		base = base[:i]
	}
	switch strings.TrimSpace(strings.ToLower(base)) {
	case "text/html", "image/svg+xml", "application/xhtml+xml", "text/xml", "application/xml":
		return true
	}
	return false
}

// handleStoredFile (GET /file/<session>/<name>) serves one stored attachment
// back — the read-back route a document chip in the text view opens, and what
// the file preview reads a stored document through (design decision 3; ADR-0005
// had no such route because non-image uploads were /tmp ephemera).
//
// Sniffing is always disabled, and active content is forced to download, so a
// document can never run as script against the authed origin.
func handleStoredFile(w http.ResponseWriter, r *http.Request) {
	f, info, head := openStored(w, r, "/file/", "file")
	if f == nil {
		return
	}
	defer f.Close()

	name := filepath.Base(info.Name())
	ct := http.DetectContentType(head)
	disposition := "inline"
	if isActiveContent(ct, name) {
		ct = "application/octet-stream"
		disposition = "attachment"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Disposition",
		mime.FormatMediaType(disposition, map[string]string{"filename": name}))
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

// writeUpload answers /upload: the stored path, plus whether it landed
// somewhere the web surface can read back (the per-(user, session) store) as
// opposed to the ephemeral /tmp transfer area. `path` keeps its name and
// position so every existing reader — the vanilla page, the SPA's pty typing —
// is unaffected by the added field.
func writeUpload(w http.ResponseWriter, path string, stored bool) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(struct {
		Path   string `json:"path"`
		Stored bool   `json:"stored"`
	}{path, stored})
}
