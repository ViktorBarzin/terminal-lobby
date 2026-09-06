package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// unitSetting returns the last value of key in a systemd unit, or "".
// Last wins, which is what systemd does for a single-value setting.
func unitSetting(t *testing.T, unit, key string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "devvm", unit))
	if err != nil {
		t.Fatal(err)
	}
	got := ""
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if v, ok := strings.CutPrefix(line, key+"="); ok {
			got = strings.TrimSpace(v)
		}
	}
	return got
}

// The ephemeral transfer directory used to be /tmp/clipboard-files, created by
// the service itself with MkdirAll (TL-7). /tmp is a world-writable tmpfs that
// is empty at every boot, MkdirAll returns nil for an existing directory of any
// owner and any mode, and the unit ordered itself only After=network.target —
// so a local user with an @reboot job could create the directory first, at a
// mode of their choosing, and then read or replace every file any lobby user
// transferred through it.
//
// systemd's RuntimeDirectory= closes the window: it creates the directory,
// owned by the unit's User=, before ExecStart runs. The Go default and the unit
// have to name the same path for that to be true, and nothing else couples
// them, so this test does.
func TestEphemeralTransferDirIsTheUnitsRuntimeDirectory(t *testing.T) {
	name := unitSetting(t, "clipboard-upload.service", "RuntimeDirectory")
	if name == "" {
		t.Fatal("clipboard-upload.service declares no RuntimeDirectory, so /run/clipboard-files is created by whoever gets there first")
	}
	if want := "/run/" + name; fileDir != want {
		t.Errorf("fileDir is %q but the unit's RuntimeDirectory makes %q; the service would create its own directory again", fileDir, want)
	}
	if strings.HasPrefix(fileDir, "/tmp/") {
		t.Errorf("fileDir is back under world-writable /tmp: %q", fileDir)
	}
	// Squatting is closed by systemd owning the creation, not by the mode.
	// The mode stays what ADR-0005 decided for the store: readable by any
	// devvm account, because the path this directory produces is handed to
	// the user's own shell, which does not run as the service account.
	if mode := unitSetting(t, "clipboard-upload.service", "RuntimeDirectoryMode"); mode != "0755" {
		t.Errorf("RuntimeDirectoryMode is %q, want 0755 (ADR-0005: a non-wizard user has to be able to read the path the drop reports)", mode)
	}
	// Restart=always is on this unit. Without a preserve setting systemd
	// removes the directory on every stop, which would drop transfers that
	// survived a restart for as long as they lived in /tmp.
	if p := unitSetting(t, "clipboard-upload.service", "RuntimeDirectoryPreserve"); p != "yes" {
		t.Errorf("RuntimeDirectoryPreserve is %q, want yes: a service restart would otherwise delete files the 7-day sweep still owns", p)
	}
}

// TL-16. The store's modes were whatever systemd's default umask produced.
// They happen to match ADR-0005, but nothing said so, and a change to the
// system default would have moved them silently.
func TestClipboardUploadStatesItsUmask(t *testing.T) {
	if got := unitSetting(t, "clipboard-upload.service", "UMask"); got != "0022" {
		t.Errorf("UMask is %q, want 0022 (ADR-0005: 0755 dirs, 0644 files, stated rather than inherited)", got)
	}
}

// TL-6. The sweep ran as unconfined root with the full capability bounding set,
// while every other unit in this package runs as the account that owns the
// files. Nothing in the sweep needs privilege.
func TestCleanupSweepIsNotRoot(t *testing.T) {
	if got := unitSetting(t, "clipboard-cleanup.service", "User"); got != "wizard" {
		t.Errorf("clipboard-cleanup.service User is %q, want wizard (it inherits root otherwise)", got)
	}
	b, err := os.ReadFile(filepath.Join("..", "devvm", "clipboard-cleanup.service"))
	if err != nil {
		t.Fatal(err)
	}
	unit := string(b)
	for _, want := range []string{
		"NoNewPrivileges=yes",
		"ProtectSystem=strict",
		"ProtectHome=yes",
		"PrivateDevices=yes",
		"RestrictSUIDSGID=yes",
		"CapabilityBoundingSet=\n",
		"ReadWritePaths=",
	} {
		if !strings.Contains(unit, want) {
			t.Errorf("clipboard-cleanup.service is missing %q", strings.TrimSuffix(want, "\n"))
		}
	}
	// ProtectSystem=strict makes the whole tree read-only, so every
	// directory the sweep deletes from has to be named back in.
	rw := unitSetting(t, "clipboard-cleanup.service", "ReadWritePaths")
	for _, dir := range []string{"/var/lib/clipboard-store", "/run/clipboard-files", "/tmp/clipboard-files"} {
		if !strings.Contains(rw, dir) {
			t.Errorf("ReadWritePaths %q does not cover %s, so the sweep cannot delete from it", rw, dir)
		}
	}
}

// The container is the third deployment this repo ships and it has no systemd.
// TL-7 moved the transfer directory to /run, which in debian:bookworm-slim is
// root-owned 0755, while docker/entrypoint.sh starts every service under the
// unprivileged `dev` account. So main()'s MkdirAll fails, the log.Fatalf fires,
// and the entrypoint's "a service exited" watchdog takes the whole container
// down before it serves a request. The image has to install the directory the
// same way it installs the store, and nothing but this test couples the Go
// default to that line.
func TestContainerInstallsTheTransferDirectory(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "Dockerfile"))
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.Contains(line, "install -d") &&
			strings.Contains(line, "-o dev -g dev") &&
			strings.Contains(line, fileDir) {
			return
		}
	}
	t.Errorf("no `install -d -o dev -g dev` line in the Dockerfile creates %s; the container runs clipboard-upload as dev, which cannot create it under root-owned /run, so the service dies at startup and takes the container with it", fileDir)
}

// Every ReadWritePaths entry carries the '-' prefix, so a directory that has
// never been created is not a startup failure. The store was the one entry
// without it: nothing installs /var/lib/clipboard-store (packaging/build-deb.sh
// has no install -d for it, and clipboard-upload only warns when its own
// MkdirAll fails), so on a box where the store has never been written
// ProtectSystem=strict fails the unit's namespace setup and the entire sweep
// stops running, including the 7-day ageing of the transfer directories.
// clipboard-store-clean guards each path with `[ -d ... ]` already.
func TestCleanupReadWritePathsToleratesMissingDirectories(t *testing.T) {
	rw := unitSetting(t, "clipboard-cleanup.service", "ReadWritePaths")
	if rw == "" {
		t.Fatal("clipboard-cleanup.service names no ReadWritePaths")
	}
	for _, entry := range strings.Fields(rw) {
		if !strings.HasPrefix(entry, "-") {
			t.Errorf("ReadWritePaths entry %q has no '-' prefix; ProtectSystem=strict fails the unit's namespace setup when that directory does not exist yet, and the sweep never runs", entry)
		}
	}
}
