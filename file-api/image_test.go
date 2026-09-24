package main

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"terminal-lobby/telemetry"
)

// GET /files/image, 2026-09-24. Viktor: "in text mode i would want to be able
// to view images natively. we can distinguish them by file name/path." A
// picture Claude names can sit anywhere the user can read, /tmp included (57 of
// 137 census Reads of an image were under /tmp/claude-1000), so this route has
// no home containment: the OS decides what the user can open, and the route
// decides that only pictures come back.

func pngBytes(t *testing.T) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := png.Encode(&b, image.NewGray(image.Rect(0, 0, 4, 4))); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// getImage asks the route for path as the test's own user, inline.
func getImage(t *testing.T, path string, hdr ...string) *httptest.ResponseRecorder {
	t.Helper()
	r := req(t, http.MethodGet, "/files/image?path="+url.QueryEscape(path), nil, true)
	for i := 0; i+1 < len(hdr); i += 2 {
		r.Header.Set(hdr[i], hdr[i+1])
	}
	rec := httptest.NewRecorder()
	handleImage(rec, r)
	return rec
}

func wantStatus(t *testing.T, rec *httptest.ResponseRecorder, code int, what string) {
	t.Helper()
	if rec.Code != code {
		t.Fatalf("%s: status %d (%q), want %d", what, rec.Code, strings.TrimSpace(rec.Body.String()), code)
	}
	if code >= 400 {
		if got := rec.Header().Get("Cache-Control"); got != "no-store" {
			t.Errorf("%s: an error must not be cached, got Cache-Control %q", what, got)
		}
		if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
			t.Errorf("%s: nosniff missing on an error", what)
		}
	}
}

