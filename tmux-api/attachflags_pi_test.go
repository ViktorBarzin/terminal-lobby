package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The pi half of the launch contract (docs/plans/2026-09-25-pi-harness-design.md).
//
// Pi is started BARE. The model and thinking level a person picked reach it as
// TL_PI_MODEL and TL_PI_THINKING in the session's environment, for the lobby's
// pi extension to apply, and never as `--model` / `--thinking`: pi exits 1 on a
// model the account no longer lists, and the session would close as it opened.
//
// The environment rides `tmux new-session -e NAME=value`, one argv element per
// variable, so no shell ever parses the value. The regexes are still the first
// line of defence, and these tests hold both: what the gate admits, and that
// what it admits arrives as exactly the argv element it was.

// runAttachArgv runs the real script with a stub tmux that records every
// invocation's argv, one element per field, and returns the new-session call.
// runAttach flattens argv with spaces, which cannot tell `-e 'A=b c'` from
// `-e A=b c`; the question here is precisely where one element ends.
func runAttachArgv(t *testing.T, args ...string) []string {
	t.Helper()
	calls := runAttachCalls(t, args...)
	for i := len(calls) - 1; i >= 0; i-- {
		if len(calls[i]) > 0 && calls[i][0] == "new-session" {
			return calls[i]
		}
	}
	t.Fatalf("attach %v made no new-session call; calls: %q", args, calls)
	return nil
}

// runAttachCalls is every tmux invocation the script made, each as its argv.
func runAttachCalls(t *testing.T, args ...string) [][]string {
	t.Helper()
	script, err := filepath.Abs(filepath.Join("..", "devvm", "tmux-user-attach"))
	if err != nil || !fileExists(script) {
		t.Skip("tmux-user-attach not present")
	}
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash not available")
	}
	bin := t.TempDir()
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(bin, name), []byte(body), 0o755); err != nil {
			t.Fatalf("stub %s: %v", name, err)
		}
	}
	logPath := filepath.Join(t.TempDir(), "tmux-argv")
	// \x1f between elements and a newline after each call. Neither can appear in
	// anything the gates admit, so a split on them is exact.
	write("tmux", "#!/usr/bin/env bash\n{ for a in \"$@\"; do printf '%s\\x1f' \"$a\"; done; printf '\\n'; } >> "+
		shellQuote(logPath)+"\nexit 0\n")
	write("systemd-run", "#!/usr/bin/env bash\nwhile [[ \"$1\" == -* ]]; do shift; done\nexec \"$@\"\n")
	// Keeps a claim's refill away from the real user manager (attachflags_test.go).
	write("systemctl", "#!/usr/bin/env bash\nexit 0\n")
	write("logger", "#!/usr/bin/env bash\nexit 0\n")
	home := t.TempDir()
	write("getent", "#!/usr/bin/env bash\nprintf 'tl:x:1000:1000::%s:/bin/bash\\n' "+shellQuote(home)+"\nexit 0\n")

	cmd := exec.Command("bash", append([]string{script}, args...)...)
	cmd.Env = append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("attach %v failed: %v\n%s", args, err, out)
	}
	raw, _ := os.ReadFile(logPath)
	var calls [][]string
	for _, line := range strings.Split(strings.TrimRight(string(raw), "\n"), "\n") {
		if line == "" {
			continue
		}
		calls = append(calls, strings.Split(strings.TrimSuffix(line, "\x1f"), "\x1f"))
	}
	return calls
}

// envOf returns the values new-session was handed with -e, by variable name.
func envOf(argv []string) map[string]string {
	env := map[string]string{}
	for i := 0; i+1 < len(argv); i++ {
		if argv[i] != "-e" {
			continue
		}
		name, value, _ := strings.Cut(argv[i+1], "=")
		env[name] = value
	}
	return env
}

// commandOf is what the session runs: the three elements after the flags,
// `<shell> -lic <line>`, as tmux-user-attach builds them.
func commandOf(t *testing.T, argv []string) []string {
	t.Helper()
	for i := 0; i+2 < len(argv); i++ {
		if argv[i+1] == "-lic" {
			return argv[i : i+3]
		}
	}
	t.Fatalf("new-session carries no `<shell> -lic <line>`: %q", argv)
	return nil
}

