package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// setupUser wires the auth map + home root for handler tests: the Authentik
// identity "alice" maps to the CURRENT OS user (so resolveOSUser's user.Lookup
// gate passes), and homeBase is pointed at a temp dir so /home/<osUser> is a
// scratch directory we own. Returns the home path.
func setupUser(t *testing.T) (osUser, home string) {
	t.Helper()
	me, err := user.Current()
	if err != nil {
		t.Fatalf("user.Current: %v", err)
	}
	base := t.TempDir()
	old := homeBase
	homeBase = base
	t.Cleanup(func() { homeBase = old })
	home = filepath.Join(base, me.Username)
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	withUserMap(t, "alice="+me.Username+"\n")
	return me.Username, home
}

func req(t *testing.T, method, target string, body io.Reader, auth bool) *http.Request {
	t.Helper()
	r := httptest.NewRequest(method, target, body)
	if auth {
		r.Header.Set(authHeader, "alice")
	}
	return r
}

// --- /files/list ------------------------------------------------------------

func TestHandleListHappyHidesDotfilesAndSortsDirsFirst(t *testing.T) {
	_, home := setupUser(t)
	writeFile(t, filepath.Join(home, "beta.txt"), "b")
	writeFile(t, filepath.Join(home, "alpha.txt"), "a")
	if err := os.MkdirAll(filepath.Join(home, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(home, ".hidden"), "secret")

	rec := httptest.NewRecorder()
	handleList(rec, req(t, http.MethodGet, "/files/list?dir="+home, nil, true))
	if rec.Code != http.StatusOK {
		t.Fatalf("list: got %d (%s)", rec.Code, rec.Body.String())
	}
	var entries []fileEntry
	if err := json.Unmarshal(rec.Body.Bytes(), &entries); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body.String())
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name)
		if e.Name == ".hidden" {
			t.Fatalf("dotfile .hidden leaked into listing")
		}
	}
	// dirs first, then files alphabetically: sub, alpha.txt, beta.txt
	want := []string{"sub", "alpha.txt", "beta.txt"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("listing order/content: got %v, want %v", names, want)
	}
	// The "sub" entry must be flagged as a directory with a usable path.
	for _, e := range entries {
		if e.Name == "sub" {
			if !e.IsDir {
				t.Fatalf("sub: isDir=false, want true")
			}
			if e.Path != filepath.Join(home, "sub") && e.Path != mustReal(t, filepath.Join(home, "sub")) {
				t.Fatalf("sub path: got %q", e.Path)
			}
		}
	}
}

func TestHandleListAllIncludesDotfiles(t *testing.T) {
	_, home := setupUser(t)
	writeFile(t, filepath.Join(home, ".hidden"), "secret")
	rec := httptest.NewRecorder()
	handleList(rec, req(t, http.MethodGet, "/files/list?all=1&dir="+home, nil, true))
	if rec.Code != http.StatusOK {
		t.Fatalf("list all: got %d (%s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), ".hidden") {
		t.Fatalf("?all=1 should include dotfiles, got %s", rec.Body.String())
	}
}

func TestHandleListMissingDir404(t *testing.T) {
	_, home := setupUser(t)
	rec := httptest.NewRecorder()
	handleList(rec, req(t, http.MethodGet, "/files/list?dir="+filepath.Join(home, "nope"), nil, true))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing dir: got %d, want 404", rec.Code)
	}
}

func TestHandleListNotADir400(t *testing.T) {
	_, home := setupUser(t)
	f := filepath.Join(home, "file.txt")
	writeFile(t, f, "x")
	rec := httptest.NewRecorder()
	handleList(rec, req(t, http.MethodGet, "/files/list?dir="+f, nil, true))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("list on a file: got %d, want 400", rec.Code)
	}
}

func TestHandleListTraversalRejected(t *testing.T) {
	_, home := setupUser(t)
	for _, dir := range []string{"/etc", home + "/../..", ""} {
		rec := httptest.NewRecorder()
		handleList(rec, req(t, http.MethodGet, "/files/list?dir="+dir, nil, true))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("list dir=%q: got %d, want 400", dir, rec.Code)
		}
	}
}

// --- /files/read ------------------------------------------------------------

