package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The model and effort a NEW session launches on, as flags on the command
// tmux-user-attach starts.
//
// It lives in this module for the reason TestPrewarmSlotNameMatchesShell does:
// devvm/ holds shell with no test target of its own, and this is the Go module
// that already owns the checks against it and runs in CI. What is tested is the
// REAL script — run with a stub tmux on PATH that prints the argv it was handed
// — not a copy of its rules, so an edit to the script cannot leave the test
// passing against a version of itself that no longer exists.
//
// The security question these answer: the resolved command line runs through
// `$SHELL -lic "$cmd"`, so anything reaching it is code. Both values are
// whitelisted tokens, and every case below that expects NO flag is a case where
// something outside that whitelist was offered.

// runAttach runs the script with a stub tmux and returns the command line it
// would have started. `TL_POOL_WARM` is off, so it takes the ordinary attach
// path and execs tmux — which is the stub.
func runAttach(t *testing.T, args ...string) string {
	t.Helper()
	script, err := filepath.Abs(filepath.Join("..", "devvm", "tmux-user-attach"))
	if err != nil || !fileExists(script) {
		t.Skip("tmux-user-attach not present")
	}
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash not available")
	}

	// A stub tmux that prints its argv and succeeds, plus a stub systemd-run
	// that just runs what it was given, so the script's scope branch is
	// transparent rather than skipped.
	bin := t.TempDir()
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(bin, name), []byte(body), 0o755); err != nil {
			t.Fatalf("stub %s: %v", name, err)
		}
	}
	write("tmux", "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\"\nexit 0\n")
	write("systemd-run", "#!/usr/bin/env bash\nwhile [[ \"$1\" == -* ]]; do shift; done\nexec \"$@\"\n")
	write("logger", "#!/usr/bin/env bash\nexit 0\n")

	// And a stub getent, which is what makes this hermetic. The script resolves
	// the home and the login shell out of the password database rather than the
	// environment — deliberately, so a caller cannot point it elsewhere — so a
	// test run on a real account reads that account's own
	// ~/.config/terminal-lobby/commands and its own shell. The first run of
	// this test did exactly that and read a commands file carrying an
	// `--effort max` of its own, which is indistinguishable from the script
	// having added one.
	home := t.TempDir()
	write("getent", "#!/usr/bin/env bash\nprintf 'tl:x:1000:1000::%s:/bin/bash\\n' "+
		shellQuote(home)+"\nexit 0\n")

	cmd := exec.Command("bash", append([]string{script}, args...)...)
	cmd.Env = append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"))
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("attach %v failed: %v\n%s", args, err, out)
	}
	return string(out)
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

// shellQuote is enough for a t.TempDir() path, which carries no quotes.
func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

func TestAttachPassesTheModelAndEffortAsFlags(t *testing.T) {
	got := runAttach(t, "flagcase", "/tmp", "claude", "opus", "max")
	for _, want := range []string{"--model opus", "--effort max"} {
		if !strings.Contains(got, want) {
			t.Errorf("command line is missing %q:\n%s", want, got)
		}
	}
}

// Codex spells both differently, and the reasoning level is config rather than
// a flag. One shared spelling would start a codex that ignores the choice.
func TestAttachSpellsCodexsFlagsCodexsWay(t *testing.T) {
	got := runAttach(t, "flagcase", "/tmp", "codex", "gpt-5.6-terra", "high")
	for _, want := range []string{"-m gpt-5.6-terra", "-c model_reasoning_effort=high"} {
		if !strings.Contains(got, want) {
			t.Errorf("command line is missing %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "--model") || strings.Contains(got, "--effort") {
		t.Errorf("codex was given Claude's flags:\n%s", got)
	}
}

// THE SECURITY CASE. The command line is run through `$SHELL -lic`, so a value
// that carries a quote, a space, a `$` or a `;` is code rather than a name.
// Every one of these has to reach the command line as nothing at all.
func TestAttachRefusesAnythingOutsideTheWhitelist(t *testing.T) {
	for _, bad := range []string{
		"opus; touch /tmp/tl-pwned",
		"opus$(id)",
		"opus `id`",
		"opus'",
		`opus"`,
		"opus max",
		"../../etc/passwd",
		"OPUS",
		"-rf",
		strings.Repeat("o", 33),
	} {
		got := runAttach(t, "flagcase", "/tmp", "claude", bad, "max")
		if strings.Contains(got, "--model") {
			t.Errorf("model %q reached the command line:\n%s", bad, got)
		}
		// The rest of the line still has to be built: a refused model is "no
		// choice", not a refused session.
		if !strings.Contains(got, "--effort max") {
			t.Errorf("model %q took the effort with it:\n%s", bad, got)
		}
		if strings.Contains(got, "tl-pwned") {
			t.Fatalf("model %q was evaluated rather than refused:\n%s", bad, got)
		}
	}
	for _, bad := range []string{"max; id", "max$(id)", "MAX", "max2", "", "verylongeffortlevel"} {
		got := runAttach(t, "flagcase", "/tmp", "claude", "opus", bad)
		if strings.Contains(got, "--effort") {
			t.Errorf("effort %q reached the command line:\n%s", bad, got)
		}
	}
}

// No choice is the common case and has to leave the command line exactly as it
// was, or every existing attach changes shape.
func TestAttachAddsNothingWithoutAChoice(t *testing.T) {
	got := runAttach(t, "flagcase", "/tmp", "claude", "", "")
	if strings.Contains(got, "--model") || strings.Contains(got, "--effort") {
		t.Errorf("an unasked-for flag appeared:\n%s", got)
	}
	if !strings.Contains(got, "claude") {
		t.Errorf("the command itself went missing:\n%s", got)
	}
}

// A plain shell has no model, and `default` has no command line to add to —
// tmux's own default-command decides what runs there.
func TestAttachAddsNothingToAShellOrTheDefault(t *testing.T) {
	for _, key := range []string{"shell", "default", ""} {
		got := runAttach(t, "flagcase", "/tmp", key, "opus", "max")
		if strings.Contains(got, "opus") || strings.Contains(got, "max") {
			t.Errorf("key %q was given model flags:\n%s", key, got)
		}
	}
}

// A slot is warmed with no flags and a running Claude cannot be re-flagged, so
// a create that asked for either must not claim one. The stub tmux answers
// success to everything, including the rename, so a claim that was attempted at
// all shows up as a rename-session in the output.
func TestAttachDoesNotClaimAWarmSlotForAFlaggedCreate(t *testing.T) {
	flagged := runAttach(t, "flagcase", "/tmp", "claude", "opus", "")
	if strings.Contains(flagged, "rename-session") {
		t.Errorf("a flagged create tried to claim a slot warmed without them:\n%s", flagged)
	}
	// Without a choice it still claims, which is the head start everything else
	// keeps.
	plain := runAttach(t, "flagcase", "/tmp", "claude", "", "")
	if !strings.Contains(plain, "rename-session") {
		t.Errorf("an unflagged create stopped claiming its slot:\n%s", plain)
	}
}
