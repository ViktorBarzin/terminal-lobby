package release

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// What the Dockerfile bundles, checked against what .github/workflows/container.yml
// rebuilds on.
//
// A paths filter that omits a directory does not fail. It just does not fire,
// and the published image keeps the library it was built with, so a fix in a
// shared module reaches the .deb and not the container. Nothing else in the
// repo holds the two lists together: the Dockerfile names five services, each
// service's go.mod names the libraries it replaces, and the filter is a
// hand-typed list of both. This test derives the first two and asserts the
// third against them, in both directions.
//
// It lives in release/ with the workflow tests for the same reason those do:
// this package owns the deploy decisions, and the workflows are where several
// of them are written down.

// The Dockerfile's build loop, whose word list is the set of services compiled
// into the image.
var dockerServiceLoop = regexp.MustCompile(`for svc in ([^;]+); do`)

// A local replace edge in a go.mod: `replace terminal-lobby/x => ../x`. The
// target is the directory that has to be in the filter, since that is what a
// change lands in.
var localReplace = regexp.MustCompile(`(?m)^replace\s+\S+\s+=>\s+\.\./(\S+)\s*$`)

// A quoted entry under the container workflow's paths filter.
var pathsEntry = regexp.MustCompile(`(?m)^\s*- "([^"]+)"`)

// dockerServices reads the services the image builds, in the Dockerfile's own
// order, deduplicated and sorted.
func dockerServices(t *testing.T) []string {
	t.Helper()
	m := dockerServiceLoop.FindStringSubmatch(repoFile(t, "Dockerfile"))
	if m == nil {
		t.Fatal("no `for svc in ...; do` build loop in Dockerfile, so nothing here knows what the image bundles")
	}
	svcs := strings.Fields(m[1])
	if len(svcs) == 0 {
		t.Fatal("the Dockerfile's build loop names no services")
	}
	sort.Strings(svcs)
	return svcs
}

// bundledDirs is the transitive closure of the Dockerfile's services over
// local replace edges: the services themselves plus every shared module they
// reach. Changing any of these changes the image.
func bundledDirs(t *testing.T) []string {
	t.Helper()
	seen := map[string]bool{}
	var visit func(dir string)
	visit = func(dir string) {
		if seen[dir] {
			return
		}
		seen[dir] = true
		b, err := os.ReadFile(filepath.Join("..", dir, "go.mod"))
		if err != nil {
			t.Fatalf("read %s/go.mod: %v", dir, err)
		}
		for _, m := range localReplace.FindAllStringSubmatch(string(b), -1) {
			visit(m[1])
		}
	}
	for _, svc := range dockerServices(t) {
		visit(svc)
	}
	var dirs []string
	for d := range seen {
		dirs = append(dirs, d)
	}
	sort.Strings(dirs)
	return dirs
}

// containerPaths reads the entries under the container workflow's `paths:`
// filter, stopping at workflow_dispatch so a later block cannot pad the list.
func containerPaths(t *testing.T) []string {
	t.Helper()
	yml := repoFile(t, ".github", "workflows", "container.yml")
	const marker = "paths:"
	i := strings.Index(yml, marker)
	if i < 0 {
		t.Fatal("no paths filter in .github/workflows/container.yml, so every push rebuilds the image")
	}
	rest := yml[i+len(marker):]
	if j := strings.Index(rest, "\n  workflow_dispatch"); j >= 0 {
		rest = rest[:j]
	}
	var entries []string
	for _, m := range pathsEntry.FindAllStringSubmatch(rest, -1) {
		entries = append(entries, m[1])
	}
	if len(entries) == 0 {
		t.Fatal("the paths filter in .github/workflows/container.yml holds no entries")
	}
	return entries
}

// The forward direction: a module the image bundles that the filter does not
// name is a module whose fix never reaches the image.
func TestContainerFilterCoversEveryBundledModule(t *testing.T) {
	named := map[string]bool{}
	for _, e := range containerPaths(t) {
		named[strings.TrimSuffix(e, "/**")] = true
	}
	bundled := bundledDirs(t)
	// The closure is the five services plus the libraries they replace. A
	// closure the size of the service list means the replace edges were not
	// read, which would make every assertion below pass on nothing.
	if len(bundled) <= len(dockerServices(t)) {
		t.Fatalf("the closure is %v, which reaches no shared module; the replace edges were not read", bundled)
	}
	for _, dir := range bundled {
		if !named[dir] {
			t.Errorf("%s is built into the image and .github/workflows/container.yml does not rebuild on it; add - \"%s/**\"", dir, dir)
		}
	}
}

// The reverse direction: a module in the filter that the image no longer
// bundles is a rebuild nothing needs, and it hides the fact that the service
// left. Non-module entries (Dockerfile, docker/, the frontends, the attach
// scripts, the workflow) are the filter's own business and are not checked.
func TestContainerFilterNamesNoUnbundledModule(t *testing.T) {
	bundled := map[string]bool{}
	for _, d := range bundledDirs(t) {
		bundled[d] = true
	}
	modules := map[string]bool{}
	for _, d := range goModuleDirs(t) {
		modules[d] = true
	}
	for _, e := range containerPaths(t) {
		dir := strings.TrimSuffix(e, "/**")
		if dir == e || !modules[dir] {
			continue
		}
		if !bundled[dir] {
			t.Errorf("%s is a Go module .github/workflows/container.yml rebuilds on, and the Dockerfile does not build it into the image", dir)
		}
	}
}
