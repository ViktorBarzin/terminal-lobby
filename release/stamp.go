// Package release holds the decisions the release pipeline makes: how a
// servable surface gets its identity at build time, and what the box does with
// a new version at install time.
//
// It exists because those decisions used to live in three deploy scripts that
// any workstation could run. Moving them here makes them one thing, testable at
// one seam, invoked by thin wrappers on both sides of the pipeline.
package release

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"regexp"
)

// diagPlaceholder marks where the shared diagnostics core is inlined. It must
// occupy a line of its own: the whole line is replaced, so a placeholder
// sharing a line with its <script> tags would take them with it.
const diagPlaceholder = "__TL_DIAG__"

// diagCoreMarker is how the core announces itself in a page. Finding it is what
// proves the inlining landed somewhere that will execute.
const diagCoreMarker = "globalThis.tlDiag = (function"

// Stamps are the two identities a surface carries, plus the terminal page's
// identity which the lobby embeds so a client can find it without a request.
//
// Build is provenance: which commit is deployed. It moves on every release.
//
// Asset is update identity: a fingerprint of the surface's own unstamped
// content, so it moves if and only if the page a user runs actually changed
// (ADR-0007).
type Stamps struct {
	Build     string
	Asset     string
	TermAsset string
}

var literalScriptTag = regexp.MustCompile(`(?i)</?script`)

// Inline splices the diagnostics core into a surface, replacing the
// placeholder's whole line, and refuses three ways of shipping diagnostics that
// would never run (ADR-0008).
func Inline(surfacePath, diagPath string) ([]byte, error) {
	surface, err := os.ReadFile(surfacePath)
	if err != nil {
		return nil, err
	}
	diag, err := os.ReadFile(diagPath)
	if err != nil {
		return nil, err
	}

	// The core is inlined into a classic script block, which the HTML tokenizer
	// ends at the first `</script`. A literal script tag anywhere in the core —
	// even inside a comment — truncates the page mid-JavaScript.
	if loc := literalScriptTag.FindIndex(diag); loc != nil {
		return nil, fmt.Errorf("%s contains a literal script tag at byte %d; inlining it would truncate the page", diagPath, loc[0])
	}

	out, replaced := replacePlaceholderLine(surface, diag)
	if !replaced {
		return nil, fmt.Errorf("%s has no %s placeholder; it would ship no diagnostics", surfacePath, diagPlaceholder)
	}
	if bytes.Contains(out, []byte(diagPlaceholder)) {
		return nil, fmt.Errorf("%s still contains %s after inlining; diagnostics would be dead", surfacePath, diagPlaceholder)
	}
	if err := assertCoreExecutable(out, surfacePath); err != nil {
		return nil, err
	}
	return out, nil
}

// replacePlaceholderLine replaces every line containing the placeholder with
// the core's bytes, matching what the deploy scripts did with sed's `r`+`d`.
func replacePlaceholderLine(surface, diag []byte) ([]byte, bool) {
	var out bytes.Buffer
	replaced := false
	for len(surface) > 0 {
		line := surface
		rest := []byte(nil)
		if i := bytes.IndexByte(surface, '\n'); i >= 0 {
			line, rest = surface[:i+1], surface[i+1:]
		}
		if bytes.Contains(line, []byte(diagPlaceholder)) {
			out.Write(diag)
			replaced = true
		} else {
			out.Write(line)
		}
		surface = rest
	}
	return out.Bytes(), replaced
}

// assertCoreExecutable proves the core landed inside an open script element.
// Present-but-inert diagnostics are the failure this catches: greppable in the
// page, never executed.
func assertCoreExecutable(page []byte, name string) error {
	inScript := false
	found := false
	for _, line := range bytes.Split(page, []byte("\n")) {
		if bytes.Contains(line, []byte(diagCoreMarker)) {
			found = true
			if !inScript {
				return fmt.Errorf("%s would ship diagnostics that never run: the core is not inside a <script> block", name)
			}
		}
		if bytes.Contains(line, []byte("<script")) {
			inScript = true
		}
		if bytes.Contains(line, []byte("</script>")) {
			inScript = false
		}
	}
	if !found {
		return fmt.Errorf("%s does not contain the diagnostics core after inlining", name)
	}
	return nil
}

// AssetID is a surface's update identity: the first 12 hex characters of the
// SHA-256 of its inlined-but-unstamped content.
//
// It hashes the surface AND the diagnostics core because the core is inlined
// into every surface. Hashing the surface alone would leave a core-only fix
// unable to move any page's identity, so no open tab would ever self-update to
// it — ADR-0007's failure mode inverted (ADR-0008).
func AssetID(surfacePath, diagPath string) (string, error) {
	pre, err := Inline(surfacePath, diagPath)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(pre)
	return hex.EncodeToString(sum[:])[:12], nil
}

// Stamp inlines the core and substitutes the identities. The order matters and
// is the same as the deploy scripts': inline, then fingerprint, then stamp — so
// the id is a fingerprint of content, never of a previous stamp.
func Stamp(surfacePath, diagPath string, s Stamps) ([]byte, error) {
	pre, err := Inline(surfacePath, diagPath)
	if err != nil {
		return nil, err
	}
	out := bytes.ReplaceAll(pre, []byte("__TL_BUILD__"), []byte(s.Build))
	out = bytes.ReplaceAll(out, []byte("__TL_ASSET__"), []byte(s.Asset))
	out = bytes.ReplaceAll(out, []byte("__TL_TERM_ASSET__"), []byte(s.TermAsset))
	return out, nil
}
