package main

import (
	"os"
	"path/filepath"
	"testing"

	"terminal-lobby/authuser"
)

// TestMain keeps the suite hermetic: the gate's default map path exists on a
// deployed box and not in CI, so without this the same test reads real
// identities on one machine and an empty map on the other. Pointing it at a
// path that does not exist, with the mode forced on, reproduces exactly what
// the per-service loadUserMap did before the gate absorbed it.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "file-api-test")
	if err != nil {
		panic(err)
	}
	actAsGate = &authuser.Gate{
		AdminsPath: filepath.Join(dir, "no-admins"),
		MapPath:    filepath.Join(dir, "no-user-map"),
		Config:     authuser.Config{MultiUser: "on"},
	}
	mapPath = actAsGate.MapPath
	// Every op runs in this process: homeBase points into a temp tree the real
	// sudo path could never reach, and the suite has no identity of its own to
	// compare against (see forceInline in privop.go).
	forceInline = true
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}
