package release

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// The privileged surface is what runs as root, or as another user, on behalf of
// this package. Three pieces of it were in no artifact until 2026-09-05: the
// deploy grant at /etc/sudoers.d/tl-reconcile, t3-mint's grant resting on the
// user map this repo renders, and /usr/local/bin/tmux-persist, which a
// root-granted wrapper execs. A rebuild from the manifest alone came up without
// any of them.
//
// These tests are the detector for that class: a privileged path this package
// reaches has to be declared here, whether the package installs it or not.

var binRe = regexp.MustCompile(`/usr/local/bin/[a-zA-Z0-9._-]+`)

// Every /usr/local/bin path a shipped script names is either installed by this
// package, installed by a named other one, or declared as a privileged
// dependency. Nothing may be reached and undeclared.
func TestEveryBinaryAShippedScriptNamesIsDeclared(t *testing.T) {
	shipped := map[string]bool{}
	for _, f := range Package.Files {
		shipped[f.Dest] = true
	}
	declared := map[string]bool{}
	for _, d := range PrivilegedDeps {
		declared[d.Path] = true
	}

	for _, f := range Package.Files {
		if !strings.HasPrefix(f.Src, "devvm/") {
			continue
		}
		body, err := os.ReadFile("../" + f.Src)
		if err != nil {
			t.Fatalf("read %s: %v", f.Src, err)
		}
		for _, path := range binRe.FindAllString(string(body), -1) {
			if shipped[path] || declared[path] || Package.ExternalFile(path) {
				continue
			}
			t.Errorf("%s runs %s, which the package does not install and no artifact declares", f.Src, path)
		}
	}
}

// TL-25. tmux-restore-user holds a NOPASSWD root grant and its whole job is to
// exec tmux-persist, which no reconciled installer here declares.
func TestTmuxPersistIsDeclaredWithItsInstaller(t *testing.T) {
	d, ok := privDep("/usr/local/bin/tmux-persist")
	if !ok {
		t.Fatal("tmux-persist is not declared; a rebuild comes up with the root grant, the state tree and no binary")
	}
	if !strings.Contains(d.Reached, "tmux-restore-user") {
		t.Errorf("the declaration does not say what reaches it, got %q", d.Reached)
	}
	if !strings.Contains(d.RunsAs, "root") {
		t.Errorf("tmux-persist runs as root through the wrapper's grant, declared %q", d.RunsAs)
	}
}

// TL-15. The map this repo renders is the sole input deciding what t3-mint may
// mint a root-issued pairing token for, across a repo boundary.
func TestT3MintIsDeclaredAsASecondConsumerOfTheUserMap(t *testing.T) {
	d, ok := privDep("/usr/local/bin/t3-mint")
	if !ok {
		t.Fatal("t3-mint is not declared; the user map has a privileged consumer outside this repo")
	}
	if !strings.Contains(d.Why, UserMapPath) {
		t.Errorf("the declaration does not name %s as its input, got %q", UserMapPath, d.Why)
	}
	if d.Grant == "" {
		t.Error("t3-mint's root grant is not named")
	}
}

func TestEveryPrivilegedDepNamesAnInstaller(t *testing.T) {
	for _, d := range PrivilegedDeps {
		if !strings.HasPrefix(d.Path, "/") {
			t.Errorf("%q is not an absolute path", d.Path)
		}
		if d.Installer == "" {
			t.Errorf("%s declares no installer; nobody knows what puts it on a rebuilt box", d.Path)
		}
		if d.RunsAs == "" || d.Reached == "" || d.Why == "" {
			t.Errorf("%s is declared without saying who runs it, what reaches it, or why", d.Path)
		}
	}
}

// A path cannot be both ours and someone else's. Shipping one we declare
// external means two writers, which is the shape that revoked two users'
// terminals.
func TestNoPrivilegedDepIsAlsoShipped(t *testing.T) {
	for _, f := range Package.Files {
		for _, d := range PrivilegedDeps {
			if f.Dest == d.Path {
				t.Errorf("%s is declared as installed elsewhere and also shipped from %s", d.Path, f.Src)
			}
		}
	}
}

// A malformed grant locks every user out of every session, so every grant this
// package depends on and can see is parsed before the install counts as done.
func TestEveryValidatedGrantIsCheckedInPostinst(t *testing.T) {
	var checked int
	for _, g := range Grants {
		if !g.Validate {
			continue
		}
		checked++
		if !strings.Contains(PostinstScript, "visudo -cf "+g.Path) {
			t.Errorf("postinst does not validate %s; a malformed one would be installed and lock users out", g.Path)
		}
	}
	if checked < 2 {
		t.Errorf("only %d grant(s) are validated at install; the deploy grant was the one nothing checked", checked)
	}
}

// TL-14. The grant that lets the deploy key run tl-reconcile was in no
// artifact: not the manifest, not users.go, not the template, and postinst
// validated only ttyd-users.
func TestTheDeployGrantIsAnArtifact(t *testing.T) {
	g, ok := grant(DeploySudoersPath)
	if !ok {
		t.Fatalf("%s is not declared; it is a NOPASSWD root grant no artifact owns", DeploySudoersPath)
	}
	if !g.Validate {
		t.Error("the deploy grant is not validated at install")
	}
	if g.Template == "" {
		t.Fatal("the deploy grant has no reference copy in the repo")
	}
}