func TestAttachStartsPiBareWithTheChoiceInItsEnvironment(t *testing.T) {
	argv := runAttachArgv(t, "flagcase", "/tmp", "pi", "anthropic/claude-opus-5", "high")

	env := envOf(argv)
	if env["TL_PI_MODEL"] != "anthropic/claude-opus-5" {
		t.Errorf("TL_PI_MODEL = %q, want anthropic/claude-opus-5; argv %q", env["TL_PI_MODEL"], argv)
	}
	if env["TL_PI_THINKING"] != "high" {
		t.Errorf("TL_PI_THINKING = %q, want high; argv %q", env["TL_PI_THINKING"], argv)
	}
	// Exactly `pi`. A --model pi does not know exits 1 before the session is up.
	if got := commandOf(t, argv); got[2] != "pi" {
		t.Errorf("the session runs %q, want exactly `pi` with no flags", got[2])
	}
	for _, a := range argv {
		if strings.Contains(a, "--model") || strings.Contains(a, "--thinking") {
			t.Errorf("pi was given a flag it would exit on: %q", argv)
		}
	}
	// -e belongs to new-session, so it has to come before the command it
	// configures; after it, tmux would take it as part of the command.
	if i, j := indexOf(argv, "-e"), indexOf(argv, "-lic"); i < 0 || j < 0 || i > j {
		t.Errorf("the environment is not handed to new-session ahead of the command: %q", argv)
	}
}

// Pi names a model provider/id, and the ids are not Claude's alphabet: a
// catalogue carries dots, colons (ollama tags, OpenRouter variants), a second
// slash (OpenRouter's upstream provider), and the odd @ or ~. Each must reach pi
// as the single element it was.
func TestAttachCarriesPisModelReferences(t *testing.T) {
	for _, ref := range []string{
		"anthropic/claude-opus-5",
		"anthropic/claude-haiku-4-5-20251001",
		"openrouter/anthropic/claude-3.5-sonnet:beta",
		"ollama/qwen2.5-coder:7b",
		"amazon-bedrock/us.anthropic.claude-opus-5-v1:0",
		"llama-cpp/Qwen3-Coder@q4~1",
		"a" + strings.Repeat("b", 95), // the longest the gate admits
	} {
		env := envOf(runAttachArgv(t, "flagcase", "/tmp", "pi", ref, ""))
		if env["TL_PI_MODEL"] != ref {
			t.Errorf("ref %q arrived as TL_PI_MODEL=%q", ref, env["TL_PI_MODEL"])
		}
		if _, set := env["TL_PI_THINKING"]; set {
			t.Errorf("no level was chosen and TL_PI_THINKING=%q was set anyway", env["TL_PI_THINKING"])
		}
	}
}

// THE SECURITY CASE for pi. None of these may reach the session in any form:
// not as an environment value, not appended to the command line. A refused
// model is "no choice" and the rest of the launch goes ahead.
func TestAttachRefusesPiValuesOutsideTheWhitelist(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "tl-pwned")
	for _, bad := range []string{
		"anthropic/x;touch " + marker,
		"anthropic/x$(touch " + marker + ")",
		"anthropic/x`touch " + marker + "`",
		"anthropic/x y",
		"anthropic/x'y",
		`anthropic/x"y`,
		"anthropic/x\ny",
		"anthropic/x\ty",
		"anthropic/x=y",
		"anthropic/x,y",
		"/anthropic/x",
		"-anthropic/x",
		"~/x",
		".hidden/x",
		"claude-opus-5[1m]", // Claude's suffix is Claude's, not a pi ref
		"a" + strings.Repeat("b", 96),
	} {
		argv := runAttachArgv(t, "flagcase", "/tmp", "pi", bad, "low")
		env := envOf(argv)
		if v, set := env["TL_PI_MODEL"]; set {
			t.Errorf("model %q reached the session as TL_PI_MODEL=%q", bad, v)
		}
		if env["TL_PI_THINKING"] != "low" {
			t.Errorf("model %q took the thinking level with it: %q", bad, argv)
		}
		if got := commandOf(t, argv); got[2] != "pi" {
			t.Errorf("model %q changed the command line to %q", bad, got[2])
		}
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("a refused model was evaluated by a shell")
	}
}

