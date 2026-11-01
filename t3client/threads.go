package t3client

import (
	"context"
	"os/exec"
	"path/filepath"
	"strings"
)

// GitToplevel resolves dir to its git toplevel, running git as the current
// user, and falls back to the cleaned dir itself outside git or when git
// cannot read it.
func GitToplevel(ctx context.Context, user, dir string) (string, error) {
	out, err := exec.CommandContext(ctx, "git", "-C", dir, "rev-parse", "--show-toplevel").Output()
	if err != nil {
		return filepath.Clean(dir), nil
	}
	return strings.TrimSpace(string(out)), nil
}
