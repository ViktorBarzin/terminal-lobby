package main

import (
	"sync"
	"testing"
	"time"

	"terminal-lobby/sessionio"
)

// fakeOrigins is the one tmux read the caller tag needs, counted.
type fakeOrigins struct {
	mu      sync.Mutex
	origins map[string]string // "user/session" -> @tl_origin
	reads   int
}

func (f *fakeOrigins) Option(osUser, session, name string) (string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reads++
	if name != sessionio.OptionOrigin {
		return "", false
	}
	v, ok := f.origins[osUser+"/"+session]
	return v, ok
}

// A Caller's session gets tl.caller on every event session-events writes about
// it, which is the half of the usage record tmux-api cannot tag: a turn's
// state changes and a prompt's sends are emitted here (CONTEXT.md: Origin).
func TestCallerTagNamesTheCallerFromTheOrigin(t *testing.T) {
	f := &fakeOrigins{origins: map[string]string{
		"wizard/session-ready": "muse",
		"wizard/main":          sessionio.OriginUser,
		"wizard/qa-run":        sessionio.OriginTest,
		"wizard/stray":         "",
	}}
	tags := newCallerTags(f)
	for _, c := range []struct{ session, want string }{
		{"session-ready", "muse"},
		{"main", ""},
		{"qa-run", ""},
		{"stray", ""},
		{"gone", ""},
	} {
		if got := tags.callerOf("wizard", c.session); got != c.want {
			t.Errorf("callerOf(%q) = %q, want %q", c.session, got, c.want)
		}
	}
	// The same session name in another user's tmux server is another session.
	if got := tags.callerOf("emo", "session-ready"); got != "" {
		t.Errorf("another user's session-ready was tagged %q", got)
	}
}

// A turn emits several events in a burst, so the origin is read once and
// remembered rather than forked for each one, and read again once the memory
// is old enough that a rescue (the origin restamped to user) should show.
func TestCallerTagReadsTmuxOncePerWindow(t *testing.T) {
	f := &fakeOrigins{origins: map[string]string{"wizard/session-ready": "muse"}}
	tags := newCallerTags(f)
	now := time.Unix(1_800_000_000, 0)
	tags.now = func() time.Time { return now }

	for i := 0; i < 5; i++ {
		tags.callerOf("wizard", "session-ready")
	}
	if f.reads != 1 {
		t.Fatalf("five events in one window read tmux %d times, want 1", f.reads)
	}

	f.mu.Lock()
	f.origins["wizard/session-ready"] = sessionio.OriginUser
	f.mu.Unlock()
	now = now.Add(callerTagTTL + time.Second)
	if got := tags.callerOf("wizard", "session-ready"); got != "" {
		t.Errorf("a rescued session is still tagged %q after the window", got)
	}
	if f.reads != 2 {
		t.Errorf("want one more read after the window, got %d in all", f.reads)
	}
}

// The memory does not grow with every session that ever emitted: entries past
// their window are swept once it is large.
func TestCallerTagForgetsOldSessions(t *testing.T) {
	f := &fakeOrigins{origins: map[string]string{}}
	tags := newCallerTags(f)
	now := time.Unix(1_800_000_000, 0)
	tags.now = func() time.Time { return now }
	for i := 0; i < callerTagSweepAt; i++ {
		tags.callerOf("wizard", "s"+time.Duration(i).String())
	}
	now = now.Add(callerTagTTL + time.Second)
	tags.callerOf("wizard", "fresh")
	tags.mu.Lock()
	n := len(tags.seen)
	tags.mu.Unlock()
	if n != 1 {
		t.Errorf("after a sweep the memo holds %d entries, want only the fresh one", n)
	}
}
