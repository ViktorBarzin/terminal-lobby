package main

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
)

const (
	// pushPollInterval matches the frontend/lobby poll cadence (main.go
	// sessionsTTL) so the background sender observes the same state edges the
	// browser would.
	pushPollInterval = 5 * time.Second
	// pushTTL: seconds a push service holds an undelivered message. An
	// "awaiting" prompt is only interesting for a few minutes, and coalescing
	// is by tag anyway, so a short TTL avoids waking a device to a stale one.
	pushTTL = 300
	// pushDialTimeout bounds the TCP dial of one push POST. The push client
	// forces IPv4 (see newPushHTTPClient), so this is a v4-connect budget.
	pushDialTimeout = 10 * time.Second
	// pushClientTimeout bounds one whole SendNotification (dial + TLS +
	// request/response) so a wedged push service can't stall the synchronous
	// poll loop. Larger than pushDialTimeout to leave room after connect.
	pushClientTimeout = 15 * time.Second
)

// Notification kinds — which session-state edge produced a push. Threaded
// through the send path so the observability line and the per-user prefs gate
// can name it (and so the payload builder picks the right wording).
const (
	kindAwaiting = "awaiting"
	kindDone     = "done"
	kindTest     = "test" // the on-demand /push/test self-diagnosis send
)

// sessionStater reads a user's session name→state map plus the latest
// client-activity (user keystroke) time per session. Abstracted so the
// sender's transition logic is testable without a live tmux server.
type sessionStater interface {
	// read returns the session name→state map, the session name→display title
	// map (absent for a session nobody and nothing has titled), and the session
	// name → unix time of the newest input from any tmux client attached to it.
	// A session nobody has TYPED into is simply absent from the last map — no
	// attached client, or one that only ever attached (driven.go
	// latestActivity) — and the sender remembers the max it has ever seen.
	//
	// The fourth return is the set of the user's SYSTEM sessions — tooling's,
	// not a person's (origin.go) — which tick drops from all three maps before
	// it diffs anything. It rides this method for the same reason the other
	// three do: it is another answer that falls out of the list read already
	// being made, and asking for it separately would mean a second fork per
	// user per tick to learn something the first one already said.
	//
	// One method rather than four because they all come out of the same tmux
	// reads, and asking separately forked `list-clients` twice per user per
	// tick.
	read(osUser string) (states map[string]string, titles map[string]string, activity map[string]int64, system map[string]bool)
}

// prefsLoader reads a user's raw roamed prefs document. *prefsStore satisfies
// it; the sender uses it to gate done/awaiting sends per user (parseNotifyPrefs).
// Abstracted so a sender test can supply gating without a prefs store on disk.
type prefsLoader interface {
	load(osUser string) ([]byte, error)
}

// liveStater is the production sessionStater: read-only tmux list-sessions via
// the shared userSessions machinery (main.go). It mirrors the frontend's
// prevStates map exactly — every session keyed to its state, "" when no live
// claude — so the server-side edge rule matches the browser's.
type liveStater struct{}

func (liveStater) read(osUser string) (map[string]string, map[string]string, map[string]int64, map[string]bool) {
	sessions, activity := userSessionsAndActivity(osUser)
	states, titles := statesAndTitles(sessions)
	return states, titles, activity, systemNames(sessions)
}

// systemNames is the set of a user's sessions that belong to tooling rather
// than to a person, read off the list the sender already has in hand.
//
// Only system sessions appear, and the map is nil when there are none, which is
// the ordinary case on this box: the sender then allocates nothing and the
// filter below is a range over an empty map. It answers both halves of the rule
// at once (isSystemSession): the stamp, and the reserved-name prefixes that
// force system whatever the stamp says.
func systemNames(sessions []Session) map[string]bool {
	var out map[string]bool
	for _, s := range sessions {
		if !isSystemSession(s) {
			continue
		}
		if out == nil {
			out = map[string]bool{}
		}
		out[s.Name] = true
	}
	return out
}

// statesAndTitles splits a parsed session list into the two maps the sender
// diffs and reads wording from. A session nobody has titled is simply absent
// from the second map, which is what pushLabel's fallback is for.
func statesAndTitles(sessions []Session) (map[string]string, map[string]string) {
	states := make(map[string]string, len(sessions))
	titles := make(map[string]string, len(sessions))
	for _, s := range sessions {
		states[s.Name] = s.State
		if s.Title != "" {
			titles[s.Name] = s.Title
		}
	}
	return states, titles
}

