package main

import (
	"bytes"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"terminal-lobby/sessionio"
)

// Pictures out of a transcript, 2026-09-24.
//
// Viktor: "in text mode i would want to be able to view images natively ...
// agent communicating back with images should also render the same way." Two
// kinds of picture have no file behind them: one pasted into the terminal (a
// user record carrying an image block beside the "[Image #1]" its text shows)
// and one Claude read (a Read's tool_result, whose content is the picture). The
// events that name them carry references only (sessionio.ImageRef), so the SSE
// stream and its 8 KiB result cap never hold a picture, and a phone downloads
// only the ones it scrolls to. These routes serve the bytes, one block at a
// time:
//
//	GET /result/{session}/{toolId}/image/{n}       n-th image block of that tool's result
//	GET /result/{session}/user/{record}/image/{n}  n-th image block of the prompt with that uuid
//
// Both sit under /result/, which the ingress, the container's nginx and the
// dev proxy already send here, so they needed no infra change. The index comes
// last rather than a file name on purpose: frontend/diag.js files anything
// ending in .png under "app" in the Data used panel.

// maxPictureBytes caps one picture, the same 10 MB file-api's picture route and
// /files/read state. It cannot fire while a scanned transcript line is bounded
// at 8 MB, which bounds a block at about 6 MB decoded; it is kept so both
// picture surfaces promise the same thing.
const maxPictureBytes = 10 << 20

// maxPictureIndex bounds n. The largest census record held one picture, and a
// bound keeps a typo from scanning a transcript for block 4,000,000.
const maxPictureIndex = 99

var (
	// toolIDRE is what a tool id may look like here. Claude's are
	// "toolu_" plus 24 base62 characters; the range leaves room for others
	// while keeping a slash or a dot out of anything that reaches a scan.
	toolIDRE = regexp.MustCompile(`^[A-Za-z0-9_-]{8,128}$`)
	// recordRE is a transcript record's uuid.
	recordRE = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
)

// pictureTypes are the sniffed types a transcript picture may be served as.
// SVG is not one of them: a document that can carry script has no business
// coming out of a transcript, and neither Claude's Read nor a terminal paste
// produces one.
var pictureTypes = map[string]bool{
	"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true,
}

// imageBlocks is the one thing the writer needs from a source, so a test can
// hand it a fake (the writeEarlier pattern).
type imageBlocks interface {
	ImageBlock(addr sessionio.ImageAddr) (sessionio.ImageData, error)
}

// imageAddrFrom reads the picture's address off the path, or says why it is
// not one. n must be written the one canonical way, so one picture has one URL
// and the immutable cache below never stores the same bytes twice.
func imageAddrFrom(r *http.Request, record bool) (sessionio.ImageAddr, error) {
	raw := r.PathValue("n")
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 || n > maxPictureIndex || strconv.Itoa(n) != raw {
		return sessionio.ImageAddr{}, errors.New("bad picture index (need 0-99)")
	}
	if record {
		id := r.PathValue("record")
		if !recordRE.MatchString(id) {
			return sessionio.ImageAddr{}, errors.New("bad record id")
		}
		return sessionio.ImageAddr{Record: id, N: n}, nil
	}
	id := r.PathValue("toolId")
	if !toolIDRE.MatchString(id) {
		return sessionio.ImageAddr{}, errors.New("bad tool id")
	}
	return sessionio.ImageAddr{ToolID: id, N: n}, nil
}

// serveImageBlock answers one picture route. The source is resolved exactly as
// /result resolves it, so another user's transcript is read by a child running
// as them (privReader.ImageBlock), on a child of its own.
func serveImageBlock(w http.ResponseWriter, r *http.Request, rg *registry, record bool) {
	addr, err := imageAddrFrom(r, record)
	if err != nil {
		pictureError(w, err.Error(), http.StatusBadRequest)
		return
	}
	fs, ok := rg.source(osUserFrom(r.Context()), r.PathValue("session"))
	if !ok {
		pictureError(w, "session not registered", http.StatusNotFound)
		return
	}
	writeImageBlock(w, r, fs, addr)
}

// writeImageBlock serves one picture's bytes, or the status that says why not.
//
// Every failure to find or read the block is a 404: the client treats any
// non-200 the same way (the placeholder text stays), and a reason would tell a
// caller nothing about their own transcript that they could act on. The bytes
// are sniffed rather than trusted to the block's media_type, and served with
// nosniff, so a transcript cannot be made to hand the browser a document.
//
// Cached for a year and immutable: a transcript is append-only and tool ids and
// record uuids are unique, so one URL never names different bytes, and a
// picture stays viewable in a timeline after its session has gone.
func writeImageBlock(w http.ResponseWriter, r *http.Request, src imageBlocks, addr sessionio.ImageAddr) {
	img, err := src.ImageBlock(addr)
	if err != nil {
		pictureError(w, "no such picture", http.StatusNotFound)
		return
	}
	if len(img.Data) > maxPictureBytes {
		pictureError(w, "picture too large (max 10MB)", http.StatusRequestEntityTooLarge)
		return
	}
	ct := http.DetectContentType(img.Data)
	if !pictureTypes[ct] {
		pictureError(w, "not an image", http.StatusUnsupportedMediaType)
		return
	}
	h := w.Header()
	h.Set("Content-Type", ct)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "private, max-age=31536000, immutable")
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(img.Data))
}

// pictureError writes a refusal nobody should cache. The next ask can go
// differently: a session this process has not registered yet, or a privileged
// child left from the previous build that answers "unknown op" until the
// restart replaces it, both 404 once and then serve.
func pictureError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Cache-Control", "no-store")
	http.Error(w, msg, code)
}
