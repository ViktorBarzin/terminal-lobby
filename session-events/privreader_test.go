package main

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"terminal-lobby/sessionio"
)

// inProcessChild runs the real child loop over pipes, so these tests exercise
// the actual protocol rather than a mock of it — everything except sudo.
func inProcessChild(t *testing.T, home string, started *int32) func() (*privChild, error) {
	t.Helper()
	var mu sync.Mutex
	return func() (*privChild, error) {
		mu.Lock()
		if started != nil {
			*started++
		}
		mu.Unlock()
		toChild, fromParent, err := os.Pipe()
		if err != nil {
			return nil, err
		}
		toParent, fromChild, err := os.Pipe()
		if err != nil {
			return nil, err
		}
		go func() {
			defer fromChild.Close()
			servePrivop(toChild, fromChild, home)
		}()
		return newPrivChild(toParent, fromParent, func() error {
			fromParent.Close()
			toParent.Close()
			return nil
		}), nil
	}
}

func TestPrivReaderReadsAnotherUsersTranscript(t *testing.T) {
	home, p := mkHome(t, `{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}`)
	pr := &privReader{osUser: "bob", spawn: inProcessChild(t, home, nil)}
	t.Cleanup(pr.close)

	lines, next, err := pr.ReadFrom(p, 0)
	if err != nil {
		t.Fatalf("ReadFrom: %v", err)
	}
	if len(lines) != 1 || !strings.Contains(lines[0], `"hi"`) {
		t.Fatalf("lines: %+v", lines)
	}
	if next == 0 {
		t.Fatal("offset did not advance")
	}

	// A poll resuming from the offset the bulk read left: this is the read the
	// long-lived child exists for.
	if _, _, err := pr.ReadFrom(p, next); err != nil {
		t.Fatalf("second read: %v", err)
	}
}

func TestPrivReaderSurfacesAChildRefusalAsAnError(t *testing.T) {
	home, _ := mkHome(t, `{}`)
	pr := &privReader{osUser: "bob", spawn: inProcessChild(t, home, nil)}
	t.Cleanup(pr.close)

	if _, _, err := pr.ReadFrom("/etc/passwd", 0); err == nil {
		t.Fatal("a refused read must not look like an empty transcript — that is the bug this fixes")
	}
}

// Every deploy restarts this service, and a child can die on its own. The next
// read has to bring one back rather than reporting an empty conversation.
func TestPrivReaderRestartsADeadChild(t *testing.T) {
	home, p := mkHome(t, `{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}`)
	var starts int32
	pr := &privReader{osUser: "bob", spawn: inProcessChild(t, home, &starts)}
	t.Cleanup(pr.close)

	// The shared child is the one the tail polls use, and a poll resumes from
	// an offset. A read from 0 is the bulk read, which runs on a child of its
	// own so it cannot hold the shared pipe (see privReader.ReadFrom).
	if _, _, err := pr.ReadFrom(p, 1); err != nil {
		t.Fatalf("first poll: %v", err)
	}
	before := starts
	pr.mu.Lock()
	pr.child.stop()
	pr.mu.Unlock()

	if _, _, err := pr.ReadFrom(p, 1); err != nil {
		t.Fatalf("read after the child died: %v", err)
	}
	if starts < before+1 {
		t.Fatalf("expected a replacement child, saw %d start(s) after %d", starts, before)
	}
}

func TestPrivReaderFullResult(t *testing.T) {
	home, p := mkHome(t,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t-9","content":"big output"}]}}`)
	pr := &privReader{osUser: "bob", spawn: inProcessChild(t, home, nil)}
	t.Cleanup(pr.close)

	body, _, err := pr.FullResult(p, "t-9")
	if err != nil {
		t.Fatalf("FullResult: %v", err)
	}
	if body != "big output" {
		t.Fatalf("body: %q", body)
	}
}

// One picture is one scan of the whole transcript, and it ships up to about
// half a megabyte back (Read blocks: p95 547k base64 characters). On the shared
// child that would hold every 200 ms tail poll for this user behind it, so each
// picture takes a child of its own, the way the bulk first read does.
func TestPrivReaderImageBlockRunsOnAChildOfItsOwn(t *testing.T) {
	pic := pngOf(t)
	home, p := mkHome(t, imageResultLine("toolu_01readabcd", pic))
	var starts int32
	pr := &privReader{osUser: "bob", spawn: inProcessChild(t, home, &starts)}
	t.Cleanup(pr.close)

	for i := 0; i < 2; i++ {
		got, err := pr.ImageBlock(p, sessionio.ImageAddr{ToolID: "toolu_01readabcd", N: 0})
		if err != nil {
			t.Fatalf("ImageBlock: %v", err)
		}
		if string(got.Data) != string(pic) || got.MediaType != "image/png" {
			t.Fatalf("got %d bytes of %q", len(got.Data), got.MediaType)
		}
	}
	if starts != 2 {
		t.Fatalf("%d child(ren) started for two pictures, want one each", starts)
	}
	pr.mu.Lock()
	shared := pr.child
	pr.mu.Unlock()
	if shared != nil {
		t.Fatal("a picture started the shared child, which the tail polls queue behind")
	}
}

func TestPrivReaderImageBlockSurfacesARefusal(t *testing.T) {
	home, _ := mkHome(t, `{}`)
	pr := &privReader{osUser: "bob", spawn: inProcessChild(t, home, nil)}
	t.Cleanup(pr.close)
	if _, err := pr.ImageBlock("/etc/passwd", sessionio.ImageAddr{ToolID: "toolu_01readabcd"}); err == nil {
		t.Fatal("a refused read must be an error, not an empty picture")
	}
}

// The sudoers grant is written against this exact command line.
func TestPrivReaderSpawnCommandShape(t *testing.T) {
	got := privopCommand("bob", "/usr/local/bin/session-events")
	want := []string{"/usr/bin/sudo", "-n", "-u", "bob", "/usr/local/bin/session-events", "-privop"}
	if len(got) != len(want) {
		t.Fatalf("got %v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v want %v", got, want)
		}
	}
}

var _ = filepath.Join
var _ = io.EOF
var _ = errors.New

// The parent half of the two agent-panel operations, over the real protocol.
func TestPrivReaderReachesAnotherUsersAgentFiles(t *testing.T) {
	home, dir := mkSessionDir(t)
	pr := &privReader{osUser: "bob", spawn: inProcessChild(t, home, nil)}
	t.Cleanup(pr.close)

	files, err := pr.ListAgentFiles(dir)
	if err != nil {
		t.Fatalf("ListAgentFiles: %v", err)
	}
	if len(files) != 6 || files[0].Name != "subagents/agent-a1.jsonl" {
		t.Fatalf("files = %+v", files)
	}
	b, err := pr.ReadSmallFile(filepath.Join(dir, "subagents", "agent-a1.meta.json"))
	if err != nil || !strings.Contains(string(b), `"description":"look"`) {
		t.Fatalf("ReadSmallFile = %q, %v", b, err)
	}
	b, err = pr.ReadSmallFile(filepath.Join(dir, "workflows", "scripts", "check-change-wf_r1.js"))
	if err != nil || !strings.Contains(string(b), "name: 'check-change'") {
		t.Fatalf("ReadSmallFile(the run's script) = %q, %v", b, err)
	}
	if _, err := pr.ReadSmallFile("/etc/passwd"); err == nil {
		t.Fatal("a refused whole read must come back as an error")
	}
}