func TestImageServesAPictureOutsideTheHome(t *testing.T) {
	setupUser(t)
	pic := pngBytes(t)
	p := filepath.Join(t.TempDir(), "shot.png") // not under the test home
	if err := os.WriteFile(p, pic, 0o644); err != nil {
		t.Fatal(err)
	}
	rec := getImage(t, p)
	wantStatus(t, rec, http.StatusOK, "a PNG in a temp dir")
	if !bytes.Equal(rec.Body.Bytes(), pic) {
		t.Fatalf("body is %d bytes, want the %d-byte PNG", rec.Body.Len(), len(pic))
	}
	for k, want := range map[string]string{
		"Content-Type":            "image/png",
		"X-Content-Type-Options":  "nosniff",
		"Cache-Control":           "private, no-cache",
		"Content-Security-Policy": "",
	} {
		if got := rec.Header().Get(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
	if rec.Header().Get("Last-Modified") == "" {
		t.Error("no Last-Modified, so a revalidation cannot answer 304")
	}
}

// An SVG opened in its own tab is a document that could run script. The sniffer
// cannot name SVG, so the extension decides the type, and the sandbox decides
// that nothing in it runs.
func TestImageServesSVGSandboxed(t *testing.T) {
	setupUser(t)
	p := filepath.Join(t.TempDir(), "chart.SVG")
	svg := `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="4" height="4"/></svg>`
	if err := os.WriteFile(p, []byte(svg), 0o644); err != nil {
		t.Fatal(err)
	}
	rec := getImage(t, p)
	wantStatus(t, rec, http.StatusOK, "an SVG")
	if got := rec.Header().Get("Content-Type"); got != "image/svg+xml" {
		t.Errorf("Content-Type = %q, want image/svg+xml", got)
	}
	if got := rec.Header().Get("Content-Security-Policy"); got != "sandbox; default-src 'none'; style-src 'unsafe-inline'" {
		t.Errorf("Content-Security-Policy = %q, want the sandbox", got)
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("nosniff missing")
	}
}

func TestImageRefusesWhatIsNotAPicture(t *testing.T) {
	setupUser(t)
	dir := t.TempDir()
	for name, body := range map[string]string{
		"notes.png": "just some text, named like a picture",
		"page.png":  "<html><script>alert(1)</script></html>",
		"secret":    "root:x:0:0:root:/root:/bin/bash",
	} {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		rec := getImage(t, p)
		wantStatus(t, rec, http.StatusUnsupportedMediaType, name)
		if strings.Contains(rec.Body.String(), body[:10]) {
			t.Fatalf("%s: the refused file's bytes came back", name)
		}
	}
}

func TestImageRefusesABadPath(t *testing.T) {
	_, home := setupUser(t)
	for _, p := range []string{"", "shot.png", "./shot.png", "../x.png", "~/x.png"} {
		wantStatus(t, getImage(t, p), http.StatusBadRequest, "path "+p)
	}
	wantStatus(t, getImage(t, filepath.Join(home, "missing.png")), http.StatusNotFound, "a missing file")
	wantStatus(t, getImage(t, home), http.StatusBadRequest, "a directory")
	wantStatus(t, getImage(t, "/tmp/a\x00.png"), http.StatusBadRequest, "a NUL byte")
}

// Traversal buys nothing: the path is the OS's to resolve, the OS decides what
// the user can open, and whatever it resolves to must still be a picture.
func TestImageTraversalInTheQueryReadsNothingButPictures(t *testing.T) {
	_, home := setupUser(t)
	for _, raw := range []string{
		"/files/image?path=" + home + "/../../../../etc/passwd",
		"/files/image?path=%2Fetc%2F..%2Fetc%2Fpasswd",
		"/files/image?path=/proc/self/environ",
	} {
		rec := httptest.NewRecorder()
		handleImage(rec, req(t, http.MethodGet, raw, nil, true))
		if rec.Code == http.StatusOK {
			t.Fatalf("%s: served", raw)
		}
		if strings.Contains(rec.Body.String(), "root:") || strings.Contains(rec.Body.String(), "PATH=") {
			t.Fatalf("%s: file content came back: %q", raw, rec.Body.String())
		}
	}
}

// A FIFO named like a picture must not hang the request waiting for a writer.
func TestImageFIFOIsRefusedWithoutHanging(t *testing.T) {
	setupUser(t)
	p := filepath.Join(t.TempDir(), "x.png")
	if err := syscall.Mkfifo(p, 0o644); err != nil {
		t.Skipf("no FIFOs here: %v", err)
	}
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- getImage(t, p) }()
	select {
	case rec := <-done:
		wantStatus(t, rec, http.StatusBadRequest, "a FIFO")
	case <-time.After(5 * time.Second):
		t.Fatal("the request hung on a FIFO")
	}
}

// The FIFO is refused by the handle as well as by the stat before it: a path
// swapped between the two still cannot hang the open or be read as a picture.
func TestOpenImageChecksTheHandle(t *testing.T) {
	p := filepath.Join(t.TempDir(), "x.png")
	if err := syscall.Mkfifo(p, 0o644); err != nil {
		t.Skipf("no FIFOs here: %v", err)
	}
	done := make(chan int, 1)
	go func() {
		f, _, _, status, _ := openHandle(p)
		if f != nil {
			f.Close()
		}
		done <- status
	}()
	select {
	case status := <-done:
		if status != http.StatusBadRequest {
			t.Fatalf("status %d for a FIFO handle, want 400", status)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("opening a FIFO hung")
	}
}

func TestImageOversizedIs413(t *testing.T) {
	setupUser(t)
	p := filepath.Join(t.TempDir(), "huge.png")
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	f.Write(pngBytes(t))
	if err := f.Truncate(maxFileSize + 1); err != nil { // sparse: no 10 MB written
		t.Fatal(err)
	}
	f.Close()
	wantStatus(t, getImage(t, p), http.StatusRequestEntityTooLarge, "an 11 MB file")
}

// What the user cannot open is the same answer as what is not there: a caller
// learns nothing their own shell would not tell them.
func TestImageUnreadableIs404(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads everything; permissions cannot be tested as root")
	}
	setupUser(t)
	dir := t.TempDir()
	pic := pngBytes(t)

	locked := filepath.Join(dir, "locked.png")
	os.WriteFile(locked, pic, 0o644)
	os.Chmod(locked, 0)
	t.Cleanup(func() { os.Chmod(locked, 0o644) })
	wantStatus(t, getImage(t, locked), http.StatusNotFound, "a mode-000 file")

	// Another user's home, as far as this user can tell: a directory it may
	// not enter.
	other := filepath.Join(dir, "someone-else")
	os.MkdirAll(other, 0o755)
	os.WriteFile(filepath.Join(other, "private.png"), pic, 0o644)
	os.Chmod(other, 0)
	t.Cleanup(func() { os.Chmod(other, 0o755) })
	wantStatus(t, getImage(t, filepath.Join(other, "private.png")), http.StatusNotFound, "a file in a home it cannot enter")

	// A symlink into the same unreadable place follows the target's rules.
	link := filepath.Join(dir, "innocent.png")
	os.Symlink(filepath.Join(other, "private.png"), link)
	wantStatus(t, getImage(t, link), http.StatusNotFound, "a symlink to an unreadable file")

	dangling := filepath.Join(dir, "dangling.png")
	os.Symlink(filepath.Join(dir, "gone.png"), dangling)
	wantStatus(t, getImage(t, dangling), http.StatusNotFound, "a dangling symlink")
}

func TestImageFollowsSymlinksLikeTheUsersShell(t *testing.T) {
	setupUser(t)
	dir := t.TempDir()
	pic := pngBytes(t)
	os.WriteFile(filepath.Join(dir, "real.png"), pic, 0o644)
	os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("plain text"), 0o644)
	os.Symlink(filepath.Join(dir, "real.png"), filepath.Join(dir, "link.png"))
	os.Symlink(filepath.Join(dir, "notes.txt"), filepath.Join(dir, "sneaky.png"))

	rec := getImage(t, filepath.Join(dir, "link.png"))
	wantStatus(t, rec, http.StatusOK, "a symlink to a PNG")
	if !bytes.Equal(rec.Body.Bytes(), pic) {
		t.Fatal("the symlink did not serve its target")
	}
	wantStatus(t, getImage(t, filepath.Join(dir, "sneaky.png")), http.StatusUnsupportedMediaType, "a symlink to text")
}

