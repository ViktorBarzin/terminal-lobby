package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"terminal-lobby/sessionio"
)

// goodConfig is a configuration that passes every gate, so a test can break
// exactly one thing.
func goodConfig(t *testing.T) Config {
	t.Helper()
	home := t.TempDir()
	return Config{
		OSUser:       "wizard",
		HomeDir:      home,
		BaseDir:      filepath.Join(home, ".t3"),
		Endpoint:     "http://127.0.0.1:3773",
		Interval:     5 * time.Second,
		BridgePath:   "/usr/local/bin/tl-t3-bridge",
		ProjectsRoot: sessionio.ProjectsRoot(home, "wizard"),
	}
}

// systemd expands an unset variable to an EMPTY ARGUMENT rather than dropping
// it, so a half-filled environment file reaches the binary as `-base-dir ""`.
// Every one of these has to fail at start, where the journal shows it, rather
// than run on a value nobody chose.
func TestConfigCheckRejectsAHalfFilledEnvironment(t *testing.T) {
	cases := []struct {
		name    string
		breakIt func(*Config)
		want    string
	}{
		{"no user", func(c *Config) { c.OSUser = "" }, "OS user"},
		{"no base dir", func(c *Config) { c.BaseDir = "" }, "T3_BASE_DIR"},
		{"no endpoint", func(c *Config) { c.Endpoint = "" }, "T3_PORT"},
		{"zero interval", func(c *Config) { c.Interval = 0 }, "-interval"},
		{"negative interval", func(c *Config) { c.Interval = -time.Second }, "-interval"},
		{"no bridge", func(c *Config) { c.BridgePath = "" }, "-bridge"},
		{"no projects root", func(c *Config) { c.ProjectsRoot = "" }, "projects root"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := goodConfig(t)
			tc.breakIt(&cfg)
			err := cfg.check()
			if err == nil {
				t.Fatalf("check() accepted %+v", cfg)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error %q does not mention %q, so an operator cannot fix it", err, tc.want)
			}
			// run must not get as far as touching tmux, T3 or the filesystem on
			// a configuration it has already rejected.
			if runErr := run(context.Background(), cfg); runErr == nil {
				t.Error("run accepted a configuration check() rejected")
			}
		})
	}
	if err := goodConfig(t).check(); err != nil {
		t.Errorf("check() rejected a good configuration: %v", err)
	}
}

// T3 derives its settings path by joining "userdata" under the base dir. Get
// this wrong and the merge writes a file T3 never reads — which looks exactly
// like a successful merge.
func TestSettingsPath(t *testing.T) {
	if got, want := SettingsPath("/home/wizard/.t3"), "/home/wizard/.t3/userdata/settings.json"; got != want {
		t.Errorf("SettingsPath = %q, want %q", got, want)
	}
}

// One pass, end to end over HTTP: read the snapshot, work out the difference,
// dispatch it. This is the loop body; run() adds only the ticker around it.
func TestReconcileOnceAdoptsOverHTTP(t *testing.T) {
	h := newHarness(t)
	repo := filepath.Join(t.TempDir(), "terminal-lobby")
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	h.startClaude("feat-header", repo, reconcileClaudeA)
	h.t3.setSnapshot(`{"snapshotSequence":1,"projects":[],"threads":[],"updatedAt":"2026-08-16T00:00:00.000Z"}`)

	if err := reconcileOnce(context.Background(), h.reconciler, h.client); err != nil {
		t.Fatalf("reconcileOnce: %v", err)
	}
	if got := len(h.t3.dispatched(VerbThreadCreate)); got != 1 {
		t.Fatalf("dispatched %d thread.create commands, want 1", got)
	}
	if got := len(h.t3.dispatched(VerbTurnStart)); got != 1 {
		t.Errorf("dispatched %d warm-up turns, want 1", got)
	}
	// And the second pass finds nothing left to do — the property that makes a
	// five-second ticker harmless.
	before := len(h.t3.seen())
	if err := reconcileOnce(context.Background(), h.reconciler, h.client); err != nil {
		t.Fatalf("second pass: %v", err)
	}
	for _, verb := range []string{VerbThreadCreate, VerbProjectCreate, VerbTurnStart} {
		if got := len(h.t3.dispatched(verb)); got != 1 {
			t.Errorf("%s dispatched %d times over two passes, want 1", verb, got)
		}
	}
	if len(h.t3.seen()) != before+1 {
		t.Errorf("the second pass made %d requests, want only the snapshot", len(h.t3.seen())-before)
	}
}

