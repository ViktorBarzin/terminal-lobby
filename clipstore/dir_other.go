//go:build !linux

package clipstore

import (
	"os"
	"path/filepath"
)

// Dir is an open store directory. Off Linux it is addressed by path, so a
// directory moved during a write is not followed; the devvm runs Linux.
type Dir struct{ path string }

func openDir(path string) (*Dir, error) {
	if _, err := os.Stat(path); err != nil {
		return nil, err
	}
	return &Dir{path: path}, nil
}

func (d *Dir) create(name string) (*os.File, error) {
	return os.OpenFile(filepath.Join(d.path, name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
}

func (d *Dir) unlink(name string) error { return os.Remove(filepath.Join(d.path, name)) }

// Close releases the directory.
func (d *Dir) Close() error { return nil }
