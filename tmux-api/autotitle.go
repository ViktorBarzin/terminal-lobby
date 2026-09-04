package main

// The auto-title rule (docs/plans/2026-09-04-prompt-first-sessions-design.md).
//
// A session's name is an opaque id now (ADR-0019), so a title is the only
// readable thing about it — and prompt-first sessions take away the moment
// where a person typed one. The title comes from Claude Code instead: it writes
// a summary of the conversation into its terminal title, that arrives as the
// pane title, and tmux-api has been carrying it in every /sessions row since
// Task 2.5. So the summariser is already running, in the same pane, and this is
// the rule that reads its output.
//
// It runs on the session-list poll rather than on a clock of its own, because
// the poll already forks tmux once per user on a 5-second cache and every field
// the rule needs is in the row it just parsed. The common case costs a handful
// of string comparisons and no fork at all.
//
// Stamping @title is what stops the rule firing again: the next poll reads the
// title back off the session and skips it. So the title freezes at the first
// summary and later drift is ignored, with no separate marker to keep. Clearing
// a title by hand unsets @title and puts the session back in front of the rule,
// which makes "clear" mean "go back to auto" — the meaning that fits now that a
// bare name is unreadable.

import (
	"log"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"terminal-lobby/slug"
	"terminal-lobby/telemetry"
)

const (
	// claudeTitleGlyphs are the glyphs Claude Code puts at the head of the
	// terminal title, one of which prefixes every summary that arrives.
	//
	// Stripped as a SET, not as the literal "✳ ". Claude Code carries six
	// glyphs for that position and rotates them on a 960ms interval while a
	// turn animates, the sixth depending on TERM. Sampled live at 4Hz for 10
	// seconds across two running sessions on 2026-09-04, all 80 reads were `✳`
	// — so the animated frames do not reach pane_title on this box. Matching
	// the set anyway costs one string and removes the case where a title
	// arrives wearing a `✶`.
	claudeTitleGlyphs = "·✢✳✶✻✽"

	// noSummaryYet is what the pane title reads, after the glyph, before the
	// first prompt of a conversation. It is the sentinel for "the summariser
	// has not run", not a title.
	noSummaryYet = "Claude Code"

	// autoTitleWindow is how long after creation the rule keeps watching. It
	// exists so the rule does not watch forever: a Claude that crashed at
	// launch, a plain shell, or a session started with
	// CLAUDE_CODE_DISABLE_TERMINAL_TITLE set never produces a summary, and
	// leaving those untitled is a normal outcome rather than a failure. They
	// stay titleable by hand.
	//
	// A summary lands seconds after the first prompt, so the window is sized
	// for the gap between creating a session and sending that prompt, not for
	// the summariser.
	//
	// It is measured from windowStart, NOT from session_created: a session's
	// creation time is not when it became somebody's session. A create that
	// claims a pre-warm slot takes over a tmux session that already existed —
	// `tmux rename-session` does not touch session_created, and a STANDING slot
	// is refilled rather than recreated, so it has no TTL at all. Measured on
	// 2026-09-04: the standing slot for /home/wizard/code read session_created
	// 4h33m in the past, so every session claimed out of it would have been
	// born expired.
	autoTitleWindow = 2 * time.Minute

	// The two outcomes session.autonamed reports.
	autoTitleTitled = "titled"
	autoTitleGaveUp = "gave_up"
)

// stripTitleGlyph returns a pane title with its leading Claude Code glyph
// removed and the surrounding whitespace with it, and reports whether there was
// a glyph to remove.
//
// Only a LEADING glyph goes. A summary that happens to contain one keeps every
// character of it, which matters because `·` is an ordinary character in
// ordinary text.
//
// The bool is what tells a title Claude Code wrote from one it did not, which
// paneTitleSummary needs and nothing else does.
func stripTitleGlyph(paneTitle string) (string, bool) {
	r, size := utf8.DecodeRuneInString(paneTitle)
	if size == 0 || !strings.ContainsRune(claudeTitleGlyphs, r) {
		return strings.TrimSpace(paneTitle), false
	}
	return strings.TrimSpace(paneTitle[size:]), true
}

// paneTitleSummary reads a Claude Code summary out of a pane title, and reports
// whether there is one there at all.
//
// A summary is only believed when the pane title LEADS with one of Claude
// Code's glyphs. That is the whole test, and the reason for it is the gap at
// boot: @claude_state is stamped about 300ms before Claude writes its first
// title (docs/plans/2026-09-04-prompt-first-sessions-design.md, Sequencing), so
// a poll landing inside that gap sees a live Claude whose pane title is still
// whatever the SHELL left there — on this box `devvm`, the hostname. Testing
// only against the "Claude Code" sentinel would stamp that hostname as the
// session's permanent title, and stamping is what stops the rule firing again,
// so the real summary would never land.
//
// Failing this way round is the safe one: a Claude Code that stopped writing
// the glyph would leave sessions untitled, which is what an untitled session
// has always looked like, rather than titling them after the shell.
func paneTitleSummary(paneTitle string) (string, bool) {
	rest, hadGlyph := stripTitleGlyph(paneTitle)
	if !hadGlyph || rest == noSummaryYet {
		return "", false
	}
	// CleanTitle runs before the emptiness test so the answer is against the
	// same normalisation everything else stores, rather than against raw pane
	// bytes.
	summary := slug.CleanTitle(rest)
	if summary == "" {
		return "", false
	}
	return summary, true
}

