package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// A slot is warmed for a directory AND the model and effort a create will ask
// for, so a create with a model picked in the composer claims a booted Claude
// instead of starting one (docs/plans/2026-10-04-warm-slot-at-send-design.md).
// These run the real script against a real tmux, like the birth-name tests.

// stubClaudeKey points the harness user's `claude` key at a stub that stays up,
// so a warm leaves a live session behind to inspect.
func stubClaudeKey(h *bornHarness) {
	h.t.Helper()
	stub := filepath.Join(h.bin, "fakeclaude")
	if err := os.WriteFile(stub, []byte("#!/usr/bin/env bash\nexec sleep 600\n"), 0o755); err != nil {
		h.t.Fatal(err)
	}
	conf := filepath.Join(h.home, ".config", "terminal-lobby")
	if err := os.MkdirAll(conf, 0o755); err != nil {
		h.t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(conf, "commands"), []byte("claude="+stub+"\n"), 0o644); err != nil {
		h.t.Fatal(err)
	}
}

// installMod writes an installed mod id and returns the file.
func installMod(h *bornHarness, id string) string {
	h.t.Helper()
	f := filepath.Join(h.home, "mod-id")
	if err := os.WriteFile(f, []byte(id+"\n"), 0o644); err != nil {
		h.t.Fatal(err)
	}
	return f
}

// runScript runs the script with the harness PATH and the given mod id file.
func (h *bornHarness) runScript(modFile string, args ...string) string {
	h.t.Helper()
	cmd := exec.Command("bash", append([]string{h.script}, args...)...)
	cmd.Env = append(os.Environ(), "PATH="+h.bin+":"+os.Getenv("PATH"), "TL_MOD_ID_FILE="+modFile)
	out, err := cmd.CombinedOutput()
	if err != nil {
		h.t.Fatalf("script %v failed: %v\n%s", args, err, out)
	}
	return string(out)
}

func (h *bornHarness) option(session, opt string) string {
	h.t.Helper()
	return h.tmuxDo("display", "-p", "-t", "="+session+":", "#{"+opt+"}")
}

func (h *bornHarness) has(name string) bool {
	for _, n := range h.names() {
		if n == name {
			return true
		}
	}
	return false
}

func TestSlotNameCarriesTheFlags(t *testing.T) {
	h := newBornHarness(t)
	dir := "/home/wizard/code/terminal-lobby/"
	plain := h.slotName(dir)
	if got := prewarmSlotName(dir, "", ""); got != plain {
		t.Fatalf("a slot with no flags changed name: go %q, shell %q", got, plain)
	}
	seen := map[string]bool{plain: true}
	for _, f := range [][2]string{
		{"claude-opus-5[1m]", "high"},
		{"claude-sonnet-5", ""},
		{"", "max"},
	} {
		shell := h.slotName(dir, f[0], f[1])
		if got := prewarmSlotName(dir, f[0], f[1]); got != shell {
			t.Errorf("flags %v: go %q, shell %q", f, got, shell)
		}
		if seen[shell] {
			t.Errorf("flags %v share a slot name with another choice: %q", f, shell)
		}
		seen[shell] = true
		if sessionNameRe.MatchString(shell) {
			t.Errorf("flagged slot %q is addressable by a client", shell)
		}
	}
}

func TestClaimOnlyClaimsTheSlotWarmedWithTheSameFlags(t *testing.T) {
	h := newBornHarness(t)
	dir := t.TempDir()
	plain := h.slotName(dir)
	flagged := h.slotName(dir, "claude-sonnet-5", "high")
	h.session(plain)
	h.session(flagged)

	out := h.claimOnly(bornID, dir, "claude", "claude-sonnet-5", "high")

	if strings.TrimSpace(out) != "claimed" {
		t.Fatalf("a flagged create did not claim its slot:\n%s", out)
	}
	if h.has(flagged) || !h.has(bornID) {
		t.Fatalf("the flagged slot was not the one claimed: %v", h.names())
	}
	if !h.has(plain) {
		t.Fatal("a flagged create took the default slot")
	}
}