// Screenshots are overwritten under the same name, so the picture is stored
// and revalidated rather than trusted for a max-age.
func TestImageRevalidatesWith304(t *testing.T) {
	setupUser(t)
	p := filepath.Join(t.TempDir(), "page-top.png")
	os.WriteFile(p, pngBytes(t), 0o644)
	mod := time.Date(2026, 9, 24, 8, 0, 0, 0, time.UTC)
	os.Chtimes(p, mod, mod)

	rec := getImage(t, p, "If-Modified-Since", mod.Format(http.TimeFormat))
	if rec.Code != http.StatusNotModified {
		t.Fatalf("status %d, want 304", rec.Code)
	}
	later := mod.Add(time.Minute)
	os.Chtimes(p, later, later)
	if rec := getImage(t, p, "If-Modified-Since", mod.Format(http.TimeFormat)); rec.Code != http.StatusOK {
		t.Fatalf("a newer capture under the same name: status %d, want 200", rec.Code)
	}
}

type captured struct{ lines []string }

func (c *captured) Write(line string) { c.lines = append(c.lines, line) }

// file.previewed counts previews people open. Pictures drawn in a timeline are
// not that, and neither is anything else here: no usage event, no path.
func TestImageEmitsNoUsageEvent(t *testing.T) {
	setupUser(t)
	c := &captured{}
	old := events
	events = telemetry.New("file-api", "test", c)
	t.Cleanup(func() { events = old })

	p := filepath.Join(t.TempDir(), "shot.png")
	os.WriteFile(p, pngBytes(t), 0o644)
	wantStatus(t, getImage(t, p), http.StatusOK, "a PNG")
	wantStatus(t, getImage(t, filepath.Join(filepath.Dir(p), "none.png")), http.StatusNotFound, "a missing PNG")
	if len(c.lines) != 0 {
		t.Fatalf("the picture route emitted %d usage event(s): %v", len(c.lines), c.lines)
	}
}

func TestImageGuardsMethodAndIdentity(t *testing.T) {
	setupUser(t)
	rec := httptest.NewRecorder()
	handleImage(rec, req(t, http.MethodPost, "/files/image?path=/tmp/a.png", nil, true))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST: status %d, want 405", rec.Code)
	}
	rec = httptest.NewRecorder()
	handleImage(rec, req(t, http.MethodGet, "/files/image?path=/tmp/a.png", nil, false))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("no identity: status %d, want 401", rec.Code)
	}
}

// --- the privileged leg ------------------------------------------------------

