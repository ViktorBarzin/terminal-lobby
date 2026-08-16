package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
)

// Keeping the provider instances in the user's T3 settings.json current.
//
// The seam is a first-class user setting: ClaudeSettingsPatch exposes
// binaryPath, launchArgs and homePath PER PROVIDER INSTANCE, and T3 supports
// several instances of one driver with independent config. T3 also watches
// settings.json for external edits and invalidates its cache (verified fact 6),
// so an idempotent merge from outside needs no restart and no RPC client.
//
// Two instances, and the second one is the point:
//
//	claudeAgent  → binaryPath = tl-t3-bridge   (the DEFAULT — see below)
//	claudeStock  → binaryPath = the real claude (the escape hatch, decision 5)
//
// It has to be claudeAgent that carries the bridge because
// defaultInstanceIdForDriver(driver) returns the instance whose ID EQUALS the
// driver name (verified fact 9). A new thread therefore lands on the bridge
// without anyone choosing anything, and a T3 upgrade that breaks the bridge is
// one instance switch away from working.
//
// The envelope this writes was read off the contract T3 decodes it with
// (packages/contracts/src/providerInstance.ts in t3 v0.0.34-nightly.20260815.1098):
// providerInstances is a Record<ProviderInstanceId, {driver, displayName?,
// accentColor?, environment?, enabled?, config?}>, and `config` is
// Schema.Unknown at that layer — each driver decodes its own blob, so the
// claudeAgent driver's {binaryPath, homePath, launchArgs} lives inside it.
// Confirmed live: writing exactly this shape made a running t3-serve spawn the
// named binary for the next turn, with no restart.

// Instance ids. These are not free choices: see the note above on
// defaultInstanceIdForDriver.
const (
	// InstanceBridged is the default Claude instance, pointed at tl-t3-bridge.
	InstanceBridged = "claudeAgent"
	// InstanceStock is the escape hatch, pointed at the real claude.
	InstanceStock = "claudeStock"
	// DriverClaude is the driver both instances use.
	DriverClaude = "claudeAgent"
)

// The two instances' names in T3's provider picker. Without them both entries
// read simply as Claude, and the one that is actually the bridge is the
// unlabelled default — which is the wrong way round for decision 5, whose whole
// point is that a human can tell them apart and switch in a hurry.
const (
	bridgedDisplayName = "Claude (tmux)"
	stockDisplayName   = "Claude (stock)"
)

// InstanceConfig is the per-instance provider config the merge writes.
//
// LaunchArgs is a STRING, not a list: the claudeAgent driver's schema declares
// it `Schema.String` ("Additional CLI arguments passed on session start", with
// the placeholder "e.g. --chrome"). The syncer never sets it — it is here so
// the shape this file writes is the shape T3 decodes.
type InstanceConfig struct {
	BinaryPath string `json:"binaryPath,omitempty"`
	LaunchArgs string `json:"launchArgs,omitempty"`
	HomePath   string `json:"homePath,omitempty"`
}

// SettingsMerge is one idempotent edit of a user's settings.json.
type SettingsMerge struct {
	// Path is <base-dir>/userdata/settings.json for the user this syncer
	// speaks for. It is NEVER another user's: their ~/.t3 is their live state.
	Path string
	// BridgePath is the absolute path of tl-t3-bridge.
	BridgePath string
	// ClaudePath is the absolute path of the real claude.
	ClaudePath string
}

// Apply merges the two provider instances into settings.json, leaving every
// other key exactly as it was.
//
// Three properties this has to have, and how each is met:
//
//   - IDEMPOTENT. The document is compared after the merge and the file is only
//     rewritten when something actually moved, because T3's watcher invalidates
//     its provider cache on every write and this runs once per tick.
//   - PRESERVING. The decode target is a generic document, and only the four
//     leaves this program owns are assigned. A typed struct would round-trip
//     away every setting the syncer does not know about, which is most of them.
//   - ATOMIC. tmp + rename inside the same directory, so a watcher that fires
//     mid-write still reads a whole file.
//
// A settings.json that exists but does not parse is an ERROR, never an
// overwrite: it is the user's whole T3 configuration, and "replace it with
// ours" is not a recovery.
func (m SettingsMerge) Apply() (changed bool, err error) {
	before, existed, err := m.load()
	if err != nil {
		return false, err
	}

	after := cloneDoc(before)
	m.mergeInto(after)

	nextRaw, err := encodeSettings(after)
	if err != nil {
		return false, err
	}
	if existed {
		prevRaw, err := encodeSettings(before)
		if err != nil {
			return false, err
		}
		if bytes.Equal(prevRaw, nextRaw) {
			return false, nil
		}
	}
	if err := writeFileAtomic(m.Path, nextRaw, 0o600); err != nil {
		return false, err
	}
	return true, nil
}

