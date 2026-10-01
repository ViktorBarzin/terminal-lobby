package release

import (
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// What the package installs for a session's browser (ADR-0035): the launcher
// Claude runs as its playwright MCP server, the Node host the launcher starts
// on first use, and the user slice that bounds every host one user runs.

const (
	browserLauncher = "/usr/local/bin/tl-browser"
	browserHostDir  = "/usr/lib/terminal-lobby/tl-browser-host"
	browserSlice    = "/usr/lib/systemd/user/tl-browser.slice"
)

func shippedFile(t *testing.T, dest string) File {
	t.Helper()
	for _, f := range Package.Files {
		if f.Dest == dest {
			return f
		}
	}
	t.Fatalf("the package does not install %s", dest)
	return File{}
}

func shippedTree(t *testing.T, dest string) Tree {
	t.Helper()
	for _, tr := range Package.Trees {
		if tr.Dest == dest {
			return tr
		}
	}
	t.Fatalf("the package does not install the tree %s", dest)
	return Tree{}
}

// Claude Code execs the launcher once per session, so no unit runs it and no
// release restarts anything when it changes: the next session picks it up.
func TestTheBrowserLauncherShipsUnmanaged(t *testing.T) {
	f := shippedFile(t, browserLauncher)
	if f.Src != "bin/tl-browser" {
		t.Errorf("the launcher installs from %q, want bin/tl-browser", f.Src)
	}
	if !f.Unmanaged {
		t.Error("the launcher is not marked unmanaged; Claude runs it per session, no unit does")
	}
	if f.Mode != 0o755 {
		t.Errorf("the launcher installs with mode %o; Claude Code execs it", f.Mode)
	}
}

// The launcher finds the host at a compiled-in path. A package that put the
// host anywhere else would install cleanly and every browser call would fail.
func TestTheBrowserHostShipsWhereTheLauncherLooks(t *testing.T) {
	shippedTree(t, browserHostDir)
	m := regexp.MustCompile(`defaultHostPath\s*=\s*"([^"]+)"`).FindStringSubmatch(repoFile(t, "tl-browser", "main.go"))
	if m == nil {
		t.Fatal("no defaultHostPath constant in tl-browser/main.go, so nothing here knows where the launcher looks")
	}
	if want := browserHostDir + "/host.mjs"; m[1] != want {
		t.Errorf("the launcher looks for the host at %s and the package installs it at %s", m[1], want)
	}
}

// The slice is a user unit: each user's own systemd instance runs one, so its
// ceiling bounds that user's browsers together. No system unit reads it, so it
// is unwatched.
func TestTheBrowserSliceShipsAsAUserUnit(t *testing.T) {
	f := shippedFile(t, browserSlice)
	if f.Src != "devvm/tl-browser.slice" {
		t.Errorf("the slice installs from %q, want devvm/tl-browser.slice", f.Src)
	}
	if !f.Unmanaged {
		t.Error("the slice is not marked unmanaged; no system unit watches a user slice")
	}
	if f.Mode != 0o644 {
		t.Errorf("the slice installs with mode %o, want 644", f.Mode)
	}
	slice := repoFile(t, "devvm", "tl-browser.slice")
	for _, want := range []string{"[Slice]", "MemoryMax=4G", "CPUQuota=800%", "CPUWeight=50"} {
		if !strings.Contains(slice, want) {
			t.Errorf("devvm/tl-browser.slice does not set %s", want)
		}
	}
}

// A Tree's Src is assembled by the build, never present in a checkout, so the
// guards that look for a File's Src in the repo cannot see it. This is the one
// that does: build-deb.sh must write each Tree's Src into the stage.
func TestEveryTreeIsAssembledByTheBuildScript(t *testing.T) {
	build := buildScript(t)
	if len(Package.Trees) == 0 {
		t.Skip("the package installs no trees")
	}
	for _, tr := range Package.Trees {
		if !strings.Contains(build, `"$STAGE/`+tr.Src+`"`) {
			t.Errorf("the manifest installs %s from the staged tree %q, and packaging/build-deb.sh never writes $STAGE/%s",
				tr.Dest, tr.Src, tr.Src)
		}
		if strings.HasPrefix(tr.Dest, ServedAssetDir) {
			t.Errorf("%s would make dpkg own part of the served asset directory", tr.Dest)
		}
	}
}

// The host's node_modules comes from the committed lockfile, production
// dependencies only, and runs no install scripts: the build has no reason to
// execute code a dependency ships.
func TestTheHostDependenciesAreInstalledFromTheLockfile(t *testing.T) {
	build := buildScript(t)
	m := regexp.MustCompile(`npm ci ([^\n]*)`).FindAllStringSubmatch(build, -1)
	var found bool
	for _, line := range m {
		if strings.Contains(line[1], "--omit=dev") {
			found = true
			if !strings.Contains(line[1], "--ignore-scripts") {
				t.Errorf("the host's npm ci runs install scripts: npm ci %s", line[1])
			}
		}
	}
	if !found {
		t.Error("packaging/build-deb.sh runs no `npm ci --omit=dev` for the browser host")
	}
}

var relativeImport = regexp.MustCompile(`from\s+"\./([^"/]+)`)

// The build copies the host's files into the stage by name. A new top-level
// module host.mjs imports and the build does not copy would ship a host that
// dies on its first import.
func TestTheBuildStagesEverythingTheHostImports(t *testing.T) {
	build := buildScript(t)
	host := repoFile(t, "tl-browser", "host", "host.mjs")
	imports := relativeImport.FindAllStringSubmatch(host, -1)
	if len(imports) == 0 {
		t.Fatal("host.mjs imports nothing relative, so this test is reading the wrong file")
	}
	for _, imp := range imports {
		if !strings.Contains(build, filepath.Join("tl-browser/host", imp[1])) {
			t.Errorf("host.mjs imports ./%s and packaging/build-deb.sh does not stage tl-browser/host/%s", imp[1], imp[1])
		}
	}
	for _, f := range []string{"tl-browser/host/host.mjs", "tl-browser/host/package.json", "tl-browser/host/package-lock.json"} {
		if !strings.Contains(build, f) {
			t.Errorf("packaging/build-deb.sh does not stage %s", f)
		}
	}
}

// ---------------------------------------------------------------------------
// The per-browser ceiling.

const browserScopeCap = "/usr/lib/systemd/user/tl-browser-.scope.d/60-tl-browser-cap.conf"

// tl-browser asks for MemoryMax=1536M on each host's scope, and on the devvm
// that request is overridden. The box ships /etc/systemd/user/scope.d/
// 50-devvm-pane-cap.conf, which sets MemoryMax=6G on EVERY user scope, and a
// drop-in outranks the properties a transient unit was created with. Measured
// 2026-10-01: a scope started with `-p MemoryMax=1536M` came up with
// memory.max 6442450944.
//
// The package ships its own drop-in for the tl-browser- prefix. Drop-ins apply
// in filename order across every directory that holds one, so this one has to
// sort after the pane cap to win, and its values have to be the launcher's.
func TestTheBrowserScopeCapOutranksThePaneCap(t *testing.T) {
	f := shippedFile(t, browserScopeCap)
	if !f.Unmanaged {
		t.Error("the scope cap is not marked unmanaged; no system unit watches a user drop-in")
	}
	if base := filepath.Base(browserScopeCap); base <= "50-devvm-pane-cap.conf" {
		t.Errorf("%s sorts before 50-devvm-pane-cap.conf, so the pane cap would win", base)
	}
	conf := repoFile(t, strings.Split(f.Src, "/")...)
	if !strings.Contains(conf, "[Scope]") {
		t.Errorf("%s has no [Scope] section, so systemd applies nothing from it", f.Src)
	}
	spawn := repoFile(t, "tl-browser", "spawn.go")
	for _, key := range []string{"MemoryHigh", "MemoryMax"} {
		m := regexp.MustCompile(`"` + key + `=([^"]+)"`).FindStringSubmatch(spawn)
		if m == nil {
			t.Fatalf("tl-browser/spawn.go sets no %s, so this test is reading the wrong file", key)
		}
		if !regexp.MustCompile(`(?m)^` + key + `=` + regexp.QuoteMeta(m[1]) + `$`).MatchString(conf) {
			t.Errorf("tl-browser asks for %s=%s and %s does not set the same", key, m[1], f.Src)
		}
	}
}

// A running user manager reads its drop-ins when it loads, and a transient
// scope created later does not look again: measured 2026-10-01, a new
// tl-browser-.scope.d drop-in had no effect until `systemctl --user
// daemon-reload`. On a box where users linger, that manager can run for weeks,
// so postinst reloads each one that is running. Best effort, under set -e.
func TestPostinstReloadsRunningUserManagers(t *testing.T) {
	var line string
	for _, l := range strings.Split(PostinstScript, "\n") {
		if strings.Contains(l, "systemctl --user") && strings.Contains(l, "daemon-reload") {
			line = l
		}
	}
	if line == "" {
		t.Fatal("postinst reloads no user manager, so the browser scope cap waits for each user's next login")
	}
	if !strings.Contains(line, "|| true") {
		t.Errorf("under set -e a user manager that will not answer aborts the upgrade: %s", line)
	}
}