// vapidConfig is the VAPID keypair + subject the sender signs pushes with.
type vapidConfig struct {
	publicKey  string
	privateKey string
	subject    string
}

// pushSender polls the users who hold push subscriptions and fans a Web Push
// out to each of a user's devices on a session's transition into "awaiting"
// (needs input) or "done" (finished) — the same edges the frontend notifies
// on — gated by that user's roamed notify prefs. A per-user last-state map
// makes it fire only on the edge, never repeatedly while a session holds a
// state; the first observation of a user seeds silently (mirrors the
// frontend's first-poll-after-load rule).
//
// The one thing it withholds is a session a device already has on screen, and
// only from THAT device (pushfocus.go): background push exists for the tab that
// is closed, so a desktop watching a session must not silence the phone in your
// pocket. A device that reports nothing is told everything.
type pushSender struct {
	store  *pushStore
	prefs  prefsLoader
	stater sessionStater
	vapid  vapidConfig
	client webpush.HTTPClient
	last   map[string]map[string]string
	// seenAct is the newest client-activity time ever observed per
	// user/session (remembered across polls, so a prompt typed just before
	// the tab closed still counts). pushedAct is seenAct's value at the
	// moment we last pushed for that session — the watermark of the
	// user-activity gate (see tick).
	seenAct   map[string]map[string]int64
	pushedAct map[string]map[string]int64
	// outstanding marks the sessions that have a notification the person has
	// not engaged with yet — the "one per thread" memory. Cleared when the
	// session goes back to running.
	outstanding map[string]map[string]bool
	// focus is what each DEVICE says it is showing right now (pushfocus.go).
	// Read per subscription in send: a device looking at the session stays
	// quiet, every other device is told. Nil means nothing is ever suppressed.
	focus *focusStore
}

// throttled says whether a push for this user/session should be suppressed, and
// why. Pure, so the rule is testable without a tmux.
//
// ONE OUTSTANDING NOTIFICATION PER SESSION (Viktor, 2026-09-02: "I'd like 1
// notification per thread at most"). A session that has already rung and has
// not been engaged with since says nothing new by ringing again — the sidebar
// marks it unread and the app icon counts it, which is what a standing state is
// for. The notification's job is to report a CHANGE.
//
// This also closes a leak that produced most of the volume. The activity gate,
// userTypedSinceLastPush, FAILS OPEN when a session has no client-activity
// reading — and a session nobody is attached to has none (driven.go: absent
// rather than zero). So every background session rang on every single turn
// boundary, unthrottled. Measured before this: 14.3 pushes an hour, 100 of 146
// of them completions.
//
// A suppressed push does NOT consume the activity credit: markPushed is skipped,
// so nothing is silenced beyond this one edge.
//
// A SECOND RULE USED TO LIVE HERE, and it is worth saying why it is gone
// (Viktor, 2026-09-06: "I stopped receiving mobile notifications if the app is
// open. I want to still receive them but only for sessions that I'm not focused
// on right now"). It held a push for 60 seconds after any client_activity on the
// session, standing in for "the person is sitting in front of this one". tmux
// stamps client_activity at ATTACH, and the lobby keeps every session you visit
// mounted with an attached client, so opening the app renewed that stamp on all
// of them at once: over the four days to 2026-09-06 it held 118 pushes, every
// held push in the window, four of them while Viktor was asleep. The page now
// says what it is showing (pushfocus.go) and send suppresses per DEVICE, which
// answers the same question with a fact instead of a proxy — and answers it for
// the device that is looking rather than for everybody. Removing it took the
// sender's clock with it: nothing left here is time-based.
func (p *pushSender) throttled(u, name string) string {
	if p.outstanding[u][name] {
		return "already-notified"
	}
	return ""
}

// markSent records that this session now has a notification outstanding.
func (p *pushSender) markSent(u, name string) {
	if p.outstanding == nil {
		p.outstanding = map[string]map[string]bool{}
	}
	m := p.outstanding[u]
	if m == nil {
		m = map[string]bool{}
		p.outstanding[u] = m
	}
	m[name] = true
}

// clearOutstanding forgets a session's notification once the person has engaged
// with it, so the next completion may ring again.
//
// Engagement is the session going back to RUNNING: something was submitted to
// it, which only happens deliberately. Using "typed" instead would never clear
// a session with no attached client, which is the case that leaked.
func (p *pushSender) clearOutstanding(u, name string) {
	if m := p.outstanding[u]; m != nil {
		delete(m, name)
	}
}

