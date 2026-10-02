package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"terminal-lobby/telemetry"
)

// Images and files in messages: POST /v1/conversations/{id}/messages as
// multipart/form-data. The limits under test are shrunk on the Server so a
// test moves kilobytes rather than the real hundreds of megabytes; the real
// values are pinned once, in TestUploadLimitsAreViktorsNumbers.

// pngBytes is a real PNG header padded to n bytes. http.DetectContentType
// needs only the magic, so padding keeps the sniff honest at any size.
func pngBytes(n int) []byte {
	head := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")
	if n < len(head) {
		n = len(head)
	}
	return append(head, bytes.Repeat([]byte{0}, n-len(head))...)
}

func pdfBytes(n int) []byte {
	head := []byte("%PDF-1.7\n")
	if n < len(head) {
		n = len(head)
	}
	return append(head, bytes.Repeat([]byte("x"), n-len(head))...)
}

// part is one multipart section of a test message.
type part struct {
	field    string // "text" or "file", or anything else to test refusal
	filename string // empty for a plain field
	ctype    string // the part's declared Content-Type, which must not be trusted
	body     []byte
}

func textPart(s string) part { return part{field: "text", body: []byte(s)} }

func filePart(name, ctype string, body []byte) part {
	return part{field: "file", filename: name, ctype: ctype, body: body}
}

// multipartBody encodes parts the way curl -F does.
func multipartBody(t *testing.T, parts ...part) (*bytes.Buffer, string) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for _, p := range parts {
		hdr := textproto.MIMEHeader{}
		disp := fmt.Sprintf(`form-data; name=%q`, p.field)
		if p.filename != "" {
			disp += fmt.Sprintf(`; filename=%q`, p.filename)
		}
		hdr.Set("Content-Disposition", disp)
		if p.ctype != "" {
			hdr.Set("Content-Type", p.ctype)
		}
		w, err := mw.CreatePart(hdr)
		if err != nil {
			t.Fatal(err)
		}
		w.Write(p.body)
	}
	mw.Close()
	return &buf, mw.FormDataContentType()
}

// postMultipart sends one multipart message as the caller under test.
func (h *harness) postMultipart(conv string, parts ...part) *httptest.ResponseRecorder {
	h.t.Helper()
	body, ctype := multipartBody(h.t, parts...)
	r := httptest.NewRequest("POST", "/v1/conversations/"+conv+"/messages", body)
	r.Header.Set("Content-Type", ctype)
	r.Header.Set("Authorization", "Bearer "+testToken)
	w := httptest.NewRecorder()
	h.handler.ServeHTTP(w, r)
	return w
}

// uploadHarness is a harness with a temp store and small limits.
func uploadHarness(t *testing.T) *harness {
	t.Helper()
	h := newHarness(t)
	h.srv.StoreRoot = t.TempDir()
	h.srv.Limits = UploadLimits{Image: 1 << 10, File: 4 << 10, Request: 8 << 10}
	h.readyConversation("c1")
	return h
}

// storeDir is where c1's files land.
func (h *harness) storeDir(session string) string {
	return filepath.Join(h.srv.StoreRoot, testOSUser, session)
}

// stored lists the files in a session's store directory.
func (h *harness) stored(session string) []string {
	h.t.Helper()
	entries, err := os.ReadDir(h.storeDir(session))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		h.t.Fatal(err)
	}
	var out []string
	for _, e := range entries {
		out = append(out, e.Name())
	}
	return out
}

// promptOnce waits for the one prompt the message should produce.
func (h *harness) promptOnce() string {
	h.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if p := h.sessions.promptCalls(); len(p) > 0 {
			if len(p) != 1 {
				h.t.Fatalf("%d prompts, want 1: %+v", len(p), p)
			}
			return p[0].Text
		}
		time.Sleep(time.Millisecond)
	}
	h.t.Fatal("no prompt reached the session")
	return ""
}

var (
	pastedRe = regexp.MustCompile(`^pasted-\d{8}-\d{6}-[0-9a-f]{8}\.png$`)
	fileRe   = regexp.MustCompile(`^file-\d{8}-\d{6}-[0-9a-f]{8}-report\.pdf$`)
)

