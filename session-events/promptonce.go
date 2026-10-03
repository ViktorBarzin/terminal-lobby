package main

import (
	"bytes"
	"context"
	"net/http"
	"regexp"
	"sync"
	"time"
)

// Each first prompt is sent once, however many times it is asked for.
//
// The New-session composer gives its first prompt a request id, and repeats
// the request when an attempt fails or runs past the browser's 8s deadline
// (frontend-v2 lib/http.ts). The server can legitimately take longer than that,
// up to PromptReadyWait for the mod and modAckWait for its ack, and a request
// the browser gave up on left its command queued for the mod regardless. On a
// slow link that sent the prompt twice.
//
// So an attempt with an id runs to its end even when the browser stops
// waiting, and every request carrying the same id is answered by it. An
// attempt that ends in "not yet" (comeBack) is forgotten when it ends, so the
// next request is a fresh attempt; one that sent the prompt, or refused it, is
// remembered for promptOnceTTL.

const (
	// promptOnceTTL is how long a finished attempt answers its id. Longer
	// than the browser's whole retry ladder.
	promptOnceTTL = 2 * time.Minute
	// promptOnceRun bounds an attempt nobody is waiting for any more: the
	// server's own hold and ack waits, with room to spare.
	promptOnceRun = 30 * time.Second
)

var promptIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

type promptOnce struct {
	mu sync.Mutex
	m  map[string]*promptAttempt
}

type promptAttempt struct {
	done   chan struct{}
	ended  time.Time
	status int
	header http.Header
	body   []byte
}

func newPromptOnce() *promptOnce { return &promptOnce{m: map[string]*promptAttempt{}} }

// do answers r with the attempt for key, starting one with run if none is
// running or remembered.
func (p *promptOnce) do(w http.ResponseWriter, r *http.Request, key string, run http.HandlerFunc) {
	now := time.Now()
	p.mu.Lock()
	for k, a := range p.m {
		if !a.ended.IsZero() && now.Sub(a.ended) > promptOnceTTL {
			delete(p.m, k)
		}
	}
	a, ok := p.m[key]
	if !ok {
		a = &promptAttempt{done: make(chan struct{})}
		p.m[key] = a
	}
	p.mu.Unlock()
	if !ok {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), promptOnceRun)
		go func() {
			defer cancel()
			c := &capturedResponse{header: http.Header{}}
			run(c, r.WithContext(ctx))
			p.mu.Lock()
			a.status, a.header, a.body, a.ended = c.code(), c.header, c.buf.Bytes(), time.Now()
			if comeBack(a.status) {
				delete(p.m, key)
			}
			p.mu.Unlock()
			close(a.done)
		}()
	}
	select {
	case <-a.done:
		for k, v := range a.header {
			w.Header()[k] = v
		}
		w.WriteHeader(a.status)
		w.Write(a.body)
	case <-r.Context().Done():
	}
}

// capturedResponse is an attempt's answer, kept to give every request for
// its id.
type capturedResponse struct {
	header http.Header
	status int
	buf    bytes.Buffer
}

func (c *capturedResponse) Header() http.Header { return c.header }

func (c *capturedResponse) WriteHeader(status int) {
	if c.status == 0 {
		c.status = status
	}
}

func (c *capturedResponse) Write(b []byte) (int, error) {
	c.WriteHeader(http.StatusOK)
	return c.buf.Write(b)
}

func (c *capturedResponse) code() int {
	if c.status == 0 {
		return http.StatusOK
	}
	return c.status
}

// comeBack reports an answer that means "not yet", which the browser's ladder
// retries (frontend-v2 lib/first-prompt.ts): the session or its mod is not
// there yet. Such an attempt sent nothing, so it is not remembered. A 504 is
// not one of them: the mod may still submit what it was given.
func comeBack(status int) bool {
	return status == http.StatusServiceUnavailable || status == http.StatusBadGateway || status == http.StatusNotFound
}
