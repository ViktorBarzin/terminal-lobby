package main

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"os"
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
	// read returns the session name→state map, and the session name → unix
	// time of the newest input from any tmux client attached to it. Sessions
	// with no attached client are simply absent from the second map — the
	// sender remembers the max it has ever seen.
	//
	// One method rather than two because both come out of the same tmux reads,
	// and asking separately forked `list-clients` twice per user per tick.
	read(osUser string) (states map[string]string, activity map[string]int64)
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

func (liveStater) read(osUser string) (map[string]string, map[string]int64) {
	sessions, activity := userSessionsAndActivity(osUser)
	m := make(map[string]string, len(sessions))
	for _, s := range sessions {
		m[s.Name] = s.State
	}
	return m, activity
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
// frontend's first-poll-after-load rule). It deliberately does NOT gate on
// window focus: that is the whole point of background push (the tab may be
// closed), and the shared tag `tl-<session>` coalesces with any foreground
// notification so the user is alerted at most once.
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

// pushPayload is the JSON delivered to the browser's service worker. The field
// names are EXACTLY what frontend/sw.js reads (title, body, tag, session, badge);
// TestBuildPushPayloadMatchesServiceWorker / TestBuildDonePayloadMatchesServiceWorker
// pin the shape so a drift from sw.js fails loudly instead of silently
// dropping notifications.
type pushPayload struct {
	Title   string `json:"title"`
	Body    string `json:"body"`
	Tag     string `json:"tag"`
	Session string `json:"session"`
	// Badge is how many of this user's sessions are waiting — what sw.js draws
	// on the app icon. A POINTER so the three states stay distinct: a count, an
	// explicit zero (which CLEARS the icon, and must survive `omitempty`), and
	// ABSENT — the self-diagnosis push, which carries no session and must leave
	// whatever the icon is showing alone.
	Badge *int `json:"badge,omitempty"`
}

// waitingCount is how many of a user's sessions are asking for attention:
// awaiting input, or finished. It is the number the installed app wears on its
// icon, and deliberately the same set this sender alerts on, so the badge and
// the notifications can never disagree about what is outstanding.
//
// The server cannot know which finished sessions the user has already looked
// at — "seen" lives in the browser's visit store — so this can read high until
// the app is next opened, when notify/appbadge.ts repaints it exactly. Counting
// high is the right direction to be wrong in: it points at real work.
func waitingCount(states map[string]string) int {
	n := 0
	for _, st := range states {
		if st == stateAwaiting || st == stateDone {
			n++
		}
	}
	return n
}

// marshalPayload builds the SW payload for one session. Both wordings share
// the tag `tl-<session>`: coalescing is by tag only (sw.js omits renotify),
// so a later awaiting push REPLACES a finished one for the same session
// rather than stacking a second alert.
func marshalPayload(title, body, session string, badge int) []byte {
	b, _ := json.Marshal(pushPayload{
		Title:   title,
		Body:    body,
		Tag:     "tl-" + session,
		Session: session,
		Badge:   &badge,
	})
	return b
}

// buildPushPayload is the running→awaiting "needs input" wording.
func buildPushPayload(session string, badge int) []byte {
	return marshalPayload(session+" needs input", "Claude is awaiting your input.", session, badge)
}

// buildDonePayload is the running→done "finished" wording — the first-class
// notification for a turn completing. Same tag as the awaiting payload (see
// marshalPayload): a subsequent awaiting alert supersedes it.
func buildDonePayload(session string, badge int) []byte {
	return marshalPayload(session+" finished", "Claude finished its turn.", session, badge)
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
		cur, act := p.stater.read(u)
		p.last[u] = cur
		p.observeActivity(u, act)
		if prev == nil {
			continue // first observation of this user seeds silently
		}
		np := p.notifyPrefsFor(u) // one prefs read per user per tick
		badge := waitingCount(cur) // one icon count per user per tick
		for name, st := range cur {
			was := prev[name] // "" when the session was absent last poll
			switch {
			case st == stateAwaiting && was != stateAwaiting:
				// running→awaiting (and any non-awaiting→awaiting, incl. a
				// newly-appeared already-awaiting session — unchanged edge).
				if np.onAwaiting && p.userTypedSinceLastPush(u, name) {
					p.markPushed(u, name)
					p.notify(u, name, kindAwaiting, badge)
				}
			case st == stateDone && was == stateRunning:
				// running→done ONLY. A session first seen already done
				// (was=="") or any non-running→done stays silent, so a
				// SessionStart hook stamping "done" never fires.
				if np.onDone && p.userTypedSinceLastPush(u, name) {
					p.markPushed(u, name)
					p.notify(u, name, kindDone, badge)
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
func (p *pushSender) notify(osUser, session, kind string, badge int) {
	var payload []byte
	if kind == kindDone {
		payload = buildDonePayload(session, badge)
	} else {
		payload = buildPushPayload(session, badge)
	}
	p.send(osUser, session, payload, kind)
}

// send fans `payload` out to every one of the user's stored devices, pruning
// any endpoint the push service reports gone (404/410) and logging one
// observability line per ACCEPTED push (os user, session, kind, HTTP status)
// — the operator's proof a push actually left the box, the forensics gap that
// made "notifications don't work" un-diagnosable. Returns the count accepted
// and the count pruned; the on-demand /push/test endpoint reads them back.
func (p *pushSender) send(osUser, session string, payload []byte, kind string) (sent, pruned int) {
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
		resp, err := webpush.SendNotification(payload, &webpush.Subscription{
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