// newPushHTTPClient builds the *http.Client every Web Push send shares (both
// the background sender and the on-demand POST /push/test go through
// pushSender.send, the single webpush.SendNotification call site). It clones
// the stdlib default transport — preserving HTTP/2, proxy and idle-conn
// behaviour — and overrides only the dial timeout; the network family is the
// caller's (dual-stack).
//
// History: 2026-07-12→13 this forced tcp4 because the site's IPv6 path to
// Apple's push range (2620:149::/32) blackholed after the TCP handshake (HE
// tunnel MTU 1280, LAN RA advertising 1500, Apple's LBs ignoring
// Packet-Too-Big). Root cause is fixed at the router — pfSense clamps MSS to
// 1280 on the HE_IPv6 gif interface — so pushes dial dual-stack again and
// double as a daily canary of that path. If Apple sends ever time out again,
// suspect the site v6 path first (pfSense: Interfaces → HE_IPv6 → MSS).
func newPushHTTPClient() *http.Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	d := &net.Dialer{Timeout: pushDialTimeout}
	tr.DialContext = d.DialContext
	return &http.Client{
		Timeout:   pushClientTimeout,
		Transport: tr,
	}
}

func newPushSender(store *pushStore, prefs prefsLoader, stater sessionStater, vapid vapidConfig) *pushSender {
	return &pushSender{
		store:     store,
		prefs:     prefs,
		stater:    stater,
		vapid:     vapid,
		client:    newPushHTTPClient(),
		focus:     focusStoreInstance,
		last:      map[string]map[string]string{},
		seenAct:   map[string]map[string]int64{},
		pushedAct: map[string]map[string]int64{},
	}
}

// notifyPrefsFor reads and parses the caller's roamed notify prefs ONCE per
// tick (the tick loop calls this once per user, then gates all that user's
// sessions with the result). A missing/unreadable doc — or no prefs loader
// wired — defaults both kinds on (opt-out), matching parseNotifyPrefs.
func (p *pushSender) notifyPrefsFor(osUser string) notifyPrefs {
	if p.prefs == nil {
		return notifyPrefs{onDone: true, onAwaiting: true}
	}
	doc, err := p.prefs.load(osUser)
	if err != nil {
		log.Printf("push sender: loading prefs for %s failed: %v — notifications default on", osUser, err)
		return notifyPrefs{onDone: true, onAwaiting: true}
	}
	return parseNotifyPrefs(doc)
}

// declarativeWebPushVersion is the protocol version WebKit looks for at the top
// level of a Declarative Web Push message. 8030 is the only value it accepts;
// anything else, or a missing key, is the classic path.
const declarativeWebPushVersion = 8030

// maxPushPayloadBytes is what one message may marshal to.
//
// RFC 8291 guarantees a push service accepts a 4096-byte ENCRYPTED body, and
// aes128gcm spends 103 of those bytes on framing: an 86-byte header (16 salt,
// 4 record size, 1 key id length, 65 key id), the 1-byte padding delimiter and
// the 16-byte auth tag. So 4096-103 = 3993 bytes of JSON is the ceiling, and
// TestWorstCasePayloadFitsTheEncryptedBudget holds waitingListCap to it.
const maxPushPayloadBytes = 3993

// declarativeData is what a declarative notification carries for our own code
// to read back.
//
// It duplicates the flat session and waiting keys on purpose. With mutable
// true the service worker's push event still fires, but event.data is NULL and
// the message arrives as event.notification, so the flat keys are invisible on
// that path. Our fields come back on event.notification.data instead, and the
// worker needs the named set to draw the badge (ADR-0015).
type declarativeData struct {
	Session string    `json:"session"`
	Waiting *waitList `json:"waiting,omitempty"`
}

