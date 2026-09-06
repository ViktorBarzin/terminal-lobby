package main

import (
	"errors"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

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
// (module.ingress_assets, auth = "none") lists exactly eleven paths — the
// manifest, three icons, sw.js and six fonts — and every other route on
// terminal.viktorbarzin.me keeps the authentik-forward-auth middleware. So a
// path in this table is not thereby public. What the table does grant is a
// direct unauthenticated hit on :7683 from the box or the cluster network,
// which bypasses the ingress in the first place — acceptable for every entry
// on the same grounds: a fixed file from the repo, byte-identical for every
// user, carrying no user data.
//
// One host, not two: terminal-dev.viktorbarzin.me and its ttyd-v2 on :7687
// were removed on 2026-08-16 (docs/architecture.md).

// defaultAssetDir is the shared install target: manifest + icons sit next to
// index.html, the woff2 files under fonts/. The .deb's postinst puts everything
// here (release/manifest.go names each destination); deploy-v2.sh, which used
// to install the terminal page beside them, was deleted in d6b9501.
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
// fonts/tl-symbols.woff2 IS listed now, and the reason it was not is worth
// keeping because it was correct until 2026-09-04. term.html embeds that face
// as a data: URI and never fetches it by URL, so serving it was pure surface.
// The app-rendered terminal declares it in theme/theme.css instead and asks for
// it by URL, and while this path 404ed the face loaded with status "error" and
// Claude Code's spinner glyphs fell through to whatever font the client
// happened to have. On the machine that reported the problem, that was a
// replacement box. Inlining 17 KB as base64 on every deploy costs more than one
// request the browser keeps for a week.
// Icons + manifest may change with a deploy (1h cache); the fonts are versioned
// by content, not path (7d).
// sw.js (the push service worker) is served no-cache: the browser re-fetches
// the worker bytes on every update check, so a deploy must never be masked
// by a cached copy.
var publicAssets = map[string]publicAsset{
	"/manifest.webmanifest":  {"manifest.webmanifest", "application/manifest+json", "public,max-age=3600"},
	"/icon-192.png":          {"icon-192.png", "image/png", "public,max-age=3600"},
	"/icon-512.png":          {"icon-512.png", "image/png", "public,max-age=3600"},
	"/icon-512-maskable.png": {"icon-512-maskable.png", "image/png", "public,max-age=3600"},
	"/sw.js":                 {"sw.js", "application/javascript", "no-cache"},
	// The lobby's build stamp, on its own so the self-update check costs ~12
	// bytes instead of the whole page. It used to read the stamp out of a full
	// GET of "/" every 5s: measured 1,430,075-1,430,242 B per fetch, and on
	// iOS Safari 1,279 full bodies to 2 revalidations in 24h = 1.83 GB/day
	// from one phone, which is 5.7x the whole downlink of a 400kbps link.
	"/build-id": {"build-id", "text/plain; charset=utf-8", "no-cache"},
	// There was a SECOND stamp here, /term-build-id, because the terminal was a
	// separate document with its own identity: the framed page re-checked itself
	// on every reconnect, which measured 502,720 B against 300 B for the same 12
	// hex characters. One document means one stamp, so it went with the page.

	"/fonts/JetBrainsMono-Regular.woff2":     {"fonts/JetBrainsMono-Regular.woff2", "font/woff2", "public,max-age=604800"},
	"/fonts/JetBrainsMono-Bold.woff2":        {"fonts/JetBrainsMono-Bold.woff2", "font/woff2", "public,max-age=604800"},
	"/fonts/JetBrainsMono-Italic.woff2":      {"fonts/JetBrainsMono-Italic.woff2", "font/woff2", "public,max-age=604800"},
	"/fonts/JetBrainsMono-BoldItalic.woff2":  {"fonts/JetBrainsMono-BoldItalic.woff2", "font/woff2", "public,max-age=604800"},
	"/fonts/dm-sans-latin-wght-normal.woff2": {"fonts/dm-sans-latin-wght-normal.woff2", "font/woff2", "public,max-age=604800"},
	"/fonts/tl-symbols.woff2":                {"fonts/tl-symbols.woff2", "font/woff2", "public,max-age=604800"},
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

// --- The deleted terminal page ----------------------------------------------
//
// /term.html served the terminal until the lobby started drawing its own
// (ADR-0017), and the page is gone. Three kinds of client still ask for it: a
// bookmark, an iOS home-screen icon installed against that URL, and a tab left
// open across the deploy. A 404 for any of them is a dead end, so the path
// answers a redirect to the lobby instead of falling off the table.
//
// The SESSION NAME survives the hop, which is the part worth getting right. The
// page took it as the first positional `?arg=` (ttyd's -a contract, $1 in
// devvm/tmux-attach.sh); the lobby reads `?session=` at boot
// (readInitialSelection in frontend-v2/src/components/App.tsx, which checks it
// against the same NAME_RE as sessionNameRe above). So /term.html?arg=main
// becomes /?session=main and a bookmark lands on the session it named. Nothing
// deeper carries: the command, dir, owner and watch slots ($2..$5) have no
// spelling in the lobby's own URL, and the lobby resolves all four itself from
// the layout and the sharing state.
//
// This MOVES a decision from the page into the server. The old bounce — a
// /term.html with no usable ?arg= sending you to the lobby — was the page's own
// JavaScript, so it died with the page; answering it here is a different layer,
// and the layer is now Go rather than a script the client has to run.
//
// 302, not 301: every answer this file gives is no-cache, and a permanent
// redirect a browser has already cached cannot be taken back. Not 410 either,
// which is the technically honest code for a deleted document and useless to a
// person, who would get a blank error page instead of their terminal.
const termPagePath = "/term.html"

// lobbyPath is where a stale terminal link lands: index.html, served by ttyd.
const lobbyPath = "/"

// handleTermPageRedirect answers termPagePath. Method-guarded like handleAsset,
// since the ingress and the walloff probe both reach these paths with HEAD.
func handleTermPageRedirect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	dest := lobbyPath
	// Query().Get returns the FIRST value of a repeated key, and ttyd's
	// contract is positional, so this is arg1 — the session name — however
	// many args the old link carried. A name the lobby could not select is
	// dropped rather than forwarded: it would only be ignored one hop later.
	if name := r.URL.Query().Get("arg"); sessionNameRe.MatchString(name) {
		dest = lobbyPath + "?session=" + url.QueryEscape(name)
	}
	w.Header().Set("Cache-Control", "no-cache")
	http.Redirect(w, r, dest, http.StatusFound)
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
		if p == termPagePath {
			handleTermPageRedirect(w, r)
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

// hashedAssetPrefix is where the lobby's content-hashed build output lives: the
// SPA's JS/CSS chunks. Routed here by the terminal stack's IngressRoute.
//
// A build no longer emits a hashed copy of the terminal page, but installed ones
// outlive the deploy that stopped producing them: the payload is not
// dpkg-owned, so postinst prunes this directory with `-mtime +14` rather than
// clearing it. A client still running an older lobby build therefore keeps a
// working terminal here for up to a fortnight, which is why ".html" stays in
// hashedAssetTypes below.
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
// revalidates and a deploy changes the NAME instead of invalidating a path. The
// measurement that bought the scheme: the terminal page, when it was a separate
// document, cost a conditional round trip per attach and ~474 KB after every
// deploy on a real device, against nothing at all once it was hashed.
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
