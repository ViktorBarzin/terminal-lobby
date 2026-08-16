package sessionio

import (
	"context"
	"log"
	"sync"
	"time"
)

// FileSource is an Event stream backed by a Claude transcript file plus
// injected events (permissions). It maintains one append-only in-memory log
// under a single monotonic ID space, so transcript-derived and hook-derived
// events resume from one cursor. Tailing runs in Run(); injected events arrive
// via Append().
//
// This is the Event-level reader, above Tail: it is what the lobby's SSE stream
// is built on. A consumer that wants the records themselves — the T3 bridge —
// should use Tail directly rather than normalizing and un-normalizing.
type FileSource struct {
	session string
	path    string
	poll    time.Duration

	mu      sync.Mutex
	seq     int64
	logbuf  []Event
	subs    map[int]chan Event
	nextSub int

	// norm is written by the tail AND by Interrupt (an HTTP handler), so it has
	// its own lock. Order is always normMu -> mu, never the reverse.
	normMu sync.Mutex
	norm   *Normalizer
	offset int64 // touched only by the Run goroutine
}

// NewFileSource builds a source over one transcript. session is the tmux
// session name, carried on every event; poll is the tail interval used by Run.
func NewFileSource(session, path string, poll time.Duration) *FileSource {
	return &FileSource{
		session: session, path: path, poll: poll,
		subs: map[int]chan Event{}, norm: NewNormalizer(session),
	}
}

// Path is the transcript this source is tailing. Callers cache sources by tmux
// session NAME, which outlives the Claude session that claimed it, so this is
// how they tell a cached source apart from a stale one.
func (f *FileSource) Path() string { return f.path }

// Append assigns the next global ID, records the event, and fans out to live
// subscribers. Slow subscribers are dropped (they resync via Replay on reconnect).
func (f *FileSource) Append(e Event) {
	f.mu.Lock()
	f.seq++
	e.ID = f.seq
	e.Session = f.session
	f.logbuf = append(f.logbuf, e)
	for id, ch := range f.subs {
		select {
		case ch <- e:
		default:
			log.Printf("FileSource[%s]: subscriber %d slow, dropped id %d (will resync)", f.session, id, e.ID)
		}
	}
	f.mu.Unlock()
}

// Replay returns every event with an ID greater than `from` (0 = from the start).
func (f *FileSource) Replay(from int64) []Event {
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

// Subscribe returns a channel of live events and a cancel func that releases
// the subscription.
func (f *FileSource) Subscribe() (<-chan Event, func()) {
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

// TailOnce consumes whatever the transcript has gained since the last read.
// Run calls it on a ticker; tests call it directly.
func (f *FileSource) TailOnce() {
	lines, next, err := ReadFrom(f.path, f.offset)
	if err != nil {
		return // transcript may not exist yet; try again next tick
	}
	f.offset = next
	f.normMu.Lock()
	defer f.normMu.Unlock()
	for _, ln := range lines {
		for _, e := range f.norm.Line([]byte(ln)) {
			f.Append(e)
		}
	}
}

// Interrupt records an operator interrupt on this session at `at` (epoch ms)
// and streams the turn_end it implies, if a turn was open. An interrupt that
// lands before Claude's first token leaves nothing in the transcript, so this
// is the only way the renderer learns the turn is over (see Normalizer.Interrupt).
func (f *FileSource) Interrupt(at int64) {
	f.normMu.Lock()
	defer f.normMu.Unlock()
	if e, ok := f.norm.Interrupt(at); ok {
		f.Append(e)
	}
}

// Run tails the transcript until ctx is cancelled.
func (f *FileSource) Run(ctx context.Context) {
	t := time.NewTicker(f.poll)
	defer t.Stop()
	f.TailOnce()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			f.TailOnce()
		}
	}
}