// declarativeNotification is the "notification" member of a Declarative Web
// Push message (iOS/iPadOS 18.4+, Safari 18.4+). Its point is Navigate: the OS
// opens the URL itself on a tap, so the right session opens with nothing
// inferred and no notificationclick handler in the path (WebKit never
// dispatches notificationclick for a notification that has a navigation URL —
// Notifications spec 2.7 steps 5 and 6).
//
// Navigate is REQUIRED and must be ABSOLUTE. WebKit parses it with no base, so
// a relative URL is a SyntaxError that drops the ENTIRE message, banner
// included. That is why these fields appear only for a subscription that
// recorded its page origin (push.go).
type declarativeNotification struct {
	Title    string `json:"title"`
	Body     string `json:"body"`
	Navigate string `json:"navigate"`
	Tag      string `json:"tag"`
	// AppBadge mirrors Badge's three states for the same reason and with the
	// same pointer: a count, an explicit zero (which CLEARS the icon), and
	// ABSENT, which leaves whatever the icon is showing alone. The
	// session-less self-diagnosis push is the absent case.
	AppBadge *int             `json:"app_badge,omitempty"`
	Data     *declarativeData `json:"data,omitempty"`
}

// pushPayload is the JSON delivered to the browser's service worker. The flat
// field names are EXACTLY what public/sw.js reads (title, body, tag, session,
// badge, waiting); TestBuildPushPayloadMatchesServiceWorker /
// TestBuildDonePayloadMatchesServiceWorker pin the shape so a drift from sw.js
// fails loudly instead of silently dropping notifications.
//
// The three declarative fields ride ALONGSIDE the flat ones rather than
// replacing them. Chrome, Android and every Apple device below 18.4 ignore
// web_push/notification and read the flat keys; iOS 18.4+ reads the
// declarative half. They are omitted entirely for a subscription with no
// recorded origin, which keeps that device's payload byte-identical to what
// shipped before (TestPayloadWithoutAnOriginIsUnchangedOnTheWire).
// There is deliberately NO "mutable" member. WebKit reads it at the top level,
// and true means "I will show a replacement banner from the service worker" —
// WebKit then starts the worker and displays NOTHING of its own, waiting for a
// replacement that sw.js never draws (showing one needs its own absolute
// navigate or WebKit throws, which is why that branch shows nothing). Sending
// it cost every iOS notification between 2026-09-08, when Viktor's iPhone first
// re-subscribed onto this path, and 2026-09-10: Apple accepted all 58 with a
// 201 and the phone displayed none. Absent, WebKit draws the payload's own
// banner without starting the worker, which is the point of a declarative
// message and the state ADR-0015's badge subtraction gives way to.
type pushPayload struct {
	WebPush      int                      `json:"web_push,omitempty"`
	Notification *declarativeNotification `json:"notification,omitempty"`

	Title   string `json:"title"`
	Body    string `json:"body"`
	Tag     string `json:"tag"`
	Session string `json:"session"`
	// Badge is how many of this user's sessions are waiting — the count a worker
	// too old to understand Waiting draws on the app icon. A POINTER so the three
	// states stay distinct: a count, an explicit zero (which CLEARS the icon, and
	// must survive `omitempty`), and ABSENT — the self-diagnosis push, which
	// carries no session and must leave whatever the icon is showing alone.
	Badge *int `json:"badge,omitempty"`
	// Waiting is the same set, NAMED rather than totalled, so the device can
	// subtract the sessions it has already shown the user before drawing a
	// number. See waitingList.
	Waiting *waitList `json:"waiting,omitempty"`
}

// waitList is which sessions are asking for attention, by name.
//
// The server sends the POPULATION and lets the device reach the conclusion,
// because the two halves of the answer live in different places: only the server
// knows what is awaiting or done, and only the browser knows what the user has
// already looked at. Sending a total forced the worker to paint a number that
// counted every finished session, including ones the user had read, so any push
// reset the icon upward. Sending names lets sw.js apply the device's own seen
// set and arrive at the same number the page would.
//
// Short JSON keys because a Web Push payload is limited (~4 KB after encryption)
// and a name may be up to 32 bytes (NAME_RE).
type waitList struct {
	Awaiting []string `json:"a"`
	Done     []string `json:"d"`
}

// waitingListCap bounds the two slices COMBINED. Past the cap the payload
// carries Badge alone and the device falls back to the server's total, which is
// the pre-existing behaviour rather than a new failure.
//
// A cap in names cannot be the thing that keeps a payload inside the byte
// budget, because a name is not the only variable: a 64-rune title of `<` costs
// 384 bytes where the same 64 runes of emoji cost 256 (encoding/json escapes
// `<`, `>` and `&` to six bytes each), and the declarative half carries the
// title twice. So the cap stays where it was and marshalPayload measures the
// finished bytes, dropping the list when they do not fit. Nobody here is near
// this number: it is a guard against a pathological account, not a working
// limit.
const waitingListCap = 64

