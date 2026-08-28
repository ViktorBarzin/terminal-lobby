package sessionio

import (
	"regexp"
	"strings"
)

// A blocking AskUserQuestion read off the pane.
//
// WHY THE PANE AT ALL. The transcript records the call losslessly, and that is
// what the Text view renders — but Claude Code does not always write the record
// while the dialog is up. Measured 2026-08-28 across five consecutive calls in
// one session: two landed within 3-8 seconds and two were not written until the
// question was ANSWERED, 112 seconds later in one case. For as long as the
// record is missing, the Text view has nothing to show while the terminal sits
// on a dialog — the reader sees "Working…" and the session sits blocked.
//
// So the pane is a FALLBACK, never the source of record: whenever the transcript
// holds the call, the client prefers it (options, descriptions and multi-select
// flags come back exactly as the tool was called). This only fills the window
// where the alternative is showing nothing at all.
type Dialog struct {
	// Questions the pane can actually see: the one on screen. Shaped like the
	// tool's own input so a client renders it with no special case.
	Questions []DialogQuestion `json:"questions"`
	// Headers of every question in the call, from the dialog's tab bar.
	Headers []string `json:"headers,omitempty"`
	// Count is how many questions the call carries.
	Count int `json:"count"`
	// Partial says the pane cannot show the whole call — a multi-question
	// dialog shows one question at a time, so an answer must be walked in the
	// terminal (or wait for the transcript, which carries them all).
	Partial bool `json:"partial,omitempty"`
}

// DialogQuestion mirrors one question of an AskUserQuestion call.
type DialogQuestion struct {
	Question    string         `json:"question"`
	Header      string         `json:"header,omitempty"`
	MultiSelect bool           `json:"multiSelect,omitempty"`
	Options     []DialogOption `json:"options"`
}

// DialogOption is one answer the question offers.
type DialogOption struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

// The two options the CLI adds to every AskUserQuestion, whatever the caller
// asked: free text, and deferring the question to chat. Requiring one of them is
// what separates a question Claude asked from a menu the operator opened —
// /model, /effort and the resume picker all draw with the same select widget and
// the same footer, and none of them carries these.
const (
	optionOther = "Type something"
	optionChat  = "Chat about this"
)

var (
	// "❯ 1. Label" / "  2. [ ] Label" / "  3. [✔] Label"
	reOption = regexp.MustCompile(`^\s*[❯>]?\s*(\d+)\.\s+(?:\[([^\]]*)\]\s+)?(.*\S)\s*$`)
	// The footer the select widget draws under every dialog.
	reFooter = regexp.MustCompile(`Enter to select .* Esc to cancel`)
	// The tab bar of a multi-question call: "←  ☐ Fruit  ☒ Drink  ✔ Submit  →"
	reTabBar = regexp.MustCompile(`^\s*←.*[☐☒].*→\s*$`)
	// The header line of a single-question call: " ☐ Colour"
	reHeader = regexp.MustCompile(`^\s*[☐☒]\s*(\S.*?)\s*$`)
	// The rule tmux draws for the composer's top border, which the dialog
	// overlaps.
	reRule = regexp.MustCompile(`^[\s─━-]+$`)
)

