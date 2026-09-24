package main

import (
	"bytes"
	"encoding/base64"
	"errors"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// GET /files/image?path=<abs> — pictures, from any path the user can read.
//
// Viktor, 2026-09-24: "in text mode i would want to be able to view images
// natively. we can distinguish them by file name/path. agent communicating
// back with images should also render the same way." The pictures Claude names
// are not all in the home: of 137 Reads of an image in the census, 57 were
// under /tmp/claude-1000 (Claude's scratchpads) and 3 elsewhere in /tmp, and
// /files/read refuses every one of them, because everything else this service
// does is confined to the caller's home (paths.go).
//
// So this route draws a different line. It has NO containment: the OS decides
// what the effective user can open, exactly as it would in their own shell,
// and this route decides that only pictures come back. That is the whole
// boundary, and it is why the route is narrow in every other way:
//
//   - the bytes must sniff as PNG, JPEG, GIF or WebP, or the path must end in
//     .svg, which is served with a CSP sandbox so opening it in a tab runs
//     nothing. Anything else is 415 and not one byte of it is sent;
//   - every response carries nosniff, so a browser never reinterprets the
//     bytes as something they were not served as;
//   - the same 10 MB cap as /files/read;
//   - no usage event: file.previewed counts previews people open, and a
//     picture drawn in a timeline is not one. No path reaches a log or an
//     event (ADR-0008).
//
// It is read as the effective user. The service user's own requests run in
// this process, whose unit sets PrivateTmp=no, ProtectHome=no and
// ProtectSystem=no, so /tmp is the real /tmp. Everyone else's run in a child
// under `sudo -u <user>` (privop.go), whose grant carries no argument list, so
// the new op needed no sudoers change.

// imageTypes are the sniffed types served as themselves.
var imageTypes = map[string]bool{
	"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true,
}

const (
	svgType = "image/svg+xml"
	// svgCSP applies to an SVG only. An SVG opened in its own tab is a
	// document that can run script, and the sandbox stops that. A raster
	// picture opened in a tab is an image document the browser builds around
	// it, and a default-src 'none' on that response can stop some browsers
	// showing it at all, so rasters go without.
	svgCSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'"
)

// isSVGPath reports whether the caller asked for an SVG, by extension: the
// sniffer cannot name SVG (it has no binary signature), which is the same
// reason /files/read forces the type for .svg.
func isSVGPath(p string) bool { return strings.EqualFold(filepath.Ext(p), ".svg") }

// handleImage serves one picture, inline for the service's own user and
// through the privileged child for everyone else.
func handleImage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Cache-Control", "no-store")
		methodNotAllowed(w, http.MethodGet)
		return
	}
	osUser := resolveOSUser(w, r)
	if osUser == "" {
		return
	}
	p := r.URL.Query().Get("path")
	if crossUser(osUser) {
		writeImageEnvelope(w, r, runPrivop(osUser, "image", p, false, nil), p)
		return
	}
	f, info, ctype, status, msg := openImage(p)
	if status != http.StatusOK {
		imageError(w, msg, status)
		return
	}
	defer f.Close()
	// A section of exactly the size that passed the cap: a file that grows
	// after the check is still served at the size that was checked.
	writeImage(w, r, ctype, isSVGPath(p), info.ModTime(), io.NewSectionReader(f, 0, info.Size()))
}

// openImage opens path for serving as a picture, or says why it will not.
// Shared by the inline leg and the privileged child, so the two can never
// disagree about what is a picture.
//
// A stat comes first so a device node, a FIFO or a socket is refused without
// being opened at all: opening some devices does something. That stat decides
// nothing on its own. openHandle then opens the path and checks the HANDLE, so
// what is read is exactly what was checked, even if the path was swapped in
// between. handleRead's stat-then-open is safe only because its path was
// contained (open.go); this route has no containment to lean on.
func openImage(path string) (*os.File, os.FileInfo, string, int, string) {
	if path == "" || !filepath.IsAbs(path) {
		return nil, nil, "", http.StatusBadRequest, "path must be absolute"
	}
	if strings.IndexByte(path, 0) >= 0 {
		return nil, nil, "", http.StatusBadRequest, "invalid path"
	}
	st, err := os.Stat(path)
	if err != nil {
		status, msg := imageOpenError(err)
		return nil, nil, "", status, msg
	}
	if !st.Mode().IsRegular() {
		return nil, nil, "", http.StatusBadRequest, "not a regular file"
	}
	return openHandle(path)
}