// The claim says what it found, so the composer can say why a first prompt
// was slow: a booted slot, a stale one it had to drop, or none at all.
func TestClaimOnlySaysWhatItFound(t *testing.T) {
	t.Run("none", func(t *testing.T) {
		h := newBornHarness(t)
		h.session("other")
		if out := strings.TrimSpace(h.claimOnly(bornID, t.TempDir(), "claude", "", "")); out != "none" {
			t.Fatalf("no slot: said %q, want none", out)
		}
	})
	// tmux 3.4 answers `display -t '=<missing>:'` with exit 0 and nothing
	// printed, which read as a slot stamped with no mod: a create in a
	// directory with no slot logged "dropped slot", said stale, and started a
	// standing refill there (found 2026-10-04).
	t.Run("none, with a mod installed", func(t *testing.T) {
		h := newBornHarness(t)
		h.session("other")
		out := strings.TrimSpace(h.runScript(installMod(h, "new"), bornID, t.TempDir(), "claude", "", "", "claim"))
		if out != "none" {
			t.Fatalf("no slot with a mod installed: said %q, want none", out)
		}
	})
	t.Run("stale", func(t *testing.T) {
		h := newBornHarness(t)
		dir := t.TempDir()
		slot := h.slotName(dir)
		h.session(slot)
		h.tmuxDo("set-option", "-t", "="+slot+":", "@tl_mod_id", "old")
		out := strings.TrimSpace(h.runScript(installMod(h, "new"), bornID, dir, "claude", "", "", "claim"))
		if out != "stale" {
			t.Fatalf("stale slot: said %q, want stale", out)
		}
		if h.has(bornID) {
			t.Fatal("a stale slot was claimed")
		}
	})
	t.Run("claimed", func(t *testing.T) {
		h := newBornHarness(t)
		dir := t.TempDir()
		h.session(h.slotName(dir))
		if out := strings.TrimSpace(h.claimOnly(bornID, dir, "claude", "", "")); out != "claimed" {
			t.Fatalf("warm slot: said %q, want claimed", out)
		}
	})
}

// tmux-api warms by argument rather than through a systemd unit, because a
// unit instance carries one string and a slot is now a directory, a model and
// an effort. `prewarm` is a speculative slot, `pool` a standing one.
func TestWarmByArgumentBuildsTheSlotAndSaysWhatItIs(t *testing.T) {
	h := newBornHarness(t)
	stubClaudeKey(h)
	dir := t.TempDir()
	mod := installMod(h, "m1")

	h.runScript(mod, "_", dir, "claude", "claude-sonnet-5", "high", "prewarm")

	slot := h.slotName(dir, "claude-sonnet-5", "high")
	if !h.has(slot) {
		t.Fatalf("no flagged slot after a warm: %v", h.names())
	}
	real, _ := filepath.EvalSymlinks(dir)
	for opt, want := range map[string]string{
		"@tl_slot_dir":    real,
		"@tl_slot_model":  "claude-sonnet-5",
		"@tl_slot_effort": "high",
		"@tl_mod_id":      "m1",
	} {
		if got := h.option(slot, opt); got != want {
			t.Errorf("%s = %q, want %q", opt, got, want)
		}
	}
	if h.option(slot, "@tl_speculative") == "" {
		t.Error("a prewarm slot is not marked speculative, so the reaper would never collect it")
	}
	if cmd := h.option(slot, "pane_start_command"); !strings.Contains(cmd, "--model 'claude-sonnet-5'") ||
		!strings.Contains(cmd, "--effort 'high'") {
		t.Errorf("the slot's Claude was not started with the flags: %q", cmd)
	}

	h.runScript(mod, "_", dir, "claude", "", "", "pool")
	standing := h.slotName(dir)
	if !h.has(standing) {
		t.Fatalf("no standing slot after a pool warm: %v", h.names())
	}
	if h.option(standing, "@tl_speculative") != "" {
		t.Error("a standing slot is marked speculative, so the reaper would collect it")
	}
	if got := h.option(standing, "@tl_slot_dir"); got != real {
		t.Errorf("standing @tl_slot_dir = %q, want %q", got, real)
	}
}

// A standing slot is always on Default: a flagged create is a guess about one
// session, and keeping one Claude per model forever is the idle cost warming
// on demand avoids.
func TestPoolWarmIgnoresFlags(t *testing.T) {
	h := newBornHarness(t)
	stubClaudeKey(h)
	dir := t.TempDir()

	h.runScript(installMod(h, "m1"), "_", dir, "claude", "claude-sonnet-5", "high", "pool")

	if h.has(h.slotName(dir, "claude-sonnet-5", "high")) {
		t.Fatal("a standing slot was warmed with flags")
	}
	if !h.has(h.slotName(dir)) {
		t.Fatalf("no standing slot: %v", h.names())
	}
}