// Pi's seven levels and nothing else. A word from Claude's ladder that pi does
// not have is refused rather than handed to an extension that would reject it.
func TestAttachAdmitsOnlyPisThinkingLevels(t *testing.T) {
	for _, level := range []string{"off", "minimal", "low", "medium", "high", "xhigh", "max"} {
		env := envOf(runAttachArgv(t, "flagcase", "/tmp", "pi", "", level))
		if env["TL_PI_THINKING"] != level {
			t.Errorf("level %q arrived as TL_PI_THINKING=%q", level, env["TL_PI_THINKING"])
		}
		if _, set := env["TL_PI_MODEL"]; set {
			t.Errorf("no model was chosen and TL_PI_MODEL=%q was set anyway", env["TL_PI_MODEL"])
		}
	}
	for _, bad := range []string{"ultracode", "ultra", "none", "MAX", "High", "high;id", "high ", "x"} {
		env := envOf(runAttachArgv(t, "flagcase", "/tmp", "pi", "anthropic/claude-opus-5", bad))
		if v, set := env["TL_PI_THINKING"]; set {
			t.Errorf("level %q reached the session as TL_PI_THINKING=%q", bad, v)
		}
		if env["TL_PI_MODEL"] != "anthropic/claude-opus-5" {
			t.Errorf("level %q took the model with it", bad)
		}
	}
}

// Widening the gate for pi leaves Claude's and Codex's exactly where it was. A
// pi reference is not a Claude model name, and the other keys never carry the
// pi variables.
func TestAttachKeepsTheOtherKeysOnTheirOwnGate(t *testing.T) {
	claude := runAttach(t, "flagcase", "/tmp", "claude", "anthropic/claude-opus-5", "max")
	if strings.Contains(claude, "--model") {
		t.Errorf("claude was handed a pi reference as a model:\n%s", claude)
	}
	for _, key := range []string{"claude", "codex", "shell", "default"} {
		env := envOf(runAttachArgv(t, "flagcase", "/tmp", key, "opus", "high"))
		for _, name := range []string{"TL_PI_MODEL", "TL_PI_THINKING"} {
			if v, set := env[name]; set {
				t.Errorf("key %q was handed %s=%q", key, name, v)
			}
		}
	}
}

// Pi is not pooled: only a `claude` slot is ever warmed, so a pi create takes
// the cold path and never tries to claim one.
func TestAttachDoesNotClaimAWarmSlotForPi(t *testing.T) {
	for _, call := range runAttachCalls(t, "flagcase", "/tmp", "pi", "", "") {
		if len(call) > 0 && call[0] == "rename-session" {
			t.Fatalf("a pi create tried to claim a claude slot: %q", call)
		}
	}
}

// tmux-attach.sh is the first of the two gates and runs as ttyd's user, before
// the sudo. It is exercised here through a copy whose two absolute exec targets
// point at stubs, which is the only edit: everything between reading the URL
// arguments and exec'ing tmux-user-attach is the real script.
func runTTYDAttach(t *testing.T, args ...string) []string {
	t.Helper()
	src, err := os.ReadFile(filepath.Join("..", "devvm", "tmux-attach.sh"))
	if err != nil {
		t.Skipf("tmux-attach.sh not readable: %v", err)
	}
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash not available")
	}
	dir := t.TempDir()
	out := filepath.Join(dir, "argv")
	stub := filepath.Join(dir, "tmux-user-attach")
	if err := os.WriteFile(stub, []byte("#!/usr/bin/env bash\n{ for a in \"$@\"; do printf '%s\\x1f' \"$a\"; done; } > "+
		shellQuote(out)+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	body := strings.ReplaceAll(string(src), "/usr/local/bin/tmux-user-attach", stub)
	if strings.Contains(body, "exec sudo") && !strings.Contains(body, stub) {
		t.Fatal("tmux-attach.sh no longer execs /usr/local/bin/tmux-user-attach; this test is reading the wrong thing")
	}
	script := filepath.Join(dir, "tmux-attach.sh")
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(dir, "bin")
	if err := os.Mkdir(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "logger"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("bash", append([]string{script}, args...)...)
	// Single-user: the identity header only has to be present, and the attach is
	// the caller's own, so the script execs tmux-user-attach directly.
	cmd.Env = append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"), "TL_MULTI_USER=off", "TTYD_USER=tl-test")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("tmux-attach.sh %v failed: %v\n%s", args, err, b)
	}
	raw, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("tmux-attach.sh %v never reached tmux-user-attach: %v", args, err)
	}
	return strings.Split(strings.TrimSuffix(string(raw), "\x1f"), "\x1f")
}

