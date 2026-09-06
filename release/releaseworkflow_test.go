package release

import (
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// What .github/workflows/release.yml compiles, formats and ships, checked
// against the tree it is compiled from.
//
// The release workflow is the only thing that compiles this repo before a
// version is cut, so a module it does not name is a module nothing builds.
// That is measured rather than feared: tl-session-watch/go.mod was added
// 2026-09-01 and reached the workflow's hand-typed module list 2026-09-04,
// and four commits landed on the module in between with no CI compiling or
// testing it. The list was guarded by `[ -f "$mod/go.mod" ] || continue`,
// which skips a name with no module and says nothing about a module with no
// name, so the omission was silent in the direction that mattered.
//
// These tests live in release/ for the same reason the ttyd version tests do:
// this package owns the deploy decisions, and the workflow is where several of
// them are actually written down.

// The go-test step's loop, whatever shape its word list takes. Matched up to
// the first `; do` so a backslash-continued list over several lines is caught
// as well as a one-line command substitution.
var releaseModuleLoop = regexp.MustCompile(`(?s)for mod in (.*?); do`)

// The derivation the loop reads from, when the step keeps it in a variable so
// the floor check can count it. Expanding the loop's words without this in
// scope would silently produce no modules at all.
var releaseModuleAssign = regexp.MustCompile(`(?m)^\s*(mods=\$\(.*\))\s*$`)

// skipDirs are directories that hold no module of this repo's own. .worktrees
// matters because the main checkout keeps other branches' trees there, each
// with its own copy of all fourteen go.mod files.
var skipDirs = map[string]bool{
	".git":         true,
	".worktrees":   true,
	"node_modules": true,
	"out":          true,
}

// goModuleDirs walks the tree rather than asking git, so that it is an
// independent answer to the question the workflow's own command answers. A
// test that ran the workflow's command back at it would agree with any
// derivation, including a broken one.
func goModuleDirs(t *testing.T) []string {
	t.Helper()
	root := ".."
	var dirs []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if path != root && skipDirs[d.Name()] {
				return fs.SkipDir
			}
			return nil
		}
		if d.Name() != "go.mod" {
			return nil
		}
		rel, err := filepath.Rel(root, filepath.Dir(path))
		if err != nil {
			return err
		}
		dirs = append(dirs, rel)
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", root, err)
	}
	sort.Strings(dirs)
	return dirs
}

// shellWords expands a loop's word list the way the runner's shell would, so
// a command substitution and a typed list are compared on the same terms.
// prelude is whatever the step ran before the loop that the words depend on.
func shellWords(t *testing.T, prelude, words string) []string {
	t.Helper()
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("no sh on PATH; the workflow's word list is the shell's to expand")
	}
	cmd := exec.Command("sh", "-c", prelude+"printf '%s\\n' "+words)
	cmd.Dir = ".."
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("expand %q: %v", words, err)
	}
	got := strings.Fields(string(out))
	sort.Strings(got)
	return got
}

// gitEnumerates reports whether git can list this tree.
//
// The workflow derives its module list with `git ls-files`, and the expansion
// above runs that derivation for real. A checkout git refuses to read (an
// archive extraction with no .git, a directory git calls dubiously owned, no
// git on PATH) leaves the assignment empty while sh still exits 0, so the
// comparison reads as "the release workflow compiles []" and blames the
// workflow for the checkout. Two reviewers filed exactly that against a branch
// where the test was green, which is why this says which of the two it is.
func gitEnumerates(t *testing.T) bool {
	t.Helper()
	cmd := exec.Command("git", "ls-files", "go.mod", "*/go.mod")
	cmd.Dir = ".."
	out, err := cmd.Output()
	return err == nil && len(strings.Fields(string(out))) > 0
}

func TestReleaseWorkflowCompilesEveryGoModule(t *testing.T) {
	yml := repoFile(t, ".github", "workflows", "release.yml")
	step := goTestStep(t, yml)
	m := releaseModuleLoop.FindStringSubmatch(step)
	if m == nil {
		t.Fatal("no `for mod in ...; do` loop in the test (go) step of .github/workflows/release.yml")
	}
	prelude := ""
	if a := releaseModuleAssign.FindStringSubmatch(step); a != nil {
		prelude = a[1] + "; "
	}
	if !gitEnumerates(t) {
		t.Skip("git cannot list this tree, so the workflow's own derivation has nothing to return here")
	}
	got := shellWords(t, prelude, m[1])
	want := goModuleDirs(t)
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("the release workflow compiles\n  %v\nand the tree holds\n  %v", got, want)
	}
}

// A derivation that returns nothing passes every module it was meant to test,
// which is the same hole as the typed list with none of its noise. The floor
// is the workflow's own guard against that, so it has to be there.
func TestReleaseWorkflowFloorsTheModuleCount(t *testing.T) {
	yml := repoFile(t, ".github", "workflows", "release.yml")
	step := goTestStep(t, yml)
	if !strings.Contains(step, "-lt") {
		t.Error("the go step derives its module list with no floor under it, so a derivation that returns nothing would pass")
	}
}

