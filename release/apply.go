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
	"strings"
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
	// Advisory carries Check.Advisory through to the decision: the probe ran
	// and is reported, and its failure alone does not revert the package.
	Advisory bool
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
// GATING probe has not been shown to work, and leaving users inside an
// unverified version costs more than a revert does.
//
// Advisory probes are reported and counted but cannot revert. Reverting
// downgrades the package and holds it, which stops every later deploy until a
// human unholds it, so it is reserved for the services a person's session runs
// through. agent-api is the one service outside that set, and the failure it is
// most likely to show -- nothing listening on a port another process took on a
// shared box -- is not a statement about the release at all.
func Decide(probes []Probe) Action {
	gating := 0
	for _, p := range probes {
		if p.Advisory {
			continue
		}
		gating++
		if !p.OK {
			return RevertAndHold
		}
	}
	// Reached by a run that probed nothing, and by one whose every probe was
	// advisory: neither has shown that what a person uses still works.
	if gating == 0 {
		return RevertAndHold
	}
	return Keep
}

// GatingFirst orders checks so the ones that can revert the package are probed
// before the ones that cannot, keeping their relative order otherwise.
//
// Verification runs under one shared deadline, and a probe that will never pass
// spends it a second at a time. An advisory check is the likeliest to be in
// that state -- a port something else is holding stays held -- and without this
// it would drain the budget ahead of the checks that decide whether the box
// keeps this version, leaving them a single attempt each. A service that is
// slow to come back from its restart would then fail, and the advisory failure
// that cannot revert the package would have caused a revert anyway.
func GatingFirst(checks []Check) []Check {
	out := make([]Check, 0, len(checks))
	for _, c := range checks {
		if !c.Advisory {
			out = append(out, c)
		}
	}
	for _, c := range checks {
		if c.Advisory {
			out = append(out, c)
		}
	}
	return out
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

// ParseUnitInstances reads `systemctl list-units` output and returns the
// instances of a templated unit, without the .service suffix.
//
// systemd prefixes a FAILED unit with a bullet (U+25CF) and, in some versions,
// an asterisk -- so a parser that strips only one of them silently skips the
// failed instance, which is the one a release most needs to restart.
func ParseUnitInstances(prefix, listUnitsOutput string) []string {
	var out []string
	for _, line := range strings.Split(listUnitsOutput, "\n") {
		line = strings.TrimLeft(line, " \t*●▶↻×")
		fields := strings.Fields(line)
		if len(fields) == 0 || !strings.HasPrefix(fields[0], prefix) {
			continue
		}
		out = append(out, strings.TrimSuffix(fields[0], ".service"))
	}
	sort.Strings(out)
	return out
}