// Verify reports whether settings.json already names the two instances
// correctly, without writing anything. It is what a health check calls, and
// what tells an operator that the escape hatch has been taken.
func (m SettingsMerge) Verify() error {
	doc, existed, err := m.load()
	if err != nil {
		return err
	}
	if !existed {
		return fmt.Errorf("%s does not exist", m.Path)
	}
	for _, want := range []struct{ id, binary string }{
		{InstanceBridged, m.BridgePath},
		{InstanceStock, m.ClaudePath},
	} {
		got, err := instanceBinaryPath(doc, want.id)
		if err != nil {
			return err
		}
		if got == "" {
			// An empty path is not a match even against an empty want: it is an
			// instance T3 cannot spawn, and reporting it healthy is how the
			// escape hatch ends up broken in the one situation it exists for.
			return fmt.Errorf("providerInstances.%s.config.binaryPath is empty", want.id)
		}
		if got != want.binary {
			return fmt.Errorf("providerInstances.%s.config.binaryPath = %q, want %q", want.id, got, want.binary)
		}
	}
	return nil
}

// load reads the settings document. A missing file is an empty document and
// existed=false — the ordinary first run against a fresh base dir, where t3
// has not written a settings.json at all yet (measured on a new --base-dir).
func (m SettingsMerge) load() (doc map[string]json.RawMessage, existed bool, err error) {
	raw, err := os.ReadFile(m.Path)
	if os.IsNotExist(err) {
		return map[string]json.RawMessage{}, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("read %s: %w", m.Path, err)
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return map[string]json.RawMessage{}, true, nil
	}
	doc = map[string]json.RawMessage{}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, true, fmt.Errorf("parse %s: %w", m.Path, err)
	}
	return doc, true, nil
}

// mergeInto sets the two instances on a decoded document, in place.
//
// It descends one raw level at a time rather than decoding the whole
// providerInstances map into typed values: a sibling instance may belong to a
// driver this build has never heard of (a fork, a downgrade, an in-flight
// branch), and T3's own contract promises those envelopes round-trip without
// loss. They only do that here because they are never decoded.
func (m SettingsMerge) mergeInto(doc map[string]json.RawMessage) {
	instances := childObject(doc, "providerInstances")
	m.mergeInstance(instances, InstanceBridged, m.BridgePath, bridgedDisplayName)
	m.mergeInstance(instances, InstanceStock, m.ClaudePath, stockDisplayName)
	doc["providerInstances"] = mustMarshal(instances)
}

// mergeInstance sets one instance's driver and binaryPath, leaving every other
// key on the instance and in its config untouched. displayName is only written
// when the key is absent, so a name the operator chose survives.
//
// An EMPTY binaryPath is not written. There is one way to arrive here with one
// — claude is not on the unit's PATH at start-up, after a failed self-update or
// a reboot that has not populated ~/.local/bin yet — and writing "" then would
// blank a good path on the escape hatch at exactly the moment the bridge is
// most likely to be the thing that broke. Leaving the stored value alone is
// both safer and what findClaude's own comment says happens.
func (m SettingsMerge) mergeInstance(instances map[string]json.RawMessage, id, binaryPath, displayName string) {
	inst := childObject(instances, id)
	inst["driver"] = mustMarshal(DriverClaude)
	if displayName != "" {
		if _, ok := inst["displayName"]; !ok {
			inst["displayName"] = mustMarshal(displayName)
		}
	}
	cfg := childObject(inst, "config")
	if binaryPath != "" {
		cfg["binaryPath"] = mustMarshal(binaryPath)
	} else if _, ok := cfg["binaryPath"]; !ok {
		log.Printf("no binary for providerInstances.%s: leaving its binaryPath unset", id)
	} else {
		log.Printf("no binary for providerInstances.%s: leaving its existing binaryPath alone", id)
	}
	inst["config"] = mustMarshal(cfg)
	instances[id] = mustMarshal(inst)
}

