package sessionio

import (
	"strconv"
	"strings"
)

// Running `/context` writes its output into the transcript as a user record
// marked isMeta, holding markdown the CLI rendered itself:
//
//	## Context Usage
//
//	**Model:** claude-opus-5
//	**Tokens:** 65.2k / 1m (7%)
//
//	### Estimated usage by category
//	| Category | Tokens | Percentage |
//	…
//
// That is a better source for a context meter than arithmetic over
// `message.usage`: the usage fields give a numerator, but the CEILING is not on
// the wire at all, and it is not a constant — a session on this box reads
// `65.2k / 1m`, so assuming the familiar 200k would be wrong by a factor of
// five. The CLI already knows the ceiling, the percentage, and where the tokens
// went; this reads what it published rather than re-deriving a worse version.
//
// Left alone the record renders as a 14,930-character block attributed to
// Claude, which is the same shape of problem skill.go was written to fix.
const contextMarker = "## Context Usage"

// contextTokensLine is the line the headline numbers come from.
const contextTokensPrefix = "**Tokens:**"

// contextModelPrefix names the model the ceiling belongs to.
const contextModelPrefix = "**Model:**"

// contextCategoryHeading opens the one table worth carrying.
const contextCategoryHeading = "### Estimated usage by category"

// ContextCategory is one row of the usage-by-category table.
type ContextCategory struct {
	Name    string  `json:"name"`
	Tokens  int64   `json:"tokens"`
	Percent float64 `json:"percent"`
}

// ContextReading is a `/context` reading, reduced to the parts a meter shows.
//
// The numbers are the CLI's own rounded display values — 65.2k is carried as
// 65,200 rather than refined into a precision it never published.
type ContextReading struct {
	Model      string            `json:"model,omitempty"`
	UsedTokens int64             `json:"usedTokens"`
	MaxTokens  int64             `json:"maxTokens"`
	Percent    float64           `json:"percent"`
	Categories []ContextCategory `json:"categories,omitempty"`
}

// contextReading returns the reading this record's text carries, and whether it
// is one at all.
//
// The marker must open the text. A message that merely quotes the heading —
// any session discussing this feature does — is not a reading, and the
// transcripts of this very work are full of them.
func contextReading(text string) (*ContextReading, bool) {
	if !strings.HasPrefix(strings.TrimLeft(text, "\n"), contextMarker) {
		return nil, false
	}
	lines := strings.Split(text, "\n")

	r := &ContextReading{}
	var gotTokens bool
	for _, line := range lines {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, contextModelPrefix):
			r.Model = strings.TrimSpace(strings.TrimPrefix(line, contextModelPrefix))
		case strings.HasPrefix(line, contextTokensPrefix):
			rest := strings.TrimSpace(strings.TrimPrefix(line, contextTokensPrefix))
			gotTokens = parseContextHeadline(rest, r)
		}
		if gotTokens && r.Model != "" {
			break
		}
	}
	// Without the headline there is nothing to meter, whatever else the record
	// holds — treat it as not a reading rather than emitting a zeroed one.
	if !gotTokens {
		return nil, false
	}
	r.Categories = contextCategories(lines)
	return r, true
}

// parseContextHeadline reads `65.2k / 1m (7%)` into the reading.
func parseContextHeadline(s string, r *ContextReading) bool {
	slash := strings.Index(s, "/")
	if slash < 0 {
		return false
	}
	used, ok := contextTokens(strings.TrimSpace(s[:slash]))
	if !ok {
		return false
	}
	rest := strings.TrimSpace(s[slash+1:])

	// The percentage is parenthesised after the ceiling; a reading over the
	// limit carries an extra field elsewhere and does not change this line.
	pct := ""
	if open := strings.Index(rest, "("); open >= 0 {
		if close := strings.Index(rest[open:], ")"); close > 0 {
			pct = rest[open+1 : open+close]
		}
		rest = strings.TrimSpace(rest[:open])
	}
	max, ok := contextTokens(rest)
	if !ok {
		return false
	}
	r.UsedTokens, r.MaxTokens = used, max
	r.Percent = contextPercent(pct)
	return true
}

// contextCategories reads the usage-by-category table, stopping at the next
// heading. The tables below it — MCP tools, custom agents, memory files, skills
// — are per-item and are what make the record 14.9 KB; a meter does not show
// them, and a phone should not have to receive them once per settled turn.
func contextCategories(lines []string) []ContextCategory {
	var out []ContextCategory
	in := false
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if !in {
			in = line == contextCategoryHeading
			continue
		}
		if strings.HasPrefix(line, "#") {
			break
		}
		cells := tableRow(line)
		if len(cells) != 3 {
			continue
		}
		tokens, ok := contextTokens(cells[1])
		if !ok {
			continue // the header row, and the |---| rule under it
		}
		out = append(out, ContextCategory{
			Name:    cells[0],
			Tokens:  tokens,
			Percent: contextPercent(cells[2]),
		})
	}
	return out
}

// tableRow splits one markdown table line into its cells, or nil if the line is
// not one.
func tableRow(line string) []string {
	if !strings.HasPrefix(line, "|") || !strings.HasSuffix(line, "|") {
		return nil
	}
	parts := strings.Split(strings.Trim(line, "|"), "|")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		out = append(out, strings.TrimSpace(p))
	}
	return out
}

// contextTokens reads the CLI's abbreviated token counts — `71`, `18k`,
// `3.5k`, `1m` — into whole tokens.
func contextTokens(s string) (int64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	mult := float64(1)
	switch {
	case strings.HasSuffix(s, "k"), strings.HasSuffix(s, "K"):
		mult, s = 1_000, s[:len(s)-1]
	case strings.HasSuffix(s, "m"), strings.HasSuffix(s, "M"):
		mult, s = 1_000_000, s[:len(s)-1]
	}
	n, err := strconv.ParseFloat(strings.ReplaceAll(s, ",", ""), 64)
	if err != nil {
		return 0, false
	}
	return int64(n*mult + 0.5), true
}

// contextPercent reads `9.5%`. A value we cannot read is 0 rather than an
// error: the headline numbers carry the meter, and the percentage is a
// convenience the CLI computed from them.
func contextPercent(s string) float64 {
	n, err := strconv.ParseFloat(strings.TrimSuffix(strings.TrimSpace(s), "%"), 64)
	if err != nil {
		return 0
	}
	return n
}
