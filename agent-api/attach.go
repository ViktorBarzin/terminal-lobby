package main

// Images and files in a message.
//
// POST /v1/conversations/{id}/messages takes multipart/form-data as well as
// JSON: one "text" field and any number of "file" parts, which is what
// `curl -F text=... -F file=@a.png` sends. Each file is written to the
// session's clipboard store, the same directory a person's paste in the lobby
// lands in, and its absolute path is appended to the prompt. That is how the
// lobby has always handed Claude Code an image: as a path it opens with its
// own Read tool, from a directory outside every git repository.
//
// Three properties carry the design, and each is placed where it cannot be
// skipped:
//
//   - The credential is checked before any body byte is read. That is the /v1
//     auth wrapper in server.go, unchanged; this file only ever runs behind it.
//   - Nothing is held in memory. Parts are streamed to disk through a size cap,
//     and the whole body sits behind http.MaxBytesReader.
//   - A refused message leaves nothing behind. Every file this request wrote is
//     removed again if any later part is refused.

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"terminal-lobby/clipstore"
)

// UploadLimits bounds what one message may carry. Fields are bytes.
type UploadLimits struct {
	// Image caps one part whose bytes sniff as an image Claude Code can read.
	Image int64
	// File caps any other part.
	File int64
	// Request caps the whole body, text and multipart framing included.
	Request int64
}

// defaultUploadLimits are Viktor's numbers (2026-10-02, design doc
// 2026-10-02-muse-homelab-integration-design.md): 25 MB an image, 100 MB any
// other file, 200 MB a message. The image cap matches the one ADR-0005 already
// set for the store. Files are allowed past it because a Caller's document is
// the point of the message rather than a convenience, and the store's
// retention clock still bounds how long any of it is kept.
var defaultUploadLimits = UploadLimits{Image: 25 << 20, File: 100 << 20, Request: 200 << 20}

// defaultUploadTimeout is how long one upload may take to arrive. The
// server's ReadTimeout stays at 30 s for everything else, because every other
// body is a small JSON object; this lifts it for an authenticated upload only.
// 200 MB at about 1 Mbit/s is 27 minutes, so 30 covers a slow link without
// leaving a trickling connection open indefinitely. Traefik in front allows an
// hour (readTimeout=3600s in stacks/traefik), so this is the tighter bound.
const defaultUploadTimeout = 30 * time.Minute

// imageTypes are the formats sent as images: the four Claude Code's Read tool
// renders. Anything else, including image formats it cannot render (BMP,
// AVIF, SVG), is stored as a document under the file limit.
var imageTypes = map[string]bool{
	"image/png":  true,
	"image/jpeg": true,
	"image/gif":  true,
	"image/webp": true,
}

func (s *Server) limits() UploadLimits {
	l := s.Limits
	if l.Image <= 0 {
		l.Image = defaultUploadLimits.Image
	}
	if l.File <= 0 {
		l.File = defaultUploadLimits.File
	}
	if l.Request <= 0 {
		l.Request = defaultUploadLimits.Request
	}
	return l
}

func (s *Server) uploadTimeout() time.Duration {
	if s.UploadTimeout > 0 {
		return s.UploadTimeout
	}
	return defaultUploadTimeout
}

func (s *Server) storeRoot() string {
	if s.StoreRoot != "" {
		return s.StoreRoot
	}
	return clipstore.DefaultRoot
}

// uploadsDir is the caller's directory in the store, which holds every
// session's subdirectory under whatever name it has now. A session gets the
// whole of it as a working directory rather than its own subdirectory,
// because tmux-api's title rename moves that subdirectory during the first
// turn and leaves a link under the old name (renameImageDir): a Read waiting
// on a permission prompt while it moved was refused as a changed symlink
// (rv-r2ui-i/j/k, measured live on 2026-10-02). The user's directory is never
// renamed, and every path handed out resolves inside it before and after.
//
// Created here because Claude refuses a working directory that does not
// exist, and a user's first conversation can come before their first paste.
// "" when it cannot be made: the session then starts without it and a Read of
// an upload asks, which is how every session behaved before.
func (s *Server) uploadsDir(osUser string) string {
	if !clipstore.SessionNameRe.MatchString(osUser) {
		return ""
	}
	// clipstore decides the mode: private for this service's own account,
	// ADR-0005's 0755 for another's.
	dir, err := clipstore.UserDir(s.storeRoot(), osUser)
	if err != nil {
		logf("agent-api: cannot create the store directory for %s (%v); reading an upload will ask permission", osUser, err)
		return ""
	}
	return dir
}