// autoTitles is what stops one session being reported twice. Package state
// because the rule runs on a poll, and the poll runs for the life of the
// process; a var so tests get their own.
var autoTitles = newAutoTitleTracker()

// autoTitleTracker remembers which sessions the rule is still waiting on, per
// OS user.
//
// Two things need remembering, and neither is on the session itself. A stamped
// @title is its own marker for "titled", but "gave up" has nothing to write, so
// without this the rule would report the same expired session on every poll.
// And a session must only be given up on if this process WATCHED it inside its
// window — otherwise a restart re-reports every old untitled Claude session on
// the box as a fresh failure.
type autoTitleTracker struct {
	mu     sync.Mutex
	byUser map[string]*autoTitleUser
}

// autoTitleUser is one OS user's memory, plus the one fact that is about the
// user rather than about any session.
type autoTitleUser struct {
	// polled is set once the rule has applied to a list for this user.
	//
	// Until it is, every session in the list was already running before this
	// process started, so none of them can be dated from the moment we first
	// saw them. After it, a name that was not in the previous list is a session
	// that came into being while we were watching — which is what a create is,
	// whether it booted a Claude of its own or claimed a pre-warm slot that had
	// been sitting there for hours.
	polled   bool
	sessions map[string]*autoTitleWatch
}

type autoTitleWatch struct {
	// firstSeen is when this process first met the session, and fresh says the
	// session APPEARED while we were watching this user rather than already
	// being there when we started. Together they date a claimed pre-warm slot,
	// whose session_created belongs to the slot and not to the create.
	firstSeen time.Time
	fresh     bool
	// watched is set once the rule has seen this session untitled while it was
	// still inside its window, i.e. genuinely waiting for a summary.
	watched bool
	// stamping is set while a stamp is in flight, so two polls landing together
	// cannot both fork tmux for the same session.
	//
	// Deliberately NOT a record that the session has been titled: @title is
	// that record, and it lives on the session. Clearing a title unsets @title
	// and puts the session back in front of the rule, which is what makes
	// "clear" mean "go back to auto".
	stamping bool
	// reported is set once an outcome has been emitted. There is one per
	// session for its whole life — a re-stamp after a clear is not a second
	// autoname, and an expired session must not be reported on every poll.
	reported bool
}

func newAutoTitleTracker() *autoTitleTracker {
	return &autoTitleTracker{byUser: map[string]*autoTitleUser{}}
}

// user returns this OS user's memory, creating it. Callers hold t.mu.
func (t *autoTitleTracker) user(osUser string) *autoTitleUser {
	u := t.byUser[osUser]
	if u == nil {
		u = &autoTitleUser{sessions: map[string]*autoTitleWatch{}}
		t.byUser[osUser] = u
	}
	return u
}

// entry returns this session's watch, creating it. Callers hold t.mu.
func (t *autoTitleTracker) entry(osUser, name string) *autoTitleWatch {
	u := t.user(osUser)
	w := u.sessions[name]
	if w == nil {
		w = &autoTitleWatch{}
		u.sessions[name] = w
	}
	return w
}

// windowStart is the moment this session's auto-title window runs from.
//
// Creation, except for a session that appeared while we were watching this
// user and is older than that: those are pre-warm claims, where tmux reports
// the SLOT's creation time because a claim is a rename. Anchoring on when the
// session showed up is what gives a claimed slot the same two minutes a cold
// create gets, and it is deliberately not applied to the first list we see for
// a user — at a restart every session looks new, and dating them all from now
// would put every old untitled Claude session on the box back in front of the
// rule.
func (t *autoTitleTracker) windowStart(osUser, name string, created, now time.Time) time.Time {
	t.mu.Lock()
	defer t.mu.Unlock()
	u := t.user(osUser)
	w := t.entry(osUser, name)
	if w.firstSeen.IsZero() {
		w.firstSeen = now
		w.fresh = u.polled
	}
	if w.fresh && w.firstSeen.After(created) {
		return w.firstSeen
	}
	return created
}

// polled records that a list has been applied for this user, so the next one
// can tell a session that appeared from one that was always there.
func (t *autoTitleTracker) polled(osUser string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.user(osUser).polled = true
}

