package main

import (
	"bytes"
	"encoding/json"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"terminal-lobby/sessionio"
)

// mkHome lays out a fake home with one transcript and returns (home, path).
func mkHome(t *testing.T, line string) (string, string) {
	t.Helper()
	home := t.TempDir()
	dir := filepath.Join(home, ".claude", "projects", "-home-bob")
	if err := os.MkdirAll(dir, 0o750); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "abc.jsonl")
	if err := os.WriteFile(p, []byte(line+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return home, p
}

// ask runs one request through the child loop and returns its answer.
func ask(t *testing.T, home string, req privRequest) privResponse {
	t.Helper()
	in, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := servePrivop(bytes.NewReader(in), &out, home); err != nil {
		t.Fatalf("servePrivop: %v", err)
	}
	var resp privResponse
	if err := json.Unmarshal(out.Bytes(), &resp); err != nil {
		t.Fatalf("decoding %q: %v", out.String(), err)
	}
	return resp
}

func TestPrivopReadsATranscriptUnderItsOwnHome(t *testing.T) {
	home, p := mkHome(t, `{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}`)

	resp := ask(t, home, privRequest{Op: "readfrom", Path: p, Off: 0})
	if !resp.OK {
		t.Fatalf("refused a legitimate read: %s", resp.Err)
	}
	lines := sessionio.SplitLines(resp.Blob)
	if len(lines) != 1 || !strings.Contains(lines[0], `"hi"`) {
		t.Fatalf("lines: %+v", lines)
	}
	if resp.Next != int64(len(lines[0])+1) {
		t.Fatalf("offset should sit past the newline, got %d", resp.Next)
	}
}

// The grant is what makes this dangerous: the child runs as the target user, so
// it must never accept a path the PARENT chose outside that user's transcripts.
// The check lives here rather than in the caller for exactly that reason.
func TestPrivopRefusesAPathOutsideItsProjectsRoot(t *testing.T) {
	home, _ := mkHome(t, `{}`)

	for _, bad := range []string{
		"/etc/passwd",
		filepath.Join(home, ".ssh", "id_ed25519"),
		filepath.Join(home, ".claude", "projects", "..", "..", ".ssh", "id_ed25519.jsonl"),
	} {
		resp := ask(t, home, privRequest{Op: "readfrom", Path: bad})
		if resp.OK {
			t.Fatalf("child accepted %q — the grant would read anything as that user", bad)
		}
	}
}

func TestPrivopRefusesASymlinkOutOfTheProjectsRoot(t *testing.T) {
	home, _ := mkHome(t, `{}`)
	secret := filepath.Join(home, "secret.jsonl")
	os.WriteFile(secret, []byte("{}\n"), 0o600)
	link := filepath.Join(home, ".claude", "projects", "-home-bob", "escape.jsonl")
	if err := os.Symlink(secret, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	if resp := ask(t, home, privRequest{Op: "readfrom", Path: link}); resp.OK {
		t.Fatal("child followed a symlink out of the projects root")
	}
}

func TestPrivopServesFullResult(t *testing.T) {
	home, p := mkHome(t,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t-9","content":"big output"}]}}`)

	resp := ask(t, home, privRequest{Op: "fullresult", Path: p, ToolID: "t-9"})
	if !resp.OK {
		t.Fatalf("refused: %s", resp.Err)
	}
	if resp.Body != "big output" {
		t.Fatalf("body: %q", resp.Body)
	}
}

func TestPrivopRejectsAnUnknownOp(t *testing.T) {
	home, _ := mkHome(t, `{}`)
	if resp := ask(t, home, privRequest{Op: "delete-everything"}); resp.OK {
		t.Fatal("unknown op accepted")
	}
}

// ownHome must come from the password database, never from $HOME.
//
// The privop child is spawned as `sudo -n -u <osUser> <exe> -privop`, and sudo
// may or may not reset HOME depending on how sudoers is configured. A child
// that trusted the environment would resolve the INVOKING user's home and serve
// that person's transcripts to a request about someone else. skills-api's copy
// of this function says the same thing in its comment; this one used to fall
// back to os.UserHomeDir(), which is $HOME.
func TestOwnHomeIgnoresTheEnvironment(t *testing.T) {
	want, err := ownHome()
	if err != nil {
		t.Skipf("no password-db entry for this uid: %v", err)
	}
	t.Setenv("HOME", "/tmp/not-my-home")
	got, err := ownHome()
	if err != nil {
		t.Fatalf("ownHome after HOME was moved: %v", err)
	}
	if got != want {
		t.Fatalf("ownHome followed $HOME: got %q, want %q", got, want)
	}
	if got == "/tmp/not-my-home" {
		t.Fatal("ownHome returned $HOME verbatim")
	}
}

// It resolves THIS process's uid, which under sudo is the target user.
func TestOwnHomeMatchesThePasswordDatabaseForThisUid(t *testing.T) {
	u, err := user.LookupId(strconv.Itoa(os.Getuid()))
	if err != nil {
		t.Skipf("no password-db entry for uid %d: %v", os.Getuid(), err)
	}
	got, err := ownHome()
	if err != nil {
		t.Fatalf("ownHome: %v", err)
	}
	if got != u.HomeDir {
		t.Fatalf("ownHome = %q, password database says %q", got, u.HomeDir)
	}
}

// TL-18. catalogue was the one op that took a path and checked nothing.
// Discover joins the cwd with .claude/skills and .claude/commands, follows
// symlinked skill entries (commands.go:86), reads every *.md it reaches and
// returns describe(), which for a file without frontmatter is its first prose
// line. An unbounded cwd therefore reads a line out of any file of that shape
// on the box, with this child's uid, including inside a 0750 home the caller
// cannot open.
func TestCataloguRefusesACwdOutsideItsOwnHome(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, ".claude", "projects")

	for _, cwd := range []string{
		"/etc",
		filepath.Join(filepath.Dir(home), "someone-else"),
		"relative/path",
		filepath.Join(home, "..", ".."),
	} {
		res := handlePrivop(privRequest{Op: "catalogue", CWD: cwd}, home, root)
		if res.OK {
			t.Errorf("catalogue accepted cwd %q; it must be bounded like every other path here", cwd)
		}
	}

	// The shapes that must keep working: no project directory at all (the only
	// caller today), and a real directory inside this user's home.
	if res := handlePrivop(privRequest{Op: "catalogue"}, home, root); !res.OK {
		t.Errorf("an empty cwd is not a path and must still catalogue: %q", res.Err)
	}
	proj := filepath.Join(home, "code")
	if err := os.MkdirAll(proj, 0o755); err != nil {
		t.Fatal(err)
	}
	if res := handlePrivop(privRequest{Op: "catalogue", CWD: proj}, home, root); !res.OK {
		t.Errorf("a directory inside this user's own home must catalogue: %q", res.Err)
	}
}

// A symlink inside the home that points out of it is the escape the lexical
// check alone would miss.
func TestCataloguRefusesACwdThatSymlinksOutOfTheHome(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, ".claude", "projects")
	outside := t.TempDir()
	link := filepath.Join(home, "escape")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("no symlinks here: %v", err)
	}
	if res := handlePrivop(privRequest{Op: "catalogue", CWD: link}, home, root); res.OK {
		t.Error("a cwd that resolves outside the home must be refused")
	}
}