// waitingList splits the same set waitingCount totals. Names are sorted so a
// payload is stable for a given state map, which keeps it diffable in a log and
// testable without ordering noise. Returns nil past the cap.
func waitingList(states map[string]string) *waitList {
	w := &waitList{}
	for name, st := range states {
		switch st {
		case stateAwaiting:
			w.Awaiting = append(w.Awaiting, name)
		case stateDone:
			w.Done = append(w.Done, name)
		}
	}
	if len(w.Awaiting)+len(w.Done) > waitingListCap {
		return nil
	}
	sort.Strings(w.Awaiting)
	sort.Strings(w.Done)
	return w
}

// waitingCount is how many of a user's sessions are asking for attention:
// awaiting input, or finished. It is the number the installed app wears on its
// icon, and deliberately the same set this sender alerts on, so the badge and
// the notifications can never disagree about what is outstanding.
//
// It is the FALLBACK total, not the number a current client draws. "Seen" lives
// in the browser's visit store, so a total counted every finished session and any
// push reset the icon upward; waitingList sends the same set by name and lets the
// device subtract what it has shown (ADR-0015). This total is what a worker
// installed before that change draws, and what any device draws when the name
// list would exceed the payload cap. Counting high is the right direction to be
// wrong in: it points at real work.
func waitingCount(states map[string]string) int {
	n := 0
	for _, st := range states {
		if st == stateAwaiting || st == stateDone {
			n++
		}
	}
	return n
}

// pushLabel is what a notification CALLS a session: its title, or the session
// name when nothing has titled it.
//
// A name stopped being readable when it became an opaque id (ADR-0019), so a
// body composed from one reads `k7m2q9x4tp0v needs input` on the phone. The
// title is what every other surface shows (frontend-v2/src/types/lobby.ts,
// sessionLabel), and this is the server-side half of the same rule. The name is
// still what `session` and the tag carry: those are addresses, and tapping the
// notification has to land on the right session.
//
// The name remains the fallback rather than "New session": a push that cannot
// say which session it is about is worse than one naming an id, and an
// untitled session is exactly the case where a phone has nothing else to go on.
func pushLabel(session, title string) string {
	if t := strings.TrimSpace(title); t != "" {
		return t
	}
	return session
}

// navigateURL is where a tap lands: the lobby with this session selected, on
// the origin the device recorded when it subscribed. The query name matches
// what the page already reads off its own URL, so the OS opening this URL and
// the app switching sessions are the same act.
//
// A session name is opaque and matches NAME_RE (/^[a-zA-Z0-9_-]{1,32}$/), so
// escaping never changes it. It is escaped anyway: a name that somehow got past
// that must not be able to write a second query parameter.
func navigateURL(origin, session string) string {
	if session == "" {
		return origin + "/"
	}
	return origin + "/?session=" + url.QueryEscape(session)
}

// marshalPayload builds the SW payload for one session and ONE subscription.
// Both wordings share the tag `tl-<session>`: coalescing is by tag only (sw.js
// omits renotify), so a later awaiting push REPLACES a finished one for the
// same session rather than stacking a second alert.
//
// `origin` is the page origin that subscription recorded, "" for one that
// predates the field. Empty means flat keys only — exactly today's bytes — so
// a device that has not re-subscribed yet loses nothing.
func marshalPayload(title, body, session string, badge int, waiting *waitList, origin string) []byte {
	p := pushPayload{
		Title:   title,
		Body:    body,
		Tag:     "tl-" + session,
		Session: session,
		Badge:   &badge,
		Waiting: waiting,
	}
	if origin != "" {
		p.WebPush = declarativeWebPushVersion
		p.Notification = &declarativeNotification{
			Title:    title,
			Body:     body,
			Navigate: navigateURL(origin, session),
			Tag:      p.Tag,
			AppBadge: &badge,
			Data:     &declarativeData{Session: session, Waiting: waiting},
		}
	}
	b, _ := json.Marshal(p)
	if len(b) <= maxPushPayloadBytes || waiting == nil {
		return b
	}
	// Over budget: send the same notification without the name list. The device
	// then draws the server's total (ADR-0015) instead of subtracting what it
	// has already read, which counts high rather than going quiet.
	//
	// Measured here rather than capped by name count because the title is the
	// other variable and it is not bounded in BYTES: slug.MaxTitleRunes allows
	// 64 runes, and 64 of `<` marshal to 384 bytes per copy where 64 emoji cost
	// 256. With a full 40-name list that title reached 4094 bytes, past the
	// 3993-byte ceiling, and a push service is only required to accept 4096
	// encrypted bytes — so send() would have logged a failure per device and the
	// notification would never have arrived.
	p.Waiting = nil
	if p.Notification != nil && p.Notification.Data != nil {
		p.Notification.Data.Waiting = nil
	}
	b, _ = json.Marshal(p)
	return b
}