// goTestStep is the body of the `test (go)` step, which is where both the loop
// and its gates belong. Reading the whole file instead would pass on a gofmt
// call that sits in some other job.
func goTestStep(t *testing.T, yml string) string {
	t.Helper()
	const marker = "name: test (go)"
	i := strings.Index(yml, marker)
	if i < 0 {
		t.Fatalf("no %q step in .github/workflows/release.yml", marker)
	}
	rest := yml[i+len(marker):]
	if j := strings.Index(rest, "\n      - name:"); j >= 0 {
		return rest[:j]
	}
	return rest
}

func TestReleaseWorkflowGatesOnGofmt(t *testing.T) {
	yml := repoFile(t, ".github", "workflows", "release.yml")
	step := goTestStep(t, yml)
	if !strings.Contains(step, "gofmt -l") {
		t.Error("the go step runs no `gofmt -l` gate, so formatting drift reaches master unremarked")
	}
}

// The gate above is worth having only if the tree passes it, and this is the
// copy that fails on a laptop rather than twenty minutes into a release.
func TestEveryGoModuleIsGofmtClean(t *testing.T) {
	if _, err := exec.LookPath("gofmt"); err != nil {
		t.Skip("no gofmt on PATH; formatting is the toolchain's answer to give")
	}
	for _, mod := range goModuleDirs(t) {
		cmd := exec.Command("gofmt", "-l", ".")
		cmd.Dir = filepath.Join("..", mod)
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("gofmt -l in %s: %v", mod, err)
		}
		for _, f := range strings.Fields(string(out)) {
			t.Errorf("%s is not gofmt-clean; run: gofmt -w %s", filepath.Join(mod, f), mod)
		}
	}
}

var pathsIgnoreEntry = regexp.MustCompile(`(?m)^\s*- '([^']+)'`)

// pathsIgnore reads the entries under paths-ignore, which is the list of things
// a push may change without cutting a version.
func pathsIgnore(t *testing.T, yml string) []string {
	t.Helper()
	const marker = "paths-ignore:"
	i := strings.Index(yml, marker)
	if i < 0 {
		t.Fatal("no paths-ignore in .github/workflows/release.yml")
	}
	rest := yml[i+len(marker):]
	if j := strings.Index(rest, "\n  workflow_dispatch"); j >= 0 {
		rest = rest[:j]
	}
	var entries []string
	for _, m := range pathsIgnoreEntry.FindAllStringSubmatch(rest, -1) {
		entries = append(entries, m[1])
	}
	if len(entries) == 0 {
		t.Fatal("paths-ignore in .github/workflows/release.yml holds no entries")
	}
	return entries
}

// The container image is built by container.yml from its own inputs, and none
// of them reach the .deb. A push that touches only those files was cutting a
// version of a package whose contents had not moved.
func TestReleaseWorkflowIgnoresContainerOnlyPaths(t *testing.T) {
	yml := repoFile(t, ".github", "workflows", "release.yml")
	have := map[string]bool{}
	for _, e := range pathsIgnore(t, yml) {
		have[e] = true
	}
	for _, want := range []string{
		"Dockerfile",
		"docker/**",
		".github/workflows/container.yml",
		"scripts/devserve/**",
	} {
		if !have[want] {
			t.Errorf("%s can not change the .deb and is missing from paths-ignore", want)
		}
	}
}

// The other direction, and the more expensive one to get wrong: ignoring a
// path the build reads means a change lands on master and the box keeps the
// package built before it. Every entry is checked against the two scripts the
// workflow runs, which is what makes adding one to paths-ignore safe.
func TestPathsIgnoreNamesNothingTheBuildReads(t *testing.T) {
	yml := repoFile(t, ".github", "workflows", "release.yml")
	scripts := map[string]string{}
	for _, name := range []string{"build-deb.sh", "verify-deb.sh"} {
		b, err := os.ReadFile(filepath.Join("..", "packaging", name))
		if err != nil {
			t.Fatalf("read packaging/%s: %v", name, err)
		}
		scripts[name] = string(b)
	}
	for _, entry := range pathsIgnore(t, yml) {
		// The literal head of the pattern, which is the part a grep can find.
		// An entry that starts with a wildcard, such as **/*.md, has none.
		lit := entry
		if i := strings.IndexAny(lit, "*?["); i >= 0 {
			lit = lit[:i]
		}
		if lit == "" {
			continue
		}
		for name, body := range scripts {
			if strings.Contains(body, lit) {
				t.Errorf("paths-ignore holds %q but packaging/%s reads %q, so a change there would ship no rebuild", entry, name, lit)
			}
		}
	}
}
