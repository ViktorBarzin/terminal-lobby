package main

import (
	"os"
	"path/filepath"
	"testing"
)

// buildCodeTree lays out a home that looks like the real one: /home/<user>/code
// with a worktree under it, a sibling directory whose name merely STARTS with
// "code", and a secret outside the allowlist entirely.
func buildCodeTree(t *testing.T, user string) string {
	t.Helper()
	base := t.TempDir()
	for _, d := range []string{
		filepath.Join(base, user, "code"),
		filepath.Join(base, user, "code", "infra"),
		filepath.Join(base, user, "code", "infra", ".worktrees", "topic"),
		filepath.Join(base, user, "codex"),
		filepath.Join(base, user, "secrets"),
		filepath.Join(base, "other", "code"),
		filepath.Join(base, "etc"),
	} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", d, err)
		}
	}
	return base
}

func TestResolveCWD(t *testing.T) {
	const user = "wizard"
	base := buildCodeTree(t, user)
	home := filepath.Join(base, user)

	// A symlink planted INSIDE the allowlist, pointing out of it. This is the
	// case a string-prefix check accepts and the reason both sides are
	// resolved before they are compared.
	escape := filepath.Join(home, "code", "escape")
	if err := os.Symlink(filepath.Join(base, "etc"), escape); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	// A symlink planted inside the allowlist pointing back INTO it. Resolving
	// must not turn a legitimate path into a refusal — ~/.claude being a
	// symlink is an ordinary dotfiles layout, and so is a linked worktree.
	inward := filepath.Join(home, "code", "linked")
	if err := os.Symlink(filepath.Join(home, "code", "infra"), inward); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	// A regular file, which is not a working directory whatever its path.
	file := filepath.Join(home, "code", "notes.md")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	cases := []struct {
		name string
		cwd  string
		want string // "" means the request must be refused
	}{
		{"the root itself", filepath.Join(home, "code"), filepath.Join(home, "code")},
		{"a project", filepath.Join(home, "code", "infra"), filepath.Join(home, "code", "infra")},
		{"a worktree with a dot component", filepath.Join(home, "code", "infra", ".worktrees", "topic"), filepath.Join(home, "code", "infra", ".worktrees", "topic")},
		{"a symlink pointing back inside", inward, filepath.Join(home, "code", "infra")},
		{"a trailing slash", filepath.Join(home, "code", "infra") + "/", filepath.Join(home, "code", "infra")},
		{"an uncleaned but inside path", filepath.Join(home, "code", "infra", "..", "infra"), filepath.Join(home, "code", "infra")},

		{"empty", "", ""},
		{"relative", "code", ""},
		{"relative traversal", "../etc", ""},
		{"dot", ".", ""},
		{"traversal out of the root", filepath.Join(home, "code", "..", "secrets"), ""},
		{"traversal to the filesystem root", filepath.Join(home, "code", "..", "..", "..", "etc"), ""},
		{"the parent of the root", home, ""},
		{"a sibling whose name starts with the root", filepath.Join(home, "codex"), ""},
		{"another user's code", filepath.Join(base, "other", "code"), ""},
		{"a symlink escaping the root", escape, ""},
		{"a path under a symlink escaping the root", filepath.Join(escape, "shadow"), ""},
		{"a directory that does not exist", filepath.Join(home, "code", "nope"), ""},
		{"a regular file", file, ""},
		{"a NUL byte", filepath.Join(home, "code") + "\x00/etc", ""},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := resolveCWD(base, user, c.cwd)
			if c.want == "" {
				if err == nil {
					t.Fatalf("resolveCWD(%q) = %q, want refusal", c.cwd, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("resolveCWD(%q): %v", c.cwd, err)
			}
			want, err := filepath.EvalSymlinks(c.want)
			if err != nil {
				t.Fatalf("EvalSymlinks(%q): %v", c.want, err)
			}
			if got != want {
				t.Fatalf("resolveCWD(%q) = %q, want %q", c.cwd, got, want)
			}
		})
	}
}

// The allowlist is per user: wizard's code root is not emo's, and the answer
// must follow the OS user the request resolved to rather than the path alone.
func TestResolveCWDIsPerUser(t *testing.T) {
	base := buildCodeTree(t, "wizard")
	if err := os.MkdirAll(filepath.Join(base, "emo", "code", "thing"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	emoDir := filepath.Join(base, "emo", "code", "thing")

	if _, err := resolveCWD(base, "emo", emoDir); err != nil {
		t.Fatalf("emo in emo's own code: %v", err)
	}
	if got, err := resolveCWD(base, "wizard", emoDir); err == nil {
		t.Fatalf("wizard reached emo's code as %q, want refusal", got)
	}
}

// A missing code root refuses everything rather than falling back to a lexical
// comparison that would accept whatever was asked for.
func TestResolveCWDNoCodeRoot(t *testing.T) {
	base := t.TempDir()
	if err := os.MkdirAll(filepath.Join(base, "ghost"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if _, err := resolveCWD(base, "ghost", filepath.Join(base, "ghost", "code")); err == nil {
		t.Fatal("a user with no code root got an accepted cwd")
	}
}