// A pass that cannot read T3 is a pass, not a crash: t3-serve restarts, and the
// next tick picks up where this one stopped.
func TestReconcileOnceReportsAnUnreachableT3(t *testing.T) {
	h := newHarness(t)
	h.t3.setSnapshotFn(func(w http.ResponseWriter, calls int) {
		writeJSON(w, http.StatusInternalServerError, `{"code":"boom"}`)
	})
	if err := reconcileOnce(context.Background(), h.reconciler, h.client); err == nil {
		t.Fatal("reconcileOnce returned nil against a broken t3-serve")
	}
}

// The listener is the whole kill-crosses path. If it cannot bind, the syncer
// looks healthy and silently never archives anything — so a failure there stops
// the start rather than being logged.
func TestServeNoticesAcceptsAKill(t *testing.T) {
	notices := NewKillNotices("wizard")
	addr := "127.0.0.1:" + freePort(t)

	stop, err := serveNotices(addr, notices)
	if err != nil {
		t.Fatalf("serveNotices: %v", err)
	}
	defer stop()

	body := strings.NewReader(`{"osUser":"wizard","session":"feat-header","killedAt":"2026-08-16T00:00:00Z","source":"tmux-api"}`)
	resp, err := http.Post("http://"+addr+NotifyKilledPath, "application/json", body)
	if err != nil {
		t.Fatalf("post a notice: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Errorf("status = %d, want 204", resp.StatusCode)
	}
	if got := notices.Drain(); len(got) != 1 || got[0] != "feat-header" {
		t.Errorf("Drain() = %v, want [feat-header]", got)
	}

	if _, err := serveNotices("127.0.0.1:", notices); err == nil {
		t.Error("serveNotices accepted an address with no port")
	}
}

// tmux-api authenticates by the Authentik identity the proxy would have sent.
// The syncer is behind no proxy, so it presents the mapped name itself.
func TestLobbyAuthUser(t *testing.T) {
	dir := t.TempDir()
	mapPath := filepath.Join(dir, "ttyd-user-map")
	if err := os.WriteFile(mapPath, []byte("# map\nvbarzin=wizard:1000\nemo=emo\n"), 0o644); err != nil {
		t.Fatalf("write map: %v", err)
	}
	if got, ok := AuthUserForOSUser(mapPath, "wizard"); !ok || got != "vbarzin" {
		t.Errorf("AuthUserForOSUser = %q/%v, want vbarzin/true", got, ok)
	}
	// An unmapped user falls back to its own name, which is what tmux-api
	// assumes when the map has no entry.
	if got := lobbyAuthUser("nobody-in-the-map"); got != "nobody-in-the-map" {
		t.Errorf("lobbyAuthUser = %q, want the OS user itself", got)
	}
}

// The syncer creates threads on the bridged instance, with a model T3 knows.
// A thread created on the stock instance would start a SECOND Claude for a
// conversation that already has one, which is the one thing the design rules
// out on memory alone (decision 1).
func TestThreadsAreCreatedOnTheBridgedInstance(t *testing.T) {
	h := newHarness(t)
	h.startClaude("feat-header", t.TempDir(), reconcileClaudeA)
	cands, err := h.adopter.Candidates()
	if err != nil {
		t.Fatalf("Candidates: %v", err)
	}
	if _, err := h.adopter.Adopt(context.Background(), cands[0]); err != nil {
		t.Fatalf("Adopt: %v", err)
	}

	created := h.t3.dispatched(VerbThreadCreate)[0]
	var selection ModelSelection
	if err := json.Unmarshal(created["modelSelection"], &selection); err != nil {
		t.Fatalf("modelSelection: %v", err)
	}
	if selection.InstanceID != InstanceBridged || selection.Model != h.cfg.Model {
		t.Errorf("modelSelection = %+v, want the bridged instance on %s", selection, h.cfg.Model)
	}
	if got := jsonString(created["runtimeMode"]); got != h.cfg.RuntimeMode {
		t.Errorf("runtimeMode = %q, want %q", got, h.cfg.RuntimeMode)
	}
	// T3's schema declares branch and worktreePath as nullable-but-required, so
	// the keys have to be there and null.
	for _, key := range []string{"branch", "worktreePath"} {
		raw, ok := created[key]
		if !ok || string(raw) != "null" {
			t.Errorf("%s = %s (present: %v), want an explicit null", key, raw, ok)
		}
	}
}
