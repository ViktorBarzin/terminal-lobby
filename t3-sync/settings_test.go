package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// readSettings decodes a settings file into the generic document the merge
// works on, so assertions can reach keys the syncer never names.
func readSettings(t *testing.T, path string) map[string]interface{} {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var doc map[string]interface{}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	return doc
}

// instanceBinary digs out providerInstances.<id>.config.binaryPath, failing
// with a useful message at whichever level is missing.
func instanceBinary(t *testing.T, doc map[string]interface{}, id string) string {
	t.Helper()
	instances, ok := doc["providerInstances"].(map[string]interface{})
	if !ok {
		t.Fatalf("providerInstances missing or not an object: %#v", doc["providerInstances"])
	}
	inst, ok := instances[id].(map[string]interface{})
	if !ok {
		t.Fatalf("providerInstances.%s missing: %#v", id, instances)
	}
	cfg, ok := inst["config"].(map[string]interface{})
	if !ok {
		t.Fatalf("providerInstances.%s.config missing: %#v", id, inst)
	}
	path, _ := cfg["binaryPath"].(string)
	return path
}

func newMerge(dir string) SettingsMerge {
	return SettingsMerge{
		Path:       filepath.Join(dir, "settings.json"),
		BridgePath: "/usr/local/bin/tl-t3-bridge",
		ClaudePath: "/usr/local/bin/claude",
	}
}

// A settings.json that does not exist yet is the ordinary first run: a fresh
// t3 base dir has no settings file at all until something writes one.
func TestSettingsMergeCreatesMissingFile(t *testing.T) {
	m := newMerge(t.TempDir())

	changed, err := m.Apply()
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if !changed {
		t.Fatal("Apply on a missing file reported no change")
	}

	doc := readSettings(t, m.Path)
	if got := instanceBinary(t, doc, InstanceBridged); got != m.BridgePath {
		t.Errorf("%s binaryPath = %q, want %q", InstanceBridged, got, m.BridgePath)
	}
	if got := instanceBinary(t, doc, InstanceStock); got != m.ClaudePath {
		t.Errorf("%s binaryPath = %q, want %q", InstanceStock, got, m.ClaudePath)
	}
	if err := m.Verify(); err != nil {
		t.Errorf("Verify after Apply: %v", err)
	}
}

// Idempotency is not cosmetic: T3 watches this file and invalidates its
// provider cache on every write, so a merge that rewrites unchanged content
// would churn that cache once per tick.
func TestSettingsMergeIsIdempotent(t *testing.T) {
	m := newMerge(t.TempDir())

	if _, err := m.Apply(); err != nil {
		t.Fatalf("first Apply: %v", err)
	}
	first, err := os.ReadFile(m.Path)
	if err != nil {
		t.Fatalf("read after first Apply: %v", err)
	}
	info, err := os.Stat(m.Path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}

	for i := 0; i < 3; i++ {
		changed, err := m.Apply()
		if err != nil {
			t.Fatalf("re-Apply %d: %v", i, err)
		}
		if changed {
			t.Fatalf("re-Apply %d reported a change; the merge is not idempotent", i)
		}
	}

	again, err := os.ReadFile(m.Path)
	if err != nil {
		t.Fatalf("read after re-Apply: %v", err)
	}
	if string(again) != string(first) {
		t.Errorf("file content changed on a no-op merge:\nbefore %s\nafter  %s", first, again)
	}
	after, err := os.Stat(m.Path)
	if err != nil {
		t.Fatalf("stat after: %v", err)
	}
	if !after.ModTime().Equal(info.ModTime()) {
		t.Error("no-op merge rewrote the file (mtime moved), which re-triggers T3's watcher")
	}
}

