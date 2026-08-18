package main

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
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

	// A second read on the same child: the point of holding it open.
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

	if _, _, err := pr.ReadFrom(p, 0); err != nil {
		t.Fatalf("first read: %v", err)
	}
	pr.mu.Lock()
	pr.child.stop()
	pr.mu.Unlock()

	if _, _, err := pr.ReadFrom(p, 0); err != nil {
		t.Fatalf("read after the child died: %v", err)
	}
	if starts < 2 {
		t.Fatalf("expected a replacement child, saw %d start(s)", starts)
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

// The sudoers grant is written against this exact command line.
func TestPrivReaderSpawnCommandShape(t *testing.T) {
	got := privopCommand("bob", "/usr/local/bin/session-events")
	want := []string{"sudo", "-n", "-u", "bob", "/usr/local/bin/session-events", "-privop"}
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
