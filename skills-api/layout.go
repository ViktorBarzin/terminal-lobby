package main

import (
	"bufio"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"terminal-lobby/skillscan"
)

// The machine's skills policy says, per OS user, which harnesses that user's
// skills are installed for: <policyDir>/<user>/agents, one name per line, shipped
// by infra's playbooks/devvm.yml. The nightly skills updater
// (claude-skills-update) reads the same file, so a skill lands in the same place
// whichever of the two installed it. No file means claude-code alone, which is
// the layout this service always had.
const defaultPolicyDir = "/usr/local/share/claude-skills"

// policyDir is a var so tests can point it at a temp directory. SKILLS_POLICY_DIR
// is the dev-harness override, the same idea as tmux-api's TMUX_API_PREFS_DIR.
var policyDir = func() string {
	if d := os.Getenv("SKILLS_POLICY_DIR"); d != "" {
		return d
	}
	return defaultPolicyDir
}()

// harnessRe bounds a harness name, because each one becomes an argv element of
// the skills CLI. The updater applies the same rule.
var harnessRe = regexp.MustCompile(`^[a-z0-9-]+$`)

// harnesses returns the harnesses osUser's skills install for. Blank lines,
// comments and malformed names are skipped; claude-code alone is the answer when
// nothing valid is left.
func harnesses(osUser string) []string {
	var out []string
	if f, err := os.Open(filepath.Join(policyDir, osUser, "agents")); err == nil {
		defer f.Close()
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" || strings.HasPrefix(line, "#") || !harnessRe.MatchString(line) {
				continue
			}
			out = append(out, line)
		}
	}
	if len(out) == 0 {
		return []string{"claude-code"}
	}
	return out
}

// layoutFor is where osUser's skill files live. Any harness besides claude-code
// means the skills CLI keeps the real copy in ~/.agents/skills, so this service
// has to install, list and remove them there too.
func layoutFor(osUser string) skillscan.Layout {
	for _, h := range harnesses(osUser) {
		if h != "claude-code" {
			return skillscan.InAgents
		}
	}
	return skillscan.InClaude
}

// agentArgs is the skills CLI's -a flags for osUser.
func agentArgs(osUser string) []string {
	var args []string
	for _, h := range harnesses(osUser) {
		args = append(args, "-a", h)
	}
	return args
}
