package main

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"terminal-lobby/sessionio"
)

// gatedReader is a sessionio.Reader that holds ReadFrom open for one transcript
// until a test releases it, and answers every other transcript immediately. It
// is how a slow first read is expressed without a slow disk.
type gatedReader struct {
	slowPath string
	entered  chan struct{}
	release  chan struct{}
	once     sync.Once
	// fullReads counts reads from offset 0 — the whole-transcript parse. The
	// tail's own reads resume from the offset that one left behind and cost a
	// stat, so they are not what this measures.
	fullReads atomic.Int64
	under     sessionio.Reader
}

func (g *gatedReader) ReadFrom(path string, off int64) ([]string, int64, error) {
	if off == 0 {
		g.fullReads.Add(1)
	}
	if path == g.slowPath {
		g.once.Do(func() { close(g.entered) })
		<-g.release
	}
	return g.under.ReadFrom(path, off)
}

func (g *gatedReader) FullResult(path, toolID string) (string, json.RawMessage, error) {
	return g.under.FullResult(path, toolID)
}

func (g *gatedReader) SearchResults(path, q string, limit int) ([]sessionio.ResultMatch, error) {
	return g.under.SearchResults(path, q, limit)
}

func (g *gatedReader) ImageBlock(path string, addr sessionio.ImageAddr) (sessionio.ImageData, error) {
	return g.under.ImageBlock(path, addr)
}

// gatedServe is servePrivop with a hold on the bulk read, so a test can keep a
// first read open while a poll read is issued on the same privReader.
func gatedServe(in io.Reader, out io.Writer, home string, entered chan<- struct{}, release <-chan struct{}) {
	dec := json.NewDecoder(in)
	enc := json.NewEncoder(out)
	root := filepath.Join(home, ".claude", "projects")
	var once sync.Once
	for {
		var req privRequest
		if err := dec.Decode(&req); err != nil {
			return
		}
		if req.Op == "readfrom" && req.Off == 0 {
			once.Do(func() { close(entered) })
			<-release
		}
		if err := enc.Encode(handlePrivop(req, home, root)); err != nil {
			return
		}
	}
}

func gatedSpawn(home string, entered chan struct{}, release chan struct{}, spawns *atomic.Int64) func() (*privChild, error) {
	return func() (*privChild, error) {
		spawns.Add(1)
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
			gatedServe(toChild, fromChild, home, entered, release)
		}()
		return newPrivChild(toParent, fromParent, func() error {
			fromParent.Close()
			toParent.Close()
			return nil
		}), nil
	}
}

// The second contention point. privReader holds one child per user behind one
// mutex because the protocol is one request and one answer on a shared pipe.
// That suits the 200 ms tail polls it was written for, which return only the
// bytes appended since the last offset — but the FIRST read returns the whole
// transcript, and while it does, every other read for that user waits.
// session-events runs as one user and emo's home is 0750, so every one of his
// reads crosses this boundary and the service's own user's reads do not.
func TestBulkReadDoesNotHoldUpPolls(t *testing.T) {
	home, path := mkHome(t, `{"type":"user","message":{"role":"user","content":"x"}}`)
	entered, release := make(chan struct{}), make(chan struct{})
	var spawns atomic.Int64
	pr := &privReader{osUser: "bob", spawn: gatedSpawn(home, entered, release, &spawns)}
	t.Cleanup(pr.close)

	bulkDone := make(chan struct{})
	go func() {
		defer close(bulkDone)
		pr.ReadFrom(path, 0)
	}()

	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the bulk read never reached the child")
	}

	pollDone := make(chan error, 1)
	go func() {
		_, _, err := pr.ReadFrom(path, 1)
		pollDone <- err
	}()

	select {
	case err := <-pollDone:
		if err != nil {
			t.Fatalf("poll read: %v", err)
		}
	case <-time.After(3 * time.Second):
		close(release)
		<-bulkDone
		t.Fatal("a poll read queued behind the bulk read on the shared pipe")
	}

	close(release)
	<-bulkDone
}

// A transcript crosses the privop boundary as one blob, not as a JSON array of
// per-line strings. The parent splits it. At 39 MB the array form escapes and
// allocates every line twice, once in the child encoding it and once in the
// parent decoding it, before the normalizer parses each line a third time.
func TestBulkReadCrossesAsOneBlob(t *testing.T) {
	home, path := mkHome(t,
		`{"type":"user","message":{"role":"user","content":"one"}}`+"\n"+
			`{"type":"user","message":{"role":"user","content":"two"}}`)
	root := filepath.Join(home, ".claude", "projects")

	resp := handlePrivop(privRequest{Op: "readfrom", Path: path, Off: 0}, home, root)
	if !resp.OK {
		t.Fatalf("readfrom refused: %s", resp.Err)
	}
	if len(resp.Lines) != 0 {
		t.Fatalf("readfrom still answers with %d per-line strings; it must carry a blob", len(resp.Lines))
	}
	if len(resp.Blob) == 0 {
		t.Fatal("readfrom carried no blob")
	}

	pr := &privReader{osUser: "bob", spawn: inProcessChild(t, home, nil)}
	t.Cleanup(pr.close)
	lines, next, err := pr.ReadFrom(path, 0)
	if err != nil {
		t.Fatalf("ReadFrom: %v", err)
	}
	want, wantNext, err := sessionio.LocalReader{}.ReadFrom(path, 0)
	if err != nil {
		t.Fatal(err)
	}
	if next != wantNext {
		t.Fatalf("offset = %d, want %d", next, wantNext)
	}
	if len(lines) != len(want) {
		t.Fatalf("got %d lines, want %d", len(lines), len(want))
	}
	for i := range want {
		if lines[i] != want[i] {
			t.Fatalf("line %d = %q, want %q", i, lines[i], want[i])
		}
	}
}
