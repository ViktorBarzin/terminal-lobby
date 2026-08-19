package skillscan

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A peer's home is 0700, so the recipient cannot read it and the owner cannot
// write into the recipient's. An install therefore hands the skill over as a
// packed value: one child packs it as the owner, another unpacks it as the
// recipient, and nothing depends on cross-home permissions.

func TestPackThenUnpackReproducesTheSkill(t *testing.T) {
	owner := t.TempDir()
	src := skill(t, Root(owner), "diagnose", map[string]string{
		"SKILL.md":       "---\nname: diagnose\ndescription: Debug.\n---\nbody\n",
		"x:scripts/a.sh": "echo a\n",
		"docs/n.md":      "n\n",
	})
	blobs, st, err := Pack(src)
	if err != nil {
		t.Fatal(err)
	}
	if len(blobs) != 3 {
		t.Fatalf("packed %d blobs, want 3", len(blobs))
	}

	home := t.TempDir()
	at := time.Date(2026, 8, 19, 9, 12, 0, 0, time.UTC)
	backup, err := Unpack(home, "diagnose", "bob", blobs, st.Hash, false, at)
	if err != nil {
		t.Fatal(err)
	}
	if backup != "" {
		t.Errorf("nothing was displaced, so no backup: %q", backup)
	}
	dst := filepath.Join(Root(home), "diagnose")
	if mustHash(t, dst) != st.Hash {
		t.Fatal("the unpacked skill does not hash to what the owner reported")
	}
	if fi, err := os.Stat(filepath.Join(dst, "scripts/a.sh")); err != nil || fi.Mode().Perm() != 0o755 {
		t.Errorf("the executable bit did not survive the round trip: %v %v", fi, err)
	}
	man, _ := LoadManifest(home)
	p := man.Installed["diagnose"]
	if p.From != "bob" || p.SourceHash != st.Hash || p.InstalledAt != "2026-08-19T09:12:00Z" {
		t.Errorf("provenance = %+v", p)
	}
}

func TestUnpackRefusesAnExistingSkillUnlessReplacing(t *testing.T) {
	owner := t.TempDir()
	blobs, st, err := Pack(skill(t, Root(owner), "tdd", map[string]string{"SKILL.md": "theirs\n"}))
	if err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	skill(t, Root(home), "tdd", map[string]string{"SKILL.md": "mine\n"})
	at := time.Date(2026, 8, 19, 9, 12, 0, 0, time.UTC)

	if _, err := Unpack(home, "tdd", "bob", blobs, st.Hash, false, at); err == nil {
		t.Fatal("want a refusal when the name is taken")
	}
	body, _ := os.ReadFile(filepath.Join(Root(home), "tdd", "SKILL.md"))
	if string(body) != "mine\n" {
		t.Fatal("the refusal must leave the existing skill alone")
	}

	backup, err := Unpack(home, "tdd", "bob", blobs, st.Hash, true, at)
	if err != nil {
		t.Fatal(err)
	}
	if backup == "" {
		t.Fatal("a replace must report where the old copy went")
	}
	if got, _ := os.ReadFile(filepath.Join(backup, "SKILL.md")); string(got) != "mine\n" {
		t.Errorf("backup content = %q", got)
	}
	if got, _ := os.ReadFile(filepath.Join(Root(home), "tdd", "SKILL.md")); string(got) != "theirs\n" {
		t.Errorf("installed content = %q", got)
	}
}

func TestUnpackRejectsBlobsThatDoNotDescribeASkill(t *testing.T) {
	home := t.TempDir()
	at := time.Now().UTC()
	cases := []struct {
		name  string
		blobs []Blob
	}{
		{"traversal", []Blob{{Rel: "../escape.md", Body: []byte("x")}, {Rel: "SKILL.md", Body: []byte("s")}}},
		{"absolute", []Blob{{Rel: "/etc/passwd", Body: []byte("x")}, {Rel: "SKILL.md", Body: []byte("s")}}},
		{"nested traversal", []Blob{{Rel: "a/../../b", Body: []byte("x")}, {Rel: "SKILL.md", Body: []byte("s")}}},
		{"no SKILL.md", []Blob{{Rel: "README.md", Body: []byte("x")}}},
		{"empty", nil},
		{"excluded path", []Blob{{Rel: ".git/HEAD", Body: []byte("x")}, {Rel: "SKILL.md", Body: []byte("s")}}},
		{"escaping symlink", []Blob{{Rel: "l", Link: "../../etc/passwd"}, {Rel: "SKILL.md", Body: []byte("s")}}},
		{"absolute symlink", []Blob{{Rel: "l", Link: "/etc/passwd"}, {Rel: "SKILL.md", Body: []byte("s")}}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := Unpack(home, "x", "bob", c.blobs, "sha256:whatever", false, at); err == nil {
				t.Fatalf("%s: want a refusal", c.name)
			}
			if _, err := os.Stat(filepath.Join(Root(home), "x")); !os.IsNotExist(err) {
				t.Fatalf("%s: a refused unpack must leave nothing behind", c.name)
			}
		})
	}
}

func TestUnpackRefusesWhenTheContentDoesNotMatchTheDeclaredHash(t *testing.T) {
	// The hash the owner reported is what gets recorded as provenance, so it has
	// to be the hash of what actually landed — otherwise every later comparison
	// is against a fiction.
	home := t.TempDir()
	blobs := []Blob{{Rel: "SKILL.md", Body: []byte("real content\n")}}
	if _, err := Unpack(home, "x", "bob", blobs, "sha256:0000", false, time.Now().UTC()); err == nil {
		t.Fatal("want a refusal on a hash mismatch")
	}
	if _, err := os.Stat(filepath.Join(Root(home), "x")); !os.IsNotExist(err) {
		t.Fatal("nothing should be left behind")
	}
	man, _ := LoadManifest(home)
	if _, ok := man.Installed["x"]; ok {
		t.Fatal("no provenance should be recorded for a refused install")
	}
}

func TestUnpackHonoursTheSizeAndCountLimits(t *testing.T) {
	home := t.TempDir()
	big := []Blob{{Rel: "SKILL.md", Body: []byte(strings.Repeat("x", 1024))}}
	if _, err := unpackWith(home, "x", "bob", big, "sha256:x", false, time.Now().UTC(),
		Limits{MaxBytes: 512, MaxFiles: 500}); err == nil {
		t.Fatal("want a refusal past MaxBytes")
	}
	many := []Blob{{Rel: "SKILL.md", Body: []byte("a")}, {Rel: "b", Body: []byte("b")}}
	if _, err := unpackWith(home, "x", "bob", many, "sha256:x", false, time.Now().UTC(),
		Limits{MaxBytes: 1 << 20, MaxFiles: 1}); err == nil {
		t.Fatal("want a refusal past MaxFiles")
	}
}
