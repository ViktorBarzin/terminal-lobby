package main

import (
	"os"
	"path/filepath"
	"testing"

	"terminal-lobby/authuser"
)

// TestMain keeps the suite hermetic: the gate's default map path exists on a
// deployed box and not in CI, so without this the same test reads real
// identities on one machine and an empty map on the other.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "clipboard-upload-test")
	if err != nil {
		panic(err)
	}
	actAsGate = &authuser.Gate{
		AdminsPath:       filepath.Join(dir, "no-admins"),
		MapPath:          filepath.Join(dir, "no-user-map"),
		Config:           authuser.Config{MultiUser: "on"},
		SkipAccountCheck: true,
	}
	mapPath = actAsGate.MapPath
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}
