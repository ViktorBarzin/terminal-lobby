package main

import (
	"encoding/json"
	"os"
)

// writeAtomic writes doc to path through a temp file in dir, so a crash
// mid-write can't leave a truncated document behind. The directory is
// created 0700 and the document lands 0600 — every store here is private
// to one OS user. A trailing newline is appended so the files stay
// readable with cat.
//
// tmpPrefix is a CreateTemp pattern (e.g. "shares.*.tmp"); it only has to
// keep concurrent writers in the same directory from colliding.
func writeAtomic(dir, tmpPrefix, path string, doc []byte) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, tmpPrefix)
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(doc, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// writeAtomicJSON marshals v and stores it with writeAtomic. A value that
// will not marshal is reported before anything on disk is touched.
func writeAtomicJSON(dir, tmpPrefix, path string, v any) error {
	doc, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return writeAtomic(dir, tmpPrefix, path, doc)
}