// watch records that the rule is waiting on this session for a summary.
func (t *autoTitleTracker) watch(osUser, name string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.entry(osUser, name).watched = true
}

// beginStamp takes the in-flight lock for a session about to be stamped, and
// reports whether this caller got it. Always paired with endStamp.
func (t *autoTitleTracker) beginStamp(osUser, name string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	w := t.entry(osUser, name)
	if w.stamping {
		return false
	}
	w.stamping = true
	return true
}

// endStamp releases the in-flight lock and reports whether the outcome is worth
// an event. A stamp tmux refused reports nothing and leaves the session
// untitled inside its window, so the next poll tries again.
func (t *autoTitleTracker) endStamp(osUser, name string, stamped bool) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	w := t.entry(osUser, name)
	w.stamping = false
	if !stamped || w.reported {
		return false
	}
	w.reported = true
	return true
}

// giveUp reports whether a session whose window has run out is worth an event.
// It is worth one exactly once, and only for a session this process actually
// watched — otherwise a restart re-reports every old untitled Claude session on
// the box as a fresh failure.
func (t *autoTitleTracker) giveUp(osUser, name string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	w := t.entry(osUser, name)
	if w.stamping || w.reported {
		return false
	}
	w.reported = true
	return w.watched
}

// retain drops every session this user no longer has, so the tracker holds one
// entry per live session rather than one per session the process has ever seen.
//
// The USER's record survives an empty list. It is one bool, and dropping it
// would forget that we have polled this user — which is the fact that tells a
// claimed pre-warm slot from a session that predates the process.
func (t *autoTitleTracker) retain(osUser string, live map[string]bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	u := t.byUser[osUser]
	if u == nil {
		return
	}
	for name := range u.sessions {
		if !live[name] {
			delete(u.sessions, name)
		}
	}
}

// size is how many of this user's sessions the tracker holds, for tests.
func (t *autoTitleTracker) size(osUser string) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	if u := t.byUser[osUser]; u != nil {
		return len(u.sessions)
	}
	return 0
}

// autoTitleSessions applies the rule to one user's freshly-parsed session list,
// stamping the title onto the session AND onto the row being served, so the
// poll that stamps is the one that shows it rather than the one after.
//
// Called from userSessionsAndActivity, after the liveness backstop has run:
// State there means a claude that is actually alive, which is what makes a
// crashed Claude leave its session untitled rather than take the pane title a
// dead process left behind.
func autoTitleSessions(osUser string, sessions []Session, now time.Time) {
	live := make(map[string]bool, len(sessions))
	for i := range sessions {
		live[sessions[i].Name] = true
	}
	autoTitles.retain(osUser, live)

	for i := range sessions {
		s := &sessions[i]
		if s.State == "" || s.Title != "" {
			// Not a live Claude, or somebody has already titled it.
			continue
		}
		age := now.Sub(autoTitles.windowStart(osUser, s.Name, time.Unix(s.Created, 0), now))
		if age > autoTitleWindow {
			if autoTitles.giveUp(osUser, s.Name) {
				emitAutoTitled(osUser, s.Name, age, autoTitleGaveUp)
			}
			continue
		}
		summary, ok := paneTitleSummary(s.PaneTitle)
		if !ok {
			// Still waiting: no glyph yet, the "Claude Code" sentinel, or
			// nothing that survives the clean.
			autoTitles.watch(osUser, s.Name)
			continue
		}
		if !autoTitles.beginStamp(osUser, s.Name) {
			continue
		}
		err := stampSessionTitle(osUser, s.Name, summary)
		if err != nil {
			// The session is still untitled and still inside its window, so
			// the next poll tries again.
			log.Printf("auto-title: titling %s/%s failed: %v", osUser, s.Name, err)
		} else {
			s.Title = summary
			if serr := titleStoreInstance.set(osUser, s.Name, summary); serr != nil {
				// The option landed, so the title is live; only its survival
				// across a restore is at risk.
				log.Printf("auto-title: remembering %s/%s failed: %v", osUser, s.Name, serr)
			}
		}
		if autoTitles.endStamp(osUser, s.Name, err == nil) {
			emitAutoTitled(osUser, s.Name, age, autoTitleTitled)
		}
	}
	// Last, after every windowStart above has read it: from here on, a name
	// this user did not have is a session that appeared while we were watching.
	autoTitles.polled(osUser)
}

// emitAutoTitled records one outcome. tl.delay_ms is measured from the window
// start — creation, or the moment a claimed pre-warm slot appeared under its
// new name — which is the only clock both outcomes share; tmux reports creation
// in whole seconds, so the number is second-resolution despite its name.
func emitAutoTitled(osUser, name string, delay time.Duration, outcome string) {
	events.Emit("session.autonamed", osUser, telemetry.Attrs{
		"tl.session":  name,
		"tl.delay_ms": delay.Milliseconds(),
		"tl.outcome":  outcome,
	})
}
