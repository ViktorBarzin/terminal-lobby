// Package siotest provides test doubles for sessionio's interfaces.
//
// It is a separate package so the doubles are shared by every module that
// consumes sessionio — session-events, tl-t3-bridge, tl-t3-sync — without
// widening sessionio's own API with test-only surface. It deliberately does not
// import sessionio: satisfying the interface structurally keeps sessionio's
// in-package tests free to import this.
package siotest

import (
	"errors"
	"sync"
)

// FakeOptions stands in for the tmux option store: a set of LIVE sessions, each
// holding its options. Killing a session drops its options with it, which is
// the property every durable-binding test leans on.
//
// It satisfies sessionio.Options. Safe for concurrent use.
type FakeOptions struct {
	mu       sync.Mutex
	sessions map[string]map[string]string // "<osUser>/<session>" -> option -> value
}

// NewFakeOptions creates the store with the given sessions already live, each
// named "<osUser>/<session>".
func NewFakeOptions(live ...string) *FakeOptions {
	f := &FakeOptions{sessions: map[string]map[string]string{}}
	for _, s := range live {
		f.sessions[s] = map[string]string{}
	}
	return f
}

// Option reads an option; ok=false means there is no such live session, which
// is what real tmux amounts to once Injector.Option has validated the name.
func (f *FakeOptions) Option(osUser, session, name string) (string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	opts, ok := f.sessions[osUser+"/"+session]
	if !ok {
		return "", false // no such tmux session
	}
	return opts[name], true
}

// SetOption stamps an option, failing on a session that is not live — with the
// message real tmux uses, so a test asserting on it stays honest.
func (f *FakeOptions) SetOption(osUser, session, name, value string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	opts, ok := f.sessions[osUser+"/"+session]
	if !ok {
		return errors.New("can't find session: " + session) // what tmux says
	}
	opts[name] = value
	return nil
}

// Kill models `tmux kill-session`: the session and every option on it go away.
func (f *FakeOptions) Kill(osUser, session string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.sessions, osUser+"/"+session)
}

// Start models a fresh `tmux new-session` under a name: live, no options.
func (f *FakeOptions) Start(osUser, session string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sessions[osUser+"/"+session] = map[string]string{}
}
