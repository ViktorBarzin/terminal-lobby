package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// These drive the built binary against a throwaway tree, because what is being
// checked is which files a run writes and which it leaves alone. That is the
// whole subject: this tool installs sudoers files and refuses to be the second
// writer of two of them.

var (
	buildOnce sync.Once
	builtBin  string
	buildErr  error
)

func tlUsers(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("visudo"); err != nil {
		t.Skip("visudo is not on PATH; this tool validates every grant with the real parser")
	}
	buildOnce.Do(func() {
		dir, err := os.MkdirTemp("", "tl-users-bin-")
		if err != nil {
			buildErr = err
			return
		}
		builtBin = filepath.Join(dir, "tl-users")
		if out, err := exec.Command("go", "build", "-o", builtBin, ".").CombinedOutput(); err != nil {
			buildErr = err
			t.Logf("go build: %s", out)
		}
	})
	if buildErr != nil {
		t.Fatalf("building tl-users: %v", buildErr)
	}
	return builtBin
}

// newBox is a box with nothing on it: the directories the real paths live in,
// and a declaration naming one account.
func newBox(t *testing.T) (root, config string) {
	t.Helper()
	root = t.TempDir()
	for _, d := range []string{"etc/sudoers.d", "var/lib/tmux-persist/snapshots"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	config = filepath.Join(root, "terminal-lobby.users")
	if err := os.WriteFile(config, []byte("alice@example.com = alice\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return root, config
}

// rosterOwnsTheMap plants what t3-provision-users.sh leaves behind, which is
// what the guard reads.
func rosterOwnsTheMap(t *testing.T, root string) string {
	t.Helper()
	p := filepath.Join(root, "etc", "ttyd-user-map")
	body := "# generated from roster.yaml by t3-provision-users.sh\nbob@example.com=bob\n"
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func run(t *testing.T, env []string, args ...string) (string, error) {
	t.Helper()
	cmd := exec.Command(tlUsers(t), args...)
	// An explicit environment: SUDO_USER decides who the grants name, and the
	// test process may itself be running under sudo.
	cmd.Env = append([]string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME")}, env...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func mustNotExist(t *testing.T, path, why string) {
	t.Helper()
	if _, err := os.Stat(path); err == nil {
		t.Fatalf("%s exists: %s", path, why)
	}
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}

// The deploy grant is a separate file, with a separate writer and a separate
// lifetime from the two the roster owns. Refusing to write it because a roster
// owns the OTHER two left the homelab devvm -- the box TL-14 was measured on --
// with no way to run the tool at all, and -force would have rewritten the two
// live files, which is the second-writer failure the guard exists to prevent.
func TestApplyWritesTheDeployGrantWhereARosterOwnsTheOtherTwo(t *testing.T) {
	root, config := newBox(t)
	mapPath := rosterOwnsTheMap(t, root)
	before := read(t, mapPath)

	out, err := run(t, nil, "-config", config, "-root", root, "-service-user", "wizard", "-deploy-grant", "apply")
	if err != nil {
		t.Fatalf("apply -deploy-grant on a roster-owned box failed: %v\n%s", err, out)
	}

	grant := read(t, filepath.Join(root, "etc", "sudoers.d", "tl-reconcile"))
	if !strings.Contains(grant, "wizard ALL=(root) NOPASSWD: /usr/local/bin/tl-reconcile") {
		t.Fatalf("the deploy grant is not what it should be:\n%s", grant)
	}
	if got := read(t, mapPath); got != before {
		t.Fatalf("the roster's map was rewritten:\n%s", got)
	}
	mustNotExist(t, filepath.Join(root, "etc", "sudoers.d", "ttyd-users"),
		"the roster owns it and this run had no business writing it")
	if !strings.Contains(out, "roster") {
		t.Errorf("the run does not say the roster still owns the other two files:\n%s", out)
	}

	// check is the dry run of that, so it has to name the same one file.
	out, err = run(t, nil, "-config", config, "-root", root, "-service-user", "wizard", "-deploy-grant", "check")
	if err != nil {
		t.Fatalf("check failed: %v\n%s", err, out)
	}
	if strings.Contains(out, "install both files") {
		t.Errorf("check predicts an apply that would write the roster's two files:\n%s", out)
	}
	if !strings.Contains(out, "tl-reconcile alone") {
		t.Errorf("check does not say the deploy grant is all apply would install:\n%s", out)
	}
}

// The guard itself is unchanged for the work it actually covers.
func TestApplyStillRefusesTheRosterOwnedFiles(t *testing.T) {
	root, config := newBox(t)
	rosterOwnsTheMap(t, root)

	out, err := run(t, nil, "-config", config, "-root", root, "-service-user", "wizard", "apply")
	if err == nil {
		t.Fatalf("apply did not refuse on a roster-owned box:\n%s", out)
	}
	mustNotExist(t, filepath.Join(root, "etc", "sudoers.d", "ttyd-users"), "the roster owns it")
	mustNotExist(t, filepath.Join(root, "etc", "sudoers.d", "tl-reconcile"), "nothing asked for it")
}

// `sudo tl-users apply` is the documented invocation, because writing a 0440
// sudoers file needs root. `id -un` under sudo is root, and a grant naming root
// installs cleanly, prints success, and leaves the deploy key's
// `sudo -n /usr/local/bin/tl-reconcile` refused exactly as before.
func TestTheGrantNamesTheInvokingAccountNotRoot(t *testing.T) {
	root, config := newBox(t)

	out, err := run(t, []string{"SUDO_USER=deployer"}, "-config", config, "-root", root, "-deploy-grant", "apply")
	if err != nil {
		t.Fatalf("apply -deploy-grant failed: %v\n%s", err, out)
	}
	grant := read(t, filepath.Join(root, "etc", "sudoers.d", "tl-reconcile"))
	if !strings.Contains(grant, "deployer ALL=(root)") {
		t.Fatalf("the grant does not name the invoking account:\n%s", grant)
	}
	sudoers := read(t, filepath.Join(root, "etc", "sudoers.d", "ttyd-users"))
	if strings.Contains(sudoers, "root ALL=") {
		t.Fatalf("the service grant was rendered for root:\n%s", sudoers)
	}
}

// A deploy grant for root is nothing: root needs no sudo, and the key is issued
// to a named account, so the run would report success over a box that still
// cannot deploy.
func TestTheDeployGrantRefusesRoot(t *testing.T) {
	root, config := newBox(t)

	out, err := run(t, nil, "-config", config, "-root", root, "-service-user", "root", "-deploy-grant", "apply")
	if err == nil {
		t.Fatalf("a root deploy grant was accepted:\n%s", out)
	}
	if !strings.Contains(out, "-service-user") {
		t.Errorf("the refusal does not say how to fix it:\n%s", out)
	}
	mustNotExist(t, filepath.Join(root, "etc", "sudoers.d", "tl-reconcile"), "it names root")
}

// check is the dry-run half of a tool that renames root-owned state belonging
// to another person. Predicting a rename of a directory that is not there is
// the same class of statement the audit is about.
func TestCheckOnlyPredictsARenameThatApplyWouldPerform(t *testing.T) {
	root, config := newBox(t)
	if err := os.WriteFile(filepath.Join(root, "etc", "ttyd-user-map"), []byte("bob@example.com=bob\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	snapshots := filepath.Join(root, "var", "lib", "tmux-persist", "snapshots")

	out, err := run(t, nil, "-config", config, "-root", root, "-service-user", "wizard", "check")
	if err != nil {
		t.Fatalf("check failed: %v\n%s", err, out)
	}
	if strings.Contains(out, "would rename") {
		t.Errorf("check promises a rename of a directory that does not exist:\n%s", out)
	}
	if !strings.Contains(out, "nothing to rename") {
		t.Errorf("check does not say the revoked user has no state to rename:\n%s", out)
	}

	if err := os.MkdirAll(filepath.Join(snapshots, "bob"), 0o700); err != nil {
		t.Fatal(err)
	}
	out, err = run(t, nil, "-config", config, "-root", root, "-service-user", "wizard", "check")
	if err != nil {
		t.Fatalf("check failed: %v\n%s", err, out)
	}
	if !strings.Contains(out, "would rename") || !strings.Contains(out, filepath.Join(snapshots, "bob")) {
		t.Errorf("check does not predict the rename apply would perform:\n%s", out)
	}
}

func TestResolveServiceUserPrefersTheFlagThenTheInvoker(t *testing.T) {
	for _, tc := range []struct {
		flag, sudoUser, idUn, want string
	}{
		{"svc", "deployer", "root", "svc"},
		{"", "deployer", "root", "deployer"},
		{"", "", "wizard", "wizard"},
		{"", "", "", ""},
	} {
		if got := resolveServiceUser(tc.flag, tc.sudoUser, tc.idUn); got != tc.want {
			t.Errorf("resolveServiceUser(%q, %q, %q) = %q, want %q", tc.flag, tc.sudoUser, tc.idUn, got, tc.want)
		}
	}
}
