package release

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The config file is the whole operator-facing surface. Shipping it as a dpkg
// conffile is what makes a local edit survive an upgrade; without that flag the
// package would overwrite an operator's header name on every release.
func TestConfigFileShipsAsAConffile(t *testing.T) {
	m := Package
	var found *File
	for i := range m.Files {
		if m.Files[i].Dest == ConfigPath {
			found = &m.Files[i]
		}
	}
	if found == nil {
		t.Fatalf("manifest does not ship %s", ConfigPath)
	}
	if !found.Conffile {
		t.Fatalf("%s is not marked Conffile; a package upgrade would clobber local edits", ConfigPath)
	}
	if found.Mode != 0o644 {
		t.Fatalf("%s mode %o, want 0644 — every service reads it", ConfigPath, found.Mode)
	}
}

// The shipped defaults are the documented ones. A reader opening the file
// should see every knob, including the ones they are not using, because the
// alternative is finding them in source.
func TestShippedConfigNamesEveryVariable(t *testing.T) {
	body := DefaultConfig()
	for _, v := range []string{"TL_AUTH_HEADER", "TL_PROXY_SECRET", "TL_MULTI_USER", "TL_BIND"} {
		if !strings.Contains(body, v) {
			t.Fatalf("shipped config does not mention %s", v)
		}
	}
	// The default must match what the binaries compile in, or the file
	// documents something untrue.
	if !strings.Contains(body, "X-Forwarded-User") {
		t.Fatal("shipped config does not name the default header")
	}
	// The secret ships commented out: setting it here without the proxy also
	// sending it would lock everyone out on the next restart.
	for _, line := range strings.Split(body, "\n") {
		s := strings.TrimSpace(line)
		if strings.HasPrefix(s, "TL_PROXY_SECRET=") {
			t.Fatalf("TL_PROXY_SECRET ships live (%q); it must be commented out", s)
		}
	}
}

// DefaultConfig and the file the manifest actually ships must be the same text.
// They are two representations of one thing — the Go string is what postinst
// writes during migration, the file is what dpkg installs — and a drift between
// them would mean the package documents one default and the migration writes
// another.
func TestShippedFileMatchesDefaultConfig(t *testing.T) {
	onDisk, err := os.ReadFile(filepath.Join("..", "devvm", "terminal-lobby.conf"))
	if err != nil {
		t.Fatalf("read shipped config: %v", err)
	}
	if string(onDisk) != DefaultConfig() {
		t.Fatal("devvm/terminal-lobby.conf differs from DefaultConfig(); regenerate it")
	}
}

// Marking a File as a conffile in the manifest does nothing on its own: dpkg
// only treats a path as configuration if it is listed in DEBIAN/conffiles. This
// asserts the list the package actually ships, which is the thing that decides
// whether an operator's edit survives.
func TestConffilesListIsWhatDpkgReads(t *testing.T) {
	got := ConffilesContent()
	if got == "" {
		t.Fatal("no DEBIAN/conffiles content; dpkg would overwrite every config file on upgrade")
	}
	lines := strings.Split(strings.TrimRight(got, "\n"), "\n")
	for _, l := range lines {
		if !strings.HasPrefix(l, "/") {
			t.Fatalf("conffiles entry %q is not an absolute path", l)
		}
	}
	if !strings.HasSuffix(got, "\n") {
		t.Fatal("conffiles must end in a newline")
	}
	var want []string
	for _, f := range Package.Files {
		if f.Conffile {
			want = append(want, f.Dest)
		}
	}
	if len(lines) != len(want) {
		t.Fatalf("conffiles lists %d paths, manifest marks %d", len(lines), len(want))
	}
	for _, w := range want {
		if !strings.Contains(got, w+"\n") {
			t.Fatalf("%s is marked Conffile but absent from DEBIAN/conffiles", w)
		}
	}
}

// The local override must NOT be a conffile. dpkg would then track it, and the
// migration writing it during postinst would show up as a locally-modified
// conffile on every later upgrade — the prompt the two-file split exists to
// avoid.
func TestLocalOverrideIsNotAConffile(t *testing.T) {
	if strings.Contains(ConffilesContent(), LocalConfigPath) {
		t.Fatalf("%s is listed as a conffile; dpkg would prompt about it every upgrade", LocalConfigPath)
	}
}

// Every process that resolves an identity — the five services and t3-sync,
// which is a CLIENT of tmux-api and has to send what tmux-api expects — must
// source the config. t3-sync was missed the first time: its unit carried only
// its own env file, so after an upgrade it sent the compiled default header
// while tmux-api expected the configured one, and every call 401'd.
func TestEveryIdentityAwareUnitSourcesTheConfig(t *testing.T) {
	// ttyd expands ${TL_AUTH_HEADER} in its ExecStart; the rest read the env.
	binaries := []string{
		"ttyd", "tmux-api", "file-api", "session-events", "skills-api",
		"clipboard-upload", "tl-t3-sync",
	}
	units, err := filepath.Glob(filepath.Join("..", "devvm", "*.service"))
	if err != nil || len(units) == 0 {
		t.Fatalf("no unit files found: %v", err)
	}
	checked := 0
	for _, u := range units {
		b, err := os.ReadFile(u)
		if err != nil {
			t.Fatal(err)
		}
		body := string(b)
		var wants bool
		for _, bin := range binaries {
			if strings.Contains(body, "ExecStart=/usr/local/bin/"+bin+" ") ||
				strings.Contains(body, "ExecStart=/usr/local/bin/"+bin+"\n") {
				wants = true
			}
		}
		if !wants {
			continue
		}
		checked++
		if !strings.Contains(body, "EnvironmentFile=-"+ConfigPath) {
			t.Errorf("%s runs an identity-aware binary but does not source %s",
				filepath.Base(u), ConfigPath)
		}
		if !strings.Contains(body, "EnvironmentFile=-"+LocalConfigPath) {
			t.Errorf("%s does not source %s, so the upgrade migration would not reach it",
				filepath.Base(u), LocalConfigPath)
		}
	}
	if checked < 6 {
		t.Fatalf("only %d identity-aware units checked; expected at least 6", checked)
	}
}

// The default an operator gets with no configuration at all must be the one
// that needs no shared secret. A service on 0.0.0.0 with TL_PROXY_SECRET unset
// trusts the identity header from anything that can reach it.
func TestShippedDefaultBindsLoopback(t *testing.T) {
	for _, line := range strings.Split(DefaultConfig(), "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "TL_BIND=") {
			if strings.TrimSpace(line) != "TL_BIND=127.0.0.1" {
				t.Fatalf("shipped default is %q; a fresh install should not be reachable "+
					"from the network without a secret", strings.TrimSpace(line))
			}
			return
		}
	}
	t.Fatal("shipped config does not set TL_BIND")
}
