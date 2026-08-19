package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"terminal-lobby/skillscan"
)

// The privileged child is the whole trust boundary: the sudoers grant lets this
// binary run as another user, so what the child accepts is what that grant is
// worth. These tests pin the argv the grant is written against, the closed op
// set, and the fact that the child takes no home or path from its caller.

func TestSudoArgvIsTheShapeTheGrantIsWrittenAgainst(t *testing.T) {
	oldSelf, oldSudo := selfUser, sudoBinary
	t.Cleanup(func() { selfUser, sudoBinary = oldSelf, oldSudo })
	// A stub that echoes a valid envelope, so run() completes and we can read the
	// argv it chose out of the recorded log.
	dir := t.TempDir()
	log := filepath.Join(dir, "argv")
	stub := filepath.Join(dir, "sudo")
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> " + log + "\ncat > /dev/null\necho '{\"status\":200}'\n"
	if err := os.WriteFile(stub, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	selfUser, sudoBinary = "wizard", stub

	if res := run("emo", opInventory, request{}); res.Status != 200 {
		t.Fatalf("run through the stub: %+v", res)
	}
	argv, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	got := strings.TrimSpace(string(argv))
	// -n so it can never prompt; -u <user> as the single identity; then this
	// binary with one op name. No home, no path, no third-party name.
	if !strings.HasPrefix(got, "-n -u emo ") {
		t.Errorf("argv = %q, want it to start -n -u emo", got)
	}
	if !strings.HasSuffix(got, " -privop "+opInventory) {
		t.Errorf("argv = %q, want it to end with -privop %s", got, opInventory)
	}
	if strings.Contains(got, "/home/") {
		t.Errorf("argv must carry no path: %q", got)
	}
}

func TestRunReportsAFailedChildAsAnInternalErrorRatherThanEmptyData(t *testing.T) {
	oldSelf, oldSudo := selfUser, sudoBinary
	t.Cleanup(func() { selfUser, sudoBinary = oldSelf, oldSudo })
	dir := t.TempDir()
	for name, script := range map[string]string{
		"exits nonzero": "#!/bin/sh\nexit 1\n",
		"prints junk":   "#!/bin/sh\ncat > /dev/null\necho not-json\n",
		"no status":     "#!/bin/sh\ncat > /dev/null\necho '{}'\n",
	} {
		stub := filepath.Join(dir, strings.ReplaceAll(name, " ", "-"))
		if err := os.WriteFile(stub, []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
		selfUser, sudoBinary = "wizard", stub
		res := run("emo", opInventory, request{})
		if res.Status != 500 {
			t.Errorf("%s: status %d, want 500", name, res.Status)
		}
		if res.Skills != nil {
			t.Errorf("%s: a failed child must not look like an empty inventory", name)
		}
	}
}

func TestPerformRejectsAnUnknownOp(t *testing.T) {
	if res := perform("rm-rf", t.TempDir(), request{}); res.Status != 500 || res.Error != "unknown op" {
		t.Fatalf("unknown op = %+v", res)
	}
}

func TestPerformValidatesNamesEvenThoughTheParentAlreadyDid(t *testing.T) {
	// Defence in depth: the child re-validates, so the grant does not depend on
	// the parent being the only caller.
	home := t.TempDir()
	for _, op := range []string{opPack, opRead} {
		for _, name := range []string{"../etc", "a/b", "", ".hidden"} {
			if res := perform(op, home, request{Name: name}); res.Status != 400 {
				t.Errorf("%s(%q) = %d, want 400", op, name, res.Status)
			}
		}
	}
}

func TestPerformRefusesAnUnparseableTimestamp(t *testing.T) {
	home := t.TempDir()
	for _, op := range []string{opUnpack, opRemove} {
		if res := perform(op, home, request{Name: "x", At: "yesterday"}); res.Status != 400 {
			t.Errorf("%s with a bad timestamp = %d, want 400", op, res.Status)
		}
	}
}

func TestPerformRoundTripsAnInstallBetweenTwoHomes(t *testing.T) {
	// The two halves the sudo path stitches together, exercised directly.
	base := t.TempDir()
	ownerHome, mineHome := filepath.Join(base, "owner"), filepath.Join(base, "mine")
	root := skillscan.Root(ownerHome)
	if err := os.MkdirAll(filepath.Join(root, "diagnose"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "diagnose", "SKILL.md"), []byte("body\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	packed := perform(opPack, ownerHome, request{Name: "diagnose"})
	if packed.Status != 200 || len(packed.Blobs) != 1 || packed.Hash == "" {
		t.Fatalf("pack = %+v", packed)
	}
	at := time.Date(2026, 8, 19, 9, 12, 0, 0, time.UTC).Format(time.RFC3339)
	res := perform(opUnpack, mineHome, request{
		Name: "diagnose", From: "owner", Hash: packed.Hash, At: at, Blobs: packed.Blobs,
	})
	if res.Status != 200 {
		t.Fatalf("unpack = %+v", res)
	}
	if body, err := os.ReadFile(filepath.Join(skillscan.Root(mineHome), "diagnose", "SKILL.md")); err != nil || string(body) != "body\n" {
		t.Fatalf("installed content = %q %v", body, err)
	}

	// A second unpack of the same name is a conflict, not a silent overwrite.
	if res := perform(opUnpack, mineHome, request{
		Name: "diagnose", From: "owner", Hash: packed.Hash, At: at, Blobs: packed.Blobs,
	}); res.Status != 409 {
		t.Fatalf("second unpack = %d, want 409", res.Status)
	}
}

func TestPerformReadsInventoryOfAHomeWithNothingInIt(t *testing.T) {
	res := perform(opInventory, filepath.Join(t.TempDir(), "fresh"), request{})
	if res.Status != 200 {
		t.Fatalf("a fresh account is not an error: %+v", res)
	}
	if len(res.Skills) != 0 || len(res.Plugins) != 0 {
		t.Errorf("want an empty inventory, got %+v", res)
	}
}

// TestChildIgnoresTheEnvironmentsHome is the property the sudoers grant leans on:
// the child works out whose skills it is touching from its own uid, not from an
// environment variable the parent controls.
func TestChildIgnoresTheEnvironmentsHome(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Skip("cannot locate the test binary")
	}
	_ = exe
	bin := filepath.Join(t.TempDir(), "skills-api")
	build := exec.Command("go", "build", "-o", bin, ".")
	if out, err := build.CombinedOutput(); err != nil {
		t.Skipf("cannot build the binary here: %v\n%s", err, out)
	}

	// A decoy HOME with a skill in it. If the child trusted $HOME it would report
	// that skill; reading its uid's real home, it reports whatever that has.
	decoy := t.TempDir()
	if err := os.MkdirAll(filepath.Join(skillscan.Root(decoy), "planted"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skillscan.Root(decoy), "planted", "SKILL.md"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command(bin, "-privop", opInventory)
	cmd.Stdin = strings.NewReader(`{}`)
	cmd.Env = append(os.Environ(), "HOME="+decoy)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("child failed: %v\n%s", err, out)
	}
	if strings.Contains(string(out), "planted") {
		t.Fatal("the child followed $HOME; it must resolve its home from its uid")
	}
}
