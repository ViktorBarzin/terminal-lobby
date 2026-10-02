package main

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"

	"terminal-lobby/sessionio"
	"terminal-lobby/slug"
)

// noticeSender is a sender with one device for alice, seeded by a first tick
// with `main` running and no notice.
func noticeSender(t *testing.T, prefs stubPrefs) (*pushSender, *stubStater, *pushRecorder) {
	t.Helper()
	rec := &pushRecorder{hits: map[string]int{}}
	srv := rec.server(t)
	store := newPushStore(t.TempDir())
	if err := store.upsert("alice", pushSubscription{Endpoint: srv.URL + "/d", Keys: genSubKeys(t)}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	stub := &stubStater{}
	sender := newPushSender(store, prefs, stub, testVAPID(t))
	stub.set(map[string]string{"main": stateRunning})
	sender.tick()
	if rec.total() != 0 {
		t.Fatalf("seed tick sent %d, want 0", rec.total())
	}
	return sender, stub, rec
}

// Viktor, 2026-10-01: "I want to be able to see the message sent, not that a
// session sent a notification only." A new notice is a push of its own, sent
// once, and the message is the body.
func TestANewNoticeIsPushedOnce(t *testing.T) {
	sender, stub, rec := noticeSender(t, stubPrefs{})

	stub.setNotices(map[string]sessionio.Notice{"main": {At: 100, Text: "build failed: 2 auth tests"}})
	logs := captureLog(t, sender.tick)
	if rec.hit("/d") != 1 {
		t.Fatalf("new notice: got %d pushes, want 1", rec.hit("/d"))
	}
	if !strings.Contains(logs, "sent "+kindNotice+" to alice (session=main") {
		t.Fatalf("no send line for the notice in:\n%s", logs)
	}

	sender.tick()
	if rec.hit("/d") != 1 {
		t.Fatalf("same notice re-read: got %d pushes, want still 1", rec.hit("/d"))
	}

	// The same words again are a second message: the stamp moved.
	stub.setNotices(map[string]sessionio.Notice{"main": {At: 200, Text: "build failed: 2 auth tests"}})
	sender.tick()
	if rec.hit("/d") != 2 {
		t.Fatalf("second notice: got %d pushes, want 2", rec.hit("/d"))
	}
}

// Claude usually sends its message near the end of the turn, and the
// "finished" push that follows would replace it on the phone (both share the
// tag tl-<session>). The notice is that turn's notification, so the done edge
// after it is held, whether it lands in the same tick or a later one.
func TestTheTurnEndAfterANoticeDoesNotReplaceIt(t *testing.T) {
	for _, sameTick := range []bool{true, false} {
		name := map[bool]string{true: "same tick", false: "next tick"}[sameTick]
		t.Run(name, func(t *testing.T) {
			sender, stub, rec := noticeSender(t, stubPrefs{})
			stub.setNotices(map[string]sessionio.Notice{"main": {At: 100, Text: "deploy finished"}})
			if !sameTick {
				sender.tick()
			}
			stub.set(map[string]string{"main": stateDone})
			sender.tick()
			if rec.hit("/d") != 1 {
				t.Fatalf("got %d pushes, want only the notice", rec.hit("/d"))
			}
		})
	}
}

// A message is new content, so it goes out even when the session already has
// a notification the person has not looked at.
func TestANoticeIsSentOverAnOutstandingNotification(t *testing.T) {
	sender, stub, rec := noticeSender(t, stubPrefs{})
	stub.set(map[string]string{"main": stateDone})
	sender.tick()
	if rec.hit("/d") != 1 {
		t.Fatalf("finished push: got %d, want 1", rec.hit("/d"))
	}

	stub.setNotices(map[string]sessionio.Notice{"main": {At: 100, Text: "one more thing"}})
	sender.tick()
	if rec.hit("/d") != 2 {
		t.Fatalf("notice over an outstanding push: got %d, want 2", rec.hit("/d"))
	}
}

// A restart, or a device subscribing for the first time, must not replay the
// message a session sent an hour ago.
func TestANoticeAlreadyThereAtTheFirstReadIsNotSent(t *testing.T) {
	rec := &pushRecorder{hits: map[string]int{}}
	srv := rec.server(t)
	store := newPushStore(t.TempDir())
	_ = store.upsert("alice", pushSubscription{Endpoint: srv.URL + "/d", Keys: genSubKeys(t)})
	stub := &stubStater{}
	sender := newPushSender(store, stubPrefs{}, stub, testVAPID(t))

	stub.set(map[string]string{"main": stateDone})
	stub.setNotices(map[string]sessionio.Notice{"main": {At: 100, Text: "old news"}})
	sender.tick()
	sender.tick()
	if rec.total() != 0 {
		t.Fatalf("got %d pushes for a notice seen at the first read, want 0", rec.total())
	}
}

// Tooling's sessions never ring, notices included.
func TestASystemSessionsNoticeIsNotSent(t *testing.T) {
	sender, stub, rec := noticeSender(t, stubPrefs{})
	stub.system = map[string]bool{"main": true}
	stub.setNotices(map[string]sessionio.Notice{"main": {At: 100, Text: "from a test harness"}})
	sender.tick()
	if rec.total() != 0 {
		t.Fatalf("got %d pushes for a system session, want 0", rec.total())
	}
}

// The two notify toggles are the only settings there are. A person who turned
// both off has asked for silence; one left on still lets a message through.
func TestNoticesFollowTheNotifyToggles(t *testing.T) {
	for _, tc := range []struct {
		doc  string
		want int
	}{
		{`{"notify":{"onDone":false,"onAwaiting":false}}`, 0},
		{`{"notify":{"onDone":false}}`, 1},
		{`{"notify":{"onAwaiting":false}}`, 1},
	} {
		t.Run(tc.doc, func(t *testing.T) {
			sender, stub, rec := noticeSender(t, stubPrefs{doc: tc.doc})
			stub.setNotices(map[string]sessionio.Notice{"main": {At: 100, Text: "hello"}})
			sender.tick()
			if rec.hit("/d") != tc.want {
				t.Fatalf("got %d pushes, want %d", rec.hit("/d"), tc.want)
			}
		})
	}
}

// The payload: the session's name in the title, Claude's words in the body, on
// both the flat keys sw.js reads and the declarative half iOS reads, under the
// session's shared tag.
func TestNoticePayloadCarriesTheMessage(t *testing.T) {
	b := buildNoticePayload("Tashkent trip", "tashkent-trip", "build failed: 2 auth tests", 1, nil, testPushOrigin)
	var got struct {
		Title        string `json:"title"`
		Body         string `json:"body"`
		Tag          string `json:"tag"`
		Session      string `json:"session"`
		Notification struct {
			Title string `json:"title"`
			Body  string `json:"body"`
			Tag   string `json:"tag"`
		} `json:"notification"`
	}
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Title != "Tashkent trip" || got.Body != "build failed: 2 auth tests" {
		t.Fatalf("flat title/body = %q / %q", got.Title, got.Body)
	}
	if got.Notification.Title != got.Title || got.Notification.Body != got.Body {
		t.Fatalf("declarative title/body = %q / %q, want the flat ones", got.Notification.Title, got.Notification.Body)
	}
	if got.Tag != "tl-tashkent-trip" || got.Notification.Tag != got.Tag || got.Session != "tashkent-trip" {
		t.Fatalf("tag/session = %q %q %q", got.Tag, got.Notification.Tag, got.Session)
	}
}

// The tool asks for under 200 characters and the hook keeps up to 1000 bytes,
// so the body is cut at noticeBodyRunes with an ellipsis, on a rune boundary.
func TestNoticeBodyIsCutToTheToolsLimit(t *testing.T) {
	long := strings.Repeat("é", noticeBodyRunes+50)
	b := buildNoticePayload("t", "s", long, 0, nil, "")
	var got struct {
		Body string `json:"body"`
	}
	_ = json.Unmarshal(b, &got)
	if n := utf8.RuneCountInString(got.Body); n != noticeBodyRunes {
		t.Fatalf("body is %d runes, want %d", n, noticeBodyRunes)
	}
	if !strings.HasSuffix(got.Body, "…") {
		t.Fatalf("a cut body should end in an ellipsis: %q", got.Body)
	}
	short := "fits"
	_ = json.Unmarshal(buildNoticePayload("t", "s", short, 0, nil, ""), &got)
	if got.Body != short {
		t.Fatalf("short body = %q, want it untouched", got.Body)
	}
}

// The worst notice still fits the encrypted budget: a full title and a full
// body of the characters encoding/json escapes to six bytes, twice each.
func TestWorstCaseNoticeFitsTheEncryptedBudget(t *testing.T) {
	w, names := fullWaitingSet()
	title := strings.Repeat("<", slug.MaxTitleRunes)
	body := strings.Repeat("<", noticeBodyRunes*2)
	for _, origin := range []string{testPushOrigin, ""} {
		if got := len(buildNoticePayload(title, names[0], body, 999, w, origin)); got > maxPushPayloadBytes {
			t.Fatalf("worst-case notice is %d bytes, over the %d-byte budget (origin %q)", got, maxPushPayloadBytes, origin)
		}
	}
}

// Viktor, 2026-10-01, after the notice shipped: "I still see 'Claude finished
// its turn'". A finished push whose turn left a reply shows the reply.
func TestAFinishedPushCarriesTheReply(t *testing.T) {
	var got struct {
		Title        string `json:"title"`
		Body         string `json:"body"`
		Notification struct {
			Title string `json:"title"`
			Body  string `json:"body"`
		} `json:"notification"`
	}
	b := buildReplyPayload("Tashkent trip", "tashkent-trip", "Done. 3 tests pass, 1 skipped", 1, nil, testPushOrigin)
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Title != "Tashkent trip finished" || got.Body != "Done. 3 tests pass, 1 skipped" {
		t.Fatalf("title/body = %q / %q", got.Title, got.Body)
	}
	if got.Notification.Title != got.Title || got.Notification.Body != got.Body {
		t.Fatalf("declarative title/body = %q / %q", got.Notification.Title, got.Notification.Body)
	}

	long := strings.Repeat("a", noticeBodyRunes*3)
	_ = json.Unmarshal(buildReplyPayload("t", "s", long, 0, nil, ""), &got)
	if n := utf8.RuneCountInString(got.Body); n != noticeBodyRunes || !strings.HasSuffix(got.Body, "…") {
		t.Fatalf("a long reply is %d runes (%q...), want cut to %d with an ellipsis", n, got.Body[:10], noticeBodyRunes)
	}
}

// A reply alone is not a push: it only changes what the finished edge says, so
// a session sitting done with a reply never rings on its own, and the edge
// still rings exactly once.
func TestAReplyDoesNotRingWithoutTheFinishedEdge(t *testing.T) {
	sender, stub, rec := noticeSender(t, stubPrefs{})
	stub.setReplies(map[string]sessionio.Notice{"main": {At: 100, Text: "Done."}})
	sender.tick()
	if rec.total() != 0 {
		t.Fatalf("a reply with no edge sent %d, want 0", rec.total())
	}
	stub.set(map[string]string{"main": stateDone})
	sender.tick()
	sender.tick()
	if rec.hit("/d") != 1 {
		t.Fatalf("finished edge with a reply: got %d pushes, want 1", rec.hit("/d"))
	}
}

func TestWorstCaseReplyFitsTheEncryptedBudget(t *testing.T) {
	w, names := fullWaitingSet()
	title := strings.Repeat("<", slug.MaxTitleRunes)
	body := strings.Repeat("&", noticeBodyRunes*2)
	for _, origin := range []string{testPushOrigin, ""} {
		if got := len(buildReplyPayload(title, names[0], body, 999, w, origin)); got > maxPushPayloadBytes {
			t.Fatalf("worst-case reply push is %d bytes, over the %d-byte budget (origin %q)", got, maxPushPayloadBytes, origin)
		}
	}
}
