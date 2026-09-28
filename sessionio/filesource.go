package sessionio

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"strconv"
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
// is built on. A consumer that wants the records themselves should use Tail
// directly rather than normalizing and un-normalizing.
type FileSource struct {
	session string
	path    string
	poll    time.Duration

	mu      sync.Mutex
	seq     int64
	logbuf  []Event
	subs    map[int]chan Event
	nextSub int
	// The last pane reading of a blocking question, so only CHANGES are
	// recorded (see SetAsking).
	asking string
	// The question the lobby's hook is holding, so only CHANGES are recorded
	// (see SetHeld).
	held string
	// This source has appended an event a replay of its transcript would not
	// produce, so its ids are its own from then on (see Head).
	diverged bool
	// The two epochs this source can report, fixed at construction: Head runs
	// once per live event per reader, so neither is hashed there.
	epochReplay, epochOwn string

	// norm is written by the tail AND by Interrupt (an HTTP handler), so it has
	// its own lock. Order is always normMu -> mu, never the reverse.
	normMu sync.Mutex
	norm   *Normalizer
	offset int64 // touched only by the Run goroutine

	// How this source reaches the transcript. Fixed at construction and never
	// reassigned, so the Run goroutine reads it without a lock.
	reader Reader
}

// NewFileSource builds a source over one transcript. session is the tmux
// session name, carried on every event; poll is the tail interval used by Run.
func NewFileSource(session, path string, poll time.Duration) *FileSource {
	return NewFileSourceWith(session, path, poll, LocalReader{})
}

// NewFileSourceWith builds a source that reaches its transcript through r. The
// registry uses it to give another OS user's session a reader that can actually
// open their 0750 home, while a session this process owns keeps LocalReader.
func NewFileSourceWith(session, path string, poll time.Duration, r Reader) *FileSource {
	if r == nil {
		r = LocalReader{}
	}
	return &FileSource{
		session: session, path: path, poll: poll,
		subs: map[int]chan Event{}, norm: NewNormalizer(session),
		reader: r, epochReplay: logEpoch(path), epochOwn: logEpoch(path + "\x00" + newNonce()),
	}
}

// newNonce is 8 random bytes in hex. crypto/rand does not fail on Linux; if it
// ever did, the time still tells two sources apart.
func newNonce() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	return hex.EncodeToString(b[:])
}

// NewAgentFileSource is a source over one agent's own transcript,
// agent-<id>.jsonl, which is what the drill-in streams: the same log, cursor
// and backfill as a session's, with the agent's records read as a
// conversation of their own (see NewAgentNormalizer). session is still the tmux
// session name, carried on every event.
func NewAgentFileSource(session, path string, poll time.Duration, r Reader) *FileSource {
	f := NewFileSourceWith(session, path, poll, r)
	f.norm = NewAgentNormalizer(session)
	return f
}

// Path is the transcript this source is tailing. Callers cache sources by tmux
// session NAME, which outlives the Claude session that claimed it, so this is
// how they tell a cached source apart from a stale one.
func (f *FileSource) Path() string { return f.path }

// Append assigns the next global ID, records the event, and fans out to live
// subscribers. Slow subscribers are dropped (they resync via Replay on reconnect).
func (f *FileSource) Append(e Event) {
	f.mu.Lock()
	f.appendLocked(e)
	f.mu.Unlock()
}

// appendLive is Append for an event the transcript does not hold: a pane
// reading, a held question, an interrupt's turn_end. A replay of the same
// transcript never assigns it an id, so every id after it is this source's
// own, and the epoch says so from the same moment (Head).
func (f *FileSource) appendLive(e Event) {
	f.mu.Lock()
	f.diverged = true
	f.appendLocked(e)
	f.mu.Unlock()
}

func (f *FileSource) appendLocked(e Event) {
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

// Subscribers is how many readers are attached right now. The registry uses it
// to decide which sources are worth re-checking against the session map: a
// source nobody is reading can wait for the next request to notice it is stale.
func (f *FileSource) Subscribers() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.subs)
}

