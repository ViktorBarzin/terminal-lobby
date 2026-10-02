package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"terminal-lobby/authuser"
	"terminal-lobby/clipstore"
	"terminal-lobby/telemetry"
)

// fileDir is where an over-cap document stays as a 7-day ephemeral transfer.
// A var, not a const, for the same reason storeRoot is one: a test that writes
// here must be able to point it at its own directory. Left as a const, the
// suite passed only because the running service had already created the real
// path, so it failed on any machine where the service had never run.
//
// /run, not /tmp, since TL-7: this is clipboard-upload.service's
// RuntimeDirectory, which systemd creates under the unit's User= before
// ExecStart. In /tmp it was created by the MkdirAll below, which accepts an
// existing directory of any owner and any mode, so a local user who won the
// boot race owned every file transferred through it. The unit and this default
// have to agree; TestEphemeralTransferDirIsTheUnitsRuntimeDirectory checks it.
var fileDir = "/run/clipboard-files"

const (
	maxUpload = 100 << 20 // 100MB
	// maxRegister bounds files accepted via /register — big enough for any
	// real screenshot or photo, small enough that a stray path can't
	// balloon the store.
	maxRegister = 25 << 20 // 25MB
	// Loopback by default: with no config file present, the identity header
	// is all that authenticates a request, so the port must not be on the
	// network until an operator says so (TL-3).
	listenAddr = "127.0.0.1:7683"
)

// storeRoot is the per-(user, session) image store; mapPath is the
// Authentik→OS-user map resolveOSUser reads. Vars (not consts) purely as test
// seams — the upload tests point them at temp fixtures so the real
// header→user→store path runs hermetically, without reading /etc or writing
// next to a user's real screenshots. Same seam tmux-api/main.go uses for its
// own mapPath. Production never reassigns them.
var (
	storeRoot = clipstore.DefaultRoot
	mapPath   = authuser.DefaultMapPath
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

// Session names: same charset as tmux-api and the frontend's NAME_RE, and the
// one agent-api writes the store under (terminal-lobby/clipstore).
var sessionNameRe = clipstore.SessionNameRe

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
	// TL_BIND is the listen address. The compiled default is loopback, so a
	// process that reaches no configuration at all stays off the network;
	// the shipped conffile says the same. Widening to 0.0.0.0 for a proxy on
	// another host is the operator's explicit act, made in the file where
	// TL_PROXY_SECRET is set alongside it.
	if b := strings.TrimSpace(os.Getenv("TL_BIND")); b != "" {
		if _, port, err := net.SplitHostPort(addr); err == nil {
			addr = net.JoinHostPort(b, port)
		}
	}
	actAsGate.Configure("clipboard-upload", addr)
	if a := os.Getenv("CLIPBOARD_UPLOAD_ADDR"); a != "" {
		addr = a
	}
	log.Printf("Clipboard upload service listening on %s (store=%s files=%s assets=%s)", addr, storeRoot, fileDir, assetDir())
	// The public-asset dispatcher rides ahead of the mux (see
	// withPublicAssets); every existing route falls through untouched.
	go timing.Run(nil)
	log.Fatal(http.ListenAndServe(addr, timing.Wrap(withPublicAssets(http.DefaultServeMux))))
}

// actAsGate resolves every request: the proxy secret, the identity header, the
// mode, and the act-as switch. A var only as a test seam; production
// configures it in main.
//
// SkipAccountCheck: this service never execs as the mapped user, it only needs
// a directory name for the per-user store, so an account missing from the host
// is not a reason to fail the request. That matches what resolveRealOSUser did
// before the gate absorbed it.
var actAsGate = &authuser.Gate{
	AdminsPath:       authuser.DefaultAdminsPath,
	SkipAccountCheck: true,
}

// authHeader is the identity header this build resolves by default. The name is
// configuration now (TL_AUTH_HEADER), so nothing in the request path may name
// the constant: the handler that asks whether a request carries an identity at
// all asks actAsGate.AuthHeader(), which is the name the gate itself resolves
// by. What is left is the tests, which run against an unconfigured gate.
const authHeader = authuser.DefaultAuthHeader

// setMapPath keeps the gate in step, since the gate is what reads the file.
func setMapPath(p string) {
	mapPath = p
	actAsGate.MapPath = p
}