// The whole feature in one message: text, an image and a document. Each lands
// in the session's store under the name clipboard-upload would give it, and
// the prompt names them by absolute path under an "Attached files:" line, so
// Claude Code reads them the way it reads a pasted path in the lobby.
func TestMessageWithAnImageAndAFile(t *testing.T) {
	h := uploadHarness(t)
	img := pngBytes(600)
	doc := pdfBytes(3000)

	w := h.postMultipart("c1",
		textPart("what is in these?"),
		filePart("shot.png", "image/png", img),
		filePart("report.pdf", "application/pdf", doc))
	h.decodeJSON(w, http.StatusAccepted, nil)

	names := h.stored("c1")
	if len(names) != 2 {
		t.Fatalf("stored %v, want two files", names)
	}
	var imgPath, docPath string
	for _, n := range names {
		switch {
		case pastedRe.MatchString(n):
			imgPath = filepath.Join(h.storeDir("c1"), n)
		case fileRe.MatchString(n):
			docPath = filepath.Join(h.storeDir("c1"), n)
		default:
			t.Fatalf("unexpected stored name %q", n)
		}
	}
	if imgPath == "" || docPath == "" {
		t.Fatalf("names %v: want one pasted- image and one file- document", names)
	}
	if b, _ := os.ReadFile(imgPath); !bytes.Equal(b, img) {
		t.Error("the stored image differs from what was sent")
	}
	if b, _ := os.ReadFile(docPath); !bytes.Equal(b, doc) {
		t.Error("the stored document differs from what was sent")
	}

	want := "what is in these?\n\nAttached files:\n" + imgPath + "\n" + docPath
	if got := h.promptOnce(); got != want {
		t.Fatalf("prompt\n%q\nwant\n%q", got, want)
	}
}

// Files with no text are a complete message: the prompt is the list alone.
func TestMessageWithOnlyAFile(t *testing.T) {
	h := uploadHarness(t)
	h.decodeJSON(h.postMultipart("c1", filePart("shot.png", "image/png", pngBytes(100))), http.StatusAccepted, nil)
	names := h.stored("c1")
	if len(names) != 1 {
		t.Fatalf("stored %v", names)
	}
	want := "Attached files:\n" + filepath.Join(h.storeDir("c1"), names[0])
	if got := h.promptOnce(); got != want {
		t.Fatalf("prompt %q, want %q", got, want)
	}
}

// Text alone over multipart behaves exactly like the JSON body.
func TestMultipartTextOnlyIsAPlainMessage(t *testing.T) {
	h := uploadHarness(t)
	h.decodeJSON(h.postMultipart("c1", textPart("  just words  ")), http.StatusAccepted, nil)
	if got := h.promptOnce(); got != "just words" {
		t.Fatalf("prompt %q", got)
	}
	if names := h.stored("c1"); len(names) != 0 {
		t.Fatalf("a text-only message stored %v", names)
	}
}

// Whether a part is an image is decided by its bytes. The declared type is
// whatever the client says it is, so trusting it would let a 4 KB "image"
// past the image limit or name a text file .png.
func TestImageOrFileIsDecidedByContent(t *testing.T) {
	t.Run("text labelled image/png is a file", func(t *testing.T) {
		h := uploadHarness(t)
		h.decodeJSON(h.postMultipart("c1", filePart("report.pdf", "image/png", pdfBytes(2000))), http.StatusAccepted, nil)
		if names := h.stored("c1"); len(names) != 1 || !fileRe.MatchString(names[0]) {
			t.Fatalf("stored %v, want one file- document", names)
		}
	})
	t.Run("a PNG labelled octet-stream is an image", func(t *testing.T) {
		h := uploadHarness(t)
		h.decodeJSON(h.postMultipart("c1", filePart("blob", "application/octet-stream", pngBytes(100))), http.StatusAccepted, nil)
		if names := h.stored("c1"); len(names) != 1 || !pastedRe.MatchString(names[0]) {
			t.Fatalf("stored %v, want one pasted- image", names)
		}
	})
	t.Run("a PNG labelled octet-stream gets the image limit", func(t *testing.T) {
		h := uploadHarness(t)
		// Over the 1 KB image limit, under the 4 KB file limit.
		w := h.postMultipart("c1", filePart("blob", "application/octet-stream", pngBytes(2000)))
		h.decodeJSON(w, http.StatusRequestEntityTooLarge, nil)
	})
}