func tooLarge(format string, args ...any) error {
	return &apiError{Status: http.StatusRequestEntityTooLarge, Msg: fmt.Sprintf(format, args...)}
}

// isMultipart reports whether a request carries multipart/form-data.
func isMultipart(r *http.Request) bool {
	mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	return err == nil && mt == "multipart/form-data"
}

// attachment is one stored file, as the trace records it.
type attachment struct {
	// Name is the filename the caller sent, unsanitized, so the trace shows
	// what was asked for; Path is where it was actually written.
	Name  string `json:"name"`
	Type  string `json:"type"`
	Bytes int64  `json:"bytes"`
	Path  string `json:"path"`
}

// multipartMessage is a parsed upload.
type multipartMessage struct {
	Text  string       `json:"text"`
	Files []attachment `json:"files"`
}

// errPartTooLarge marks a part that ran past its own cap.
var errPartTooLarge = errors.New("part over its size limit")

// cappedReader passes at most limit bytes through and fails on the next one.
// It remembers its own read error, so a failed save can tell a refusal of the
// caller's bytes (413, 400) from a disk that would not take them (500).
type cappedReader struct {
	r       io.Reader
	limit   int64
	n       int64
	readErr error
}

func (c *cappedReader) Read(p []byte) (int, error) {
	if c.n > c.limit {
		c.readErr = errPartTooLarge
		return 0, errPartTooLarge
	}
	// Ask for one byte past the cap at most, which is how an over-cap part is
	// noticed without reading the rest of it.
	if room := c.limit + 1 - c.n; int64(len(p)) > room {
		p = p[:room]
	}
	n, err := c.r.Read(p)
	c.n += int64(n)
	if c.n > c.limit {
		c.readErr = errPartTooLarge
		return n, errPartTooLarge
	}
	if err != nil && err != io.EOF {
		c.readErr = err
	}
	return n, err
}

// bodyError turns a failure reading the caller's body into the right refusal.
func bodyError(err error, l UploadLimits) error {
	var mbe *http.MaxBytesError
	if errors.As(err, &mbe) {
		return tooLarge("the message is over the %d MB a request may carry", l.Request>>20)
	}
	return badRequest("reading the multipart body: %v", err)
}

// liftDeadlines gives an upload the time it needs to arrive, on this request
// only. Called after the credential check, so an unauthenticated client never
// gets more than the server's 30 s.
//
// The write deadline moves too: Go starts its clock when the headers are read,
// so a long upload followed by a ?wait= would otherwise have its answer cut
// off. It is set to the upload window plus the ordinary write budget.
func liftDeadlines(w http.ResponseWriter, upload time.Duration) {
	if w == nil {
		return
	}
	rc := http.NewResponseController(w)
	until := time.Now().Add(upload)
	if err := rc.SetReadDeadline(until); err != nil {
		logf("agent-api: cannot lift the read deadline for an upload, so it is cut at the server's ReadTimeout: %v", err)
	}
	if err := rc.SetWriteDeadline(until.Add(serverWriteTimeout)); err != nil {
		logf("agent-api: cannot lift the write deadline for an upload: %v", err)
	}
}