// openHandle opens path and runs every check on the open file.
//
// The open follows symlinks the way the user's own shell would: with no
// containment there is nothing for a symlink to escape, so neither
// resolveWithin nor O_NOFOLLOW applies here. O_NONBLOCK keeps a FIFO named
// x.png from hanging the request waiting for a writer, and does nothing to a
// regular file. O_NOCTTY keeps a terminal device from becoming the service's
// controlling terminal, which a systemd service, being a session leader with
// none, would otherwise acquire on open.
func openHandle(path string) (*os.File, os.FileInfo, string, int, string) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOCTTY, 0)
	if err != nil {
		status, msg := imageOpenError(err)
		return nil, nil, "", status, msg
	}
	fail := func(status int, msg string) (*os.File, os.FileInfo, string, int, string) {
		f.Close()
		return nil, nil, "", status, msg
	}
	info, err := f.Stat()
	if err != nil {
		log.Printf("files/image: stat: %v", errnoOf(err))
		return fail(http.StatusInternalServerError, "internal error")
	}
	if !info.Mode().IsRegular() {
		return fail(http.StatusBadRequest, "not a regular file")
	}
	if info.Size() > maxFileSize {
		return fail(http.StatusRequestEntityTooLarge, "file too large (max 10MB)")
	}
	head := make([]byte, 512)
	n, err := f.ReadAt(head, 0)
	if err != nil && !errors.Is(err, io.EOF) {
		log.Printf("files/image: read: %v", errnoOf(err))
		return fail(http.StatusInternalServerError, "internal error")
	}
	ctype := http.DetectContentType(head[:n])
	switch {
	case isSVGPath(path):
		ctype = svgType
	case !imageTypes[ctype]:
		return fail(http.StatusUnsupportedMediaType, "not an image")
	}
	return f, info, ctype, http.StatusOK, ""
}

// imageOpenError maps an open or stat failure to a status. Not found and not
// readable share 404: the client treats every non-200 the same way (the path
// stays as text), and telling them apart would tell a caller nothing their
// own shell cannot.
func imageOpenError(err error) (int, string) {
	switch {
	case errors.Is(err, fs.ErrNotExist), errors.Is(err, fs.ErrPermission),
		errors.Is(err, syscall.ELOOP), errors.Is(err, syscall.ENOTDIR),
		errors.Is(err, syscall.ENAMETOOLONG):
		return http.StatusNotFound, "not found"
	case errors.Is(err, syscall.ENXIO), errors.Is(err, syscall.ENODEV):
		// A socket, or a device with nothing behind it: open(2) refuses both
		// before a stat of the handle could.
		return http.StatusBadRequest, "not a regular file"
	default:
		log.Printf("files/image: open: %v", errnoOf(err))
		return http.StatusInternalServerError, "internal error"
	}
}

// errnoOf is what an unexpected failure logs: the errno, never the
// *PathError, whose text carries the path.
func errnoOf(err error) error {
	var pe *fs.PathError
	if errors.As(err, &pe) {
		return pe.Err
	}
	return err
}

// writeImage sets the picture headers and serves the body.
//
// private, no-cache rather than a max-age because screenshots are overwritten
// under the same name (10 screenshot names were reused within one census
// transcript, up to 3 times each), and a max-age would show the previous
// capture for its lifetime. no-cache still stores the picture and revalidates
// it with one small request: ServeContent sets Last-Modified from mod and
// answers If-Modified-Since with 304.
func writeImage(w http.ResponseWriter, r *http.Request, ctype string, svg bool, mod time.Time, body io.ReadSeeker) {
	h := w.Header()
	h.Set("Content-Type", ctype)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "private, no-cache")
	if svg {
		h.Set("Content-Security-Policy", svgCSP)
	}
	http.ServeContent(w, r, "", mod, body)
}

// imageError writes a refusal nobody should cache, so a file that appears
// later is asked for again. http.Error adds nosniff.
func imageError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Cache-Control", "no-store")
	http.Error(w, msg, code)
}

// opImageEnvelope is the privileged child's half: openImage as the target user,
// the whole (at most 10 MB) picture base64'd into the envelope. A refused file
// sends its status and nothing else, so no byte of a non-picture crosses the
// pipe.
func opImageEnvelope(path string) privopResult {
	f, info, ctype, status, msg := openImage(path)
	if status != http.StatusOK {
		return privopResult{Status: status, Error: msg}
	}
	defer f.Close()
	data, err := io.ReadAll(io.NewSectionReader(f, 0, info.Size()))
	if err != nil {
		log.Printf("files/image: read: %v", errnoOf(err))
		return privopResult{Status: http.StatusInternalServerError, Error: "internal error"}
	}
	return privopResult{
		Status:      http.StatusOK,
		ContentB64:  base64.StdEncoding.EncodeToString(data),
		ContentType: ctype,
		MtimeUnix:   info.ModTime().Unix(),
	}
}

// writeImageEnvelope relays the child's answer. The child is this binary and
// applied openImage, but the parent writes the headers, so it holds the type to
// the same rule rather than relaying whatever the envelope says: a raster type
// for a raster path, image/svg+xml only for a path the CALLER asked for as
// .svg, which is also what decides the CSP. Serving from the child's mtime keeps
// conditional requests working the same on both legs.
func writeImageEnvelope(w http.ResponseWriter, r *http.Request, res privopResult, reqPath string) {
	if res.Status != http.StatusOK {
		imageError(w, res.Error, res.Status)
		return
	}
	svg := isSVGPath(reqPath)
	if (svg && res.ContentType != svgType) || (!svg && !imageTypes[res.ContentType]) {
		log.Printf("files/image: privileged child answered an unexpected type")
		imageError(w, "internal error", http.StatusInternalServerError)
		return
	}
	data, err := base64.StdEncoding.DecodeString(res.ContentB64)
	if err != nil {
		log.Printf("files/image: undecodable content envelope: %v", err)
		imageError(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeImage(w, r, res.ContentType, svg, time.Unix(res.MtimeUnix, 0), bytes.NewReader(data))
}
