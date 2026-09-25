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
	dir, err := os.MkdirTemp("", "skills-api-test")
	if err != nil {
		panic(err)
	}
	actAsGate = &authuser.Gate{
		AdminsPath: filepath.Join(dir, "no-admins"),
		MapPath:    filepath.Join(dir, "no-user-map"),
		Config:     authuser.Config{MultiUser: "on"},
	}
	mapPath = actAsGate.MapPath
	// The skills policy exists on a deployed box (wizard's lists codex) and not in
	// CI; no policy is the default layout. withPolicy sets one per test.
	policyDir = filepath.Join(dir, "no-skills-policy")
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}
