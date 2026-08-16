package main

import (
	"encoding/base64"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestCrossUser(t *testing.T) {
	old := selfUser
	defer func() { selfUser = old }()

	selfUser = "" // tests + a service that can't resolve its own user → always inline
	if crossUser("emo") {
		t.Fatal("empty selfUser must never take the sudo path")
	}
	selfUser = "wizard"
	if !crossUser("emo") {
		t.Fatal("wizard serving emo must cross (sudo)")
	}
	if crossUser("wizard") {
		t.Fatal("wizard serving wizard must be inline")
	}
}

func TestOpReadEnvelopeRoundTrip(t *testing.T) {
	home := t.TempDir()
	p := filepath.Join(home, "note.txt")
	os.WriteFile(p, []byte("hello preview"), 0o644)

	res := opReadEnvelope(home, p)
	if res.Status != http.StatusOK {
		t.Fatalf("status=%d err=%q", res.Status, res.Error)
	}
	got, err := base64.StdEncoding.DecodeString(res.ContentB64)
	if err != nil || string(got) != "hello preview" {
		t.Fatalf("content=%q err=%v", got, err)
	}
	if res.ContentType == "" || res.MtimeUnix == 0 {
		t.Fatalf("headers not set: type=%q mtime=%d", res.ContentType, res.MtimeUnix)
	}
}

func TestOpReadEnvelopeErrors(t *testing.T) {
	home := t.TempDir()
	if res := opReadEnvelope(home, filepath.Join(home, "nope")); res.Status != http.StatusNotFound {
		t.Fatalf("missing file: status=%d", res.Status)
	}
	if res := opReadEnvelope(home, "/etc/passwd"); res.Status != http.StatusBadRequest {
		t.Fatalf("outside home: status=%d", res.Status)
	}
	if res := opReadEnvelope(home, home); res.Status != http.StatusBadRequest {
		t.Fatalf("directory: status=%d", res.Status)
	}
}

func TestOpListAndWriteEnvelope(t *testing.T) {
	home := t.TempDir()
	os.WriteFile(filepath.Join(home, "a.txt"), []byte("x"), 0o644)
	os.Mkdir(filepath.Join(home, "sub"), 0o755)
	os.WriteFile(filepath.Join(home, ".hidden"), []byte("h"), 0o644)

	res := opList(home, home, false)
	if res.Status != http.StatusOK {
		t.Fatalf("list status=%d", res.Status)
	}
	if len(res.Entries) != 2 || !res.Entries[0].IsDir || res.Entries[0].Name != "sub" {
		t.Fatalf("dotfile must hide, dir must sort first: %+v", res.Entries)
	}
	if all := opList(home, home, true); len(all.Entries) != 3 {
		t.Fatalf("list all: want 3 entries, got %d", len(all.Entries))
	}

	wp := filepath.Join(home, "new.txt")
	if res := opWrite(home, wp, []byte("written")); res.Status != http.StatusNoContent {
		t.Fatalf("write status=%d err=%q", res.Status, res.Error)
	}
	if b, _ := os.ReadFile(wp); string(b) != "written" {
		t.Fatalf("write content=%q", b)
	}
	if res := opWrite(home, "/etc/x", []byte("no")); res.Status != http.StatusBadRequest {
		t.Fatalf("write outside home: status=%d", res.Status)
	}
}

// --- routing: which requests leave the process ------------------------------
//
// The inline path is the one Viktor uses every day and the one every other test
// in this package exercises, so it must stay byte-identical: same ServeContent
// streaming, same Range support, same SVG content-type rule. Only a request
// that maps to a DIFFERENT OS user may take the sudo detour, because only then
// is the service unable to read the file itself.

func TestRoutesOnlyOtherUsersThroughSudo(t *testing.T) {
	old := selfUser
	t.Cleanup(func() { selfUser = old })
	selfUser = "wizard"

	if crossUser("wizard") {
		t.Fatal("the service's OWN user must stay inline — sudo there would " +
			"swap streaming reads for a base64 pipe and regress the common case")
	}
	if !crossUser("emo") {
		t.Fatal("another user's files are unreadable inline (0750 home); the " +
			"request has to go through sudo or the Files button 500s for them")
	}
}

func TestNeverSudosWhenSelfUserIsUnknown(t *testing.T) {
	// user.Current() failing must not turn every request into a sudo call
	// against a user we cannot name.
	old := selfUser
	t.Cleanup(func() { selfUser = old })
	selfUser = ""
	if crossUser("emo") {
		t.Fatal("with no known self user the service must stay inline, not " +
			"guess that every request is cross-user")
	}
}

func TestPrivopArgvCarriesNoShell(t *testing.T) {
	// The sudoers grant is the security boundary: it permits exactly
	// `file-api` as the target user. argv must therefore be a plain exec with
	// the path passed as its own argument — never a shell string a filename
	// could break out of.
	cmd := privopCommand("emo", "read", "/home/emo", "/home/emo/a; rm -rf /", false)
	if cmd.Path != sudoBinary {
		t.Fatalf("expected %s, got %s", sudoBinary, cmd.Path)
	}
	for _, a := range cmd.Args {
		if a == "-c" || a == "sh" || a == "bash" || a == "/bin/sh" {
			t.Fatalf("argv routes through a shell: %v", cmd.Args)
		}
	}
	var got string
	for i, a := range cmd.Args {
		if a == "-path" && i+1 < len(cmd.Args) {
			got = cmd.Args[i+1]
		}
	}
	if got != "/home/emo/a; rm -rf /" {
		t.Fatalf("the path must arrive as ONE argv element, got %q", got)
	}
	if cmd.Args[1] != "-n" {
		t.Fatalf("sudo must be non-interactive (-n), got %v", cmd.Args)
	}
}
