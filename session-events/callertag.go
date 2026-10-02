package main

import (
	"sync"
	"time"

	"terminal-lobby/sessionio"
)

// Tagging a Caller's events (CONTEXT.md: Origin).
//
// A session a Caller made is recorded in the usage record with tl.caller set
// to the Caller's name, so a query over a person's usage can leave a program's
// turns out and a query over Muse's can find them. tmux-api tags its own events
// from the session list it already holds; this service holds no list, so it
// reads the one tmux option it needs and remembers the answer.
//
// The origin is read through sessionio.CallerOf, the rule tmux-api uses too.
// tmux-api's reserved name prefixes are not repeated here: a reserved-name
// session stamped by a Caller does not occur in practice, and tagging one would
// cost a query nothing.

// callerTagTTL is how long one read of a session's origin answers for. An
// origin changes only when somebody drags a session out of its Caller's group,
// so a minute is the longest a rescued session goes on being tagged.
const callerTagTTL = time.Minute

// callerTagSweepAt is the memo size at which expired entries are dropped.
const callerTagSweepAt = 512

// originReader is the half of sessionio.Injector the tag needs.
type originReader interface {
	Option(osUser, session, name string) (string, bool)
}

type callerTag struct {
	caller string
	at     time.Time
}

type callerTags struct {
	in   originReader
	now  func() time.Time
	mu   sync.Mutex
	seen map[string]callerTag
}

func newCallerTags(in originReader) *callerTags {
	return &callerTags{in: in, now: time.Now, seen: map[string]callerTag{}}
}

// callerOf is the rule installed with events.SetCallerRule. A session that is
// gone, or whose option cannot be read, is no Caller's, which records the
// event untagged rather than dropping it.
func (c *callerTags) callerOf(osUser, session string) string {
	key := osUser + "/" + session
	c.mu.Lock()
	now := c.now()
	if t, ok := c.seen[key]; ok && now.Sub(t.at) <= callerTagTTL {
		c.mu.Unlock()
		return t.caller
	}
	c.mu.Unlock()

	// Outside the lock: this is a tmux fork, and every event this service
	// emits passes through here.
	origin, _ := c.in.Option(osUser, session, sessionio.OptionOrigin)
	caller := sessionio.CallerOf(origin)

	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.seen) >= callerTagSweepAt {
		for k, t := range c.seen {
			if now.Sub(t.at) > callerTagTTL {
				delete(c.seen, k)
			}
		}
	}
	c.seen[key] = callerTag{caller: caller, at: now}
	return caller
}