// The child refuses a non-picture itself, so none of its bytes cross the pipe.
func TestOpImageEnvelopeRefusesTextInTheChild(t *testing.T) {
	p := filepath.Join(t.TempDir(), "x.png")
	os.WriteFile(p, []byte("text pretending to be a picture"), 0o644)
	res := opImageEnvelope(p)
	if res.Status != http.StatusUnsupportedMediaType || res.ContentB64 != "" {
		t.Fatalf("status %d with %d base64 characters, want 415 and none", res.Status, len(res.ContentB64))
	}
	pic := pngBytes(t)
	good := filepath.Join(t.TempDir(), "y.png")
	os.WriteFile(good, pic, 0o644)
	res = opImageEnvelope(good)
	got, _ := base64.StdEncoding.DecodeString(res.ContentB64)
	if res.Status != http.StatusOK || !bytes.Equal(got, pic) || res.ContentType != "image/png" || res.MtimeUnix == 0 {
		t.Fatalf("a PNG: %+v", res.Status)
	}
}

// The parent writes the headers, so it holds the envelope to the same rules
// the inline leg applies: the child's status passes through, the CSP comes
// from the extension the CALLER asked for, and a type outside the picture set
// is refused rather than relayed.
func TestWriteImageEnvelope(t *testing.T) {
	pic := pngBytes(t)
	ok := privopResult{Status: http.StatusOK, ContentB64: base64.StdEncoding.EncodeToString(pic),
		ContentType: "image/png", MtimeUnix: time.Date(2026, 9, 24, 8, 0, 0, 0, time.UTC).Unix()}

	rec := httptest.NewRecorder()
	writeImageEnvelope(rec, httptest.NewRequest("GET", "/files/image", nil), ok, "/home/bob/shot.png")
	if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), pic) {
		t.Fatalf("status %d, %d bytes", rec.Code, rec.Body.Len())
	}
	if rec.Header().Get("Cache-Control") != "private, no-cache" || rec.Header().Get("X-Content-Type-Options") != "nosniff" ||
		rec.Header().Get("Last-Modified") == "" || rec.Header().Get("Content-Security-Policy") != "" {
		t.Fatalf("headers: %v", rec.Header())
	}

	svg := privopResult{Status: http.StatusOK, ContentB64: base64.StdEncoding.EncodeToString([]byte("<svg/>")),
		ContentType: "image/svg+xml", MtimeUnix: ok.MtimeUnix}
	rec = httptest.NewRecorder()
	writeImageEnvelope(rec, httptest.NewRequest("GET", "/files/image", nil), svg, "/home/bob/chart.svg")
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Security-Policy") == "" {
		t.Fatalf("an SVG through the child: status %d, CSP %q", rec.Code, rec.Header().Get("Content-Security-Policy"))
	}

	for _, bad := range []struct {
		res  privopResult
		path string
	}{
		{privopResult{Status: http.StatusOK, ContentB64: "PGh0bWw+", ContentType: "text/html; charset=utf-8"}, "/home/bob/x.png"},
		{svg, "/home/bob/x.png"}, // an SVG type for a path that did not ask for one
	} {
		rec = httptest.NewRecorder()
		writeImageEnvelope(rec, httptest.NewRequest("GET", "/files/image", nil), bad.res, bad.path)
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("%q for %s: status %d, want 500", bad.res.ContentType, bad.path, rec.Code)
		}
	}

	for _, status := range []int{http.StatusNotFound, http.StatusUnsupportedMediaType, http.StatusRequestEntityTooLarge} {
		rec = httptest.NewRecorder()
		writeImageEnvelope(rec, httptest.NewRequest("GET", "/files/image", nil),
			privopResult{Status: status, Error: "from the child"}, "/home/bob/x.png")
		wantStatus(t, rec, status, "a child's refusal")
	}
}

// The privileged child gets its op by name, the path as one argv element.
func TestPrivopCommandCarriesTheImageOp(t *testing.T) {
	cmd := privopCommand("bob", "image", "/tmp/claude-1001/a b; rm -rf ~.png", false)
	joined := strings.Join(cmd.Args, "\x00")
	if !strings.Contains(joined, "\x00-privop\x00image\x00-path\x00/tmp/claude-1001/a b; rm -rf ~.png") {
		t.Fatalf("argv: %q", cmd.Args)
	}
}