// mkSessionDir lays out one session directory under a fake home's projects
// root, the way Claude Code writes it: an ad-hoc agent with its sidecar, and a
// workflow member with the run file and the run's script. It returns (home,
// sessionDir).
func mkSessionDir(t *testing.T) (string, string) {
	t.Helper()
	home, transcript := mkHome(t, `{}`)
	dir := sessionio.SessionDir(transcript)
	for name, body := range map[string]string{
		"subagents/agent-a1.jsonl":                     "{}\n",
		"subagents/agent-a1.meta.json":                 `{"agentType":"Explore","description":"look"}`,
		"subagents/workflows/wf_r1/agent-m1.jsonl":     "{}\n",
		"subagents/workflows/wf_r1/agent-m1.meta.json": `{}`,
		"workflows/wf_r1.json":                         `{"runId":"r1"}`,
		"workflows/scripts/check-change-wf_r1.js":      "export const meta = { name: 'check-change' }\n",
	} {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return home, dir
}

// The agent panel needs another user's session directory listed and its small
// JSON files read, as that user: ReadFrom returns complete lines only, and a
// sidecar or a run file never ends in one.
func TestPrivopListsASessionsAgentFiles(t *testing.T) {
	home, dir := mkSessionDir(t)

	resp := ask(t, home, privRequest{Op: "listagents", Path: dir})
	if !resp.OK {
		t.Fatalf("refused a legitimate listing: %s", resp.Err)
	}
	var names []string
	for _, f := range resp.Files {
		names = append(names, f.Name)
		if f.Size <= 0 || f.MTime <= 0 {
			t.Errorf("%s came back without its size or mtime: %+v", f.Name, f)
		}
	}
	want := []string{
		"subagents/agent-a1.jsonl", "subagents/agent-a1.meta.json",
		"subagents/workflows/wf_r1/agent-m1.jsonl", "subagents/workflows/wf_r1/agent-m1.meta.json",
		"workflows/scripts/check-change-wf_r1.js", "workflows/wf_r1.json",
	}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("listing = %v, want %v", names, want)
	}
}