// Every limit answers 413 in the service's error shape, and a refused message
// leaves nothing behind: no file in the store, no prompt in the session.
func TestUploadLimits(t *testing.T) {
	for _, c := range []struct {
		name  string
		parts []part
	}{
		{"an image over the image limit", []part{textPart("hi"), filePart("big.png", "image/png", pngBytes(1<<10+1))}},
		{"a file over the file limit", []part{textPart("hi"), filePart("big.pdf", "application/pdf", pdfBytes(4<<10+1))}},
		{"files over the request limit together", []part{
			textPart("hi"),
			filePart("a.pdf", "application/pdf", pdfBytes(3<<10)),
			filePart("b.pdf", "application/pdf", pdfBytes(3<<10)),
			filePart("c.pdf", "application/pdf", pdfBytes(3<<10)),
		}},
		{"the text over its limit", []part{textPart(strings.Repeat("x", maxBodyBytes+1))}},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := uploadHarness(t)
			if c.name == "the text over its limit" {
				// The text cap is the JSON body cap; give the request room.
				h.srv.Limits.Request = 4 << 20
			}
			w := h.postMultipart("c1", c.parts...)
			var got map[string]string
			h.decodeJSON(w, http.StatusRequestEntityTooLarge, &got)
			if got["error"] == "" {
				t.Fatalf("413 without the error shape: %s", w.Body.String())
			}
			if names := h.stored("c1"); len(names) != 0 {
				t.Fatalf("a refused message left %v in the store", names)
			}
			if p := h.sessions.promptCalls(); len(p) != 0 {
				t.Fatalf("a refused message reached the session: %+v", p)
			}
		})
	}
}

// A refused message takes back every file it wrote even when the session's
// store directory is renamed while the message arrives. tmux-api renames a
// session from its first turn and moves the store directory with it
// (rename_cascade.go), which can land in the middle of an upload: measured
// live on 2026-10-02, a 26 MB image was refused with 413 and the file stayed
// in the renamed directory, because the cleanup unlinked the old path.
func TestRefusedUploadIsRemovedWhenTheSessionDirectoryMoves(t *testing.T) {
	h := uploadHarness(t)
	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)
	moved := filepath.Join(h.srv.StoreRoot, testOSUser, "c1-renamed")
	go func() {
		defer pw.Close()
		w, _ := mw.CreateFormField("text")
		w.Write([]byte("hi"))
		hdr := textproto.MIMEHeader{}
		hdr.Set("Content-Disposition", `form-data; name="file"; filename="a.pdf"`)
		w, _ = mw.CreatePart(hdr)
		w.Write(pdfBytes(100))
		hdr = textproto.MIMEHeader{}
		hdr.Set("Content-Disposition", `form-data; name="file"; filename="big.png"`)
		w, _ = mw.CreatePart(hdr)
		// The first file is on disk by now. Move its directory, as the
		// rename cascade does, and then send an image over the limit.
		for deadline := time.Now().Add(5 * time.Second); len(h.stored("c1")) == 0; {
			if time.Now().After(deadline) {
				t.Error("the first file never reached the store")
				return
			}
			time.Sleep(time.Millisecond)
		}
		if err := os.Rename(h.storeDir("c1"), moved); err != nil {
			t.Error(err)
			return
		}
		w.Write(pngBytes(1<<10 + 1))
		mw.Close()
	}()
	r := httptest.NewRequest("POST", "/v1/conversations/c1/messages", pr)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	r.Header.Set("Authorization", "Bearer "+testToken)
	w := httptest.NewRecorder()
	h.handler.ServeHTTP(w, r)
	h.decodeJSON(w, http.StatusRequestEntityTooLarge, nil)
	left, err := os.ReadDir(moved)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range left {
		t.Errorf("a refused message left %s in the renamed directory", e.Name())
	}
	if names := h.stored("c1"); len(names) != 0 {
		t.Errorf("a refused message left %v under the old name", names)
	}
}

// The real limits, as Viktor set them on 2026-10-02.
func TestUploadLimitsAreViktorsNumbers(t *testing.T) {
	want := UploadLimits{Image: 25 << 20, File: 100 << 20, Request: 200 << 20}
	if got := (&Server{}).limits(); got != want {
		t.Fatalf("default limits %+v, want %+v", got, want)
	}
}

