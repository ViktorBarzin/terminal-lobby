package clipstore

import (
	"bytes"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Real magic bytes for the formats the store distinguishes. Enough of each
// header for http.DetectContentType to recognise it, padded so a reader that
// stops at the sniff length still sees a whole file's worth of bytes.
var (
	pngHead  = []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")
	jpegHead = []byte("\xff\xd8\xff\xe0\x00\x10JFIF\x00")
	gifHead  = []byte("GIF89a\x01\x00\x01\x00")
	webpHead = []byte("RIFF\x24\x00\x00\x00WEBPVP8 ")
	// An AVIF ftyp box: size 0x1c, major brand avif, minor 0, compat mif1 miaf.
	avifHead = []byte("\x00\x00\x00\x1cftypavif\x00\x00\x00\x00mif1miafMA1B")
	// An mp4 ftyp box: same container, a video brand, which is not an image.
	mp4Head = []byte("\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2")
)

func TestSniff(t *testing.T) {
	for _, c := range []struct {
		name string
		head []byte
		want string
	}{
		{"png", pngHead, "image/png"},
		{"jpeg", jpegHead, "image/jpeg"},
		{"gif", gifHead, "image/gif"},
		{"webp", webpHead, "image/webp"},
		// The reason Sniff exists rather than DetectContentType alone: AVIF
		// sniffs as application/octet-stream there.
		{"avif", avifHead, "image/avif"},
		{"mp4 is not an image", mp4Head, "application/octet-stream"},
		{"plain text named .png", []byte("this is not a png at all"), "text/plain; charset=utf-8"},
		{"pdf", []byte("%PDF-1.7\n"), "application/pdf"},
		{"empty", nil, "text/plain; charset=utf-8"},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := Sniff(c.head); got != c.want {
				t.Fatalf("Sniff = %q, want %q", got, c.want)
			}
		})
	}
}

func TestISOBMFFImageType(t *testing.T) {
	heic := []byte("\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic")
	// A box size larger than what was read must clamp, not index past the end.
	lying := []byte("\x7f\xff\xff\xffftypisom\x00\x00\x00\x00iso2avif")
	for _, c := range []struct {
		name string
		head []byte
		want string
	}{
		{"avif", avifHead, "image/avif"},
		{"heic", heic, "image/heif"},
		{"mp4", mp4Head, ""},
		{"oversized box size clamps", lying, "image/avif"},
		{"too short", []byte("\x00\x00\x00\x08ftyp"), ""},
		{"not ftyp", pngHead, ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := ISOBMFFImageType(c.head); got != c.want {
				t.Fatalf("ISOBMFFImageType = %q, want %q", got, c.want)
			}
		})
	}
}

func TestSanitizeName(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"report.pdf", "report.pdf"},
		{"../../etc/passwd", "passwd"},
		{`..\..\windows\system.ini`, "system.ini"},
		{".bashrc", "bashrc"},
		{"...", "file"},
		{"", "file"},
		{"/", "_"},
		{"q3 plan (final).xlsx", "q3_plan__final_.xlsx"},
		{"résumé.txt", "r_sum_.txt"},
		{strings.Repeat("a", 200) + ".txt", strings.Repeat("a", 124) + ".txt"},
	} {
		t.Run(c.in, func(t *testing.T) {
			got := SanitizeName(c.in)
			if got != c.want {
				t.Fatalf("SanitizeName(%q) = %q, want %q", c.in, got, c.want)
			}
			// Whatever the input, the result is one safe path element.
			if got != filepath.Base(got) || strings.HasPrefix(got, ".") || strings.Contains(got, "/") {
				t.Fatalf("SanitizeName(%q) = %q is not a clean basename", c.in, got)
			}
		})
	}
}

