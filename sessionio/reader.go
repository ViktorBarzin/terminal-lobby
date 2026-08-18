package sessionio

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
)

// Reader is how a FileSource reaches a transcript.
//
// It exists because session-events runs as ONE OS user but serves several, and
// a home directory is 0750: the service could resolve another user's transcript
// path (that goes through `sudo -u <user> tmux`, which does cross users) and
// then fail to open the file. The failure was silent — the stream opened,
// reported "ready", and delivered nothing, which the text view renders as an
// empty conversation rather than an error. Every non-owning user's text view
// was blank from the SPA's promotion until 2026-08-18.
//
// The operations are transcript-shaped rather than file-shaped on purpose. The
// implementation that crosses users hands each one to a child process running
// AS that user, so the work — and the containment check that bounds it — moves
// with the operation instead of a raw file handle crossing the boundary. It is
// the same principle file-api's privop split follows.
type Reader interface {
	// ReadFrom returns the complete lines appended after byte offset off, and
	// the offset just past the last complete one.
	ReadFrom(path string, off int64) (lines []string, next int64, err error)
	// FullResult scans the transcript for one tool result, returning its
	// flattened text and structured form. The scan runs wherever the file is
	// readable, so a multi-megabyte transcript is never shipped whole.
	FullResult(path, toolID string) (string, json.RawMessage, error)
	// SearchResults scans the transcript for tool results matching q, returning
	// the newest `limit` of them. Like FullResult it runs where the file is
	// readable and returns only the matches — a search that shipped the
	// transcript across this boundary to grep it would defeat the split.
	SearchResults(path, q string, limit int) ([]ResultMatch, error)
}

// ResultMatch is one tool result whose FULL body matched a search — the part
// past MaxInlineResult that the in-memory log does not hold. It carries the tool
// id rather than an event id because the scan reads records, not events; the
// caller maps it back to the event that already knows it (see FileSource.Search).
type ResultMatch struct {
	ToolID  string `json:"toolId"`
	Snippet string `json:"snippet"`
}

// LocalReader reads with this process's own file access — the right and only
// reader for a user the service already runs as.
type LocalReader struct{}

// ReadFrom reads through the package's own file access.
func (LocalReader) ReadFrom(path string, off int64) ([]string, int64, error) {
	return ReadFrom(path, off)
}

// FullResult opens the transcript locally and scans it in this process.
func (LocalReader) FullResult(path, toolID string) (string, json.RawMessage, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", nil, err
	}
	defer file.Close()
	return ScanToolResult(file, toolID)
}

// SearchResults implements Reader through this process's own file access.
func (LocalReader) SearchResults(path, q string, limit int) ([]ResultMatch, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return ScanResults(file, q, limit)
}

// ScanResults finds tool results whose full body matches q, newest `limit`
// first-to-last. Exported for the same reason as ScanToolResult: the privileged
// child runs this exact scan rather than a second one that could drift.
//
// It matches against the DECODED body, not the raw JSON line, so a search for a
// phrase spanning a newline behaves the way the reader saw it on screen.
func ScanResults(r io.Reader, q string, limit int) ([]ResultMatch, error) {
	q = strings.TrimSpace(q)
	if q == "" {
		return nil, nil
	}
	if limit <= 0 || limit > MaxSearchHits {
		limit = MaxSearchHits
	}
	needle := []byte(strings.ToLower(q))

	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64<<10), maxTranscriptLine)
	// A rolling tail: the scan runs oldest to newest, and the newest matches are
	// the ones a reader means, so old ones fall off the front.
	var out []ResultMatch
	lower := make([]byte, 0, 64<<10)
	for sc.Scan() {
		line := sc.Bytes()
		// Cheap reject before the JSON decode. Lowercasing into a reused buffer
		// keeps this allocation-free per line on a 29 MB transcript.
		lower = append(lower[:0], line...)
		asciiLower(lower)
		if !bytes.Contains(lower, needle) {
			continue
		}
		rec, ok := DecodeRecord(line)
		if !ok {
			continue
		}
		for _, bl := range rec.Blocks() {
			if bl.Type != "tool_result" || bl.ToolUseID == "" {
				continue
			}
			body := decodeToolResult(bl.Content)
			at := strings.Index(strings.ToLower(body), strings.ToLower(q))
			if at < 0 {
				continue
			}
			out = append(out, ResultMatch{ToolID: bl.ToolUseID, Snippet: snippet(body, at, len(q))})
			if len(out) > limit {
				out = out[1:]
			}
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// asciiLower lowercases ASCII letters in place. The needle is a user's search
// term and the haystack is a JSON line; case folding beyond ASCII is not worth
// decoding every line of a 29 MB file for, and a non-ASCII query still matches
// exactly.
func asciiLower(b []byte) {
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
}

// ScanToolResult finds one tool result in a transcript stream. It is exported so
// the privileged child can run exactly the same scan the local path does, rather
// than a second implementation that could drift from it.
func ScanToolResult(r io.Reader, toolID string) (string, json.RawMessage, error) {
	if toolID == "" {
		return "", nil, fmt.Errorf("full result: no tool id")
	}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64<<10), maxTranscriptLine)
	for sc.Scan() {
		line := sc.Bytes()
		// Cheap reject before the JSON decode — most lines are not this one.
		if !bytes.Contains(line, []byte(toolID)) {
			continue
		}
		rec, ok := DecodeRecord(line)
		if !ok {
			continue
		}
		for _, bl := range rec.Blocks() {
			if bl.Type == "tool_result" && bl.ToolUseID == toolID {
				return decodeToolResult(bl.Content), rec.ToolUseResult, nil
			}
		}
	}
	if err := sc.Err(); err != nil {
		return "", nil, err
	}
	return "", nil, fmt.Errorf("full result: no result for tool %q in this transcript", toolID)
}
