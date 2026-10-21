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
//
// It also keeps the real tmux-user-attach the suite runs from reaching
// session-events on this box.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "tmux-api-test")
	if err != nil {
		panic(err)
	}
	actAsGate = &authuser.Gate{
		AdminsPath: filepath.Join(dir, "no-admins"),
		MapPath:    filepath.Join(dir, "no-user-map"),
		// The paired-device registry, so no test reads the box's real one or
		// writes into /var/lib.
		Config: authuser.Config{
			MultiUser:       "on",
			DevicesPath:     filepath.Join(dir, "devices.json"),
			DevicesSeenPath: filepath.Join(dir, "devices-seen.json"),
		},
	}
	mapPath = actAsGate.MapPath
	// The public-link store, so no test reads or writes the box's real
	// links.json.
	linkStoreInstance = newLinkStore(filepath.Join(dir, "links.json"))
	// A guest's watch attach rewraps the owner's tmux bindings
	// (sessionio.GuardReadOnly). Run for real, it reaches the tmux server of
	// whoever runs the suite and rewrites their live bindings, and on a runner
	// with no tmux server it fails the attach. The tests that are about the
	// guard install their own.
	guardReadOnly = func(string) error { return nil }
	// tmux-user-attach posts each claim to session-events (POST /hooks/claimed).
	// The suite runs the real script, and on a deployed box localhost:7685 is
	// the LIVE service, so the post goes to a port nothing listens on instead.
	// A test that checks the post replaces curl itself (stubCurl).
	_ = os.Setenv("TL_CLAIMED_ENDPOINT", "http://127.0.0.1:9/hooks/claimed")
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}
