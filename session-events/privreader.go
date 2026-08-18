package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"strings"
	"sync"

	"terminal-lobby/sessionio"
)

// privReader is the parent half of the privileged read path: a sessionio.Reader
// that answers by asking a child process running AS the target user.
//
// One child per user, held open. The tail polls every 200 ms, so a process per
// operation — file-api's shape, which suits its one-shot requests — would mean a
// fork every 200 ms for every open session. The child is started on first use
// and replaced if it dies; nothing schedules or reaps it otherwise.
//
// Requests are serialized by mu. The protocol is one request and one response at
// a time on a shared pipe, and the reads it carries are already cheap: a poll
// returns only the bytes appended since the last offset.
type privReader struct {
	osUser string
	spawn  func() (*privChild, error)

	mu    sync.Mutex
	child *privChild
}

// privChild is one live child: the encoder that reaches it, the decoder that
// reads its answers, and the way to shut it down.
type privChild struct {
	enc  *json.Encoder
	dec  *json.Decoder
	stop func() error
}

func newPrivChild(r io.Reader, w io.Writer, stop func() error) *privChild {
	return &privChild{enc: json.NewEncoder(w), dec: json.NewDecoder(r), stop: stop}
}

// newPrivReader builds the reader for one OS user, spawning through sudo.
func newPrivReader(osUser string) *privReader {
	return &privReader{
		osUser: osUser,
		spawn:  func() (*privChild, error) { return sudoChild(osUser) },
	}
}

// privopCommand is the exact command line the sudoers grant is written against.
// Kept as a function so the test and the deployment note cannot drift apart.
func privopCommand(osUser, exe string) []string {
	return []string{"sudo", "-n", "-u", osUser, exe, "-privop"}
}

func sudoChild(osUser string) (*privChild, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("privreader: locating this binary: %w", err)
	}
	// A deploy replaces the binary under the running process, and Linux then
	// reports the old path with this suffix. The service is restarted right
	// after, so this only covers the window in between — but sudo would reject
	// the decorated path against a grant written for the real one, which reads
	// as a permission problem rather than a stale process.
	exe = strings.TrimSuffix(exe, " (deleted)")
	argv := privopCommand(osUser, exe)
	cmd := exec.Command(argv[0], argv[1:]...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	// The child's stderr is the service's: a refusal or a sudo failure belongs
	// in the journal, where the rest of this service's diagnostics already are.
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("privreader: starting a reader for %s: %w", osUser, err)
	}
	return newPrivChild(stdout, stdin, func() error {
		stdin.Close()
		if cmd.Process != nil {
			cmd.Process.Kill()
		}
		return cmd.Wait()
	}), nil
}

// do runs one operation, starting a child if there is none and replacing one
// that has died. A dead child is ordinary — the service is restarted on every
// deploy — so it costs a retry, not an error.
func (p *privReader) do(req privRequest) (privResponse, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		if p.child == nil {
			c, err := p.spawn()
			if err != nil {
				return privResponse{}, err
			}
			p.child = c
		}
		resp, err := p.child.roundTrip(req)
		if err == nil {
			if !resp.OK {
				// A refusal is an answer, not a broken pipe: keep the child.
				return resp, errors.New(resp.Err)
			}
			return resp, nil
		}
		lastErr = err
		p.dropChild()
	}
	return privResponse{}, fmt.Errorf("privreader: %s: %w", p.osUser, lastErr)
}

func (c *privChild) roundTrip(req privRequest) (privResponse, error) {
	if err := c.enc.Encode(req); err != nil {
		return privResponse{}, err
	}
	var resp privResponse
	if err := c.dec.Decode(&resp); err != nil {
		return privResponse{}, err
	}
	return resp, nil
}

// dropChild shuts the current child down. Caller holds mu.
func (p *privReader) dropChild() {
	if p.child == nil {
		return
	}
	if err := p.child.stop(); err != nil {
		// Expected when we killed it; worth a line only at the level that
		// already carries this service's operational noise.
		log.Printf("privreader: %s: child exited: %v", p.osUser, err)
	}
	p.child = nil
}

func (p *privReader) close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.dropChild()
}

// ReadFrom implements sessionio.Reader.
func (p *privReader) ReadFrom(path string, off int64) ([]string, int64, error) {
	resp, err := p.do(privRequest{Op: "readfrom", Path: path, Off: off})
	if err != nil {
		return nil, off, err
	}
	return resp.Lines, resp.Next, nil
}

// FullResult implements sessionio.Reader.
func (p *privReader) FullResult(path, toolID string) (string, json.RawMessage, error) {
	resp, err := p.do(privRequest{Op: "fullresult", Path: path, ToolID: toolID})
	if err != nil {
		return "", nil, err
	}
	return resp.Body, resp.Result, nil
}

// SearchResults implements sessionio.Reader.
func (p *privReader) SearchResults(path, q string, limit int) ([]sessionio.ResultMatch, error) {
	resp, err := p.do(privRequest{Op: "search", Path: path, Query: q, Limit: limit})
	if err != nil {
		return nil, err
	}
	return resp.Matches, nil
}

// Catalogue is the slash-command list, discovered inside the user's own home.
func (p *privReader) Catalogue(cwd string) ([]Command, error) {
	resp, err := p.do(privRequest{Op: "catalogue", CWD: cwd})
	if err != nil {
		return nil, err
	}
	return resp.Commands, nil
}

var _ sessionio.Reader = (*privReader)(nil)