// Each grant we render carries a reference copy, and it ships: a rebuilt box
// should not need the repository to see what its own grants are for. The live
// path is never installed, because both grants name accounts and a drifted copy
// revokes real users.
func TestEveryGrantTemplateExistsAndShips(t *testing.T) {
	for _, g := range Grants {
		if g.Template == "" {
			continue
		}
		if _, err := os.Stat("../" + g.Template); err != nil {
			t.Errorf("the reference copy %s does not exist: %v", g.Template, err)
		}
		var shipped bool
		for _, f := range Package.Files {
			if f.Src == g.Template {
				shipped = true
			}
			if f.Dest == g.Path {
				t.Errorf("the package installs %s; a grant names accounts, so it is rendered on the box, never copied", g.Path)
			}
		}
		if !shipped {
			t.Errorf("%s is not shipped; a rebuilt box has no reference for the grant it needs", g.Template)
		}
	}
}

// The deploy grant is one command, as root, from the service user. tl-reconcile
// runs apt-get, so the grant is already "run what the configured source
// publishes": widening it further has no ceiling left to hit.
func TestRenderDeploySudoersIsScopedToTheOneCommand(t *testing.T) {
	got := RenderDeploySudoers("svc")
	lines := nonComment(got)
	if len(lines) != 1 {
		t.Fatalf("want exactly one grant, got %d:\n%s", len(lines), got)
	}
	if lines[0] != "svc ALL=(root) NOPASSWD: /usr/local/bin/tl-reconcile" {
		t.Fatalf("unexpected grant: %q", lines[0])
	}
	if strings.Contains(got, "NOPASSWD: ALL") {
		t.Fatal("the deploy grant is unscoped")
	}
}

// The map's own format, as tmux-restore-user and tmux-persist read it: comments
// stripped, right-hand side only, an optional :cwd suffix dropped.
func TestOSUsersInMapReadsWhatTheWrappersRead(t *testing.T) {
	got := OSUsersInMap("# a comment\nalice@example.com=alice\nbob = bob:/home/bob/code\n\n#carol=carol\n")
	want := []string{"alice", "bob"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("OSUsersInMap = %v, want %v", got, want)
	}
}

// TL-35. Revocation removes the grant; it does not remove what the user
// accumulated outside their home, and re-adding the name would make months-old
// snapshots restorable to whoever holds that account next.
func TestDroppedOSUsersFindsTheRevokedNames(t *testing.T) {
	previous := "alice=alice\nbob=bob\nancamilea=ancamilea\n"
	users, err := ParseUsers("alice = alice\nbob = bob\n")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	got := DroppedOSUsers(previous, users)
	if len(got) != 1 || got[0] != "ancamilea" {
		t.Fatalf("DroppedOSUsers = %v, want [ancamilea]", got)
	}
	if len(DroppedOSUsers(previous, mustParse(t, "alice = alice\nbob = bob\nancamilea = ancamilea\n"))) != 0 {
		t.Fatal("a user still on the map was reported as dropped")
	}
	if len(DroppedOSUsers("", users)) != 0 {
		t.Fatal("a first install reported drops; there is no previous map to compare against")
	}
}

// Tombstoned, never deleted. The snapshots are a user's session titles and
// transcript ids, the tool runs as root, and a rename is the reversible half of
// the choice.
func TestRevokedStateIsTombstonedNotDeleted(t *testing.T) {
	dir, name := RevokedStateDir(SnapshotStore, "ancamilea", "20260905")
	if dir != SnapshotStore+"/ancamilea" {
		t.Fatalf("source dir = %q", dir)
	}
	if !strings.HasPrefix(name, SnapshotStore+"/ancamilea.revoked-") || !strings.HasSuffix(name, "20260905") {
		t.Fatalf("tombstone = %q, want a dated sibling of the original", name)
	}
	if name == dir {
		t.Fatal("the tombstone is the original path; the rename would be a no-op")
	}
}

// What a user accumulates outside their home has to be written down somewhere,
// or the next person to revoke someone has to go looking for it.
func TestThePerUserStateOutsideAHomeIsDeclared(t *testing.T) {
	if len(PerUserState) == 0 {
		t.Fatal("no per-user state is declared; revocation has no checklist")
	}
	var snapshots bool
	for _, s := range PerUserState {
		if s.Path == SnapshotStore {
			snapshots = true
		}
		if s.OnRevoke == "" {
			t.Errorf("%s does not say what happens to it when a user is revoked", s.Path)
		}
	}
	if !snapshots {
		t.Errorf("%s is not declared; it is root-owned state that outlives every grant", SnapshotStore)
	}
}

func privDep(path string) (PrivilegedDep, bool) {
	for _, d := range PrivilegedDeps {
		if d.Path == path {
			return d, true
		}
	}
	return PrivilegedDep{}, false
}

func grant(path string) (Grant, bool) {
	for _, g := range Grants {
		if g.Path == path {
			return g, true
		}
	}
	return Grant{}, false
}

func mustParse(t *testing.T, text string) []User {
	t.Helper()
	u, err := ParseUsers(text)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	return u
}
