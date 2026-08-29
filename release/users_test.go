package release

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Users renders the two files a multi-user box needs from one declaration, for
// boxes that have no roster. It is the self-hoster's answer to the same problem
// roster.yaml solves here: today they hand-write /etc/ttyd-user-map AND
// /etc/sudoers.d/ttyd-users and keep them in step by remembering to.
//
// The one thing it must never become is a second writer on a box whose roster
// already owns those files — that is the shape of the bug that revoked two
// users' terminals on 2026-08-29.

func TestParseUsersReadsOneDeclarationPerLine(t *testing.T) {
	cfg, err := ParseUsers(`
# who may use this box
alice = alice
bob.smith=bob

carol@example.com = carol
`)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(cfg) != 3 {
		t.Fatalf("got %d users, want 3: %+v", len(cfg), cfg)
	}
	want := map[string]string{"alice": "alice", "bob.smith": "bob", "carol@example.com": "carol"}
	for _, u := range cfg {
		if want[u.Identity] != u.OSUser {
			t.Fatalf("%q -> %q, want %q", u.Identity, u.OSUser, want[u.Identity])
		}
	}
}

// A malformed line is refused rather than skipped. Silently dropping one is how
// a user finds out they have no access by trying to log in.
func TestParseUsersRefusesAMalformedLine(t *testing.T) {
	for _, bad := range []string{"alice", "=bob", "alice=", "alice=bob=carol"} {
		if _, err := ParseUsers(bad); err == nil {
			t.Fatalf("accepted a malformed line: %q", bad)
		}
	}
}

// The OS user reaches `sudo -u` argv and a /home/<user> path, so it is bounded
// by the same charset the act-as target is, including the leading-dash refusal.
func TestParseUsersRefusesAnUnsafeOSUser(t *testing.T) {
	for _, bad := range []string{"alice = -rf", "alice = a b", "alice = ../root", "alice = " + strings.Repeat("x", 40)} {
		if _, err := ParseUsers(bad); err == nil {
			t.Fatalf("accepted an unsafe OS user: %q", bad)
		}
	}
}

func TestParseUsersRefusesADuplicate(t *testing.T) {
	if _, err := ParseUsers("alice = alice\nalice = bob\n"); err == nil {
		t.Fatal("accepted two rows for one identity")
	}
	if _, err := ParseUsers("alice = same\nbob = same\n"); err == nil {
		t.Fatal("accepted two identities mapping to one account")
	}
}

func TestRenderUserMapMatchesWhatTheServicesParse(t *testing.T) {
	cfg, _ := ParseUsers("alice = alice\nbob.smith = bob\n")
	got := RenderUserMap(cfg)
	for _, want := range []string{"alice=alice", "bob.smith=bob"} {
		if !strings.Contains(got, want+"\n") {
			t.Fatalf("map does not contain %q:\n%s", want, got)
		}
	}
	if !strings.Contains(got, "DO NOT EDIT") {
		t.Fatal("rendered map does not say it is generated")
	}
}

// Same shape the roster derives, because the services parse one format.
func TestRenderSudoersGrantsEveryNonServiceUser(t *testing.T) {
	cfg, _ := ParseUsers("alice = alice\nbob.smith = bob\n")
	got := RenderSudoers(cfg, "svc")
	lines := nonComment(got)
	if len(lines) != 3 {
		t.Fatalf("got %d grants, want 3 (two users + root):\n%s", len(lines), got)
	}
	for _, l := range lines {
		if !strings.HasPrefix(l, "svc ALL=(") {
			t.Fatalf("grant does not come from the service user: %q", l)
		}
		if strings.Contains(l, "NOPASSWD: ALL") {
			t.Fatalf("grant is unscoped: %q", l)
		}
	}
	if !strings.Contains(got, "svc ALL=(root) NOPASSWD:") {
		t.Fatal("no root grant for the wrapper scripts")
	}
}

// The service user runs the services, so it is the left side of every grant and
// never a target: a grant to become yourself is meaningless and reads as though
// the service needed privilege it does not.
func TestRenderSudoersNeverTargetsTheServiceUser(t *testing.T) {
	cfg, _ := ParseUsers("alice = svc\nbob.smith = bob\n")
	for _, l := range nonComment(RenderSudoers(cfg, "svc")) {
		target := l[strings.Index(l, "(")+1 : strings.Index(l, ")")]
		if target == "svc" {
			t.Fatalf("the service user is a target of its own grant: %q", l)
		}
	}
}

// A one-person box needs no cross-user grant at all: that is single-user mode,
// which never calls sudo.
func TestRenderSudoersForOneUserIsOnlyTheRootGrant(t *testing.T) {
	cfg, _ := ParseUsers("alice = svc\n")
	lines := nonComment(RenderSudoers(cfg, "svc"))
	if len(lines) != 1 || !strings.HasPrefix(lines[0], "svc ALL=(root)") {
		t.Fatalf("want only the root grant, got:\n%s", strings.Join(lines, "\n"))
	}
}

// Everything it writes must be valid sudoers, and the only way to know is to
// run visudo. That check belongs in the command, but the rendered text must at
// least never contain the shapes that break it.
func TestRenderSudoersEmitsNothingThatBreaksTheParser(t *testing.T) {
	cfg, _ := ParseUsers("alice = alice\n")
	got := RenderSudoers(cfg, "svc")
	for _, forbidden := range []string{"\t", "\\\n", "  ALL"} {
		if strings.Contains(got, forbidden) {
			t.Fatalf("rendered grant contains %q, which sudoers parses badly:\n%s", forbidden, got)
		}
	}
	for _, l := range nonComment(got) {
		if !strings.HasSuffix(strings.TrimSpace(l), l[len(l)-1:]) {
			t.Fatalf("trailing whitespace on %q", l)
		}
	}
}

func nonComment(s string) []string {
	var out []string
	for _, l := range strings.Split(s, "\n") {
		t := strings.TrimSpace(l)
		if t != "" && !strings.HasPrefix(t, "#") {
			out = append(out, t)
		}
	}
	return out
}

// The guard that keeps this from becoming a second writer. On a box whose
// roster owns these files, apply must stand down — a generated copy overwriting
// a live one is what revoked two users' terminals on 2026-08-29.
func TestRosterOwnsDetectsAGeneratedFile(t *testing.T) {
	dir := t.TempDir()
	roster := filepath.Join(dir, "map-from-roster")
	mine := filepath.Join(dir, "map-from-tl-users")
	os.WriteFile(roster, []byte("# Generated from roster.yaml by roster_engine.py\nalice=alice\n"), 0o644)
	os.WriteFile(mine, []byte(RenderUserMap([]User{{Identity: "alice", OSUser: "alice"}})), 0o644)

	if got := RosterOwns(mine, roster); got != roster {
		t.Fatalf("RosterOwns = %q, want %q", got, roster)
	}
	// Our own output must not look like a roster's, or the tool would refuse to
	// run a second time on a box it set up itself.
	if got := RosterOwns(mine); got != "" {
		t.Fatalf("our own rendered map was mistaken for a roster's: %q", got)
	}
	if got := RosterOwns(filepath.Join(dir, "absent")); got != "" {
		t.Fatalf("a missing file was read as roster-owned: %q", got)
	}
}