func resolveOSUser(w http.ResponseWriter, r *http.Request) string {
	return actAsGate.ResolveOSUser(w, r)
}

// osUserKnown reports whether name is a mapped OS user. /register's loopback
// callers self-report their user; only real terminal accounts are accepted.
func osUserKnown(name string) bool { return actAsGate.IsTarget(name) }

// galleryPrefixes are the stored-name prefixes the 🖼 gallery lists: a
// clipboard paste/upload, and a `show-image` render registered by the script
// itself. Everything else in a store directory — today, a document attached to
// a text-view message — is chat content, reachable by its own path and never
// drawn as a thumbnail.
var galleryPrefixes = []string{clipstore.PastedPrefix, clipstore.DisplayedPrefix}

// isGalleryName reports whether a stored file belongs in the gallery listing.
func isGalleryName(name string) bool {
	for _, p := range galleryPrefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
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
		if header.Size <= maxAttach {
			session := clipstore.Bucket(r.FormValue("session"))
			path, err := clipstore.SaveToStore(storeRoot, osUser, session, clipstore.AttachName(header.Filename), file)
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
		name := fmt.Sprintf("%s-%s-%s", clipstore.Stamp(), clipstore.RandToken(), clipstore.SanitizeName(header.Filename))
		path, err := clipstore.Save(fileDir, name, file)
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
	session := clipstore.Bucket(r.FormValue("session"))
	path, err := clipstore.SaveToStore(storeRoot, osUser, session, clipstore.PastedName(ct), file)
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
// store/<user>/<session>/displayed-<timestamp>-<token>-<basename>. Responds
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

	// Three ways in, in the order that keeps the weakest one local.
	//
	// The identity branch is selected by the CONFIGURED header name: reading the
	// compiled default here meant every request on a box whose proxy sends
	// X-Authentik-Username fell through to the user= branch instead.
	//
	// That branch is for the box's own tools — show-image and the clipboard
	// helper run as the user, with no proxy in front of them and no header to
	// send — and it trusts a self-reported name. Nothing checked that the caller
	// was local, so with TL_BIND widened for an ingress elsewhere, any host that
	// could route to this port named any mapped user and wrote into that user's
	// store. It is loopback-only now; a caller on the network must present
	// identity, and the proxy secret with it once one is configured.
	var osUser string
	switch {
	case r.Header.Get(actAsGate.AuthHeader()) != "":
		osUser = resolveOSUser(w, r)
		if osUser == "" {
			return
		}
	case !authuser.IsLoopback(r):
		log.Printf("register: refusing headerless request from %s", r.RemoteAddr)
		http.Error(w, "missing identity header", http.StatusUnauthorized)
		return
	default:
		osUser = r.FormValue("user")
		if !osUserKnown(osUser) {
			log.Printf("register: unknown user %q", osUser)
			http.Error(w, "unknown user", http.StatusForbidden)
			return
		}
	}
	session := clipstore.Bucket(r.FormValue("session"))

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
	// The token is what lets the same file be registered twice in one second:
	// the store refuses to overwrite a name (clipstore.Save), and without it
	// the second show-image would get a 500 where it used to get the copy.
	name := fmt.Sprintf("%s%s-%s-%s", clipstore.DisplayedPrefix, clipstore.Stamp(), clipstore.RandToken(),
		clipstore.SanitizeName(filepath.Base(src)))
	path, err := clipstore.SaveToStore(storeRoot, osUser, session, name, f)
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
// are, per clipstore.Sniff, and rewinds so the caller can still copy the whole
// part. /upload's image branch gates the store write on this.
//
// clipstore.Sniff has the reasoning: no extension fallback (unlike isImage
// below), and ISO-BMFF brands recognised so AVIF is not refused. Files that
// pass here and still fail to paint are handled by the gallery's onError
// fallback in frontend-v2/src/components/Gallery.tsx.
func sniffContentType(f multipart.File) (string, error) {
	head := make([]byte, clipstore.SniffLen)
	n, err := f.Read(head)
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	return clipstore.Sniff(head[:n]), nil
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
		if iso := clipstore.ISOBMFFImageType(head); iso != "" {
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
