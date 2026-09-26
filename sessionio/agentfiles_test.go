package sessionio

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// layDown writes each file under dir with the given body and modification
// time, creating directories on the way.
func layDown(t *testing.T, dir string, files map[string]string, mtime time.Time) {
	t.Helper()
	for name, body := range files {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, mtime, mtime); err != nil {
			t.Fatal(err)
		}
	}
}

// The listing names every file the agent panel reads under a session
// directory, and nothing else that lives there: ad-hoc agents and teammates,
// workflow members, each run's journal, the workflow run files, and each run's
// script. The workflow half is listed before anything reads it, so the step
// that parses runs needs no second operation across the privileged boundary.
// The journal and the script matter because the run file is written only when
// a run ends (measured on Claude Code 2.1.281): mid-run, the journal and the
// member files say where a run is, and its script what it is.
func TestListAgentFilesNamesEveryAgentFileAndNothingElse(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "sess")
	at := time.UnixMilli(1_790_000_000_123)
	files := map[string]string{
		"subagents/agent-a1.jsonl":                         "{}\n",
		"subagents/agent-a1.meta.json":                     `{"agentType":"Explore"}`,
		"subagents/agent-a2.meta.json":                     `{}`,
		"subagents/workflows/wf_r1/agent-m1.jsonl":         "{}\n{}\n",
		"subagents/workflows/wf_r1/agent-m1.meta.json":     `{}`,
		"subagents/workflows/wf_r1/journal.jsonl":          "{}\n",
		"workflows/wf_r1.json":                             `{"runId":"r1"}`,
		"workflows/scripts/check-change-wf_r1.js":          "export const meta = {}\n",
		"subagents/journal.jsonl":                          "{}\n",
		"subagents/notes.txt":                              "not an agent",
		"subagents/agent-a1.jsonl.tmp":                     "a half-written copy",
		"subagents/agent-.jsonl":                           "{}\n",
		"subagents/workflows/not-a-run/agent-x.jsonl":      "{}\n",
		"subagents/workflows/wf_r1/deeper/agent-y.jsonl":   "{}\n",
		"workflows/wf_r1.json.bak":                         "{}",
		"workflows/other.json":                             "{}",
		"tool-results/b8i8a4l1h.txt":                       "a tool result",
		"subagents/workflows/wf_r1/agent-m2.meta.json.swp": "",
		"workflows/scripts/notes.md":                       "not a script",
		"workflows/scripts/review.js":                      "no run in its name",
		"workflows/scripts/check-change-wf_r1.js.tmp":      "a half-written copy",
		"workflows/scripts/deeper/other-wf_r2.js":          "too deep",
		"workflows/check-change-wf_r1.js":                  "not under scripts/",
	}
	layDown(t, dir, files, at)

	got, err := ListAgentFiles(dir)
	if err != nil {
		t.Fatalf("ListAgentFiles: %v", err)
	}
	var want []AgentFile
	for _, name := range []string{
		"subagents/agent-a1.jsonl",
		"subagents/agent-a1.meta.json",
		"subagents/agent-a2.meta.json",
		"subagents/workflows/wf_r1/agent-m1.jsonl",
		"subagents/workflows/wf_r1/agent-m1.meta.json",
		"subagents/workflows/wf_r1/journal.jsonl",
		"workflows/scripts/check-change-wf_r1.js",
		"workflows/wf_r1.json",
	} {
		want = append(want, AgentFile{Name: name, Size: int64(len(files[name])), MTime: at.UnixMilli()})
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("listing\n got %+v\nwant %+v", got, want)
	}
}

// A session that never spawned anything has no session directory, or one
// without subagents/. That is the ordinary case, not an error.
func TestListAgentFilesOfASessionWithNoAgents(t *testing.T) {
	base := t.TempDir()
	for _, tc := range []struct {
		name string
		dir  string
	}{
		{"no session directory", filepath.Join(base, "never-made")},
		{"a session directory with only tool results", func() string {
			d := filepath.Join(base, "results-only")
			layDown(t, d, map[string]string{"tool-results/x.txt": "x"}, time.Now())
			return d
		}()},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ListAgentFiles(tc.dir)
			if err != nil || len(got) != 0 {
				t.Fatalf("ListAgentFiles = %+v, %v; want nothing and no error", got, err)
			}
		})
	}
}

