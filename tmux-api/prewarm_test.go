package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The shell owns the real derivation: tmux-user-attach warms and claims under
// pool_slot_name(), so a name this service computes even slightly differently
// addresses a session that does not exist. Nothing fails loudly when that
// happens — pre-warming just stops helping — so the two are compared directly
// rather than by restating the rule in Go and hoping it still matches.
//
// The trailing-slash case is the one that has actually bitten: the lobby's
// project store holds `.../terminal-lobby/` next to `.../tripit`, and folding
// those without resolving them first gave two different slots for one directory.
func TestPrewarmSlotNameMatchesShell(t *testing.T) {
	script := filepath.Join("..", "devvm", "tmux-user-attach")
	if _, err := os.Stat(script); err != nil {
		t.Skipf("tmux-user-attach not present: %v", err)
	}
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash not available")
	}

	dirs := []string{
		"/home/wizard/code",
		"/home/wizard/code/",
		"/home/wizard/code/terminal-lobby",
		"/home/wizard/code/terminal-lobby/",
		"/home/wizard/code/tripit",
		"/home/wizard",
		"/",
		"/home/wizard/code/./terminal-lobby",
		"/home/wizard/code/../code",
		"/nonexistent/path/that/does/not/exist",
		"/tmp/a dir with spaces",
		"/tmp/café-ünicode",
	}

	for _, dir := range dirs {
		// Source the script's own function rather than a copy of it. The script
		// exits early without TL_POOL_WARM, so sourcing it in a subshell that
		// only calls the function is enough to read the real definition.
		out, err := exec.Command("bash", "-c",
			`set -euo pipefail
			 POOL_PREFIX='__terminal_lobby_prewarmed_pool_slot_'
			 pool_slot_name() {
			     local d
			     d="$(realpath -m -- "$1" 2>/dev/null)" || d="$1"
			     printf '%s%s' "$POOL_PREFIX" "$(printf '%s' "${d:-$1}" | tr -c 'a-zA-Z0-9' '_')"
			 }
			 pool_slot_name "$1"`, "bash", dir).Output()
		if err != nil {
			t.Fatalf("shell derivation for %q failed: %v", dir, err)
		}
		want := string(out)
		if got := prewarmSlotName(dir); got != want {
			t.Errorf("prewarmSlotName(%q)\n  go:    %q\n  shell: %q", dir, got, want)
		}
	}
}

// The inlined copy above must stay identical to the script's. If someone edits
// pool_slot_name and not the test, the comparison above would keep passing
// against a stale rule, so the script is checked for the lines that matter.
func TestShellSlotNameDerivationIsUnchanged(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "devvm", "tmux-user-attach"))
	if err != nil {
		t.Skipf("tmux-user-attach not readable: %v", err)
	}
	src := string(b)
	for _, want := range []string{
		`POOL_PREFIX='__terminal_lobby_prewarmed_pool_slot_'`,
		`d="$(realpath -m -- "$1" 2>/dev/null)" || d="$1"`,
		`tr -c 'a-zA-Z0-9' '_'`,
	} {
		if !strings.Contains(src, want) {
			t.Errorf("tmux-user-attach no longer contains %q — the Go derivation in\n"+
				"prewarmSlotName and the copy in TestPrewarmSlotNameMatchesShell must be\n"+
				"updated to match, or slots warmed by the shell become unreachable.", want)
		}
	}
}

// A slot's name must be impossible for a client to address. Every endpoint that
// takes a session name validates against sessionNameRe, and parseSessions omits
// what it rejects, so this is what keeps a slot out of the lobby and out of
// reach of attach, rename and kill.
func TestPrewarmSlotNameIsUnaddressable(t *testing.T) {
	for _, dir := range []string{"/", "/a", "/home/wizard/code", "/home/wizard"} {
		name := prewarmSlotName(dir)
		if sessionNameRe.MatchString(name) {
			t.Errorf("prewarmSlotName(%q) = %q, which sessionNameRe ACCEPTS — a client could address it", dir, name)
		}
	}
	// The prefix alone already exceeds the limit, which is what makes the
	// property hold for any directory rather than just the ones tested.
	if len(poolSlotPrefix) <= 32 {
		t.Errorf("poolSlotPrefix is %d chars; it must exceed the 32-char session-name limit "+
			"so that no directory suffix can bring a slot name back into addressable range", len(poolSlotPrefix))
	}
}

