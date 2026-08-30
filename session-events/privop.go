package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"

	"terminal-lobby/sessionio"
)

// The privileged read child.
//
// session-events runs as one OS user and serves every mapped user. Resolving
// another user's transcript already crosses the boundary (that goes through
// `sudo -u <user> tmux`), but OPENING it did not: homes are 0750, so the read
// failed and the text view showed an empty conversation instead of an error.
//
// This is the other half. A request for a user this process is not gets handed
// to `sudo -n -u <user> session-events -privop`, which runs as them and answers
// over a pipe. Two things make it a child rather than a per-operation re-exec
// (the shape file-api uses): the tail polls every 200 ms, so a fork per read
// would be a fork per 200 ms per open session; and one child serves every
// session that user has open.
//
// The operations are transcript-shaped, not file-shaped. Nothing hands a file
// descriptor back across the boundary — the child does the reading AND the
// scanning, so a 29 MB transcript never crosses the pipe to find one tool
// result, and the containment check travels with the operation that needs it.

// privRequest is one operation, encoded as a single JSON value on the child's
// stdin. Paths are chosen by the PARENT, which is exactly why the child
// re-validates every one of them against its own home.
type privRequest struct {
	Op     string `json:"op"`
	Path   string `json:"path,omitempty"`
	Off    int64  `json:"off,omitempty"`
	ToolID string `json:"toolId,omitempty"`
	CWD    string `json:"cwd,omitempty"`
	Query  string `json:"query,omitempty"`
	Limit  int    `json:"limit,omitempty"`
}

// privResponse is the child's answer. Err carries the reason on refusal; the
// parent turns that into the same error the local reader would have returned.
type privResponse struct {
	OK       bool                    `json:"ok"`
	Err      string                  `json:"err,omitempty"`
	Lines    []string                `json:"lines,omitempty"`
	Next     int64                   `json:"next,omitempty"`
	Body     string                  `json:"body,omitempty"`
	Result   json.RawMessage         `json:"result,omitempty"`
	Commands []Command               `json:"commands,omitempty"`
	Matches  []sessionio.ResultMatch `json:"matches,omitempty"`
}

// ownHome is the home directory of the user the CHILD is running as, read from
// the password database rather than $HOME — sudo's environment handling is a
// configuration detail, and the answer here decides what the child will agree
// to read.
func ownHome() (string, error) {
	u, err := user.LookupId(strconv.Itoa(os.Getuid()))
	if err != nil {
		return "", fmt.Errorf("privop: cannot resolve uid %d: %w", os.Getuid(), err)
	}
	if u.HomeDir == "" {
		return "", fmt.Errorf("privop: user %s has no home directory", u.Username)
	}
	return u.HomeDir, nil
}

// runPrivop is the child's whole life: serve requests on stdin until it closes.
func runPrivop() error {
	home, err := ownHome()
	if err != nil {
		return err
	}
	return servePrivop(os.Stdin, os.Stdout, home)
}

// servePrivop answers one request per decoded value until in is exhausted.
func servePrivop(in io.Reader, out io.Writer, home string) error {
	dec := json.NewDecoder(in)
	enc := json.NewEncoder(out)
	root := filepath.Join(home, ".claude", "projects")
	for {
		var req privRequest
		if err := dec.Decode(&req); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		if err := enc.Encode(handlePrivop(req, home, root)); err != nil {
			return err
		}
	}
}

func fail(format string, a ...any) privResponse {
	return privResponse{OK: false, Err: fmt.Sprintf(format, a...)}
}

// handlePrivop runs one operation. Every path-bearing op is bounded by
// transcriptWithin FIRST, so a parent that asked for something outside this
// user's transcripts gets a refusal rather than a read.
func handlePrivop(req privRequest, home, root string) privResponse {
	switch req.Op {
	case "readfrom":
		if err := transcriptWithin(root, req.Path); err != nil {
			return fail("%v", err)
		}
		lines, next, err := sessionio.ReadFrom(req.Path, req.Off)
		if err != nil {
			return fail("%v", err)
		}
		return privResponse{OK: true, Lines: lines, Next: next}

	case "fullresult":
		if err := transcriptWithin(root, req.Path); err != nil {
			return fail("%v", err)
		}
		f, err := os.Open(req.Path)
		if err != nil {
			return fail("%v", err)
		}
		defer f.Close()
		body, result, err := sessionio.ScanToolResult(f, req.ToolID)
		if err != nil {
			return fail("%v", err)
		}
		return privResponse{OK: true, Body: body, Result: result}

	case "search":
		if err := transcriptWithin(root, req.Path); err != nil {
			return fail("%v", err)
		}
		f, err := os.Open(req.Path)
		if err != nil {
			return fail("%v", err)
		}
		defer f.Close()
		// The child scans and returns only the matches, the same way fullresult
		// returns one result — a search that shipped the transcript across the
		// pipe to grep it on the other side would give up the whole point of
		// keeping the reading on this side of the boundary.
		matches, err := sessionio.ScanResults(f, req.Query, req.Limit)
		if err != nil {
			return fail("%v", err)
		}
		return privResponse{OK: true, Matches: matches}

	case "catalogue":
		// No path check: Discover only ever reads .claude/{skills,commands}
		// under the home this child owns and under the session's own working
		// directory, and it answers with entries rather than file contents.
		return privResponse{OK: true, Commands: Discover(home, req.CWD)}

	default:
		return fail("privop: unknown op %q", req.Op)
	}
}

// transcriptWithin is the boundary the grant rests on: this child will read a
// .jsonl under its OWN projects root and nothing else, however the parent asked.
func transcriptWithin(root, path string) error {
	if !filepath.IsAbs(path) || filepath.Ext(path) != ".jsonl" {
		return fmt.Errorf("privop: %q is not an absolute transcript path", path)
	}
	clean := filepath.Clean(path)
	// Resolve what exists, so a symlink planted inside the root cannot widen
	// the grant. A transcript that does not exist YET is an ordinary state —
	// Claude has not written it — so fall back to the lexical form there and
	// let the read report the absence itself.
	if resolved, err := filepath.EvalSymlinks(clean); err == nil {
		clean = resolved
	}
	realRoot := root
	if resolved, err := filepath.EvalSymlinks(root); err == nil {
		realRoot = resolved
	}
	rel, err := filepath.Rel(realRoot, clean)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("privop: %q is outside %s", path, root)
	}
	return nil
}
