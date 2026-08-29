package release

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// run executes the migration snippet against a fake root and returns whatever
// it left at the local override path. Running the real shell beats asserting on
// the text of it: the thing that breaks an upgrade is the script's behaviour.
func run(t *testing.T, mapExists bool, existingLocal string) (string, error) {
	t.Helper()
	dir := t.TempDir()
	local := filepath.Join(dir, "terminal-lobby.local.conf")
	userMap := filepath.Join(dir, "ttyd-user-map")
	if mapExists {
		if err := os.WriteFile(userMap, []byte("alice=wizard\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if existingLocal != "" {
		if err := os.WriteFile(local, []byte(existingLocal), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	script := "TL_LOCAL_CONF=" + local + "\nTL_USER_MAP=" + userMap + "\n" + MigrateConfigSnippet
	cmd := exec.Command("sh", "-e", "-c", script)
	if out, err := cmd.CombinedOutput(); err != nil {
		return "", err
	} else if len(out) > 0 {
		t.Logf("migration said: %s", out)
	}
	b, err := os.ReadFile(local)
	if os.IsNotExist(err) {
		return "", nil
	}
	if err != nil {
		t.Fatal(err)
	}
	return string(b), nil
}

// The upgrade this exists for: a box already running multi-user on the Authentik
// header, taking a package whose compiled default is X-Forwarded-User. Without
// the migration every user is locked out at the next restart.
func TestMigrationPinsTheAuthentikHeaderOnAnExistingMultiUserBox(t *testing.T) {
	got, err := run(t, true, "")
	if err != nil {
		t.Fatalf("migration failed: %v", err)
	}
	if !strings.Contains(got, "TL_AUTH_HEADER=X-Authentik-Username") {
		t.Fatalf("local override does not pin the Authentik header:\n%s", got)
	}
}

// A fresh install has no user map, so there is nothing to preserve and the
// compiled default is the right answer. Writing a file here would make every
// new install carry a setting it never chose.
func TestMigrationWritesNothingOnAFreshInstall(t *testing.T) {
	got, err := run(t, false, "")
	if err != nil {
		t.Fatalf("migration failed: %v", err)
	}
	if got != "" {
		t.Fatalf("fresh install got a local override it did not ask for:\n%s", got)
	}
}

// The override belongs to the operator. Once it exists the migration must not
// touch it, on this upgrade or any later one — otherwise it would revert a
// deliberate change on every release.
func TestMigrationNeverOverwritesAnExistingOverride(t *testing.T) {
	mine := "TL_AUTH_HEADER=X-Remote-User\n"
	got, err := run(t, true, mine)
	if err != nil {
		t.Fatalf("migration failed: %v", err)
	}
	if got != mine {
		t.Fatalf("migration overwrote the operator's file:\ngot  %q\nwant %q", got, mine)
	}
}

// A single-user install has no sudoers grant, because it never runs sudo. The
// postinst validates that file, so the check has to be conditional or a fresh
// single-user install cannot configure at all.
func TestPostinstOnlyValidatesTheSudoersGrantWhenItExists(t *testing.T) {
	if !strings.Contains(PostinstScript, "[ -e /etc/sudoers.d/ttyd-users ]") {
		t.Fatal("postinst validates the sudoers grant unconditionally; a single-user install has none")
	}
}