func TestBucket(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"agent-01M2KR6R0079D934XTRGMJVSF3", "agent-01M2KR6R0079D934XTRGMJVSF3"},
		{"my_session", "my_session"},
		{"", UnsortedSession},
		{"../other", UnsortedSession},
		{"has space", UnsortedSession},
		{strings.Repeat("x", 33), UnsortedSession},
	} {
		if got := Bucket(c.in); got != c.want {
			t.Errorf("Bucket(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestImageExt(t *testing.T) {
	for ct, want := range map[string]string{
		"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif",
		"image/webp": ".webp", "image/bmp": ".png",
	} {
		if got := ImageExt(ct); got != want {
			t.Errorf("ImageExt(%q) = %q, want %q", ct, got, want)
		}
	}
}

// The names the store writes are what the gallery and the cleaner key on, so
// their shape is the contract: prefix, timestamp, random token, then the rest.
func TestNames(t *testing.T) {
	pasted := regexp.MustCompile(`^pasted-\d{8}-\d{6}-[0-9a-f]{8}\.jpg$`)
	if n := PastedName("image/jpeg"); !pasted.MatchString(n) {
		t.Errorf("PastedName = %q", n)
	}
	attach := regexp.MustCompile(`^file-\d{8}-\d{6}-[0-9a-f]{8}-passwd$`)
	if n := AttachName("../../etc/passwd"); !attach.MatchString(n) {
		t.Errorf("AttachName = %q", n)
	}
	// Two names in the same second differ, which is what the token is for.
	if PastedName("image/png") == PastedName("image/png") {
		t.Error("two pasted names in the same second collided")
	}
}

func TestSaveToStore(t *testing.T) {
	root := t.TempDir()
	path, err := SaveToStore(root, "wizard", "s1", "file-x.txt", strings.NewReader("hello"))
	if err != nil {
		t.Fatalf("SaveToStore: %v", err)
	}
	if want := filepath.Join(root, "wizard", "s1", "file-x.txt"); path != want {
		t.Fatalf("path %q, want %q", path, want)
	}
	if b, _ := os.ReadFile(path); string(b) != "hello" {
		t.Fatalf("content %q", b)
	}
	// ADR-0005's modes. The umask can only narrow them, so assert no wider.
	info, _ := os.Stat(filepath.Dir(path))
	if info.Mode().Perm()&^0o755 != 0 {
		t.Errorf("directory mode %v is wider than 0755", info.Mode().Perm())
	}
	finfo, _ := os.Stat(path)
	if finfo.Mode().Perm()&^0o644 != 0 {
		t.Errorf("file mode %v is wider than 0644", finfo.Mode().Perm())
	}
}

// A name that is already taken is refused, never overwritten: a store file is
// something a conversation already points at.
func TestSaveNeverClobbers(t *testing.T) {
	dir := t.TempDir()
	if _, err := Save(dir, "a.txt", strings.NewReader("first")); err != nil {
		t.Fatal(err)
	}
	_, err := Save(dir, "a.txt", strings.NewReader("second"))
	if !errors.Is(err, fs.ErrExist) {
		t.Fatalf("second save: err %v, want fs.ErrExist", err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "a.txt")); string(b) != "first" {
		t.Fatalf("the first file was overwritten: %q", b)
	}
}

// A copy that fails part way leaves nothing behind.
func TestSaveRemovesAPartialFile(t *testing.T) {
	dir := t.TempDir()
	boom := errors.New("the client went away")
	src := io.MultiReader(bytes.NewReader([]byte("half a file")), errReader{boom})
	if _, err := Save(dir, "half.bin", src); !errors.Is(err, boom) {
		t.Fatalf("err %v, want the reader's error", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "half.bin")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("a partial file was left behind: %v", err)
	}
}

// Names that are not one clean path element are refused before touching disk.
func TestSaveRefusesUnsafeNames(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"", ".", "..", "../escape", "a/b", ".hidden"} {
		if _, err := SaveToStore(root, "wizard", "s1", name, strings.NewReader("x")); err == nil {
			t.Errorf("name %q was accepted", name)
		}
	}
	for _, user := range []string{"", "..", "a/b"} {
		if _, err := SaveToStore(root, user, "s1", "ok.txt", strings.NewReader("x")); err == nil {
			t.Errorf("user %q was accepted", user)
		}
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(root), "escape")); err == nil {
		t.Fatal("a traversal name wrote outside the store")
	}
}

type errReader struct{ err error }

func (e errReader) Read([]byte) (int, error) { return 0, e.err }
