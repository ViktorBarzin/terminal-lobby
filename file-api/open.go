package main

import (
	"io"
	"os"
	"syscall"
)

// The opens below carry O_NOFOLLOW because resolveWithin returns a STRING, not
// a handle: it walks the path, checks containment, and lets go. Every open that
// follows is an independent second walk, and co-ownership hands a peer the
// capability that makes the gap matter — `u:<user>:rwX` on a shared project
// directory is `rwx`, which permits rename(2) inside a directory that sits in
// the owner's home. A symlink renamed over the leaf between the check and the
// open would be followed out of the home the check just proved.
//
// O_NOFOLLOW closes the leaf case only. A component EARLIER in the path swapped
// in the same window still resolves, and closing that needs the walk itself to
// hold each directory open (openat against an O_DIRECTORY parent). That rewrite
// is deliberately not here.

// openForRead opens a regular file for reading and refuses a symlink leaf. The
// caller has already resolved and range-checked the path.
func openForRead(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
}

// readNoFollow is os.ReadFile with the same refusal.
func readNoFollow(path string) ([]byte, error) {
	f, err := openForRead(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(f)
}

// writeLeaf is writeNoFollow behind a var, as a test seam and nothing else.
// The ELOOP that the handlers map to 400 arrives only when a symlink appears at
// the leaf AFTER their Lstat, which no test can stage on a real filesystem, so
// swapping this out is the only way to assert what they do with it. Production
// always runs writeNoFollow.
var writeLeaf = writeNoFollow

// writeNoFollow is os.WriteFile with the same refusal: it creates the file when
// it is missing and truncates it when it is not, but a symlink sitting at the
// leaf gets ELOOP rather than a write through it.
func writeNoFollow(path string, content []byte, perm os.FileMode) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC|syscall.O_NOFOLLOW, perm)
	if err != nil {
		return err
	}
	if _, err := f.Write(content); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
