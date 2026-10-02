package clipstore

import (
	"os"
	"path/filepath"
	"syscall"
)

// Dir is an open store directory. Files are created and removed relative to
// the directory itself (openat/unlinkat on the descriptor), not by path, so
// they stay reachable when tmux-api's rename cascade moves the directory
// while a write is in flight.
type Dir struct {
	path string
	fd   int
	// private says the directory is the service account's own store, whose
	// files are 0600 (storeModes).
	private bool
}

func openDir(path string) (*Dir, error) {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	return &Dir{path: path, fd: fd}, nil
}

func (d *Dir) create(name string) (*os.File, error) {
	path := filepath.Join(d.path, name)
	fd, err := syscall.Openat(d.fd, name,
		syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, uint32(d.fileMode()))
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	return os.NewFile(uintptr(fd), path), nil
}

func (d *Dir) unlink(name string) error {
	if err := syscall.Unlinkat(d.fd, name); err != nil {
		return &os.PathError{Op: "unlink", Path: filepath.Join(d.path, name), Err: err}
	}
	return nil
}

// Close releases the directory.
func (d *Dir) Close() error { return syscall.Close(d.fd) }

func (d *Dir) fileMode() os.FileMode {
	_, m := storeModes(d.private)
	return m
}
