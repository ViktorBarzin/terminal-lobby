package release

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
)

// Unit is a systemd unit and the installed files whose bytes decide whether it
// restarts. The mapping is what keeps a release's disruption proportional to
// what it actually changed: restarting ttyd drops every attached terminal's
// WebSocket, and restarting session-events drops every Text-view client's SSE
// stream, so neither should happen for a release that did not touch them.
type Unit struct {
	Name  string
	Files []string
	// Template marks a unit run per user as Name+<instance>. A release restarts
	// the instances that are already enabled and enables nobody: enabling a user
	// needs a hand-written env file carrying their port allocation.
	Template bool
}

// Changed reports which of paths differ between what is installed and what is
// incoming. A path absent from the installed tree counts as changed, which is
// what a first install looks like.
func Changed(installedRoot, incomingRoot string, paths []string) ([]string, error) {
	var changed []string
	for _, rel := range paths {
		same, err := sameBytes(filepath.Join(installedRoot, rel), filepath.Join(incomingRoot, rel))
		if err != nil {
			return nil, err
		}
		if !same {
			changed = append(changed, rel)
		}
	}
	sort.Strings(changed)
	return changed, nil
}

func sameBytes(a, b string) (bool, error) {
	x, err := os.ReadFile(a)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	y, err := os.ReadFile(b)
	if err != nil {
		return false, err
	}
	return bytes.Equal(x, y), nil
}

// RestartSet returns the units owning at least one changed file, sorted so the
// same release always restarts things in the same order. Templated units are
// returned as their template name; RestartTargets resolves them to instances.
func RestartSet(units []Unit, changed []string) []string {
	moved := make(map[string]bool, len(changed))
	for _, c := range changed {
		moved[c] = true
	}
	var names []string
	for _, u := range units {
		for _, f := range u.Files {
			if moved[f] {
				names = append(names, u.Name)
				break
			}
		}
	}
	sort.Strings(names)
	return names
}

// Probe is one verification result: a service's health endpoint, or an
// unauthenticated request to an authed surface that must be refused.
type Probe struct {
	Name string
	OK   bool
}

// Action is what to do with the version that was just installed.
type Action int

const (
	// Keep leaves the new version in place.
	Keep Action = iota
	// RevertAndHold reinstalls the previous package from apt's cache and marks
	// it held, so the next trigger cannot immediately reinstall what just failed.
	RevertAndHold
)

func (a Action) String() string {
	if a == Keep {
		return "keep"
	}
	return "revert-and-hold"
}

// Decide reads the verification results. It fails closed: a release that ran no
// probe has not been shown to work, and leaving users inside an unverified
// version costs more than a revert does.
func Decide(probes []Probe) Action {
	if len(probes) == 0 {
		return RevertAndHold
	}
	for _, p := range probes {
		if !p.OK {
			return RevertAndHold
		}
	}
	return Keep
}

// RestartTargets resolves a restart set to the systemd targets to act on,
// expanding each templated unit to the instances that are already enabled.
func RestartTargets(units []Unit, changed []string, enabled map[string][]string) []string {
	tmpl := make(map[string]bool, len(units))
	for _, u := range units {
		tmpl[u.Name] = u.Template
	}
	var targets []string
	for _, name := range RestartSet(units, changed) {
		if !tmpl[name] {
			targets = append(targets, name)
			continue
		}
		targets = append(targets, enabled[name]...)
	}
	sort.Strings(targets)
	return targets
}

// Snapshot records the digest of each path that exists. Paths that are absent
// are omitted, so a first install compares against nothing and reports
// everything it ships as changed.
//
// This runs before dpkg unpacks: once it has, the old bytes are gone.
func Snapshot(root string, paths []string) (map[string]string, error) {
	out := make(map[string]string)
	for _, rel := range paths {
		sum, err := digest(filepath.Join(root, rel))
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			return nil, err
		}
		out[rel] = sum
	}
	return out, nil
}

// ChangedSince reports which paths differ from the snapshot, after dpkg has
// unpacked. A path that was absent and is now present counts as changed.
func ChangedSince(root string, before map[string]string, paths []string) ([]string, error) {
	var changed []string
	for _, rel := range paths {
		sum, err := digest(filepath.Join(root, rel))
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				// Shipped before, gone now: the unit that watched it should know.
				if _, had := before[rel]; had {
					changed = append(changed, rel)
				}
				continue
			}
			return nil, err
		}
		if before[rel] != sum {
			changed = append(changed, rel)
		}
	}
	sort.Strings(changed)
	return changed, nil
}

func digest(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}
