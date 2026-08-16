package sessionio

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"sync"
	"time"
)

// maxTranscriptLine bounds one JSONL line when scanning for a payload. A single
// transcript record has been measured at 673 KB on this box; 8 MB leaves room
// without letting a corrupt file consume memory unbounded.
const maxTranscriptLine = 8 << 20

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

// ReplayWindow is Replay for a client OPENING the session: it returns only the
// most recent `turns` turns, so first paint does not depend on how old the
// session is. The largest transcript on this box is 28.9 MB — about 4,900
// events and 5.5 MB of tool results — and a phone should not have to receive
// all of it to read the last thing that happened.
//
// A resume (from > 0) is never windowed. A reconnecting client already holds
// the history and is asking for the gap; clipping that would drop events it can
// never ask for again.
//
// The window is a suffix ending at the live end, and it begins at a turn
// boundary — a view that opened halfway through a turn would show an answer
// with no question. Earlier turns are fetched with Earlier.
func (f *FileSource) ReplayWindow(from int64, turns int) []Event {
	if from > 0 || turns <= 0 {
		return f.Replay(from)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return window(f.logbuf, turns)
}

// Earlier returns the window of `turns` turns immediately BEFORE the event id
// `before` — the "Load earlier" step. Empty once the start of the log is
// reached.
func (f *FileSource) Earlier(before int64, turns int) []Event {
	f.mu.Lock()
	defer f.mu.Unlock()
	var head []Event
	for _, e := range f.logbuf {
		if e.ID >= before {
			break
		}
		head = append(head, e)
	}
	return window(head, turns)
}

// window returns the last `turns` turns of a log slice, starting at a turn
// boundary. Events carrying no turn id at all (session-level meta that arrived
// before the first prompt) belong to no turn and are only included when the
// window reaches the start of the log.
func window(log []Event, turns int) []Event {
	if len(log) == 0 {
		return nil
	}
	seen := map[string]bool{}
	start := 0
	for i := len(log) - 1; i >= 0; i-- {
		id := log[i].TurnID
		if id == "" {
			continue
		}
		if !seen[id] {
			if len(seen) == turns {
				start = i + 1
				break
			}
			seen[id] = true
		}
	}
	out := make([]Event, len(log)-start)
	copy(out, log[start:])
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

// FullResult reads one tool result back off disk in full — what "show full
// output" asks for after MaxInlineResult capped it on the wire. It returns the
// flattened text and the structured form.
//
// It re-reads the transcript rather than holding the payload in memory: the
// whole point of the cap is that a session's results run to megabytes, and
// keeping them for a click that usually never comes would put the memory back
// in a longer-lived place. Transcripts here top out around 29 MB, and this runs
// once per click.
func (f *FileSource) FullResult(toolID string) (string, json.RawMessage, error) {
	if toolID == "" {
		return "", nil, errors.New("full result: no tool id")
	}
	file, err := os.Open(f.path)
	if err != nil {
		return "", nil, err
	}
	defer file.Close()

	sc := bufio.NewScanner(file)
	sc.Buffer(make([]byte, 0, 64<<10), maxTranscriptLine)
	for sc.Scan() {
		line := sc.Bytes()
		// Cheap reject before the JSON decode — most lines are not this one.
		if !bytes.Contains(line, []byte(toolID)) {
			continue
		}
		rec, ok := DecodeRecord(line)
		if !ok {
			continue
		}
		for _, bl := range rec.Blocks() {
			if bl.Type == "tool_result" && bl.ToolUseID == toolID {
				return decodeToolResult(bl.Content), rec.ToolUseResult, nil
			}
		}
	}
	if err := sc.Err(); err != nil {
		return "", nil, err
	}
	return "", nil, fmt.Errorf("full result: no result for tool %q in this transcript", toolID)
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