// Close retires the source: every live subscription ends, and Subscribe hands
// out no more.
//
// It is what a reader needs to hear when the tmux name it is watching starts
// pointing at a different transcript. Left subscribed to the retired source, a
// browser receives nothing further and shows the conversation frozen at the
// moment of the swap — including a question whose dialog is long gone, since
// the answer was written to the file nobody is tailing any more. Ending the
// stream makes the browser reconnect, which is the whole recovery.
//
// Idempotent, and safe alongside the cancel Subscribe returned: the entry is
// gone by then, so nothing is closed twice. It does NOT stop the tail — the
// registry owns that context — so a source closed by mistake keeps its log
// correct for whoever opens it next.
func (f *FileSource) Close() {
	f.mu.Lock()
	defer f.mu.Unlock()
	for id, ch := range f.subs {
		delete(f.subs, id)
		close(ch)
	}
}

// Head is the newest id in the log and the identity of the LOG ITSELF.
//
// Ids are per-source and deterministic: the same transcript replayed by a new
// process assigns the same ids, which is why a restart costs a reader nothing.
// A DIFFERENT transcript under the same tmux name starts again at 1, and then
// a client holding id 5,000 asks for the gap above it, receives nothing, and
// keeps showing the previous conversation for as long as the tab stays open.
// The epoch is the transcript's identity, so the two cases are distinguishable
// on the wire; the id is there for the narrower case where the same log comes
// back SHORTER.
//
// Replaying a transcript reproduces its ids only while the log holds nothing
// else. A live-only event (appendLive) takes an id no replay assigns, and every
// transcript event after it lands one higher than a rebuilt source would put
// it. The rebuilt log can then be LONGER than a client's cursor with the same
// epoch, and the resume skips whatever sits between the two numberings: found
// live on 2026-09-27, where an answer, a reply and the next prompt vanished
// from a session reopened after its source was dropped. So from the first
// live-only event the epoch also names this source, and a client holding its
// ids resyncs against any other.
func (f *FileSource) Head() (int64, string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var newest int64
	if n := len(f.logbuf); n > 0 {
		newest = f.logbuf[n-1].ID
	}
	return newest, f.epochLocked()
}

func (f *FileSource) epochLocked() string {
	if f.diverged {
		return f.epochOwn
	}
	return f.epochReplay
}

// eventShape names the wire shape events are normalized into. It is part of
// the log's identity: a client holding events normalized under an older shape
// drops them and reopens, the same path a rewritten transcript takes. Bumped
// 2026-09-24, when pictures became references (ImageRef) and tool results
// stopped carrying base64. Without it a device that cached a session before
// that deploy would go on showing base64 bodies and bare "[Image #1]"
// placeholders for as long as the cache holds, up to 2,000 events a session
// (frontend-v2/src/store/transcript-cache.ts). The cost is one full reopen per
// cached session per device, once.
//
// Bumped again 2026-09-28, when a prompt a Stop took back started being marked
// (MetaRewound): a replay of an older transcript now carries markers it did
// not, and the ids after them move.
const eventShape = "2026-09-28-rewound"

// logEpoch names a log by the transcript behind it and the shape its events
// take. Hashed rather than sent as a path: it travels to the browser, and the
// identity is all the browser needs.
func logEpoch(path string) string { return logEpochFor(eventShape, path) }

// logEpochFor is logEpoch under an explicit shape, so a test can vary it.
func logEpochFor(shape, path string) string {
	sum := sha256.Sum256([]byte(shape + "\x00" + path))
	return hex.EncodeToString(sum[:8])
}

// SetAsking records what the PANE shows about a blocking question — the JSON of
// a Dialog, or "" when there is none — and returns whether that CHANGED.
//
// A change appends one meta event, which is how the reading reaches a client:
// the newest one wins, exactly as the mode and the /context reading do. A
// dialog can sit on screen for minutes, so recording only changes is what keeps
// a watcher off the log.
func (f *FileSource) SetAsking(body string) bool {
	f.mu.Lock()
	if body == f.asking {
		f.mu.Unlock()
		return false
	}
	f.asking = body
	f.mu.Unlock()

	e := Event{Kind: KindMeta, Meta: MetaAsking, Body: body, At: time.Now().UnixMilli()}
	f.appendLive(e)
	return true
}

