package main

import (
	"os"
	"path/filepath"
	"testing"

	"terminal-lobby/authuser"
)

// TestMain keeps the suite hermetic. The gate's default map path is
// /etc/ttyd-user-map, which exists on a deployed box and does not exist in CI —
// so without this, the same test reads real identities on one machine and an
// empty map on the other.
//
// The default is pointed at a path that does not exist, and the mode is forced
// on. That reproduces exactly what the per-service loadUserMap did before the
// gate absorbed it: a missing map yields no accounts, so an identity resolves
// to nobody and the handler answers 403. Tests that want a populated map call
// withUserMap, which overrides the path for their duration.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "tmux-api-test")
	if err != nil {
		panic(err)
	}
	actAsGate = &authuser.Gate{
		AdminsPath: filepath.Join(dir, "no-admins"),
		MapPath:    filepath.Join(dir, "no-user-map"),
		Config:     authuser.Config{MultiUser: "on"},
	}
	mapPath = actAsGate.MapPath
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}