func TestHandleReadHappy(t *testing.T) {
	_, home := setupUser(t)
	f := filepath.Join(home, "hello.txt")
	writeFile(t, f, "hello world")
	rec := httptest.NewRecorder()
	handleRead(rec, req(t, http.MethodGet, "/files/read?path="+f, nil, true))
	if rec.Code != http.StatusOK {
		t.Fatalf("read: got %d (%s)", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != "hello world" {
		t.Fatalf("read body: got %q", rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Fatalf("read content-type: got %q, want text/plain*", ct)
	}
}

// SVG is the one previewable image whose type the browser will not guess.
// http.DetectContentType has no SVG signature, so it sniffs the source as
// text/plain — and Chrome refuses to parse an SVG document out of an <img>
// unless the type is exactly image/svg+xml. The preview routes .svg to the
// image kind (and offers no Raw/Edit fallback there), so a text/plain SVG was
// unviewable anywhere in the app.
func TestHandleReadSVGGetsImageSVGContentType(t *testing.T) {
	_, home := setupUser(t)
	for _, name := range []string{"pic.svg", "PIC.SVG"} {
		f := filepath.Join(home, name)
		writeFile(t, f, `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"></svg>`)
		rec := httptest.NewRecorder()
		handleRead(rec, req(t, http.MethodGet, "/files/read?path="+f, nil, true))
		if rec.Code != http.StatusOK {
			t.Fatalf("read %s: got %d (%s)", name, rec.Code, rec.Body.String())
		}
		if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "image/svg+xml") {
			t.Fatalf("%s content-type: got %q, want image/svg+xml", name, ct)
		}
	}
}

// The SVG special case must stay exactly one extension wide: every raster
// format still gets its sniffed type (and Chrome content-sniffs those in an
// <img> anyway, so none of them needed help).
func TestHandleReadRasterKeepsSniffedContentType(t *testing.T) {
	_, home := setupUser(t)
	f := filepath.Join(home, "pic.png")
	// 1x1 PNG: the 8-byte signature is all DetectContentType reads.
	writeFile(t, f, "\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")
	rec := httptest.NewRecorder()
	handleRead(rec, req(t, http.MethodGet, "/files/read?path="+f, nil, true))
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "image/png") {
		t.Fatalf("png content-type: got %q, want image/png", ct)
	}
}

func TestHandleReadMissing404(t *testing.T) {
	_, home := setupUser(t)
	rec := httptest.NewRecorder()
	handleRead(rec, req(t, http.MethodGet, "/files/read?path="+filepath.Join(home, "nope.txt"), nil, true))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("read missing: got %d, want 404", rec.Code)
	}
}

func TestHandleReadDirectory400(t *testing.T) {
	_, home := setupUser(t)
	rec := httptest.NewRecorder()
	handleRead(rec, req(t, http.MethodGet, "/files/read?path="+home, nil, true))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("read a directory: got %d, want 400", rec.Code)
	}
}

func TestHandleReadTooLarge413(t *testing.T) {
	_, home := setupUser(t)
	f := filepath.Join(home, "big.bin")
	if err := os.WriteFile(f, make([]byte, maxFileSize+1), 0o644); err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	handleRead(rec, req(t, http.MethodGet, "/files/read?path="+f, nil, true))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("read oversize file: got %d, want 413", rec.Code)
	}
}

func TestHandleReadTraversalRejected(t *testing.T) {
	_, home := setupUser(t)
	probes := []string{"/etc/passwd", home + "/../../etc/passwd"}
	for _, p := range probes {
		rec := httptest.NewRecorder()
		handleRead(rec, req(t, http.MethodGet, "/files/read?path="+p, nil, true))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("read %q: got %d, want 400", p, rec.Code)
		}
	}
}

func TestHandleReadSymlinkEscapeRejected(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink semantics differ on windows")
	}
	_, home := setupUser(t)
	outside := t.TempDir()
	writeFile(t, filepath.Join(outside, "secret"), "top-secret")
	if err := os.Symlink(outside, filepath.Join(home, "escape")); err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	handleRead(rec, req(t, http.MethodGet, "/files/read?path="+filepath.Join(home, "escape", "secret"), nil, true))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("read via symlink escape: got %d, want 400", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "top-secret") {
		t.Fatalf("symlink escape leaked file contents")
	}
}

// --- /files/write -----------------------------------------------------------

func writeReq(t *testing.T, path, content string, auth bool) *http.Request {
	t.Helper()
	b, _ := json.Marshal(map[string]string{"path": path, "content": content})
	return req(t, http.MethodPost, "/files/write", strings.NewReader(string(b)), auth)
}