// buildPushPayload is the running→awaiting "needs input" wording. `label` is
// what the person reads (pushLabel); `session` is the address, and `origin` the
// subscription's own (marshalPayload).
func buildPushPayload(label, session string, badge int, waiting *waitList, origin string) []byte {
	return marshalPayload(label+" needs input", "Claude is awaiting your input.", session, badge, waiting, origin)
}

// buildDonePayload is the running→done "finished" wording — the first-class
// notification for a turn completing. Same tag as the awaiting payload (see
// marshalPayload): a subsequent awaiting alert supersedes it.
func buildDonePayload(label, session string, badge int, waiting *waitList, origin string) []byte {
	return marshalPayload(label+" finished", "Claude finished its turn.", session, badge, waiting, origin)
}

// tick runs one poll cycle: for every subscribed user, diff the current
// session states against the previous poll and notify on each edge of
// interest — running→awaiting ("needs input") and running→done ("finished")
// — gated by the user's roamed notify prefs AND the user-activity gate.
//
// The user-activity gate (Viktor, 2026-07-13: "send only once the turn
// completes, not when any subagent completes"): the @claude_state hooks stamp
// done on EVERY Stop, and in an agent-orchestration session Stop fires at
// every internal turn boundary — scheduled wakeups and subagent reports each
// end a turn — so one human prompt used to spray a dozen "finished" pushes.
// tmux's client_activity moves only on human keystrokes, so: once we have any
// activity reading for a session, an edge pushes ONLY if the user typed into
// it since our previous push (one push per human interaction; a permission
// approval is itself typed input and re-arms the next completion). Sessions
// we've never seen activity for fail OPEN — legacy behaviour, nothing goes
// silently un-notified for lack of data.
func (p *pushSender) tick() {
	users, err := p.store.users()
	if err != nil {
		log.Printf("push sender: listing subscribed users failed: %v", err)
		return
	}
	seen := make(map[string]bool, len(users))
	for _, u := range users {
		seen[u] = true
		prev := p.last[u]
		cur, titles, act, system := p.stater.read(u)
		p.forgetSystemSessions(u, system, cur, titles, act)
		p.last[u] = cur
		p.observeActivity(u, act)
		if prev == nil {
			continue // first observation of this user seeds silently
		}
		np := p.notifyPrefsFor(u)   // one prefs read per user per tick
		badge := waitingCount(cur)  // one icon count per user per tick
		waiting := waitingList(cur) // and the same set by name, for the device to filter
		for name, st := range cur {
			was := prev[name] // "" when the session was absent last poll
			// Back to running means something was submitted to this session,
			// which is the engagement that lets it ring again.
			if st == stateRunning && was != stateRunning {
				p.clearOutstanding(u, name)
			}
			switch {
			case st == stateAwaiting && was != stateAwaiting:
				// running→awaiting (and any non-awaiting→awaiting, incl. a
				// newly-appeared already-awaiting session — unchanged edge).
				if np.onAwaiting && p.userTypedSinceLastPush(u, name) {
					if why := p.throttled(u, name); why != "" {
						log.Printf("push sender: held %s for %s (session=%s, %s)", kindAwaiting, u, name, why)
						break
					}
					p.markPushed(u, name)
					p.markSent(u, name)
					p.notify(u, name, titles[name], kindAwaiting, badge, waiting)
				}
			case st == stateDone && was == stateRunning:
				// running→done ONLY. A session first seen already done
				// (was=="") or any non-running→done stays silent, so a
				// SessionStart hook stamping "done" never fires.
				if np.onDone && p.userTypedSinceLastPush(u, name) {
					if why := p.throttled(u, name); why != "" {
						log.Printf("push sender: held %s for %s (session=%s, %s)", kindDone, u, name, why)
						break
					}
					p.markPushed(u, name)
					p.markSent(u, name)
					p.notify(u, name, titles[name], kindDone, badge, waiting)
				}
			}
		}
	}
	// Drop per-user state for users whose last device unsubscribed, so a
	// later re-subscribe seeds silently again instead of replaying a stale
	// edge (and the activity maps don't grow unbounded).
	for u := range p.last {
		if !seen[u] {
			delete(p.last, u)
			delete(p.seenAct, u)
			delete(p.pushedAct, u)
		}
	}
}

