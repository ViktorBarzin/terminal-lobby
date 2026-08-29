package release

import (
	"errors"
	"strings"
)

// PreviousVersion reads `apt-cache policy <pkg>` output and returns the newest
// version that is not the installed one — what a revert goes back to, since apt
// keeps the package it replaced in its archive cache.
//
// The version table is parsed structurally rather than by guessing at line
// prefixes: an entry is a line whose first field is a version and whose second
// is a numeric priority. The priority also appears alone on its own indented
// line, and reading that as a version would have the box try to install "100".
func PreviousVersion(policy string) (string, error) {
	var installed string
	var versions []string
	sawTable := false

	for _, raw := range strings.Split(policy, "\n") {
		line := strings.TrimSpace(raw)
		if v, ok := strings.CutPrefix(line, "Installed:"); ok {
			installed = strings.TrimSpace(v)
			continue
		}
		if strings.HasPrefix(line, "Version table:") {
			sawTable = true
			continue
		}
		if !sawTable {
			continue
		}
		// The installed entry is marked with ***; strip the marker, not the line.
		fields := strings.Fields(strings.TrimPrefix(line, "***"))
		if len(fields) != 2 || !allDigits(fields[1]) || allDigits(fields[0]) {
			continue
		}
		versions = append(versions, fields[0])
	}

	if !sawTable {
		return "", errors.New("no version table in apt-cache policy output")
	}
	if installed == "" || installed == "(none)" {
		// Nothing is installed, so nothing was replaced.
		return "", nil
	}
	// The table is already newest-first, which is the order a revert wants.
	for _, v := range versions {
		if v != installed {
			return v, nil
		}
	}
	return "", nil
}

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}
