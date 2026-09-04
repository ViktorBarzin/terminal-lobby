package release

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Two halves of one defect: a ttyd-devvm build that CI published never reached
// the box. Measured on 2026-09-04, with the sixel-less binary already uploaded,
// `apt-cache policy ttyd-devvm` named 1.7.7+c76b116 as the candidate while four
// newer builds sat in the same registry, and `dpkg-query -W ttyd-devvm` said the
// box still ran c76b116, installed on 2026-08-29. The version scheme did not
// sort, and nothing on the box asked for the package.
//
// The two halves live two files apart -- the version comes out of
// .github/workflows/ttyd.yml, the install out of devvm/tl-reconcile -- so they
// are checked together here, in the package that owns the deploy decisions.

// The one bare-sha version that every published build of the old scheme sorted
// at or below. Kept as a constant because it is the thing a new scheme has to
// beat, not an example.
const ttydVersionCeiling = "1.7.7+c76b116"

func repoFile(t *testing.T, parts ...string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(append([]string{".."}, parts...)...))
	if err != nil {
		t.Fatalf("read %v: %v", parts, err)
	}
	return string(b)
}

// dpkgSaysGreater asks dpkg, which is the only authority on Debian version
// order. Asserting on the shape of the string instead would be asserting on
// this test's understanding of the algorithm.
func dpkgSaysGreater(t *testing.T, a, b string) bool {
	t.Helper()
	if _, err := exec.LookPath("dpkg"); err != nil {
		t.Skip("no dpkg on PATH; version order is dpkg's answer to give")
	}
	err := exec.Command("dpkg", "--compare-versions", a, "gt", b).Run()
	if err == nil {
		return true
	}
	if ee, ok := err.(*exec.ExitError); ok && ee.ExitCode() == 1 {
		return false
	}
	t.Fatalf("dpkg --compare-versions %s gt %s: %v", a, b, err)
	return false
}

var ttydVersionLine = regexp.MustCompile(`(?m)^\s*VERSION="([^"]*)"`)

// The shell fills in only the command substitutions, so the test replaces each
// with a stand-in and asserts on the version the workflow would really publish.
// Hard-coding the expected string instead would keep passing after somebody
// changed the scheme back.
var shellSubstitution = regexp.MustCompile(`\$\([^)]*\)`)

func ttydVersion(t *testing.T, date, sha string) string {
	t.Helper()
	yml := repoFile(t, ".github", "workflows", "ttyd.yml")
	m := ttydVersionLine.FindStringSubmatch(yml)
	if m == nil {
		t.Fatal("no VERSION= assignment in .github/workflows/ttyd.yml")
	}
	filled := shellSubstitution.ReplaceAllStringFunc(m[1], func(sub string) string {
		switch {
		case strings.Contains(sub, "--date=format"):
			return date
		case strings.Contains(sub, "rev-parse"):
			return sha
		}
		t.Fatalf("unrecognised substitution %q in the version line; teach this test what it produces", sub)
		return ""
	})
	if strings.ContainsAny(filled, "$`") {
		t.Fatalf("version %q still holds shell to expand", filled)
	}
	return filled
}

// Under dpkg's ordering a version is split into alternating non-digit and digit
// runs, the non-digit run is compared first, and end-of-string sorts below a
// letter. So "1.7.7+<sha>" is ordered by the sha's leading characters: a sha
// starting with a digit loses to one starting with a letter, which is what made
// 1.7.7+c76b116 a ceiling nothing could climb past. A sha is hex, so the first
// character is one of these sixteen and that character decides the comparison.
func TestTheTerminalServerVersionSortsAboveEveryBareShaBuild(t *testing.T) {
	got := ttydVersion(t, "202609041200", "02cbf4b")
	for _, lead := range strings.Split("0123456789abcdef", "") {
		bare := "1.7.7+" + lead + "76b116"
		if !dpkgSaysGreater(t, got, bare) {
			t.Errorf("%s does not sort above the published build %s", got, bare)
		}
	}
	if !dpkgSaysGreater(t, got, ttydVersionCeiling) {
		t.Errorf("%s does not sort above %s, so apt would never offer it", got, ttydVersionCeiling)
	}
}

// Clearing today's ceiling is not enough: the box tracks latest with no pin
// (ADR-0013), so every future build has to sort above every earlier one. The
// adversarial pair is a later build whose sha starts with a digit against an
// earlier one whose sha starts with the highest hex letter, which is exactly
// the comparison the old scheme lost.
func TestTheTerminalServerVersionStaysMonotonicAcrossBuilds(t *testing.T) {
	earlier := ttydVersion(t, "202609041159", "fffffff")
	later := ttydVersion(t, "202609041200", "0000000")
	if !dpkgSaysGreater(t, later, earlier) {
		t.Errorf("%s does not sort above %s; the scheme is not monotonic", later, earlier)
	}
}