func TestMultipartRejects(t *testing.T) {
	for _, c := range []struct {
		name  string
		parts []part
	}{
		{"nothing at all", nil},
		{"blank text and no files", []part{textPart("   ")}},
		{"an empty file", []part{textPart("hi"), filePart("empty.txt", "text/plain", nil)}},
		{"an unknown field", []part{textPart("hi"), {field: "model", body: []byte("opus")}}},
		{"text twice", []part{textPart("hi"), textPart("again")}},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := uploadHarness(t)
			h.decodeJSON(h.postMultipart("c1", c.parts...), http.StatusBadRequest, nil)
			if names := h.stored("c1"); len(names) != 0 {
				t.Fatalf("a refused message left %v in the store", names)
			}
			if p := h.sessions.promptCalls(); len(p) != 0 {
				t.Fatalf("a refused message reached the session: %+v", p)
			}
		})
	}

	t.Run("a body that is not multipart", func(t *testing.T) {
		h := uploadHarness(t)
		r := httptest.NewRequest("POST", "/v1/conversations/c1/messages", strings.NewReader("not multipart"))
		r.Header.Set("Content-Type", "multipart/form-data; boundary=nope")
		r.Header.Set("Authorization", "Bearer "+testToken)
		w := httptest.NewRecorder()
		h.handler.ServeHTTP(w, r)
		h.decodeJSON(w, http.StatusBadRequest, nil)
	})
}

// A message the caller may not send writes nothing to disk: ownership and
// existence are settled before the first part is read.
func TestRefusedMultipartWritesNothing(t *testing.T) {
	h := uploadHarness(t)
	h.sessions.start(testOSUser, LiveSession{Name: "theirs", State: "done"})

	h.decodeJSON(h.postMultipart("theirs", textPart("hi"), filePart("a.png", "image/png", pngBytes(100))), http.StatusForbidden, nil)
	h.decodeJSON(h.postMultipart("ghost", textPart("hi"), filePart("a.png", "image/png", pngBytes(100))), http.StatusNotFound, nil)
	for _, s := range []string{"theirs", "ghost"} {
		if names := h.stored(s); len(names) != 0 {
			t.Fatalf("a refused message stored %v under %s", names, s)
		}
	}
}

// Hostile filenames stay inside the session's directory, and two files with
// the same name are both kept.
func TestFilenamesAreSafeAndNeverClobber(t *testing.T) {
	h := uploadHarness(t)
	h.decodeJSON(h.postMultipart("c1",
		textPart("hi"),
		filePart("../../../etc/passwd", "text/plain", []byte("one")),
		filePart("../../../etc/passwd", "text/plain", []byte("two")),
		filePart(".hidden", "text/plain", []byte("three"))),
		http.StatusAccepted, nil)

	names := h.stored("c1")
	if len(names) != 3 {
		t.Fatalf("stored %v, want three distinct files", names)
	}
	contents := map[string]bool{}
	for _, n := range names {
		if !strings.HasPrefix(n, "file-") {
			t.Errorf("name %q does not carry the document prefix", n)
		}
		b, _ := os.ReadFile(filepath.Join(h.storeDir("c1"), n))
		contents[string(b)] = true
	}
	for _, want := range []string{"one", "two", "three"} {
		if !contents[want] {
			t.Errorf("content %q was lost: %v", want, names)
		}
	}
	if _, err := os.Stat(filepath.Join(h.srv.StoreRoot, "etc")); err == nil {
		t.Fatal("a traversal filename escaped the session directory")
	}
}

// The trace records what was sent without the bytes: the text, and for each
// file its original name, type, size and where it was stored.
func TestTraceRecordsAttachmentsNotTheirBytes(t *testing.T) {
	h := uploadHarness(t)
	h.decodeJSON(h.postMultipart("c1", textPart("look"), filePart("shot.png", "image/png", pngBytes(700))), http.StatusAccepted, nil)

	var entry *TraceEntry
	for _, e := range h.traceLines() {
		if e.Verb == "POST /v1/conversations/{id}/messages" {
			e := e
			entry = &e
		}
	}
	if entry == nil {
		t.Fatal("no trace line for the message")
	}
	var req struct {
		Text  string `json:"text"`
		Files []struct {
			Name  string `json:"name"`
			Type  string `json:"type"`
			Bytes int64  `json:"bytes"`
			Path  string `json:"path"`
		} `json:"files"`
	}
	if err := json.Unmarshal(entry.Request, &req); err != nil {
		t.Fatalf("trace request %s: %v", entry.Request, err)
	}
	if req.Text != "look" || len(req.Files) != 1 {
		t.Fatalf("trace request %s", entry.Request)
	}
	f := req.Files[0]
	if f.Name != "shot.png" || f.Type != "image/png" || f.Bytes != 700 || !strings.HasPrefix(f.Path, h.storeDir("c1")) {
		t.Fatalf("trace file %+v", f)
	}
	if bytes.Contains(entry.Request, []byte("PNG")) {
		t.Fatal("the trace carries the file's bytes")
	}
}