// instanceBinaryPath reads providerInstances.<id>.config.binaryPath, naming the
// level that was missing so a Verify failure says where to look.
func instanceBinaryPath(doc map[string]json.RawMessage, id string) (string, error) {
	instances, err := decodeObject(doc, "providerInstances")
	if err != nil {
		return "", err
	}
	inst, err := decodeObject(instances, id)
	if err != nil {
		return "", err
	}
	cfg, err := decodeObject(inst, "config")
	if err != nil {
		return "", err
	}
	rawPath, ok := cfg["binaryPath"]
	if !ok {
		return "", fmt.Errorf("providerInstances.%s.config.binaryPath is not set", id)
	}
	var path string
	if err := json.Unmarshal(rawPath, &path); err != nil {
		return "", fmt.Errorf("providerInstances.%s.config.binaryPath is not a string: %w", id, err)
	}
	return path, nil
}

// childObject returns key's object, creating an empty one when the key is
// missing or holds something that is not an object. Replacing a non-object is
// the only lossy branch here and it is the right one: T3 could not have used
// that value either.
func childObject(parent map[string]json.RawMessage, key string) map[string]json.RawMessage {
	child := map[string]json.RawMessage{}
	if raw, ok := parent[key]; ok {
		if err := json.Unmarshal(raw, &child); err != nil {
			return map[string]json.RawMessage{}
		}
	}
	return child
}

// decodeObject is childObject's read-only twin: it reports a missing or
// malformed level instead of inventing one.
func decodeObject(parent map[string]json.RawMessage, key string) (map[string]json.RawMessage, error) {
	raw, ok := parent[key]
	if !ok {
		return nil, fmt.Errorf("%s is not set", key)
	}
	child := map[string]json.RawMessage{}
	if err := json.Unmarshal(raw, &child); err != nil {
		return nil, fmt.Errorf("%s is not an object: %w", key, err)
	}
	return child, nil
}

// cloneDoc copies the top level so a merge can be compared against the
// original. The values are json.RawMessage — immutable byte slices as far as
// this code is concerned — so a shallow copy is a real copy.
func cloneDoc(doc map[string]json.RawMessage) map[string]json.RawMessage {
	out := make(map[string]json.RawMessage, len(doc))
	for k, v := range doc {
		out[k] = v
	}
	return out
}

// encodeSettings renders the document the way it is written to disk. Comparing
// two of these is what makes the merge idempotent: json.Marshal sorts map keys,
// so the same logical document always produces the same bytes.
func encodeSettings(doc map[string]json.RawMessage) ([]byte, error) {
	raw, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("encode settings: %w", err)
	}
	return append(raw, '\n'), nil
}

// mustMarshal encodes a value that cannot fail to encode: strings and maps of
// already-valid RawMessages. An error here would mean the program built an
// impossible document, which is a bug rather than a runtime condition.
func mustMarshal(v interface{}) json.RawMessage {
	raw, err := json.Marshal(v)
	if err != nil {
		panic(fmt.Sprintf("t3-sync: encoding a settings fragment failed: %v", err))
	}
	return raw
}

// writeFileAtomic writes via a temp file in the same directory, fsynced before
// the rename. T3 is watching this path and reads whatever appears there, so a
// half-written file would be a half-configured provider.
func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+"-*.tmp")
	if err != nil {
		return fmt.Errorf("temp file in %s: %w", dir, err)
	}
	defer os.Remove(tmp.Name()) // no-op once the rename succeeds
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return fmt.Errorf("chmod %s: %w", tmp.Name(), err)
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("write %s: %w", tmp.Name(), err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("sync %s: %w", tmp.Name(), err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close %s: %w", tmp.Name(), err)
	}
	return os.Rename(tmp.Name(), path)
}
