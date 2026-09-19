package main

import (
	"errors"
	"sync"
	"time"
)

// fakeSessions stands in for tmux.
//
// It is the reason no test in this package touches a real tmux server. Every
// session on the devvm is somebody's live conversation, and a test that
// pasted into one would look exactly like the bug this whole service has to
// avoid — so the boundary is faked and the handlers never learn the
// difference.
//
// Safe for concurrent use: the runner drives it from its own goroutines while
// a test reads the recordings from the test goroutine.
type fakeSessions struct {
	mu sync.Mutex

	// live is the tmux server's state, keyed by "<osUser>/<session>".
	live map[string]*LiveSession
	// transcripts are the .jsonl lines each session's Claude has written.
	transcripts map[string][][]byte
	// panes are what capture-pane would return.
	panes map[string]string

	// Recordings, for assertions.
	prompts          []promptCall
	promptsUncleared []promptCall
	cancels          []string
	created          []CreateSpec
	readyCalls       int

	// Faults a test can arm.
	listErr   error
	createErr error
	promptErr error
	cancelErr error
	readyErr  error
	// readyBlock, when set, holds WaitReady until it is closed, so a test can
	// cancel a task while the harness is still coming up.
	readyBlock    chan struct{}
	noTranscript  map[string]bool
	transcriptErr error

	// onPrompt runs (holding the lock) right after a prompt is recorded, so a
	// test can make the fake behave like a session that starts working.
	onPrompt func(f *fakeSessions, key string)
}

type promptCall struct{ OSUser, Session, Text string }

func newFakeSessions() *fakeSessions {
	return &fakeSessions{
		live:         map[string]*LiveSession{},
		transcripts:  map[string][][]byte{},
		panes:        map[string]string{},
		noTranscript: map[string]bool{},
	}
}

func key(osUser, session string) string { return osUser + "/" + session }

// start adds a live session.
func (f *fakeSessions) start(osUser string, s LiveSession) *fakeSessions {
	f.mu.Lock()
	defer f.mu.Unlock()
	copied := s
	f.live[key(osUser, s.Name)] = &copied
	return f
}

// setState changes @claude_state on a live session.
func (f *fakeSessions) setState(osUser, session, state string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.setStateLocked(key(osUser, session), state)
}

func (f *fakeSessions) setStateLocked(k, state string) {
	if s := f.live[k]; s != nil {
		s.State = state
	}
}

// setTranscript replaces a session's transcript lines.
func (f *fakeSessions) setTranscript(osUser, session string, lines ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.setTranscriptLocked(key(osUser, session), lines...)
}

func (f *fakeSessions) setTranscriptLocked(k string, lines ...string) {
	raw := make([][]byte, 0, len(lines))
	for _, l := range lines {
		raw = append(raw, []byte(l))
	}
	f.transcripts[k] = raw
}

// appendTranscript adds lines to a session's transcript, as a running turn
// does.
func (f *fakeSessions) appendTranscript(osUser, session string, lines ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.appendTranscriptLocked(key(osUser, session), lines...)
}

func (f *fakeSessions) appendTranscriptLocked(k string, lines ...string) {
	for _, l := range lines {
		f.transcripts[k] = append(f.transcripts[k], []byte(l))
	}
}

// rename models tmux-api's autotitle: the session keeps its options,
// including @tl_born, and answers to a new name.
func (f *fakeSessions) rename(osUser, from, to string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	k := key(osUser, from)
	s := f.live[k]
	if s == nil {
		return
	}
	delete(f.live, k)
	if t, ok := f.transcripts[k]; ok {
		f.transcripts[key(osUser, to)] = t
		delete(f.transcripts, k)
	}
	if p, ok := f.panes[k]; ok {
		f.panes[key(osUser, to)] = p
		delete(f.panes, k)
	}
	s.Name = to
	f.live[key(osUser, to)] = s
}

func (f *fakeSessions) setPane(osUser, session, pane string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.panes[key(osUser, session)] = pane
}