// tripwire is a request body that fails the test if anything reads past the
// first few kilobytes of it. It stands in for a 50 MB upload from a client
// that holds no credential.
type tripwire struct {
	t     *testing.T
	limit int64
	size  int64
	read  atomic.Int64
}

func (r *tripwire) Read(p []byte) (int, error) {
	n := r.read.Load()
	if n >= r.size {
		return 0, io.EOF
	}
	if n >= r.limit {
		r.t.Errorf("an unauthenticated body was read past %d bytes", r.limit)
		return 0, io.ErrUnexpectedEOF
	}
	k := int64(len(p))
	if k > r.size-n {
		k = r.size - n
	}
	for i := range p[:k] {
		p[i] = 'x'
	}
	r.read.Add(k)
	return int(k), nil
}

// The bearer check runs before any body byte is read, so a client with no
// credential cannot make this service accept, buffer or spool an upload.
func TestUnauthenticatedUploadIsRefusedUnread(t *testing.T) {
	for _, c := range []struct{ name, auth string }{
		{"no credential", ""},
		{"an unknown token", "Bearer " + strings.Repeat("q", 40)},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := uploadHarness(t)
			body := &tripwire{t: t, limit: 4 << 10, size: 50 << 20}
			r := httptest.NewRequest("POST", "/v1/conversations/c1/messages", body)
			r.Header.Set("Content-Type", "multipart/form-data; boundary=xyz")
			r.ContentLength = body.size
			if c.auth != "" {
				r.Header.Set("Authorization", c.auth)
			}
			w := httptest.NewRecorder()
			h.handler.ServeHTTP(w, r)
			if w.Code != http.StatusUnauthorized {
				t.Fatalf("status %d, want 401: %s", w.Code, w.Body.String())
			}
			if n := body.read.Load(); n != 0 {
				t.Fatalf("%d body bytes were read before the credential was refused", n)
			}
			if names := h.stored("c1"); len(names) != 0 {
				t.Fatalf("an unauthenticated upload stored %v", names)
			}
		})
	}
}

// slowBody delivers its bytes in chunks with a pause between them, the way a
// large upload arrives over a slow link.
type slowBody struct {
	data  []byte
	chunk int
	pause time.Duration
}

func (s *slowBody) Read(p []byte) (int, error) {
	if len(s.data) == 0 {
		return 0, io.EOF
	}
	time.Sleep(s.pause)
	n := s.chunk
	if n > len(s.data) {
		n = len(s.data)
	}
	n = copy(p, s.data[:n])
	s.data = s.data[n:]
	return n, nil
}

// The server's read timeout is short, because every other body here is a
// small JSON object. An upload outlives it: the route lifts the read deadline
// for its own request, after the credential is checked, through the same
// middleware production runs it behind.
func TestASlowUploadOutlivesTheServerReadTimeout(t *testing.T) {
	h := uploadHarness(t)
	h.srv.UploadTimeout = 10 * time.Second

	tm := telemetry.NewTiming(nil, telemetry.TimingOpts{})
	ts := httptest.NewUnstartedServer(tm.Wrap(h.handler))
	ts.Config.ReadTimeout = 100 * time.Millisecond
	ts.Config.ReadHeaderTimeout = 100 * time.Millisecond
	ts.Start()
	defer ts.Close()

	buf, ctype := multipartBody(t, textPart("slow"), filePart("shot.png", "image/png", pngBytes(900)))
	// Ten chunks 50 ms apart: half a second, five times the read timeout.
	body := &slowBody{data: buf.Bytes(), chunk: buf.Len()/10 + 1, pause: 50 * time.Millisecond}
	req, _ := http.NewRequest("POST", ts.URL+"/v1/conversations/c1/messages", body)
	req.ContentLength = int64(buf.Len())
	req.Header.Set("Content-Type", ctype)
	req.Header.Set("Authorization", "Bearer "+testToken)

	client := &http.Client{Transport: &http.Transport{DialContext: (&net.Dialer{}).DialContext}}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("the upload was cut off: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("status %d: %s", resp.StatusCode, b)
	}
	if names := h.stored("c1"); len(names) != 1 {
		t.Fatalf("stored %v", names)
	}
}