// forgetSystemSessions takes tooling's sessions out of one tick's reading, and
// out of everything the sender remembers about them, BEFORE any of it is
// diffed. Nothing downstream then has to know they exist: the edge detector
// never sees them, `last` never records the state they were in, and the badge
// and the waiting list are counted from what is left.
//
// Dropping them HERE rather than declining to send is what makes a rescue safe
// (docs/plans/2026-09-06-test-session-origin-design.md). A session that
// finished while it was hidden would otherwise sit in `last` as running,
// against a current state of done, and the first tick after it was dragged out
// of System would fire on that stale edge — a push about a turn that ended
// minutes ago. With no memory of it at all, the tick after the rescue is a
// first observation, and a session first seen already done stays silent.
//
// The three maps are this tick's own — the production stater builds them per
// call and the stub returns copies — so deleting from them mutates nothing
// anyone else holds. Deleting from seenAct and pushedAct is for the session
// that becomes system after having been a user session, which the origin
// endpoint makes possible in both directions.
func (p *pushSender) forgetSystemSessions(u string, system map[string]bool, states, titles map[string]string, act map[string]int64) {
	for name, sys := range system {
		if !sys {
			// A set, by contract, and a stater that sent a verdict per session
			// instead would otherwise erase the whole list here.
			continue
		}
		delete(states, name)
		delete(titles, name)
		delete(act, name)
		delete(p.seenAct[u], name)
		delete(p.pushedAct[u], name)
		p.clearOutstanding(u, name)
	}
}

// observeActivity folds the stater's current client-activity reading into
// seenAct, keeping the max ever observed per session — a client detaching
// (tab closed) must not erase the fact that the user typed a prompt.
func (p *pushSender) observeActivity(u string, act map[string]int64) {
	if len(act) == 0 {
		return
	}
	sa := p.seenAct[u]
	if sa == nil {
		sa = map[string]int64{}
		p.seenAct[u] = sa
	}
	for name, ts := range act {
		if ts > sa[name] {
			sa[name] = ts
		}
	}
}

// userTypedSinceLastPush is the activity gate: true when we have no activity
// data for the session (fail open), or when the newest observed keystroke is
// later than the watermark recorded at our previous push for it.
func (p *pushSender) userTypedSinceLastPush(u, name string) bool {
	sa, ok := p.seenAct[u][name]
	if !ok {
		return true
	}
	return sa > p.pushedAct[u][name]
}

// markPushed records the activity watermark for a session at push time. The
// watermark is per-session, shared across kinds — whichever of awaiting/done
// fires first consumes the current interaction's credit.
func (p *pushSender) markPushed(u, name string) {
	pa := p.pushedAct[u]
	if pa == nil {
		pa = map[string]int64{}
		p.pushedAct[u] = pa
	}
	pa[name] = p.seenAct[u][name]
}

// notify builds the payload for `session` of the given kind and fans it out
// to the user's devices. The wording comes from the kind; the tag is shared
// across kinds so a later push for the same session coalesces (send()).
func (p *pushSender) notify(osUser, session, title, kind string, badge int, waiting *waitList) {
	label := pushLabel(session, title)
	build := func(origin string) []byte {
		if kind == kindDone {
			return buildDonePayload(label, session, badge, waiting, origin)
		}
		return buildPushPayload(label, session, badge, waiting, origin)
	}
	p.send(osUser, session, build, kind)
}

// payloadBuilder renders the wire payload for ONE subscription, given the page
// origin that subscription recorded ("" when it recorded none). Marshalling is
// a per-device job since the navigate URL is built from that origin.
type payloadBuilder func(origin string) []byte