// readMultipartMessage streams one multipart message into the store at
// <root>/<osUser>/<session>/ and returns its text and the files it wrote.
//
// On any error every file written so far is removed, so a message is stored
// whole or not at all.
func (s *Server) readMultipartMessage(c *call, osUser, session string) (msg multipartMessage, err error) {
	l := s.limits()
	liftDeadlines(c.w, s.uploadTimeout())
	c.r.Body = http.MaxBytesReader(c.w, c.r.Body, l.Request)

	// The store directory is opened once, at the first file, and every file
	// is written and taken back relative to it. tmux-api renames a session
	// from its first turn and moves this directory with it, which can land in
	// the middle of an upload; removing by path would then miss.
	var dir *clipstore.Dir
	defer func() {
		if dir == nil {
			return
		}
		if err != nil {
			for _, f := range msg.Files {
				dir.Remove(filepath.Base(f.Path))
			}
			msg.Files = nil
		}
		dir.Close()
	}()

	mr, err := c.r.MultipartReader()
	if err != nil {
		return msg, badRequest("reading the multipart body: %v", err)
	}
	sawText := false
	for {
		p, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return msg, bodyError(err, l)
		}
		switch p.FormName() {
		case "text":
			if sawText {
				return msg, badRequest("text was sent more than once; send one text field")
			}
			sawText = true
			b, err := io.ReadAll(io.LimitReader(p, maxBodyBytes+1))
			if err != nil {
				return msg, bodyError(err, l)
			}
			if len(b) > maxBodyBytes {
				return msg, tooLarge("text is over %d KB; send a longer document as a file part", maxBodyBytes>>10)
			}
			msg.Text = string(b)
		case "file":
			if dir == nil {
				if dir, err = clipstore.OpenStoreDir(s.storeRoot(), osUser, session); err != nil {
					dir = nil
					return msg, serverError("opening the attachment store: %v", err)
				}
			}
			a, err := s.storePart(p, dir, l)
			if err != nil {
				return msg, err
			}
			msg.Files = append(msg.Files, a)
		default:
			return msg, badRequest("unknown form field %q: a message takes one text field and file parts", p.FormName())
		}
	}
	return msg, nil
}

// storePart writes one file part to the store.
//
// Whether the part is an image is decided by its first bytes. The part's own
// Content-Type is whatever the client chose to send, so trusting it would let
// a large document in under the image label or name a text file .png.
func (s *Server) storePart(p *multipart.Part, dir *clipstore.Dir, l UploadLimits) (attachment, error) {
	filename := p.FileName()

	head := make([]byte, clipstore.SniffLen)
	n, err := io.ReadFull(p, head)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		return attachment{}, bodyError(err, l)
	}
	head = head[:n]
	if n == 0 {
		return attachment{}, badRequest("file %q is empty", filename)
	}

	ct := clipstore.Sniff(head)
	limit, kind, name := l.File, "a file", clipstore.AttachName(filename)
	if imageTypes[ct] {
		limit, kind, name = l.Image, "an image", clipstore.PastedName(ct)
	}

	src := &cappedReader{r: io.MultiReader(bytes.NewReader(head), p), limit: limit}
	path, err := dir.Save(name, src)
	if err != nil {
		switch {
		case errors.Is(src.readErr, errPartTooLarge):
			return attachment{}, tooLarge("file %q is over the %d MB limit for %s", filename, limit>>20, kind)
		case src.readErr != nil:
			return attachment{}, bodyError(src.readErr, l)
		default:
			return attachment{}, serverError("storing file %q: %v", filename, err)
		}
	}
	return attachment{Name: filename, Type: ct, Bytes: src.n, Path: path}, nil
}

// composePrompt appends the stored paths to the caller's text, one per line
// under a short heading, which is the shape Claude Code reads a pasted path
// in. With no text the list is the whole prompt.
func composePrompt(text string, files []attachment) string {
	text = strings.TrimSpace(text)
	if len(files) == 0 {
		return text
	}
	var b strings.Builder
	if text != "" {
		b.WriteString(text)
		b.WriteString("\n\n")
	}
	b.WriteString("Attached files:")
	for _, f := range files {
		b.WriteString("\n")
		b.WriteString(f.Path)
	}
	return b.String()
}
