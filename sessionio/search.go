package sessionio

import (
	"log"
	"sort"
	"strings"
)

// Finding something in a session that has scrolled past.
//
// The view opens on a 20-turn window and walks back a window at a time, so most
// of a long session is not in the browser: the largest transcript on this box is
// 28.9 MB over 7,964 records, where 20 turns is a few hundred events. A search
// limited to what the client holds would answer "no matches" for the part of the
// session most worth searching, so this runs against the whole log.
//
// It runs over the source's in-memory log rather than re-reading the file. That
// log is the WHOLE session — the tail appends every event to it, which is what
// Earlier walks — and its ids are the ones the client already uses, so a hit can
// name the event to scroll to. Only tool RESULTS are capped in it
// (MaxInlineResult); everything else — messages, thinking, tool inputs — is
// held complete.

// MaxSnippet bounds the context returned around a match. The hit list shows one
// line per hit on a phone; a result body can run to megabytes.
const MaxSnippet = 160

// MaxSearchHits bounds one search. A common word in a long session matches
// thousands of times, and nobody scrolls a list that long.
const MaxSearchHits = 200

// SearchHit is one match, named well enough for a list entry and carrying the
// event id the reader jumps to.
type SearchHit struct {
	// ID is the event to scroll to. It is the same id space the SSE stream and
	// Last-Event-ID use, so the client resolves it with the machinery it has.
	ID int64 `json:"id"`
	// Kind is the event kind, so the list can label the row the way the
	// timeline labels it.
	Kind Kind `json:"kind"`
	// Tool names the tool for a tool_use/tool_result hit.
	Tool string `json:"tool,omitempty"`
	// Field says WHERE the match was: message, thinking, input, result.
	Field string `json:"field"`
	// Snippet is MaxSnippet bytes of the body centred on the match.
	Snippet string `json:"snippet"`
	// At is the event timestamp (epoch ms) when the transcript recorded one.
	At int64 `json:"at,omitempty"`
}

// searchField names the part of the record an event's Body came from, in the
// vocabulary the hit list shows.
func searchField(k Kind) string {
	switch k {
	case KindUser, KindText:
		return "message"
	case KindThinking:
		return "thinking"
	case KindToolUse:
		return "input"
	case KindToolResult:
		return "result"
	default:
		return string(k)
	}
}

// searchable says whether an event's Body is worth matching against. Meta
// events carry state rather than content — a mode name or a queued prompt — and
// a reader searching for "default" does not want every mode change in the
// session.
func searchable(k Kind) bool {
	switch k {
	case KindUser, KindText, KindThinking, KindToolUse, KindToolResult:
		return true
	default:
		return false
	}
}

// Search returns matches for q across the whole log, newest first, at most
// limit of them. An empty or whitespace-only query matches nothing.
func (f *FileSource) Search(q string, limit int) []SearchHit {
	q = strings.TrimSpace(q)
	if q == "" {
		return nil
	}
	if limit <= 0 || limit > MaxSearchHits {
		limit = MaxSearchHits
	}
	needle := strings.ToLower(q)

	f.mu.Lock()
	log := make([]Event, len(f.logbuf))
	copy(log, f.logbuf)
	f.mu.Unlock()

	// Newest first, and stop at the limit — so the cut falls on the OLD end,
	// which is the end a reader is least likely to have meant.
	// A tool_result event carries the tool id but not the tool NAME — only the
	// tool_use that opened it does. The hit list says "Bash · result", so the
	// name is resolved here rather than left blank.
	toolOf := map[string]string{}
	for _, e := range log {
		if e.Kind == KindToolUse && e.ToolID != "" && e.Tool != "" {
			toolOf[e.ToolID] = e.Tool
		}
	}
	name := func(e Event) string {
		if e.Tool != "" {
			return e.Tool
		}
		return toolOf[e.ToolID]
	}

	var out []SearchHit
	hit := map[int64]bool{}
	// Truncated results are the ones whose full body lives only on disk. Their
	// tool ids are how a disk match finds the event it belongs to.
	truncated := map[string]Event{}
	for i := len(log) - 1; i >= 0; i-- {
		e := log[i]
		if e.Kind == KindToolResult && e.Truncated && e.ToolID != "" {
			if _, seen := truncated[e.ToolID]; !seen {
				truncated[e.ToolID] = e
			}
		}
		if len(out) >= limit || !searchable(e.Kind) || e.Body == "" {
			continue
		}
		at := strings.Index(strings.ToLower(e.Body), needle)
		if at < 0 {
			continue
		}
		hit[e.ID] = true
		out = append(out, SearchHit{
			ID:      e.ID,
			Kind:    e.Kind,
			Tool:    name(e),
			Field:   searchField(e.Kind),
			Snippet: snippet(e.Body, at, len(q)),
			At:      e.At,
		})
	}

	out = append(out, f.searchTruncatedResults(q, limit, truncated, hit, name)...)

	// Newest first as a property of the RESULT rather than of the loop that
	// built it — the disk pass appends out of order by construction.
	sort.SliceStable(out, func(i, j int) bool { return out[i].ID > out[j].ID })
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

// searchTruncatedResults finds matches living past MaxInlineResult, which the
// in-memory log does not hold.
//
// It touches the disk only when the session actually has a truncated result —
// most searches never read the file at all — and it maps each match back to the
// event that already carries the id, so a hit from 4,000 records ago is jumped
// to exactly like one from the open window.
func (f *FileSource) searchTruncatedResults(q string, limit int, truncated map[string]Event, hit map[int64]bool, name func(Event) string) []SearchHit {
	if len(truncated) == 0 {
		return nil
	}
	matches, err := f.reader.SearchResults(f.path, q, limit)
	if err != nil {
		// A search that cannot read the file still answers with what memory
		// held; reporting nothing at all would be worse than reporting less.
		log.Printf("search %s: scanning results: %v", f.session, err)
		return nil
	}
	var out []SearchHit
	for _, m := range matches {
		e, ok := truncated[m.ToolID]
		if !ok || hit[e.ID] {
			continue // not truncated, or its visible head already matched
		}
		hit[e.ID] = true
		out = append(out, SearchHit{
			ID:      e.ID,
			Kind:    KindToolResult,
			Tool:    name(e),
			Field:   searchField(KindToolResult),
			Snippet: m.Snippet,
			At:      e.At,
		})
	}
	return out
}

// snippet returns up to MaxSnippet bytes of s centred on the match at `at`,
// with an ellipsis wherever it cut. Offsets are clamped to rune boundaries so
// the result is never invalid UTF-8 in the middle of a character.
func snippet(s string, at, n int) string {
	const pad = (MaxSnippet - 20) / 2
	start, end := at-pad, at+n+pad
	if start < 0 {
		start = 0
	}
	if end > len(s) {
		end = len(s)
	}
	start, end = runeStart(s, start), runeEnd(s, end)

	var b strings.Builder
	if start > 0 {
		b.WriteString("…")
	}
	// Newlines inside a snippet would break the one-line-per-hit list.
	b.WriteString(strings.Join(strings.Fields(s[start:end]), " "))
	if end < len(s) {
		b.WriteString("…")
	}
	return b.String()
}

// runeStart moves i back to the start of the rune it lands inside.
func runeStart(s string, i int) int {
	for i > 0 && i < len(s) && s[i]&0xC0 == 0x80 {
		i--
	}
	return i
}

// runeEnd moves i forward to the start of the next rune, so s[:i] ends whole.
func runeEnd(s string, i int) int {
	for i < len(s) && s[i]&0xC0 == 0x80 {
		i++
	}
	return i
}
