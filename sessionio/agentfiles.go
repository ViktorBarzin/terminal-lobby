package sessionio

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

// AgentFile is one file under a session directory that the agent panel reads,
// as the directory lists it. It crosses the privileged read boundary, so it
// carries what deciding to read a file needs and nothing of its content.
type AgentFile struct {
	// Name is the path below the session directory, "/"-separated:
	// subagents/agent-<id>.jsonl, its .meta.json sidecar, the same two under
	// subagents/workflows/wf_<runId>/ beside that run's journal.jsonl,
	// workflows/wf_<runId>.json, or the run's script,
	// workflows/scripts/<name>-wf_<runId>.js.
	Name  string `json:"name"`
	Size  int64  `json:"size"`
	MTime int64  `json:"mtime"` // ms epoch
}

// AgentReader is how the agent panel reaches a session directory. The agent
// transcripts are tailed through the Reader half, like the session's own; the
// directory listing and the small documents beside them (the identity
// sidecars, the workflow run files and the runs' scripts) need two more
// operations, because ReadFrom only ever returns complete newline-terminated
// lines and none of those is read that way.
type AgentReader interface {
	Reader
	ListAgentFiles(sessionDir string) ([]AgentFile, error)
	ReadSmallFile(path string) ([]byte, error)
}

// MaxSmallFile bounds ReadSmallFile. A sidecar is under 400 bytes (the largest
// of 2,835 on this box is 383) and a workflow run file is the big one: 726,346
// bytes at most across 2,400 of them. A run's script is at most 512 KB, the
// Workflow tool's own limit (61,590 bytes is the largest of 138 here). Four
// megabytes leaves room for a run five times that size without letting a stray
// file cost a whole read of anything.
const MaxSmallFile = 4 << 20

// SessionDir is the directory Claude Code keeps beside a session's transcript
// for the session's agents: the transcript path without its .jsonl.
func SessionDir(transcript string) string {
	return strings.TrimSuffix(transcript, agentFileSuffix)
}

// ListAgentFiles lists the agent files under a session directory, sorted by
// name. A session that has spawned nothing has no directory, or one without
// subagents/, and that lists as nothing rather than as an error.
//
// It is exported for the privileged child, which runs this same walk as the
// session's owner. Only regular files and real directories are read: a link is
// skipped wherever it sits, so a link planted inside the directory cannot
// point the child's listing at anything outside it. That takes checking every
// directory on the way down, since Lstat refuses a link only as a path's last
// element.
func ListAgentFiles(sessionDir string) ([]AgentFile, error) {
	var out []AgentFile
	add := func(dir, rel string, keep func(name string) bool) error {
		entries, err := readRealDir(filepath.Join(sessionDir, filepath.FromSlash(dir)))
		if err != nil {
			return err
		}
		for _, e := range entries {
			if !e.Type().IsRegular() || !keep(e.Name()) {
				continue
			}
			info, err := e.Info()
			if err != nil {
				continue // removed since the directory was read
			}
			out = append(out, AgentFile{
				Name:  path.Join(rel, e.Name()),
				Size:  info.Size(),
				MTime: info.ModTime().UnixMilli(),
			})
		}
		return nil
	}

	if err := add("subagents", "subagents", isAgentFile); err != nil {
		return nil, err
	}
	var runs []fs.DirEntry
	if ok, err := realDirs(sessionDir, "subagents"); err != nil {
		return nil, err
	} else if ok {
		if runs, err = readRealDir(filepath.Join(sessionDir, "subagents", "workflows")); err != nil {
			return nil, err
		}
	}
	for _, e := range runs {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), "wf_") {
			continue
		}
		rel := path.Join("subagents", "workflows", e.Name())
		if err := add(rel, rel, isMemberFile); err != nil {
			return nil, err
		}
	}
	if err := add("workflows", "workflows", isRunFile); err != nil {
		return nil, err
	}
	if ok, err := realDirs(sessionDir, "workflows"); err != nil {
		return nil, err
	} else if ok {
		if err := add("workflows/scripts", "workflows/scripts", isRunScript); err != nil {
			return nil, err
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// realDirs reports whether each of the nested directories elems, below
// sessionDir, is really there: a directory, and not a link to one.
func realDirs(sessionDir string, elems ...string) (bool, error) {
	p := sessionDir
	for _, e := range elems {
		p = filepath.Join(p, e)
		info, err := os.Lstat(p)
		if errors.Is(err, fs.ErrNotExist) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		if !info.IsDir() {
			return false, nil
		}
	}
	return true, nil
}

// readRealDir reads a directory that is really there: absent means empty, and
// so does a link, which is not followed.
func readRealDir(dir string) ([]fs.DirEntry, error) {
	info, err := os.Lstat(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, nil
	}
	return os.ReadDir(dir)
}

// isAgentFile matches agent-<id>.jsonl and agent-<id>.meta.json.
func isAgentFile(name string) bool {
	if _, ok := AgentFileID(name); ok {
		return true
	}
	id := strings.TrimSuffix(strings.TrimPrefix(name, agentFilePrefix), agentMetaSuffix)
	return strings.HasPrefix(name, agentFilePrefix) && strings.HasSuffix(name, agentMetaSuffix) && id != ""
}

// runJournal is the file a running workflow appends to beside its members.
// The run file under workflows/ is written only when the run ends (measured on
// Claude Code 2.1.281), so mid-run the journal and the member files are all
// there is to read.
const runJournal = "journal.jsonl"

// isMemberFile matches what a subagents/workflows/wf_<runId>/ directory holds
// for the panel: its members' files and the run's journal.
func isMemberFile(name string) bool { return name == runJournal || isAgentFile(name) }

// isRunScript matches workflows/scripts/<name>-wf_<runId>.js.
func isRunScript(name string) bool {
	_, ok := WorkflowScriptRun(name)
	return ok
}

// isRunFile matches workflows/wf_<runId>.json.
func isRunFile(name string) bool {
	return strings.HasPrefix(name, "wf_") && strings.HasSuffix(name, ".json") && len(name) > len("wf_.json")
}

// ReadSmallFile reads a whole file of at most MaxSmallFile bytes. A larger one
// is refused rather than cut short, since a truncated JSON document is exactly
// what a half-written one looks like and the caller would keep retrying it.
func ReadSmallFile(p string) ([]byte, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, MaxSmallFile+1))
	if err != nil {
		return nil, err
	}
	if len(b) > MaxSmallFile {
		return nil, fmt.Errorf("%s: larger than %d bytes", p, MaxSmallFile)
	}
	return b, nil
}

// ListAgentFiles lists a session directory through this process's own access.
func (LocalReader) ListAgentFiles(sessionDir string) ([]AgentFile, error) {
	return ListAgentFiles(sessionDir)
}

// ReadSmallFile reads a sidecar, a run file or a run's script through this
// process's own access.
func (LocalReader) ReadSmallFile(p string) ([]byte, error) { return ReadSmallFile(p) }

var _ AgentReader = LocalReader{}