// ParseDialog reads a blocking AskUserQuestion off the visible pane, or returns
// nil when the pane is not showing one.
//
// It is deliberately strict: a false positive docks an answer card over
// something that is not a question, and the card types keys. Everything it needs
// has to be on screen — the footer, a numbered option list, and one of the two
// options the CLI adds to every AskUserQuestion.
func ParseDialog(pane string) *Dialog {
	lines := strings.Split(pane, "\n")
	if d := reviewScreen(lines); d != nil {
		return d
	}

	// Work from the footer up: it is the bottom of the dialog, and anything
	// below it belongs to the composer.
	end := -1
	for i := len(lines) - 1; i >= 0; i-- {
		if reFooter.MatchString(lines[i]) {
			end = i
			break
		}
	}
	if end < 0 {
		return nil
	}

	type parsed struct {
		n     int
		box   string
		label string
		desc  string
		line  int
	}
	var opts []parsed
	first := end
	for i := end - 1; i >= 0; i-- {
		line := lines[i]
		if strings.TrimSpace(line) == "" || reRule.MatchString(line) {
			continue
		}
		m := reOption.FindStringSubmatch(line)
		if m == nil {
			// Not an option: either a description belonging to the option
			// above it, or the top of the dialog. Descriptions are attached in
			// the second pass; stop as soon as the numbering has started and a
			// non-option, non-description line appears.
			if len(opts) > 0 && numbered(lines, i) {
				continue
			}
			if len(opts) > 0 {
				first = i + 1
				break
			}
			continue
		}
		opts = append(opts, parsed{n: atoi(m[1]), box: m[2], label: m[3], line: i})
		first = i
	}
	if len(opts) < 2 {
		return nil
	}
	// Bottom-up collection reversed the list.
	for l, r := 0, len(opts)-1; l < r; l, r = l+1, r-1 {
		opts[l], opts[r] = opts[r], opts[l]
	}
	// The numbering must be the widget's own: 1..n, in order.
	for i, o := range opts {
		if o.n != i+1 {
			return nil
		}
	}

	// A description is the line under an option that is not itself an option.
	for i := range opts {
		next := end
		if i+1 < len(opts) {
			next = opts[i+1].line
		}
		var desc []string
		for j := opts[i].line + 1; j < next; j++ {
			t := strings.TrimSpace(lines[j])
			if t == "" || reRule.MatchString(lines[j]) {
				continue
			}
			desc = append(desc, t)
		}
		opts[i].desc = strings.Join(desc, " ")
	}

	// The CLI's own options identify the widget, and are then dropped: the card
	// offers its own free-text and chat rows, so carrying these would double
	// them.
	var kept []DialogOption
	sawChat, sawOther, multi := false, false, false
	for _, o := range opts {
		label := strings.TrimRight(o.label, ".")
		switch label {
		case optionChat:
			sawChat = true
			continue
		case optionOther:
			sawOther = true
			continue
		}
		if o.box != "" {
			multi = true
		}
		kept = append(kept, DialogOption{Label: o.label, Description: o.desc})
	}
	if !sawChat && !sawOther {
		return nil // a menu, not a question
	}
	if len(kept) == 0 {
		return nil
	}
	// "Next" is the multi-select widget's own advance row, not an answer.
	if n := len(kept); n > 0 && kept[n-1].Label == "Next" {
		kept = kept[:n-1]
	}
	for i := range kept {
		if kept[i].Description == "Next" {
			kept[i].Description = ""
		}
	}

	d := &Dialog{Count: 1}
	q := DialogQuestion{MultiSelect: multi, Options: kept}

	// Above the options: the question, and above that either a tab bar (several
	// questions) or the header of the only one.
	for i := first - 1; i >= 0 && i >= first-4; i-- {
		line := lines[i]
		if strings.TrimSpace(line) == "" || reRule.MatchString(line) {
			continue
		}
		if q.Question == "" {
			q.Question = strings.TrimSpace(line)
			continue
		}
		if reTabBar.MatchString(line) {
			d.Headers = tabHeaders(line)
			d.Count = len(d.Headers)
			d.Partial = d.Count > 1
			break
		}
		if m := reHeader.FindStringSubmatch(line); m != nil {
			q.Header = m[1]
		}
		break
	}
	if q.Question == "" {
		return nil
	}
	// The review screen at the end of a multi-question walk is not a question.
	if strings.HasPrefix(q.Question, "Ready to submit") || strings.HasPrefix(q.Question, "Review your answers") {
		return nil
	}
	if q.Header == "" && len(d.Headers) > 0 {
		// Which tab is on screen is drawn in colour, which a text capture does
		// not carry; the headers are still worth showing.
		q.Header = ""
	}
	d.Questions = []DialogQuestion{q}
	return d
}

// reviewScreen recognises the last step of a multi-question walk: every question
// answered, waiting for a Submit.
//
// It is not a question — mirroring its "Submit answers / Cancel" as one would
// offer an answer nobody asked for — but the session IS blocked on it, and
// reporting nothing would leave the Text view on "Working…" while the terminal
// waits for a keystroke. So it comes back partial, with the headers, and the
// card says where to finish it.
func reviewScreen(lines []string) *Dialog {
	asks, tabs := false, ""
	for _, line := range lines {
		t := strings.TrimSpace(line)
		if t == "Ready to submit your answers?" || t == "Review your answers" {
			asks = true
		}
		if reTabBar.MatchString(line) {
			tabs = line
		}
	}
	if !asks || tabs == "" {
		return nil
	}
	headers := tabHeaders(tabs)
	return &Dialog{
		Questions: []DialogQuestion{{Question: "Ready to submit your answers?"}},
		Headers:   headers,
		Count:     len(headers),
		Partial:   true,
	}
}

// numbered reports whether the line is a description belonging to an option —
// i.e. it sits inside the option list rather than above it.
func numbered(lines []string, i int) bool {
	return i > 0 && !reTabBar.MatchString(lines[i]) && strings.HasPrefix(lines[i], "  ")
}

// tabHeaders pulls the question headers out of a multi-question tab bar.
func tabHeaders(line string) []string {
	var out []string
	for _, part := range strings.Split(line, "☐") {
		out = append(out, splitTab(part)...)
	}
	var headers []string
	for _, h := range out {
		h = strings.TrimSpace(h)
		h = strings.TrimPrefix(h, "←")
		h = strings.TrimSuffix(h, "→")
		h = strings.TrimSpace(h)
		if h == "" || h == "✔ Submit" || h == "Submit" {
			continue
		}
		headers = append(headers, h)
	}
	return headers
}

// splitTab splits a tab-bar fragment on the answered marker, so "☒ Drink  ✔
// Submit" yields its parts.
func splitTab(part string) []string {
	var out []string
	for _, p := range strings.Split(part, "☒") {
		for _, q := range strings.Split(p, "✔") {
			out = append(out, q)
		}
	}
	return out
}

func atoi(s string) int {
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return -1
		}
		n = n*10 + int(r-'0')
	}
	return n
}