// The publish step treats a 409 from the registry as "already published at this
// version", which is only true while one commit yields one version. Taking the
// date from the clock would make a re-run of the same commit upload a different
// version, and the box would install a rebuild of code it already has.
func TestTheTerminalServerVersionComesFromTheCommitNotTheClock(t *testing.T) {
	yml := repoFile(t, ".github", "workflows", "ttyd.yml")
	m := ttydVersionLine.FindStringSubmatch(yml)
	if m == nil {
		t.Fatal("no VERSION= assignment in .github/workflows/ttyd.yml")
	}
	if strings.Contains(m[1], "$(date") {
		t.Errorf("version %q reads the clock; a rebuild of one commit must produce one version", m[1])
	}
}

// The registry had four builds the box could not see, because tl-reconcile
// named one package. terminal-lobby's "Depends: ttyd-devvm" does not help: an
// unversioned depend is satisfied by whatever version is installed, so apt has
// no reason to upgrade it.
func TestTheReconcileInstallsTheTerminalServerToo(t *testing.T) {
	script := repoFile(t, "devvm", "tl-reconcile")
	var installs []string
	for _, line := range strings.Split(script, "\n") {
		s := strings.TrimSpace(line)
		if strings.HasPrefix(s, "#") {
			continue
		}
		if strings.Contains(s, "apt-get install") {
			installs = append(installs, s)
		}
	}
	// TWO transactions, not one, and the order is load-bearing. The lobby's own
	// postinst verification probes ttyd (manifest.go, want 407 on 7681), and one
	// failing probe makes apply.go return RevertAndHold, which tl-apply acts on
	// by reinstalling and apt-mark holding terminal-lobby, and only
	// terminal-lobby. One transaction would therefore let a bad ttyd build put
	// the brake on the lobby: reverted and held for a fault it does not own.
	// Installing the lobby first means its probe runs against the ttyd that was
	// working a moment ago.
	if len(installs) != 2 {
		t.Fatalf("want two apt-get installs, the lobby then the terminal server, found %d: %v", len(installs), installs)
	}
	if !strings.Contains(installs[0], "terminal-lobby") {
		t.Errorf("the first install is not terminal-lobby, so its ttyd probe would run against a ttyd that just changed: %q", installs[0])
	}
	if !strings.Contains(installs[1], "ttyd-devvm") {
		t.Errorf("the second install is not ttyd-devvm: %q", installs[1])
	}
	if strings.Contains(installs[0], "ttyd-devvm") {
		t.Errorf("ttyd-devvm rides the lobby's transaction, which is what puts the revert brake on the wrong package: %q", installs[0])
	}
	// The before snapshot and the after report still walk one list, so a package
	// cannot be reported without being installed or installed without being
	// reported. Same reason the manifest generates the ship list and the watch
	// list from one declaration.
	pkgs := regexp.MustCompile(`(?m)^PKGS="([^"]*)"`).FindStringSubmatch(script)
	if pkgs == nil {
		t.Fatal("no PKGS= list in devvm/tl-reconcile")
	}
	for _, pkg := range []string{"terminal-lobby", "ttyd-devvm"} {
		found := false
		for _, f := range strings.Fields(pkgs[1]) {
			if f == pkg {
				found = true
			}
		}
		if !found {
			t.Errorf("PKGS=%q does not include %s", pkgs[1], pkg)
		}
	}
	// Twice: the snapshot before apt runs, and the report after it. A reconcile
	// that upgrades ttyd has to say so, the way it already says so for the
	// lobby.
	if n := strings.Count(script, "in $PKGS"); n < 2 {
		t.Errorf("$PKGS is walked %d times; the before snapshot and the after report both need it", n)
	}
}

// The deploy key's authority is "ask this box to update itself" and nothing
// else. A forced command still receives whatever the client asked for, so
// reading SSH_ORIGINAL_COMMAND would hand back the freedom the forced command
// exists to remove.
func TestTheReconcileStillReadsNothingFromItsCaller(t *testing.T) {
	script := repoFile(t, "devvm", "tl-reconcile")
	for _, expansion := range []string{"$SSH_ORIGINAL_COMMAND", "${SSH_ORIGINAL_COMMAND"} {
		if strings.Contains(script, expansion) {
			t.Errorf("tl-reconcile expands %s; it must ignore what the client asked for", expansion)
		}
	}
}

// The script is /bin/sh, which on this box is dash, and it is only ever run by
// a forced command over ssh -- there is nowhere for a syntax error to show up
// before a deploy needs it.
func TestTheReconcileIsValidPosixShell(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("no sh on PATH")
	}
	out, err := exec.Command("sh", "-n", filepath.Join("..", "devvm", "tl-reconcile")).CombinedOutput()
	if err != nil {
		t.Fatalf("sh -n rejected tl-reconcile: %v\n%s", err, out)
	}
}