// Everything the syncer did not author has to survive. Round-tripping through
// a typed struct would silently drop most of a real settings.json.
func TestSettingsMergePreservesForeignKeys(t *testing.T) {
	dir := t.TempDir()
	m := newMerge(dir)
	original := `{
  "theme": "dark",
  "providers": {"claudeAgent": {"binaryPath": "/opt/claude", "launchArgs": "--chrome"}},
  "providerInstances": {
    "codex_work": {"driver": "codex", "displayName": "Codex (work)", "config": {"binaryPath": "/opt/codex"}},
    "claudeAgent": {"driver": "claudeAgent", "accentColor": "#54c98d", "config": {"binaryPath": "/old/claude", "homePath": "~/.claude"}}
  },
  "observability": {"enabled": true}
}`
	if err := os.WriteFile(m.Path, []byte(original), 0o600); err != nil {
		t.Fatalf("seed settings: %v", err)
	}

	changed, err := m.Apply()
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if !changed {
		t.Fatal("Apply over a stale binaryPath reported no change")
	}

	doc := readSettings(t, m.Path)
	if doc["theme"] != "dark" {
		t.Errorf("theme lost: %#v", doc["theme"])
	}
	if _, ok := doc["observability"]; !ok {
		t.Error("observability key lost")
	}
	if _, ok := doc["providers"]; !ok {
		t.Error("legacy providers block lost")
	}
	instances := doc["providerInstances"].(map[string]interface{})
	if _, ok := instances["codex_work"]; !ok {
		t.Error("another driver's instance was dropped")
	}
	if got := instanceBinary(t, doc, InstanceBridged); got != m.BridgePath {
		t.Errorf("%s binaryPath = %q, want the bridge", InstanceBridged, got)
	}
	// Keys inside the instance we DO author, but did not set, stay put: the
	// operator's own homePath and accentColor are not ours to clear.
	inst := instances[InstanceBridged].(map[string]interface{})
	if inst["accentColor"] != "#54c98d" {
		t.Errorf("accentColor lost: %#v", inst["accentColor"])
	}
	cfg := inst["config"].(map[string]interface{})
	if cfg["homePath"] != "~/.claude" {
		t.Errorf("homePath lost: %#v", cfg["homePath"])
	}
}

// The two instances have to name the same driver: defaultInstanceIdForDriver
// returns the instance whose id equals the driver name, which is the only
// reason the bridge can be the default without anyone choosing it.
func TestSettingsMergeSetsDriverOnBothInstances(t *testing.T) {
	m := newMerge(t.TempDir())
	if _, err := m.Apply(); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	doc := readSettings(t, m.Path)
	instances := doc["providerInstances"].(map[string]interface{})
	for _, id := range []string{InstanceBridged, InstanceStock} {
		inst := instances[id].(map[string]interface{})
		if inst["driver"] != DriverClaude {
			t.Errorf("providerInstances.%s.driver = %#v, want %q", id, inst["driver"], DriverClaude)
		}
	}
}

// Verify is what a health check calls; it must not write, and it must fail
// when somebody has pointed the default instance somewhere else.
func TestSettingsVerify(t *testing.T) {
	dir := t.TempDir()
	m := newMerge(dir)

	if err := m.Verify(); err == nil {
		t.Error("Verify on a missing settings.json returned nil")
	}
	if _, err := os.Stat(m.Path); !os.IsNotExist(err) {
		t.Errorf("Verify created the file: %v", err)
	}

	if _, err := m.Apply(); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if err := m.Verify(); err != nil {
		t.Fatalf("Verify after Apply: %v", err)
	}

	// Somebody switched the default instance back to stock claude — the escape
	// hatch of decision 5, and exactly the state a health check must report.
	doc := readSettings(t, m.Path)
	instances := doc["providerInstances"].(map[string]interface{})
	instances[InstanceBridged].(map[string]interface{})["config"].(map[string]interface{})["binaryPath"] = "/usr/local/bin/claude"
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(m.Path, raw, 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := m.Verify(); err == nil {
		t.Error("Verify accepted a default instance pointing away from the bridge")
	}
}

// A settings.json that is not JSON must stop the merge rather than be
// replaced: overwriting it would destroy a user's whole configuration.
func TestSettingsMergeRefusesCorruptFile(t *testing.T) {
	dir := t.TempDir()
	m := newMerge(dir)
	if err := os.WriteFile(m.Path, []byte("{not json"), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}

	if _, err := m.Apply(); err == nil {
		t.Fatal("Apply overwrote an unparseable settings.json")
	}
	raw, err := os.ReadFile(m.Path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(raw) != "{not json" {
		t.Errorf("file was modified: %q", raw)
	}
}

// The file carries provider credentials' neighbours and is written into a
// directory T3 owns; it stays 0600.
func TestSettingsMergeWritesPrivateFile(t *testing.T) {
	m := newMerge(t.TempDir())
	if _, err := m.Apply(); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	info, err := os.Stat(m.Path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Errorf("settings.json mode = %o, want 600", got)
	}
}
