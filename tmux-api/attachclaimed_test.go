package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The claim tells session-events the slot's new name (session-events
// firstprompt.go), so the slot's mod is under it before the browser's first
// prompt arrives. Measured 2026-10-03, before it did: a claimed slot's first
// prompt waited on the mod's retry backoff, p90 16.2s.

// stubCurl puts a curl on the harness PATH that records its arguments and the
// body it was handed, one file per call.
func stubCurl(h *bornHarness) string {
	h.t.Helper()
	out := h.t.TempDir()
	body := `#!/usr/bin/env bash
f="` + out + `/call.$$"
printf '%s\n' "$@" > "$f.args"
cat > "$f.body"
mv "$f.args" "$f.done"
`
	if err := os.WriteFile(filepath.Join(h.bin, "curl"), []byte(body), 0o755); err != nil {
		h.t.Fatal(err)
	}
	return out
}

type curlCall struct {
	args []string
	body string
}

// curlCalls waits up to a second for the backgrounded posts to land.
func curlCalls(t *testing.T, dir string, want int) []curlCall {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		done, _ := filepath.Glob(filepath.Join(dir, "*.done"))
		if len(done) >= want || time.Now().After(deadline) {
			var out []curlCall
			for _, d := range done {
				args, _ := os.ReadFile(d)
				body, _ := os.ReadFile(strings.TrimSuffix(d, ".done") + ".body")
				out = append(out, curlCall{strings.Fields(string(args)), string(body)})
			}
			return out
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestAClaimTellsSessionEventsTheNewName(t *testing.T) {
	h := newBornHarness(t)
	calls := stubCurl(h)
	dir := t.TempDir()
	h.session(h.slotName(dir))

	h.attach(bornID, dir, "claude", "", "")

	got := curlCalls(t, calls, 1)
	if len(got) != 1 {
		t.Fatalf("%d posts, want 1", len(got))
	}
	if !strings.Contains(strings.Join(got[0].args, " "), os.Getenv("TL_CLAIMED_ENDPOINT")) {
		t.Fatalf("posted to %q", got[0].args)
	}
	var body struct{ User, Session string }
	if err := json.Unmarshal([]byte(got[0].body), &body); err != nil {
		t.Fatalf("body %q: %v", got[0].body, err)
	}
	if body.Session != bornID || body.User == "" {
		t.Fatalf("body %+v", body)
	}
}

// A cold create has no slot's mod to move: its Claude says hello under the
// session's own name as it boots.
func TestAColdCreateTellsSessionEventsNothing(t *testing.T) {
	h := newBornHarness(t)
	calls := stubCurl(h)

	h.attach(bornID, t.TempDir(), "claude", "", "")

	if got := curlCalls(t, calls, 1); len(got) != 0 {
		t.Fatalf("a cold create posted %+v", got)
	}
}

// claimOnly runs the script in claim-only mode (6th argument "claim"), the way
// tmux-api's POST /sessions/claim does, and returns what it printed.
func (h *bornHarness) claimOnly(args ...string) string {
	h.t.Helper()
	cmd := exec.Command("bash", append([]string{h.script}, append(args, "claim")...)...)
	cmd.Env = append(os.Environ(), "PATH="+h.bin+":"+os.Getenv("PATH"),
		"TL_MOD_ID_FILE="+filepath.Join(h.home, "no-mod-id"))
	out, err := cmd.CombinedOutput()
	if err != nil {
		h.t.Fatalf("claim %v failed: %v\n%s", args, err, out)
	}
	return string(out)
}

// The composer claims the slot at Send, before its terminal attaches, so a slow
// link's WebSocket is off the first prompt's path. Claim-only mode does the
// claim exactly as an attach would, and then stops: no attach, no cold create.
func TestClaimOnlyClaimsTheSlotAndAttachesNothing(t *testing.T) {
	h := newBornHarness(t)
	dir := t.TempDir()
	h.session(h.slotName(dir))

	out := h.claimOnly(bornID, dir, "claude", "", "")

	if strings.Contains(out, "ATTACH") {
		t.Fatalf("claim-only attached:\n%s", out)
	}
	if !strings.Contains(out, "claimed") {
		t.Fatalf("claim-only did not say it claimed:\n%s", out)
	}
	if got := h.bornOf(bornID); got != bornID {
		t.Fatalf("the claimed session's birth name = %q, want %q", got, bornID)
	}
	if origin := h.tmuxDo("display", "-p", "-t", "="+bornID+":", "#{@tl_origin}"); origin != "user" {
		t.Fatalf("@tl_origin = %q, want user", origin)
	}
}

func TestClaimOnlyWithNoSlotCreatesNothing(t *testing.T) {
	h := newBornHarness(t)
	h.session("other")

	out := h.claimOnly(bornID, t.TempDir(), "claude", "", "")

	if strings.Contains(out, "ATTACH") || strings.Contains(out, "claimed") {
		t.Fatalf("claim-only with no slot did something:\n%s", out)
	}
	for _, n := range h.names() {
		if n == bornID {
			t.Fatal("claim-only cold-created the session")
		}
	}
}

// A model or effort choice cannot ride a warm slot, so it is not claimed.
func TestClaimOnlyLeavesTheSlotForAFlaggedCreate(t *testing.T) {
	h := newBornHarness(t)
	dir := t.TempDir()
	slot := h.slotName(dir)
	h.session(slot)

	if out := h.claimOnly(bornID, dir, "claude", "claude-sonnet-5", ""); strings.Contains(out, "claimed") {
		t.Fatalf("a create with a model claimed the slot:\n%s", out)
	}
	found := false
	for _, n := range h.names() {
		found = found || n == slot
	}
	if !found {
		t.Fatal("the slot is gone")
	}
}

// The session already exists, under its id or renamed from it: a retry after
// the title rename must not claim a second slot.
func TestClaimOnlyLeavesASessionBornAsTheID(t *testing.T) {
	h := newBornHarness(t)
	dir := t.TempDir()
	h.session(h.slotName(dir))
	h.session("fix-the-deploy")
	h.tmuxDo("set-option", "-t", "=fix-the-deploy:", "@tl_born", bornID)

	if out := h.claimOnly(bornID, dir, "claude", "", ""); strings.Contains(out, "claimed") {
		t.Fatalf("claimed a second slot for a session already born as the id:\n%s", out)
	}
}