// tmux-user-attach's argv is name, dir, key, model, effort.
func TestTTYDAttachForwardsPiReferences(t *testing.T) {
	for _, ref := range []string{"anthropic/claude-opus-5", "openrouter/anthropic/claude-3.5-sonnet:beta", "llama-cpp/Qwen3-Coder@q4~1"} {
		got := runTTYDAttach(t, "flagcase", "pi", "/tmp", "", "", ref, "xhigh")
		if len(got) != 5 || got[2] != "pi" || got[3] != ref || got[4] != "xhigh" {
			t.Errorf("ref %q was forwarded as %q", ref, got)
		}
	}
}

func TestTTYDAttachRefusesPiValuesOutsideTheWhitelist(t *testing.T) {
	for _, bad := range []string{"anthropic/x;id", "anthropic/x$(id)", "anthropic/x y", "x'y", "/x", "claude-opus-5[1m]", "a" + strings.Repeat("b", 96)} {
		got := runTTYDAttach(t, "flagcase", "pi", "/tmp", "", "", bad, "ultracode")
		if len(got) != 5 || got[3] != "" || got[4] != "" {
			t.Errorf("model %q / effort ultracode were forwarded as %q", bad, got)
		}
	}
}

// Claude keeps its own gate at this layer too, the [1m] suffix included.
func TestTTYDAttachKeepsClaudesGate(t *testing.T) {
	if got := runTTYDAttach(t, "flagcase", "claude", "/tmp", "", "", "claude-opus-5[1m]", "max"); got[3] != "claude-opus-5[1m]" || got[4] != "max" {
		t.Errorf("claude's 1M suffix no longer passes the first gate: %q", got)
	}
	if got := runTTYDAttach(t, "flagcase", "claude", "/tmp", "", "", "anthropic/claude-opus-5", "max"); got[3] != "" {
		t.Errorf("a pi reference passed claude's gate: %q", got)
	}
}

// The two scripts are two gates on one value, and a model the first admits and
// the second refuses is a choice that silently vanishes. The pi patterns are
// the same literal in both.
func TestPiGatesMatchAcrossBothScripts(t *testing.T) {
	read := func(name string) string {
		b, err := os.ReadFile(filepath.Join("..", "devvm", name))
		if err != nil {
			t.Skipf("%s not readable: %v", name, err)
		}
		return string(b)
	}
	pattern := func(src, name string) string {
		m := regexp.MustCompile(`(?m)^\s*` + name + `='([^']*)'`).FindStringSubmatch(src)
		if m == nil {
			t.Fatalf("no %s= line", name)
		}
		return m[1]
	}
	ttyd, user := read("tmux-attach.sh"), read("tmux-user-attach")
	if a, b := pattern(ttyd, "PI_MODEL_ARG_RE"), pattern(user, "PI_MODEL_RE"); a != b {
		t.Errorf("pi model gates differ:\n  tmux-attach.sh   %s\n  tmux-user-attach %s", a, b)
	}
	if a, b := pattern(ttyd, "PI_EFFORT_ARG_RE"), pattern(user, "PI_EFFORT_RE"); a != b {
		t.Errorf("pi thinking gates differ:\n  tmux-attach.sh   %s\n  tmux-user-attach %s", a, b)
	}
	// And they are the contract the frontend was given.
	if got := pattern(user, "PI_MODEL_RE"); got != `^[A-Za-z0-9][A-Za-z0-9._:@/~-]{0,95}$` {
		t.Errorf("PI_MODEL_RE = %s, not the agreed ^[A-Za-z0-9][A-Za-z0-9._:@/~-]{0,95}$", got)
	}
	if got := pattern(user, "PI_EFFORT_RE"); got != `^(off|minimal|low|medium|high|xhigh|max)$` {
		t.Errorf("PI_EFFORT_RE = %s, not pi's seven levels", got)
	}
}

func indexOf(xs []string, want string) int {
	for i, x := range xs {
		if x == want {
			return i
		}
	}
	return -1
}
