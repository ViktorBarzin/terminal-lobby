package main

import (
	"encoding/json"
	"os"
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
