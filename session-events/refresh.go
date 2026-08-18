package main

import (
	"log"
	"sync"

	"terminal-lobby/sessionio"
)

// Keeping the context meter current.
//
// A `/context` reading exists only because somebody ran `/context`, so a meter
// that only ever showed what happened to be in the transcript would be blank for
// almost every session. This runs it — on open, and again each time a turn
// settles — so the number is current at the moment a reader looks at a finished
// turn, which is when it gets read.
//
// It is the one thing in this service that writes to a pane on its own schedule
// rather than because somebody clicked, so its whole design is about not
// reaching further than it should:
//
//   - Only while a text viewer is ATTACHED. A session nobody is watching is
//     never touched. This is the reach lesson of 575d4f5: what made the removed
//     permission broker costly was not its logic but that it acted on every
//     session on a shared box, including the ones nobody had open.
//   - Only once per SESSION, not once per viewer. Three devices watching one
//     session produce one command in its pane, not three.
//   - Only when @claude_state is `done`. `running` would queue the command as a
//     prompt and run it after the work; `awaiting` means something is blocking
//     on a human, and typing there would answer it.
//   - Only when the composer is EMPTY. Prompt clears the input line before it
//     types, so a refresh landing on an unsent draft would delete it. The check
//     fails closed (see sessionio.PaneComposerEmpty).
//
// Running `/context` does not open a turn: the CLI records the invocation as a
// `system` record and the output as an isMeta user record, neither of which the
// turn model treats as a prompt. So this cannot feed itself.
type paneOps interface {
	State(osUser, session string) string
	CapturePane(osUser, session string) (string, error)
	Prompt(osUser, session, text string) error
}

// refreshCommand is what gets typed. It is a display command: it prints the
// reading and changes nothing about the conversation.
const refreshCommand = "/context"

type refresher struct {
	ops paneOps

	mu       sync.Mutex
	watchers map[string]int   // key -> attached text viewers
	lastTurn map[string]int64 // key -> the turn_end id already refreshed on

	// wg tracks refreshes in flight. A refresh talks to tmux, so it runs off
	// the request goroutine; the tests wait on this rather than on a clock.
	wg sync.WaitGroup
}

func newRefresher(ops paneOps) *refresher {
	return &refresher{ops: ops, watchers: map[string]int{}, lastTurn: map[string]int64{}}
}

func watchKey(osUser, session string) string { return osUser + "\x00" + session }

// attach registers a text viewer. The FIRST viewer of a session gets a reading
// straight away, so the meter has something current when the view opens.
func (r *refresher) attach(osUser, session string) {
	if r == nil {
		return
	}
	r.mu.Lock()
	key := watchKey(osUser, session)
	first := r.watchers[key] == 0
	r.watchers[key]++
	r.mu.Unlock()

	if first {
		r.dispatch(osUser, session)
	}
}

// detach releases a viewer. Once the last one goes, the session stops being
// refreshed at all.
func (r *refresher) detach(osUser, session string) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	key := watchKey(osUser, session)
	if n := r.watchers[key]; n <= 1 {
		delete(r.watchers, key)
	} else {
		r.watchers[key] = n - 1
	}
}

// turnSettled is called when a turn ends, with the id of the turn_end event.
// It refreshes only if somebody is watching this session, and only once per
// turn: every attached viewer sees the same turn_end on its own stream, so
// without the id three devices watching would put three commands in the pane
// for one finished turn.
func (r *refresher) turnSettled(osUser, session string, eventID int64) {
	if r == nil {
		return
	}
	key := watchKey(osUser, session)
	r.mu.Lock()
	watched := r.watchers[key] > 0
	fresh := eventID > r.lastTurn[key]
	if watched && fresh {
		r.lastTurn[key] = eventID
	}
	r.mu.Unlock()
	if watched && fresh {
		r.dispatch(osUser, session)
	}
}

// dispatch runs one refresh off the calling goroutine — it shells out to tmux
// three times, which has no business sitting in the path of an HTTP handler.
func (r *refresher) dispatch(osUser, session string) {
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		r.refresh(osUser, session)
	}()
}

// wait blocks until every dispatched refresh has finished. Tests only.
func (r *refresher) wait() { r.wg.Wait() }

// refresh applies every guard and, if they all hold, runs the command.
func (r *refresher) refresh(osUser, session string) {
	if r.ops.State(osUser, session) != sessionio.StateDone {
		return
	}
	pane, err := r.ops.CapturePane(osUser, session)
	if err != nil {
		// Unreadable is not empty. Skipping costs a reading; guessing could
		// cost somebody's draft.
		return
	}
	if !sessionio.PaneComposerEmpty(pane) {
		return
	}
	if err := r.ops.Prompt(osUser, session, refreshCommand); err != nil {
		log.Printf("context refresh %s/%s: %v", osUser, session, err)
	}
}
