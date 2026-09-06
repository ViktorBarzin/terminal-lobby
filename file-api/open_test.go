package main

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// stubWriteLeafELOOP stages the one case the real filesystem cannot: a symlink
// renamed over the leaf between the handler's Lstat and the open, which comes
// back from the open as ELOOP. Anything a test can set up statically is a
// symlink the Lstat already sees, so this is how the raced answer gets asserted.
func stubWriteLeafELOOP(t *testing.T) {
	t.Helper()
	old := writeLeaf
	writeLeaf = func(path string, _ []byte, _ os.FileMode) error {
		return &fs.PathError{Op: "open", Path: path, Err: syscall.ELOOP}
	}
	t.Cleanup(func() { writeLeaf = old })
}

// TL-9. resolveWithin hands back a plain string and nothing pins the inode, so
// between the check and the open a co-owner with `rwx` on the directory can
// rename a symlink over the leaf. Both opens refuse to follow one, which closes
// the leaf half of that window (the directory-component half needs openat).
func TestOpenForReadRefusesASymlinkLeaf(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	if err := os.WriteFile(target, []byte("owner only"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "swapped")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}

	f, err := openForRead(link)
	if err == nil {
		f.Close()
		t.Fatal("read followed a symlink that appeared after the check")
	}
}

func TestOpenForReadOpensARegularFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), "plain")
	if err := os.WriteFile(p, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	f, err := openForRead(p)
	if err != nil {
		t.Fatalf("regular file must still open: %v", err)
	}
	defer f.Close()
	buf := make([]byte, 5)
	if _, err := f.Read(buf); err != nil || string(buf) != "hello" {
		t.Fatalf("read back %q, %v", buf, err)
	}
}

func TestWriteNoFollowRefusesASymlinkLeaf(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	if err := os.WriteFile(target, []byte("owner only"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "swapped")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}

	if err := writeNoFollow(link, []byte("clobbered"), 0o644); err == nil {
		t.Fatal("write followed a symlink that appeared after the check")
	}
	if got, _ := os.ReadFile(target); string(got) != "owner only" {
		t.Fatalf("the symlink target was truncated: %q", got)
	}
}

func TestWriteNoFollowCreatesAndTruncates(t *testing.T) {
	p := filepath.Join(t.TempDir(), "note.txt")
	if err := writeNoFollow(p, []byte("first draft"), 0o644); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := writeNoFollow(p, []byte("short"), 0o644); err != nil {
		t.Fatalf("overwrite: %v", err)
	}
	got, err := os.ReadFile(p)
	if err != nil || string(got) != "short" {
		t.Fatalf("read back %q, %v — the second write must truncate", got, err)
	}
}

// The 404 the handlers give a missing parent directory comes from the error
// class, so the new open has to keep answering with it.
func TestWriteNoFollowMissingParentStaysNotExist(t *testing.T) {
	p := filepath.Join(t.TempDir(), "nope", "note.txt")
	err := writeNoFollow(p, []byte("x"), 0o644)
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("missing parent gave %v, want fs.ErrNotExist", err)
	}
}