func TestPrivopReadsASmallFileUnderItsRoot(t *testing.T) {
	home, dir := mkSessionDir(t)

	resp := ask(t, home, privRequest{Op: "readsmall", Path: filepath.Join(dir, "subagents", "agent-a1.meta.json")})
	if !resp.OK {
		t.Fatalf("refused a sidecar: %s", resp.Err)
	}
	if string(resp.Blob) != `{"agentType":"Explore","description":"look"}` {
		t.Fatalf("blob = %q", resp.Blob)
	}

	// A run's script, which names the run and its phases before the run file
	// exists. It is the script the session's own transcript already carries,
	// as the Workflow call's input, so reading it shows no one anything new.
	resp = ask(t, home, privRequest{Op: "readsmall", Path: filepath.Join(dir, "workflows", "scripts", "check-change-wf_r1.js")})
	if !resp.OK || string(resp.Blob) != "export const meta = { name: 'check-change' }\n" {
		t.Fatalf("a run's script: ok %v, err %q, blob %q", resp.OK, resp.Err, resp.Blob)
	}
}

// The same boundary every other operation keeps: the parent names the path,
// so the child refuses anything outside its own projects root, and a whole
// read is further held to the JSON documents it exists for. A transcript is
// not one of them; readfrom already serves those, in bounded steps.
func TestPrivopRefusesAgentReadsOutsideItsProjectsRoot(t *testing.T) {
	home, dir := mkSessionDir(t)
	root := filepath.Join(home, ".claude", "projects")
	secret := filepath.Join(home, "secret.json")
	if err := os.WriteFile(secret, []byte(`{"token":"x"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "subagents", "agent-escape.meta.json")
	if err := os.Symlink(secret, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	linkedDir := filepath.Join(root, "-home-bob", "escape")
	if err := os.Symlink(home, linkedDir); err != nil {
		t.Fatal(err)
	}
	big := filepath.Join(dir, "workflows", "wf_big.json")
	if err := os.WriteFile(big, []byte(strings.Repeat(" ", sessionio.MaxSmallFile+1)), 0o600); err != nil {
		t.Fatal(err)
	}
	strayScript := filepath.Join(dir, "subagents", "check-change-wf_r1.js")
	helper := filepath.Join(dir, "workflows", "scripts", "helper.js")
	outsideScript := filepath.Join(home, "workflows", "scripts", "check-change-wf_r1.js")
	for _, p := range []string{strayScript, helper, outsideScript} {
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("export const meta = {}\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	for _, tc := range []struct {
		name string
		req  privRequest
	}{
		{"a listing of /etc", privRequest{Op: "listagents", Path: "/etc"}},
		{"a listing of the home", privRequest{Op: "listagents", Path: home}},
		{"a listing that climbs out", privRequest{Op: "listagents", Path: filepath.Join(root, "..", "..")}},
		{"a relative listing", privRequest{Op: "listagents", Path: "-home-bob/abc"}},
		{"a listing through a link out of the root", privRequest{Op: "listagents", Path: linkedDir}},
		{"a whole read of /etc/passwd", privRequest{Op: "readsmall", Path: "/etc/passwd"}},
		{"a whole read of a JSON file outside the root", privRequest{Op: "readsmall", Path: secret}},
		{"a whole read through a link out of the root", privRequest{Op: "readsmall", Path: link}},
		{"a whole read of a transcript", privRequest{Op: "readsmall", Path: filepath.Join(dir, "subagents", "agent-a1.jsonl")}},
		{"a whole read past the cap", privRequest{Op: "readsmall", Path: big}},
		{"a script that is not under workflows/scripts/", privRequest{Op: "readsmall", Path: strayScript}},
		{"a .js under workflows/scripts/ that names no run", privRequest{Op: "readsmall", Path: helper}},
		{"a script outside the root", privRequest{Op: "readsmall", Path: outsideScript}},
		{"a relative whole read", privRequest{Op: "readsmall", Path: "x/agent-a1.meta.json"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if resp := ask(t, home, tc.req); resp.OK {
				t.Fatalf("child accepted %+v and answered %+v", tc.req, resp)
			}
		})
	}
}
