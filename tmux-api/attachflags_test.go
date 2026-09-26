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
	out, _ := runAttachWithLog(t, args...)
	return out
}

// runAttachWithLog returns that same command line AND every tmux invocation the
// script made along the way. The two differ because the claim path sends its
// tmux calls to /dev/null — deliberately, so a failed option write cannot break
// a session start — which puts them out of reach of stdout. The stub appends
// its argv to a file as well, and that file is the second return.
func runAttachWithLog(t *testing.T, args ...string) (string, string) {
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
	tmuxLog := filepath.Join(t.TempDir(), "tmux-argv")
	write("tmux", "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\"\n"+
		"printf '%s\\n' \"$*\" >> "+shellQuote(tmuxLog)+"\nexit 0\n")
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
	// Absent when the script made no tmux call at all, which is not a failure
	// here — the caller asserts on what it finds.
	logged, _ := os.ReadFile(tmuxLog)
	return string(out), string(logged)
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

// shellQuote is enough for a t.TempDir() path, which carries no quotes.
func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

func TestAttachPassesTheModelAndEffortAsFlags(t *testing.T) {
	got := runAttach(t, "flagcase", "/tmp", "claude", "claude-opus-5", "max")
	for _, want := range []string{"--model 'claude-opus-5'", "--effort 'max'"} {
		if !strings.Contains(got, want) {
			t.Errorf("command line is missing %q:\n%s", want, got)
		}
	}
}

// The context-window suffix is the one model name that is not plain
// alphanumerics, and it has to survive two things: a whitelist that used to
// end at `-`, and the shell the command line is handed to, where `[1m]` is a
// glob. A bare `--model claude-opus-5[1m]` expands away the moment a file in
// the start directory matches, which is why the flag is quoted.
func TestAttachCarriesTheContextWindowSuffix(t *testing.T) {
	got := runAttach(t, "flagcase", "/tmp", "claude", "claude-opus-5[1m]", "max")
	if !strings.Contains(got, "--model 'claude-opus-5[1m]'") {
		t.Errorf("the 1M suffix did not reach the command line:\n%s", got)
	}
}

// A pinned build carries a date, which is 25 characters before anything is
// added. The whitelist has to admit the longest real name, not just the short
// ones.
func TestAttachCarriesADatedBuild(t *testing.T) {
	got := runAttach(t, "flagcase", "/tmp", "claude", "claude-haiku-4-5-20251001", "low")
	if !strings.Contains(got, "--model 'claude-haiku-4-5-20251001'") {
		t.Errorf("a dated build did not reach the command line:\n%s", got)
	}
}

// Codex spells both differently, and the reasoning level is config rather than
// a flag. One shared spelling would start a codex that ignores the choice.
func TestAttachSpellsCodexsFlagsCodexsWay(t *testing.T) {
	got := runAttach(t, "flagcase", "/tmp", "codex", "gpt-5.6-terra", "high")
	for _, want := range []string{"-m 'gpt-5.6-terra'", "-c model_reasoning_effort='high'"} {
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
		// The bracket class the 1M suffix opened, offered without closing it
		// and with something other than a short token inside.
		"claude-opus-5[1m",
		"claude-opus-5[1m]x",
		"claude-opus-5[$(id)]",
	} {
		got := runAttach(t, "flagcase", "/tmp", "claude", bad, "max")
		if strings.Contains(got, "--model") {
			t.Errorf("model %q reached the command line:\n%s", bad, got)
		}
		// The rest of the line still has to be built: a refused model is "no
		// choice", not a refused session.
		if !strings.Contains(got, "--effort 'max'") {
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

// The claim is the moment a pooled session became somebody's, and it is the
// only moment anything records: `rename-session` leaves #{session_created}
// reading the SLOT's age, which a standing slot makes days wrong. So the claim
// has to stamp @tl_created, and a create that never claims must not — a cold
// create's session_created is already the right answer, and stamping it here
// would be writing an option for the sake of it.
//
// Asserted through the real script for the reason the tests above are: the stub
// tmux prints the argv it was handed, so what shows up is what the script would
// actually have run.
func TestAttachStampsTheClaimTime(t *testing.T) {
	_, claimed := runAttachWithLog(t, "flagcase", "/tmp", "claude", "", "")
	if !strings.Contains(claimed, "rename-session") {
		t.Fatalf("no claim happened, so there is nothing to assert on:\n%s", claimed)
	}
	// `=flagcase:` and not `=flagcase`: set-option rejects the bare exact form,
	// and a plain name resolves by unambiguous prefix, which could stamp a
	// neighbouring session.
	want := "set-option -t =flagcase: " + createdStampOption + " "
	if !strings.Contains(claimed, want) {
		t.Errorf("a claim did not run %q, so the claimed session keeps the slot's age:\n%s",
			want, claimed)
	}
	// After the speculative mark is dropped, never before: the comment on that
	// clear says nothing best-effort may run while the mark still points the
	// reaper at live work.
	clear := strings.Index(claimed, "set-option -u")
	stamp := strings.Index(claimed, createdStampOption)
	if clear >= 0 && stamp >= 0 && stamp < clear {
		t.Errorf("the stamp ran before the speculative mark was cleared:\n%s", claimed)
	}

	// A flagged create cannot claim a slot warmed without those flags, so it
	// takes the cold path — where session_created is already the moment the
	// session became somebody's and there is nothing to correct.
	_, flagged := runAttachWithLog(t, "flagcase", "/tmp", "claude", "opus", "")
	if strings.Contains(flagged, createdStampOption) {
		t.Errorf("a create that never claimed a slot stamped %s anyway:\n%s",
			createdStampOption, flagged)
	}
}
