package sessionio

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// toolDetailMax is how long the agent panel's tool line may be, in runes. It is
// the text view's own LABEL_MAX (frontend-v2 canonicalize.ts), so one call reads
// the same length in both places.
const toolDetailMax = 120

// toolDetail is one line saying what a tool call is doing, from its name and
// input: the command, the path, the pattern. It is the Go side of frontend-v2's
// describe() label, so the panel names a call the way the timeline row for the
// same call does, with two changes the panel needs. A path stays whole, cut from
// the left when it is too long so the file name survives; describe() shortens it
// to two segments, which a client can still do and could not undo. And the line
// always fits toolDetailMax.
func toolDetail(tool string, input json.RawMessage) string {
	var in map[string]json.RawMessage
	if json.Unmarshal(input, &in) != nil {
		return ""
	}
	get := func(k string) string {
		var s string
		_ = json.Unmarshal(in[k], &s)
		return s
	}
	switch tool {
	case "Bash":
		if cmd := shellLine(get("command")); cmd != "" {
			return clipRight(cmd, toolDetailMax)
		}
		return clipRight(oneLine(get("description")), toolDetailMax)
	case "Read", "Edit", "Write":
		return clipLeft(oneLine(get("file_path")), toolDetailMax)
	case "NotebookEdit":
		return clipLeft(oneLine(get("notebook_path")), toolDetailMax)
	case "Glob", "Grep":
		return clipRight(oneLine(get("pattern")), toolDetailMax)
	case "WebSearch":
		return clipRight(oneLine(get("query")), toolDetailMax)
	case "WebFetch":
		return clipRight(oneLine(get("url")), toolDetailMax)
	case "Agent", "Task":
		return clipRight(oneLine(firstOf(get("description"), get("subagent_type"))), toolDetailMax)
	case "Skill":
		return clipRight(oneLine(firstOf(get("skill"), get("command"))), toolDetailMax)
	case "AskUserQuestion":
		var qs []struct {
			Question string `json:"question"`
		}
		if json.Unmarshal(in["questions"], &qs) == nil && len(qs) > 0 {
			return clipRight(oneLine(qs[0].Question), toolDetailMax)
		}
		return ""
	case "TodoWrite":
		var todos []struct {
			Status string `json:"status"`
		}
		if json.Unmarshal(in["todos"], &todos) != nil {
			return ""
		}
		done := 0
		for _, td := range todos {
			if td.Status == "completed" {
				done++
			}
		}
		return strconv.Itoa(done) + "/" + strconv.Itoa(len(todos)) + " done"
	}
	// An unfamiliar tool, MCP ones included: the first string its input
	// carries, as written. The map above has lost that order, so read the
	// object again as a token stream.
	return clipRight(oneLine(firstString(input)), toolDetailMax)
}

// shellLine is describe()'s oneLine for a shell command. A Bash call can carry
// a whole heredoc, so take the first line that says something, drop a leading
// `cd … &&` (setup, not the command), and mark that the command had more lines.
func shellLine(cmd string) string {
	var lines []string
	for _, l := range strings.Split(cmd, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			lines = append(lines, l)
		}
	}
	if len(lines) == 0 {
		return ""
	}
	first := lines[0]
	if cd := leadingCd.FindString(first); cd != "" && len(first) > len(cd) {
		first = first[len(cd):]
	} else if loneCd.MatchString(first) && len(lines) > 1 {
		first = lines[1] // a `cd` on its own line is setup too
	}
	first = oneLine(first)
	if len(lines) > 1 && utf8.RuneCountInString(first) <= toolDetailMax-2 {
		first += " …"
	}
	return first
}

// The same two patterns describe() matches a leading `cd` with.
var (
	leadingCd = regexp.MustCompile(`^cd\s+\S+\s*&&\s*`)
	loneCd    = regexp.MustCompile(`^cd\s+\S+$`)
)

// oneLine folds every run of whitespace, newlines included, into one space.
func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }

func firstOf(ss ...string) string {
	for _, s := range ss {
		if s != "" {
			return s
		}
	}
	return ""
}

// firstString is the first non-empty string value at the top level of a JSON
// object, in document order.
func firstString(obj json.RawMessage) string {
	dec := json.NewDecoder(bytes.NewReader(obj))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return ""
	}
	for dec.More() {
		if _, err := dec.Token(); err != nil { // the key
			return ""
		}
		var v json.RawMessage
		if err := dec.Decode(&v); err != nil {
			return ""
		}
		var s string
		if json.Unmarshal(v, &s) == nil && strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}

// clipRight cuts s to at most max runes, the last of them an ellipsis.
func clipRight(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	cut := 0
	for i := 0; i < max-1; i++ {
		_, n := utf8.DecodeRuneInString(s[cut:])
		cut += n
	}
	return s[:cut] + "…"
}

// clipLeft cuts s to at most max runes from the front, keeping the end, which
// for a path is the part that names the file.
func clipLeft(s string, max int) string {
	n := utf8.RuneCountInString(s)
	if n <= max {
		return s
	}
	cut := 0
	for i := 0; i < n-(max-1); i++ {
		_, w := utf8.DecodeRuneInString(s[cut:])
		cut += w
	}
	return "…" + s[cut:]
}
