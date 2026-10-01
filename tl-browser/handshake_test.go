package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func TestHostVersionHashesHostAndLockfile(t *testing.T) {
	dir := t.TempDir()
	host := filepath.Join(dir, "host.mjs")
	os.WriteFile(host, []byte("console.log(1)\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "package-lock.json"), []byte(`{"lockfileVersion":3}`), 0o644)

	sum := sha256.Sum256([]byte("console.log(1)\n" + `{"lockfileVersion":3}`))
	want := hex.EncodeToString(sum[:])[:16]

	got, err := HostVersion(host)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("HostVersion = %s, want %s", got, want)
	}

	// Bumping a dependency changes the version, so a stale cache is never read.
	os.WriteFile(filepath.Join(dir, "package-lock.json"), []byte(`{"lockfileVersion":3,"x":1}`), 0o644)
	if again, _ := HostVersion(host); again == got {
		t.Fatalf("a lockfile change did not change the version")
	}
}

func TestHostVersionNeedsTheHost(t *testing.T) {
	if _, err := HostVersion(filepath.Join(t.TempDir(), "missing.mjs")); err == nil {
		t.Fatal("HostVersion of a missing host succeeded")
	}
}

func TestCacheDirFollowsXDG(t *testing.T) {
	cases := []struct {
		name, xdg, home, want string
	}{
		{"xdg set", "/x/cache", "/home/u", "/x/cache/tl-browser"},
		{"xdg unset", "", "/home/u", "/home/u/.cache/tl-browser"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := CacheDir(c.xdg, c.home); got != c.want {
				t.Fatalf("CacheDir = %s, want %s", got, c.want)
			}
		})
	}
}

func TestCachePathCarriesTheVersion(t *testing.T) {
	c := &HandshakeCache{Dir: "/c", Version: "0123456789abcdef"}
	if got := c.Path(); got != "/c/handshake-0123456789abcdef.json" {
		t.Fatalf("Path = %s", got)
	}
}

func TestCorruptCacheIsRedescribed(t *testing.T) {
	dir := t.TempDir()
	c := &HandshakeCache{
		Dir:      dir,
		Version:  "v",
		Describe: []string{os.Args[0], "--describe"},
		Env:      []string{"TLB_FAKE_HOST=1"},
	}
	os.WriteFile(c.Path(), []byte("{not json"), 0o600)
	hs, err := c.Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(hs.Initialize) == 0 || len(hs.Tools) == 0 {
		t.Fatalf("Load = %+v", hs)
	}
}

func TestDescribeFailureIsAnError(t *testing.T) {
	c := &HandshakeCache{
		Dir:      t.TempDir(),
		Version:  "v",
		Describe: []string{"/bin/false"},
	}
	if _, err := c.Load(); err == nil {
		t.Fatal("Load succeeded though describe failed")
	}
	if _, err := os.Stat(c.Path()); err == nil {
		t.Fatal("a failed describe left a cache file")
	}
}
