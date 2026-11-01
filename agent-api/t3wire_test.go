package main

import (
	"os"
	"path/filepath"
	"testing"
)

// The T3 token directory holds a credential that acts as each user in T3, so
// it is made private, and narrowed if something made it wider.
func TestT3TokenDirIsPrivate(t *testing.T) {
	state := t.TempDir()
	dir := t3TokenDir(func(k string) string {
		if k == "TL_AGENT_STATE_DIR" {
			return state
		}
		return ""
	})
	if dir != filepath.Join(state, "t3") {
		t.Fatalf("token dir %q, want under the state dir", dir)
	}
	if err := ensurePrivateDir(dir); err != nil {
		t.Fatal(err)
	}
	if fi, err := os.Stat(dir); err != nil || fi.Mode().Perm() != 0o700 {
		t.Fatalf("made %v (%v), want 0700", fi.Mode().Perm(), err)
	}
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := ensurePrivateDir(dir); err != nil {
		t.Fatal(err)
	}
	if fi, _ := os.Stat(dir); fi.Mode().Perm() != 0o700 {
		t.Fatalf("left at %v, want 0700", fi.Mode().Perm())
	}
}

// newT3Client wires what the pass-through needs from the environment, and a
// bad TL_T3_HOSTS costs the links, not the service.
func TestNewT3ClientToleratesABadHostsValue(t *testing.T) {
	state := t.TempDir()
	env := map[string]string{"TL_AGENT_STATE_DIR": state, "TL_T3_HOSTS": "not a pair"}
	c := newT3Client(func(k string) string { return env[k] }, nil)
	if c == nil || c.Service() != "agent-api" {
		t.Fatalf("client %v", c)
	}
}