// The privileged child lists another user's directory as that user, so the
// listing must not follow a link out of the session directory: the parent
// bounds the directory it names, and a link planted inside it would otherwise
// list whatever it points at.
func TestListAgentFilesDoesNotFollowLinks(t *testing.T) {
	base := t.TempDir()
	outside := filepath.Join(base, "outside")
	layDown(t, outside, map[string]string{
		"agent-leak.jsonl":                   "{}\n",
		"wf_leak/agent-leak.jsonl":           "{}\n",
		"wf_leak.json":                       "{}",
		"leak-wf_leak.js":                    "export const meta = {}",
		"scripts/leak-wf_leak.js":            "export const meta = {}",
		"workflows/wf_leak/agent-leak.jsonl": "{}\n",
	}, time.Now())
	dir := filepath.Join(base, "sess")
	layDown(t, dir, map[string]string{"subagents/agent-real.jsonl": "{}\n"}, time.Now())
	for _, link := range []struct{ target, at string }{
		{filepath.Join(outside, "agent-leak.jsonl"), "subagents/agent-linked.jsonl"},
		{outside, "subagents/workflows"},
		{outside, "workflows"},
	} {
		if err := os.Symlink(link.target, filepath.Join(dir, filepath.FromSlash(link.at))); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
	}

	got, err := ListAgentFiles(dir)
	if err != nil {
		t.Fatalf("ListAgentFiles: %v", err)
	}
	if len(got) != 1 || got[0].Name != "subagents/agent-real.jsonl" {
		t.Fatalf("the listing followed a link: %+v", got)
	}

	// A subagents/ that is itself a link is not walked either, nor anything
	// below it: Lstat refuses a link only as a path's last element, so
	// subagents/workflows would otherwise be read through it.
	linked := filepath.Join(base, "linked-sess")
	if err := os.MkdirAll(linked, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(linked, "subagents")); err != nil {
		t.Fatal(err)
	}
	if got, err := ListAgentFiles(linked); err != nil || len(got) != 0 {
		t.Fatalf("a linked subagents/ was walked: %+v, %v", got, err)
	}

	// The same for scripts/ under a real workflows/.
	scripted := filepath.Join(base, "scripted-sess")
	if err := os.MkdirAll(filepath.Join(scripted, "workflows"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(scripted, "workflows", "scripts")); err != nil {
		t.Fatal(err)
	}
	if got, err := ListAgentFiles(scripted); err != nil || len(got) != 0 {
		t.Fatalf("a linked workflows/scripts/ was walked: %+v, %v", got, err)
	}
}

// Sidecars and run files are single JSON documents with no trailing newline,
// which ReadFrom (complete lines only) can never return. They are read whole,
// and bounded: the largest run file on this box is 726,346 bytes, and a file
// past the cap is refused rather than truncated into something that parses.
func TestReadSmallFile(t *testing.T) {
	dir := t.TempDir()
	small := filepath.Join(dir, "agent-a1.meta.json")
	if err := os.WriteFile(small, []byte(`{"agentType":"Explore"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	big := filepath.Join(dir, "wf_big.json")
	if err := os.WriteFile(big, []byte(strings.Repeat("x", MaxSmallFile+1)), 0o600); err != nil {
		t.Fatal(err)
	}

	if b, err := ReadSmallFile(small); err != nil || string(b) != `{"agentType":"Explore"}` {
		t.Errorf("ReadSmallFile(sidecar) = %q, %v", b, err)
	}
	if b, err := ReadSmallFile(big); err == nil {
		t.Errorf("a file past the cap was read (%d bytes)", len(b))
	}
	if _, err := ReadSmallFile(filepath.Join(dir, "gone.json")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("a missing file should say so, got %v", err)
	}
	if MaxSmallFile < 726_346 {
		t.Errorf("MaxSmallFile %d is below the largest run file measured on this box", MaxSmallFile)
	}
}

// The local reader is what the service's own user goes through; it has to
// answer exactly what the privileged child answers for everyone else.
func TestLocalReaderReachesAgentFiles(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "sess")
	layDown(t, dir, map[string]string{"subagents/agent-a1.meta.json": `{"description":"d"}`}, time.Now())
	var r AgentReader = LocalReader{}

	files, err := r.ListAgentFiles(dir)
	if err != nil || len(files) != 1 {
		t.Fatalf("ListAgentFiles = %+v, %v", files, err)
	}
	b, err := r.ReadSmallFile(filepath.Join(dir, filepath.FromSlash(files[0].Name)))
	if err != nil || string(b) != `{"description":"d"}` {
		t.Fatalf("ReadSmallFile = %q, %v", b, err)
	}
}

func TestSessionDir(t *testing.T) {
	for _, tc := range []struct{ transcript, want string }{
		{"/home/u/.claude/projects/-home-u/abc.jsonl", "/home/u/.claude/projects/-home-u/abc"},
		{"/home/u/.claude/projects/-home-u/abc", "/home/u/.claude/projects/-home-u/abc"},
	} {
		if got := SessionDir(tc.transcript); got != tc.want {
			t.Errorf("SessionDir(%q) = %q, want %q", tc.transcript, got, tc.want)
		}
	}
}