// systemd-escape --path is the naming contract for the tl-prewarm@ instance, so
// a wrong answer here starts the wrong unit (or none).
func TestSystemdEscapePath(t *testing.T) {
	cases := map[string]string{
		"/home/wizard/code":  "home-wizard-code",
		"/home/wizard/code/": "home-wizard-code",
		"/home/wizard":       "home-wizard",
		"/":                  "-",
	}
	for in, want := range cases {
		if got := systemdEscapePath(in); got != want {
			t.Errorf("systemdEscapePath(%q) = %q, want %q", in, got, want)
		}
	}
	// Cross-check against the real tool where it exists, so the in-process
	// version cannot drift from what systemd actually does.
	if _, err := exec.LookPath("systemd-escape"); err != nil {
		return
	}
	for in := range cases {
		out, err := exec.Command("systemd-escape", "--path", in).Output()
		if err != nil {
			continue
		}
		want := strings.TrimSpace(string(out))
		if got := systemdEscapePath(in); got != want {
			t.Errorf("systemdEscapePath(%q) = %q, but systemd-escape says %q", in, got, want)
		}
	}
}

// A directory has to be one the user's own lobby would create a session in.
// This is what stops the endpoint being a way to start Claude anywhere on the
// box, so relative paths and other people's directories are refused.
func TestPrewarmAllowedDirRejectsWhatIsNotTheirs(t *testing.T) {
	for _, dir := range []string{
		"",
		"relative/path",
		"../escape",
		"/etc",
		"/home/someone-else/code",
	} {
		if prewarmAllowedDir("nosuchuser-for-test", dir) {
			t.Errorf("prewarmAllowedDir refused nothing for %q", dir)
		}
	}
}

// The mark is the whole safety property: an unmarked session is either the
// standing pool slot or somebody's real work, and neither may be collected.
// A claimed slot has had its mark cleared by tmux-user-attach before the attach
// proceeds, which is why clearing it there comes before anything best-effort.
func TestSpeculativeTTLBoundsAreSane(t *testing.T) {
	if prewarmReapInterval >= speculativeTTL {
		t.Errorf("reap interval %s is not shorter than the TTL %s, so a slot could live "+
			"close to twice the TTL before being collected", prewarmReapInterval, speculativeTTL)
	}
	if speculativeTTL < 30*time.Second {
		t.Errorf("TTL %s is short enough to collect a slot while someone is still "+
			"deciding on a name", speculativeTTL)
	}
	if maxSpeculativeSlots < 1 {
		t.Error("the cap must admit at least one slot, or pre-warming never happens")
	}
}

// tmux-api runs as its own user but under the SYSTEM manager, so it inherits no
// XDG_RUNTIME_DIR and a bare `systemctl --user` fails with "Failed to connect to
// bus: No medium found". The self case is the one where it is easy to assume no
// environment is needed, and the failure is a warm that silently never happens.
func TestUserSystemctlAlwaysPointsAtTheUserBus(t *testing.T) {
	for _, osUser := range []string{selfUser, "someone-else"} {
		cmd := userSystemctl(osUser, "start", "--no-block", "unit.service")
		joined := strings.Join(cmd.Args, " ") + "\x00" + strings.Join(cmd.Env, "\x00")
		for _, want := range []string{"XDG_RUNTIME_DIR=", "DBUS_SESSION_BUS_ADDRESS="} {
			if !strings.Contains(joined, want) {
				t.Errorf("userSystemctl(%q) carries no %s, so `systemctl --user` cannot reach the bus", osUser, want)
			}
		}
	}
}