func TestHandleWriteCreatesFile(t *testing.T) {
	_, home := setupUser(t)
	target := filepath.Join(home, "new.txt")
	rec := httptest.NewRecorder()
	handleWrite(rec, writeReq(t, target, "fresh content", true))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("write: got %d (%s)", rec.Code, rec.Body.String())
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("readback: %v", err)
	}
	if string(got) != "fresh content" {
		t.Fatalf("written content: got %q", string(got))
	}
}

func TestHandleWriteOverwrites(t *testing.T) {
	_, home := setupUser(t)
	target := filepath.Join(home, "edit.txt")
	writeFile(t, target, "old")
	rec := httptest.NewRecorder()
	handleWrite(rec, writeReq(t, target, "new", true))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("overwrite: got %d (%s)", rec.Code, rec.Body.String())
	}
	got, _ := os.ReadFile(target)
	if string(got) != "new" {
		t.Fatalf("overwrite content: got %q, want new", string(got))
	}
}

func TestHandleWriteMissingParent404(t *testing.T) {
	_, home := setupUser(t)
	rec := httptest.NewRecorder()
	handleWrite(rec, writeReq(t, filepath.Join(home, "nodir", "f.txt"), "x", true))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("write into missing dir: got %d, want 404", rec.Code)
	}
}

func TestHandleWriteTooLarge413(t *testing.T) {
	_, home := setupUser(t)
	big := strings.Repeat("a", maxFileSize+1)
	rec := httptest.NewRecorder()
	handleWrite(rec, writeReq(t, filepath.Join(home, "big.txt"), big, true))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize write: got %d, want 413", rec.Code)
	}
	if _, err := os.Stat(filepath.Join(home, "big.txt")); !os.IsNotExist(err) {
		t.Fatalf("oversize write must not create the file")
	}
}

func TestHandleWriteTraversalRejected(t *testing.T) {
	_, home := setupUser(t)
	// A path outside home must be refused AND must not create anything.
	outsideProbe := filepath.Join(t.TempDir(), "evil.txt")
	for _, p := range []string{"/tmp/file-api-evil.txt", home + "/../../etc/evil", outsideProbe} {
		rec := httptest.NewRecorder()
		handleWrite(rec, writeReq(t, p, "pwned", true))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("write %q: got %d, want 400", p, rec.Code)
		}
	}
	if _, err := os.Stat(outsideProbe); !os.IsNotExist(err) {
		t.Fatalf("traversal write created a file outside home")
	}
}

func TestHandleWriteSymlinkEscapeRejected(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink semantics differ on windows")
	}
	_, home := setupUser(t)
	outside := t.TempDir()
	victim := filepath.Join(outside, "victim")
	writeFile(t, victim, "original")
	if err := os.Symlink(victim, filepath.Join(home, "leaf")); err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	handleWrite(rec, writeReq(t, filepath.Join(home, "leaf"), "clobbered", true))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("write through leaf symlink: got %d, want 400", rec.Code)
	}
	got, _ := os.ReadFile(victim)
	if string(got) != "original" {
		t.Fatalf("symlink escape clobbered outside file: %q", string(got))
	}
}

func TestHandleWriteInvalidJSON400(t *testing.T) {
	setupUser(t)
	rec := httptest.NewRecorder()
	handleWrite(rec, req(t, http.MethodPost, "/files/write", strings.NewReader("{not json"), true))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid json: got %d, want 400", rec.Code)
	}
}

// --- cross-cutting: auth + method guards on every endpoint ------------------

func TestEndpointsRequireAuth(t *testing.T) {
	setupUser(t)
	cases := []struct {
		name    string
		handler http.HandlerFunc
		method  string
	}{
		{"list", handleList, http.MethodGet},
		{"read", handleRead, http.MethodGet},
		{"write", handleWrite, http.MethodPost},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		c.handler(rec, req(t, c.method, "/files/"+c.name, nil, false))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s without auth: got %d, want 401", c.name, rec.Code)
		}
	}
}

func TestEndpointsRejectWrongMethod(t *testing.T) {
	setupUser(t)
	cases := []struct {
		name    string
		handler http.HandlerFunc
		bad     string
	}{
		{"list", handleList, http.MethodPost},
		{"read", handleRead, http.MethodDelete},
		{"write", handleWrite, http.MethodGet},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		c.handler(rec, req(t, c.bad, "/files/"+c.name, nil, true))
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s %s: got %d, want 405", c.bad, c.name, rec.Code)
		}
	}
}

func mustReal(t *testing.T, p string) string {
	t.Helper()
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		return p
	}
	return r
}
