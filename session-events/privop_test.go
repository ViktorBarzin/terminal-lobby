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
	if len(resp.Lines) != 1 || !strings.Contains(resp.Lines[0], `"hi"`) {
		t.Fatalf("lines: %+v", resp.Lines)
	}
	if resp.Next != int64(len(resp.Lines[0])+1) {
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
