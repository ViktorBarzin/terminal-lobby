package main

import (
	"context"
	"log"
	"sync"
	"time"
)

// fileSource is a Source backed by a Claude transcript file plus injected events
// (permissions). It maintains one append-only in-memory log under a single
// monotonic ID space, so transcript-derived and hook-derived events resume from
// one cursor. Tailing runs in Run(); permission events arrive via Append().
type fileSource struct {
	session string
	path    string
	poll    time.Duration

	mu      sync.Mutex
	seq     int64
	logbuf  []Event
	subs    map[int]chan Event
	nextSub int

	norm   *Normalizer
	offset int64 // touched only by the Run goroutine
}

func newFileSource(session, path string, poll time.Duration) *fileSource {
	return &fileSource{
		session: session, path: path, poll: poll,
		subs: map[int]chan Event{}, norm: NewNormalizer(session),
	}
}

// Append assigns the next global ID, records the event, and fans out to live
// subscribers. Slow subscribers are dropped (they resync via Replay on reconnect).
func (f *fileSource) Append(e Event) {
	f.mu.Lock()
	f.seq++
	e.ID = f.seq
	e.Session = f.session
	f.logbuf = append(f.logbuf, e)
	for id, ch := range f.subs {
		select {
		case ch <- e:
		default:
			log.Printf("fileSource[%s]: subscriber %d slow, dropped id %d (will resync)", f.session, id, e.ID)
		}
	}
	f.mu.Unlock()
}

// subscriberCount reports how many live SSE clients are attached — used to decide
// whether a permission request waits for the web or falls through to the terminal.
func (f *fileSource) subscriberCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.subs)
}

func (f *fileSource) Replay(from int64) []Event {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []Event
	for _, e := range f.logbuf {
		if e.ID > from {
			out = append(out, e)
		}
	}
	return out
}

func (f *fileSource) Subscribe() (<-chan Event, func()) {
	f.mu.Lock()
	defer f.mu.Unlock()
	id := f.nextSub
	f.nextSub++
	ch := make(chan Event, 512)
	f.subs[id] = ch
	return ch, func() {
		f.mu.Lock()
		if c, ok := f.subs[id]; ok {
			delete(f.subs, id)
			close(c)
		}
		f.mu.Unlock()
	}
}

func (f *fileSource) tailOnce() {
	lines, next, err := ReadFrom(f.path, f.offset)
	if err != nil {
		return // transcript may not exist yet; try again next tick
	}
	f.offset = next
	for _, ln := range lines {
		for _, e := range f.norm.Line([]byte(ln)) {
			f.Append(e)
		}
	}
}

// Run tails the transcript until ctx is cancelled.
func (f *fileSource) Run(ctx context.Context) {
	t := time.NewTicker(f.poll)
	defer t.Stop()
	f.tailOnce()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			f.tailOnce()
		}
	}
}