// send fans a payload out to every one of the user's stored devices, pruning
// any endpoint the push service reports gone (404/410) and logging one
// observability line per ACCEPTED push (os user, session, kind, HTTP status)
// — the operator's proof a push actually left the box, the forensics gap that
// made "notifications don't work" un-diagnosable. Returns the count accepted
// and the count pruned; the on-demand /push/test endpoint reads them back.
func (p *pushSender) send(osUser, session string, build payloadBuilder, kind string) (sent, pruned int) {
	subs, err := p.store.list(osUser)
	if err != nil {
		log.Printf("push sender: loading subs for %s failed: %v", osUser, err)
		return 0, 0
	}
	opts := &webpush.Options{
		HTTPClient: p.client,
		// webpush-go re-adds "mailto:" for any non-https subscriber, so a
		// subject already carrying the prefix would become "mailto:mailto:…".
		// Strip our canonical prefix and let the library re-apply it (an
		// https: subject is left untouched by TrimPrefix and by the library).
		Subscriber:      strings.TrimPrefix(p.vapid.subject, "mailto:"),
		VAPIDPublicKey:  p.vapid.publicKey,
		VAPIDPrivateKey: p.vapid.privateKey,
		TTL:             pushTTL,
	}
	for _, sub := range subs {
		// The one device with this session on screen already knows. Every other
		// device is told, because the person may not be holding this one.
		if p.focus != nil && p.focus.watching(osUser, sub.Endpoint, session) {
			log.Printf("push sender: held %s for %s (session=%s, on-screen-here)", kind, osUser, session)
			continue
		}
		// Built HERE, not once for the user: the origin is per subscription,
		// so two of this user's devices can get different payloads — the phone
		// that has re-subscribed gets the declarative half, a browser that has
		// not gets today's flat bytes.
		resp, err := webpush.SendNotification(build(sub.Origin), &webpush.Subscription{
			Endpoint: sub.Endpoint,
			Keys:     webpush.Keys{P256dh: sub.Keys.P256dh, Auth: sub.Keys.Auth},
		}, opts)
		if err != nil {
			log.Printf("push sender: send for %s failed: %v", osUser, err)
			continue
		}
		status := resp.StatusCode
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		switch {
		case status == http.StatusNotFound || status == http.StatusGone:
			if _, err := p.store.remove(osUser, sub.Endpoint); err != nil {
				log.Printf("push sender: pruning a gone endpoint for %s failed: %v", osUser, err)
			} else {
				// The device is gone; its last word about what it was showing
				// must not outlive it and silence a future device here.
				if p.focus != nil {
					p.focus.forget(osUser, sub.Endpoint)
				}
				pruned++
				log.Printf("push sender: pruned a gone endpoint for %s (push service returned %d)", osUser, status)
			}
		case status >= 200 && status < 300:
			sent++
			log.Printf("push sender: sent %s to %s (session=%s, status=%d)", kind, osUser, session, status)
		default:
			log.Printf("push sender: unexpected status sending %s to %s (session=%s, status=%d)", kind, osUser, session, status)
		}
	}
	return sent, pruned
}

// run drives tick on a ticker until ctx is cancelled. The first tick fires
// immediately so a restart re-seeds without waiting a whole interval.
func (p *pushSender) run(ctx context.Context) {
	t := time.NewTicker(pushPollInterval)
	defer t.Stop()
	p.tick()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			p.tick()
		}
	}
}

// pushSenderInstance is the process-wide sender, set by maybeStartPushSender
// iff VAPID is configured (nil = push dark). The background loop uses it; the
// on-demand POST /push/test handler reuses it to fan a test push through the
// exact same send path.
var pushSenderInstance *pushSender

// maybeStartPushSender launches the background sender iff a full VAPID config
// is present in the environment (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY /
// VAPID_SUBJECT — installed from Vault into /etc/tmux-api/vapid.env at deploy
// time). Absent or partial config leaves the whole push path dark: GET
// /push/vapid-public 404s, POST /push/test 503s, and the frontend falls back
// to foreground notifications only.
func maybeStartPushSender() {
	pub := os.Getenv("VAPID_PUBLIC_KEY")
	priv := os.Getenv("VAPID_PRIVATE_KEY")
	subject := os.Getenv("VAPID_SUBJECT")
	if pub == "" || priv == "" || subject == "" {
		log.Printf("push sender: VAPID config incomplete — background push disabled")
		return
	}
	pushSenderInstance = newPushSender(pushStoreInstance, prefsStoreInstance, liveStater{}, vapidConfig{
		publicKey:  pub,
		privateKey: priv,
		subject:    subject,
	})
	go pushSenderInstance.run(context.Background())
	log.Printf("push sender: started (poll every %s)", pushPollInterval)
}