// SetHeld records the question the lobby's hook is holding for this session —
// `{"questions": [...]}`, or "" once the hold has ended — and returns whether
// that CHANGED. It reaches a client the way SetAsking's reading does, as one
// meta event per change.
func (f *FileSource) SetHeld(body string) bool {
	f.mu.Lock()
	if body == f.held {
		f.mu.Unlock()
		return false
	}
	f.held = body
	f.mu.Unlock()

	e := Event{Kind: KindMeta, Meta: MetaHeld, Body: body, At: time.Now().UnixMilli()}
	f.appendLive(e)
	return true
}

// WorthWatching reports whether reading this session's pane could tell anyone
// anything: somebody is reading the stream, and the last turn has not settled.
//
// Both halves bound a cost that is otherwise paid per session per tick — a tmux
// subprocess, and for another user's session a sudo one. A session nobody has
// open needs no pane reading, and a settled turn cannot be sitting on a dialog:
// the question is asked mid-turn, and answering it is what lets the turn end.
func (f *FileSource) WorthWatching() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.subs) == 0 || len(f.logbuf) == 0 {
		return false
	}
	// Past the watcher's OWN events: withdrawing a reading appends one, and
	// counting that as "something happened" would make every settled session
	// look like it was working again — and be polled for the rest of its life.
	for i := len(f.logbuf) - 1; i >= 0; i-- {
		e := f.logbuf[i]
		if e.Kind == KindMeta && (e.Meta == MetaAsking || e.Meta == MetaHeld) {
			continue
		}
		return e.Kind != KindTurnEnd
	}
	return false
}

// TailOnce consumes whatever the transcript has gained since the last read.
// Run calls it on a ticker; tests call it directly.
func (f *FileSource) TailOnce() {
	lines, next, err := f.reader.ReadFrom(f.path, f.offset)
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
	return f.reader.FullResult(f.path, toolID)
}

// ImageBlock reads one picture back off disk, through the source's reader: a
// transcript this process cannot open is scanned by a child running as its
// owner, exactly as FullResult is. Nothing is cached here; the route's
// immutable cache header is what keeps a picture from being read twice by the
// same device.
func (f *FileSource) ImageBlock(addr ImageAddr) (ImageData, error) {
	return f.reader.ImageBlock(f.path, addr)
}

// Interrupt records an operator interrupt on this session at `at` (epoch ms)
// and streams the turn_end it implies, if a turn was open. An interrupt that
// lands before Claude's first token leaves nothing in the transcript, so this
// is the only way the renderer learns the turn is over (see Normalizer.Interrupt).
func (f *FileSource) Interrupt(at int64) {
	f.normMu.Lock()
	defer f.normMu.Unlock()
	e, ok := f.norm.Interrupt(at)
	if ok {
		f.appendLive(e)
		return
	}
	// Nothing to append, but the normalizer now settles the next prompt at
	// or before `at` as it opens, which a replay would not: the numbering is
	// this source's own either way.
	f.mu.Lock()
	f.diverged = true
	f.mu.Unlock()
}

// Rewind records that the prompt `text` went back to the session's input line
// at `at` (epoch ms), and streams the marker that takes it out of the
// conversation (Normalizer.Rewind). When the tail has not read the prompt's
// record yet, the record is marked as it arrives, which a replay would not do.
func (f *FileSource) Rewind(text string, at int64) {
	f.normMu.Lock()
	defer f.normMu.Unlock()
	evs := f.norm.Rewind(text, at)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.diverged = true
	for _, e := range evs {
		f.appendLocked(e)
	}
}

// RestoreRewound streams the marker for a prompt a Stop took back before this
// source existed, when the transcript read so far ends on it
// (Normalizer.RestoreRewound). Called once the first read is done, with the
// session's OptionRewound; a stamp that names nothing appends nothing.
func (f *FileSource) RestoreRewound(stamp string) {
	f.normMu.Lock()
	defer f.normMu.Unlock()
	for _, e := range f.norm.RestoreRewound(stamp) {
		f.appendLive(e)
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