func (f *fakeSessions) promptCalls() []promptCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]promptCall(nil), f.prompts...)
}

func (f *fakeSessions) cancelCalls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.cancels...)
}

func (f *fakeSessions) createCalls() []CreateSpec {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]CreateSpec(nil), f.created...)
}

// --- the Sessions interface ---

func (f *fakeSessions) List(osUser string) ([]LiveSession, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.listErr != nil {
		return nil, f.listErr
	}
	prefix := osUser + "/"
	var out []LiveSession
	for k, s := range f.live {
		if len(k) > len(prefix) && k[:len(prefix)] == prefix {
			out = append(out, *s)
		}
	}
	// Stable order, so a test can assert on a list rather than a set.
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].Name < out[j-1].Name; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out, nil
}

func (f *fakeSessions) Create(spec CreateSpec) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.created = append(f.created, spec)
	if f.createErr != nil {
		return f.createErr
	}
	k := key(spec.OSUser, spec.Name)
	if _, taken := f.live[k]; taken {
		return errors.New("duplicate session: " + spec.Name)
	}
	f.live[k] = &LiveSession{Name: spec.Name, Dir: spec.Dir}
	return nil
}

// promptsUncleared records the messages sent WITHOUT the line-clearing
// prelude, so a test can assert which route a turn took.
func (f *fakeSessions) PromptUncleared(osUser, session, text string) error {
	f.mu.Lock()
	f.promptsUncleared = append(f.promptsUncleared, promptCall{osUser, session, text})
	f.mu.Unlock()
	return f.Prompt(osUser, session, text)
}

func (f *fakeSessions) Prompt(osUser, session, text string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.prompts = append(f.prompts, promptCall{osUser, session, text})
	if f.promptErr != nil {
		return f.promptErr
	}
	if f.onPrompt != nil {
		f.onPrompt(f, key(osUser, session))
	}
	return nil
}

func (f *fakeSessions) Cancel(osUser, session string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cancels = append(f.cancels, key(osUser, session))
	return f.cancelErr
}

func (f *fakeSessions) Option(osUser, session, name string) (string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s, ok := f.live[key(osUser, session)]
	if !ok {
		return "", false
	}
	switch name {
	case OptionOwner:
		return s.Owner, true
	case OptionSuspended:
		if s.Suspended {
			return "1700000000", true
		}
		return "", true
	case "@claude_state":
		return s.State, true
	case "@claude_transcript":
		return s.Transcript, true
	case "@title":
		return s.Title, true
	case "@tl_born":
		return s.BornAs, true
	}
	return "", true
}

func (f *fakeSessions) SetOption(osUser, session, name, value string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	s, ok := f.live[key(osUser, session)]
	if !ok {
		return errors.New("can't find session: " + session)
	}
	switch name {
	case OptionOwner:
		s.Owner = value
	case "@claude_state":
		s.State = value
	case "@title":
		s.Title = value
	case "@tl_born":
		s.BornAs = value
	}
	return nil
}

func (f *fakeSessions) TranscriptLines(osUser, session string) ([][]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.transcriptErr != nil {
		return nil, f.transcriptErr
	}
	k := key(osUser, session)
	if f.noTranscript[k] {
		return nil, errNoTranscript
	}
	if _, ok := f.live[k]; !ok {
		return nil, errNoTranscript
	}
	return append([][]byte(nil), f.transcripts[k]...), nil
}

// readyCalls counts WaitReady, so a test can prove the wait happened.
func (f *fakeSessions) readyCallCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.readyCalls
}

func (f *fakeSessions) WaitReady(osUser, session string, wait, poll time.Duration) error {
	f.mu.Lock()
	f.readyCalls++
	block, err := f.readyBlock, f.readyErr
	f.mu.Unlock()
	if block != nil {
		<-block
	}
	return err
}

func (f *fakeSessions) Pane(osUser, session string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.panes[key(osUser, session)], nil
}
