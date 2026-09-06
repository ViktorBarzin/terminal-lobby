package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"terminal-lobby/sessionio/siotest"
)

// The new-session composer's `/` menu asks for a DIRECTORY, because there is no
// session yet. These pin the two things that makes different from the session
// route: an empty dir is the user's own half rather than an error, and a dir
// outside the caller's home is refused rather than silently answered empty.
func newDirFixture(t *testing.T) (*registry, string) {
	t.Helper()
	base := t.TempDir()
	home := filepath.Join(base, "wizard")
	skill := filepath.Join(home, ".claude", "skills", "publish-page")
	if err := os.MkdirAll(skill, 0o755); err != nil {
		t.Fatal(err)
	}
	body := "---\nname: publish-page\ndescription: Publish a design doc as a page.\n---\n"
	if err := os.WriteFile(filepath.Join(skill, "SKILL.md"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	// self == the user, so the walk runs inline (LocalReader) rather than
	// reaching for the privileged child, which a test has no business starting.
	rg := newRegistry(ctx, time.Millisecond, base, siotest.NewFakeOptions(), "wizard")
	return rg, home
}

func TestCatalogueForDirWithNoDirIsTheUsersOwnHalf(t *testing.T) {
	rg, _ := newDirFixture(t)
	cmds, ok := rg.catalogueForDir("wizard", "")
	if !ok {
		t.Fatal("an empty dir is Ungrouped, not a refusal")
	}
	var found bool
	for _, c := range cmds {
		if c.Name == "/publish-page" {
			found = true
		}
	}
	if !found {
		t.Errorf("the user's own skills are missing: %+v", cmds)
	}
}

func TestCatalogueForDirIncludesTheProjectHalf(t *testing.T) {
	rg, home := newDirFixture(t)
	proj := filepath.Join(home, "code", "thing")
	skill := filepath.Join(proj, ".claude", "skills", "deploy-thing")
	if err := os.MkdirAll(skill, 0o755); err != nil {
		t.Fatal(err)
	}
	body := "---\nname: deploy-thing\ndescription: Ship it.\n---\n"
	if err := os.WriteFile(filepath.Join(skill, "SKILL.md"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	cmds, ok := rg.catalogueForDir("wizard", proj)
	if !ok {
		t.Fatal("a dir inside the home is readable")
	}
	var own, project bool
	for _, c := range cmds {
		switch c.Name {
		case "/publish-page":
			own = true
		case "/deploy-thing":
			project = true
		}
	}
	if !own || !project {
		t.Errorf("want both halves, got own=%v project=%v: %+v", own, project, cmds)
	}
}

func TestCatalogueForDirRefusesADirOutsideTheHome(t *testing.T) {
	rg, _ := newDirFixture(t)
	for _, dir := range []string{"/etc", "/home/someone-else", "/"} {
		if _, ok := rg.catalogueForDir("wizard", dir); ok {
			t.Errorf("%q outside the home was not refused", dir)
		}
	}
}
