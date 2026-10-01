package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// hostTree writes a host directory: host.mjs, a lockfile, and the given lib
// files keyed by their path under lib/.
func hostTree(t *testing.T, lib map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	write := func(rel, body string) {
		p := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("host.mjs", "console.log(1)\n")
	write("package-lock.json", `{"lockfileVersion":3}`)
	for rel, body := range lib {
		write(filepath.Join("lib", rel), body)
	}
	return filepath.Join(dir, "host.mjs")
}

func hostVersion(t *testing.T, host string) string {
	t.Helper()
	v, err := HostVersion(host)
	if err != nil {
		t.Fatal(err)
	}
	if len(v) != 16 {
		t.Fatalf("HostVersion = %q, want 16 hex digits", v)
	}
	return v
}

func TestHostVersionIsStableForTheSameTree(t *testing.T) {
	lib := map[string]string{"a.mjs": "export const a = 1\n", "b.mjs": "export const b = 2\n", "x/c.mjs": "c\n"}
	if a, b := hostVersion(t, hostTree(t, lib)), hostVersion(t, hostTree(t, lib)); a != b {
		t.Fatalf("two identical host trees hash differently: %s, %s", a, b)
	}
}

// Every file the host loads at runtime feeds the key, so an edit to any of them
// describes the host afresh instead of serving the old instructions and tool
// list from the cache.
func TestHostVersionCoversEveryHostSource(t *testing.T) {
	base := map[string]string{"control.mjs": "export const c = 1\n", "deep/tabs.mjs": "export const t = 1\n"}
	want := hostVersion(t, hostTree(t, base))

	for name, edit := range map[string]func(dir string){
		"host.mjs": func(d string) { os.WriteFile(filepath.Join(d, "host.mjs"), []byte("console.log(2)\n"), 0o644) },
		"package-lock": func(d string) {
			os.WriteFile(filepath.Join(d, "package-lock.json"), []byte(`{"lockfileVersion":3,"x":1}`), 0o644)
		},
		"a lib file": func(d string) {
			os.WriteFile(filepath.Join(d, "lib", "control.mjs"), []byte("export const c = 2\n"), 0o644)
		},
		"a nested lib": func(d string) {
			os.WriteFile(filepath.Join(d, "lib", "deep", "tabs.mjs"), []byte("export const t = 2\n"), 0o644)
		},
		"a new lib file": func(d string) { os.WriteFile(filepath.Join(d, "lib", "popup.mjs"), []byte("export {}\n"), 0o644) },
		"a removed lib":  func(d string) { os.Remove(filepath.Join(d, "lib", "control.mjs")) },
		"a renamed lib":  func(d string) { os.Rename(filepath.Join(d, "lib", "control.mjs"), filepath.Join(d, "lib", "gate.mjs")) },
	} {
		t.Run(name, func(t *testing.T) {
			host := hostTree(t, base)
			edit(filepath.Dir(host))
			if got := hostVersion(t, host); got == want {
				t.Fatalf("changing %s left the version at %s", name, got)
			}
		})
	}
}

// Content moving from one file to the next is a different host, even though
// the bytes run together the same.
func TestHostVersionSeparatesFiles(t *testing.T) {
	a := hostVersion(t, hostTree(t, map[string]string{"a.mjs": "xy", "b.mjs": "z"}))
	b := hostVersion(t, hostTree(t, map[string]string{"a.mjs": "x", "b.mjs": "yz"}))
	if a == b {
		t.Fatal("moving bytes between lib files did not change the version")
	}
}

// What is not the host's own source stays out: tests, and anything that is
// not a module.
func TestHostVersionIgnoresWhatTheHostDoesNotLoad(t *testing.T) {
	base := map[string]string{"control.mjs": "export const c = 1\n"}
	want := hostVersion(t, hostTree(t, base))

	host := hostTree(t, base)
	dir := filepath.Dir(host)
	os.MkdirAll(filepath.Join(dir, "test"), 0o755)
	os.WriteFile(filepath.Join(dir, "test", "control.test.mjs"), []byte("test\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "lib", "notes.txt"), []byte("notes\n"), 0o644)
	if got := hostVersion(t, host); got != want {
		t.Fatalf("a test or a non-module file changed the version: %s, want %s", got, want)
	}
}

func TestHostVersionWithoutLibOrLockfile(t *testing.T) {
	dir := t.TempDir()
	host := filepath.Join(dir, "host.mjs")
	os.WriteFile(host, []byte("console.log(1)\n"), 0o644)
	hostVersion(t, host)
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

// Each host release writes a new cache file, so the old ones are pruned as the
// new one lands rather than piling up in ~/.cache. Files that are not handshake
// caches are left alone.
func TestWritingTheCachePrunesOlderHandshakes(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"handshake-0000000000000001.json", "handshake-0000000000000002.json", "notes.txt", "handshake-x.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	c := &HandshakeCache{
		Dir:      dir,
		Version:  "00000000000000ff",
		Describe: []string{os.Args[0], "--describe"},
		Env:      []string{"TLB_FAKE_HOST=1"},
	}
	if _, err := c.Load(); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, e := range entries {
		got = append(got, e.Name())
	}
	want := []string{"handshake-00000000000000ff.json", "handshake-x.txt", "notes.txt"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("cache dir holds %v, want %v", got, want)
	}
}

// A cache hit writes nothing, so it prunes nothing either: a session of an
// older release still running beside a newer one keeps its file.
func TestACacheHitLeavesOtherHandshakes(t *testing.T) {
	dir := t.TempDir()
	c := &HandshakeCache{Dir: dir, Version: "00000000000000ff", Describe: []string{"/bin/false"}}
	other := filepath.Join(dir, "handshake-0000000000000001.json")
	valid := []byte(`{"initialize":{},"tools":{}}`)
	os.WriteFile(other, valid, 0o600)
	os.WriteFile(c.Path(), valid, 0o600)
	if _, err := c.Load(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(other); err != nil {
		t.Fatalf("a cache hit removed another release's handshake: %v", err)
	}
}
