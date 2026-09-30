package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"terminal-lobby/sessionio"
	"terminal-lobby/sessionio/siotest"
)

// THE STOP REPLAY. Send a message, press Stop some time later, and check that
// nothing was lost or doubled, at every timing from 0 to 3 s.
//
// Stop took four review rounds of the T3 pass to get right (2026-09-28 to
// 2026-09-29): a prompt stopped before Claude's first token was left on the
// input line while the chat showed it as sent, a queued prompt ran after the
// Stop meant to hand it back, a long message came back in pieces, and a
// picture came back as "[Image #1]" with no picture. Each was found by a
// person pressing Stop at the wrong moment. This replays that person with no
// real Claude: the real POST /prompt and POST /cancel routes, the real
// sessionio.Injector, and sessionio/testdata/fakeinput.py standing in for
// Claude Code's input box with its turn modelled (FAKEINPUT_TURN_MS) and its
// delayed picture attach (FAKEINPUT_IMAGE_MS).
//
// The client half is what the Text view sends when the transcript has not
// caught up (TextView.tsx stopHandingBack, stoppable): the first message it
// sent as returnPrompt, the ones after it as restoreQueue. The Stop is pressed
// no earlier than the send came back, since the round button offers Stop only
// then (Composer.tsx turnRunning).
//
// Every run checks three things:
//
//   - each message reached Claude exactly once, or came back whole to the
//     field, never both and never neither;
//   - Claude's input box is left empty, where the next send's clear would
//     erase whatever sat in it;
//   - a message the server said came back is out of the conversation and is
//     the one the rewound stamp names, so no device still shows it as sent.
//
// It runs in CI with the rest of `go test -race ./...` in session-events
// (.github/workflows/release.yml, "test (go)"), which needs tmux and python3;
// under CI it fails rather than skips when either is missing. -short takes a
// coarser sweep of the timings.
func TestStopReplayLosesAndDoublesNothing(t *testing.T) {
	requireReplayTools(t)
	scenarios := []struct {
		name string
		env  string
		msgs []string
	}{
		{name: "plain", msgs: []string{"Say hello in three words."}},
		{name: "long", msgs: []string{longReplayMessage()}},
		{
			name: "one-picture",
			env:  "FAKEINPUT_IMAGE_MS=250",
			msgs: []string{"/var/tmp/tl-replay/red.png What colour is this?"},
		},
		{
			name: "two-pictures",
			env:  "FAKEINPUT_IMAGE_MS=120,450",
			msgs: []string{"/var/tmp/tl-replay/red.png /var/tmp/tl-replay/blue.jpg Name both colours."},
		},
		{
			name: "queued-batch",
			msgs: []string{"First, list the files.", "Second, count them.", "Third, say done."},
		},
	}
	step := 200 * time.Millisecond
	if testing.Short() {
		step = 600 * time.Millisecond
	}
	// Most of a run is waiting on the stand-in's clock, so runs go
	// replayConcurrency at a time whatever -parallel says, each in a tmux
	// server of its own.
	var wg sync.WaitGroup
	slots := make(chan struct{}, replayConcurrency)
	for _, sc := range scenarios {
		for at := time.Duration(0); at <= 3*time.Second; at += step {
			sc, at := sc, at
			wg.Add(1)
			slots <- struct{}{}
			go func() {
				defer wg.Done()
				defer func() { <-slots }()
				t.Run(fmt.Sprintf("%s/stop-at-%dms", sc.name, at.Milliseconds()), func(t *testing.T) {
					replayStop(t, sc.env, sc.msgs, at)
				})
			}()
		}
	}
	wg.Wait()
}

// replayConcurrency is how many replays run at once.
const replayConcurrency = 8

// replayTurnMS is how long the stand-in takes to write something for a turn.
// The sweep runs past it, so a Stop lands before the reply, which takes the
// prompt back, and after it, which leaves it in the conversation.
const replayTurnMS = 1000

func replayStop(t *testing.T, env string, msgs []string, stopAt time.Duration) {
	in, osUser, sock := replayBox(t, fmt.Sprintf("FAKEINPUT_TURN_MS=%d %s", replayTurnMS, env))
	h := replayMux(t, in, osUser)

	start := time.Now()
	// The field: what the composer holds once the dust settles.
	var field []string
	var sent []string
	for _, m := range msgs {
		body, _ := json.Marshal(map[string]string{"text": m})
		rec := replayPost(h, osUser, "/prompt/"+sock, string(body))
		if rec.Code != http.StatusNoContent {
			// A refused or failed send leaves the words in the field.
			t.Logf("send %.20q: %d %s", m, rec.Code, strings.TrimSpace(rec.Body.String()))
			field = append(field, m)
			continue
		}
		sent = append(sent, m)
	}
	sentBy := time.Since(start)
	if wait := stopAt - sentBy; wait > 0 {
		time.Sleep(wait)
	}

	stop := map[string]any{}
	if len(sent) > 0 {
		stop["returnPrompt"] = sent[0]
	}
	if len(sent) > 1 {
		stop["restoreQueue"] = sent[1:]
	}
	body, _ := json.Marshal(stop)
	rec := replayPost(h, osUser, "/cancel/"+sock, string(body))
	var reply struct {
		Restored bool `json:"restored"`
		Returned bool `json:"returned"`
	}
	if len(stop) > 0 {
		if rec.Code != http.StatusOK {
			t.Fatalf("cancel = %d %s", rec.Code, rec.Body.String())
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &reply); err != nil {
			t.Fatalf("cancel reply %q: %v", rec.Body.String(), err)
		}
	}
	if reply.Returned {
		field = append(field, sent[0])
	}
	if reply.Restored {
		field = append(field, sent[1:]...)
	}

	pane := settledPane(t, in, osUser, sock)
	conv := paneRows(joinedPane(t, sock), "SUBMITTED=")
	t.Logf("sent by %v, stop at %v: returned=%v restored=%v conversation=%q",
		sentBy.Round(time.Millisecond), stopAt, reply.Returned, reply.Restored, conv)

	for _, m := range msgs {
		inConv := 0
		for _, c := range conv {
			if replayWords(c) == replayWords(m) {
				inConv++
			}
		}
		inField := 0
		for _, f := range field {
			if f == m {
				inField++
			}
		}
		if inConv+inField != 1 {
			t.Errorf("%.40q reached Claude %d times and came back to the field %d times, want exactly one of the two\npane:\n%s",
				m, inConv, inField, pane)
		}
	}
	if box := boxText(pane); box != "" {
		t.Errorf("Claude's input box still holds %q\npane:\n%s", box, pane)
	}
	if reply.Returned {
		stamp, _ := in.Option(osUser, sock, sessionio.OptionRewound)
		if stampKey(stamp) != stampKey(sessionio.RewoundStamp(sent[0], 0)) {
			t.Errorf("rewound stamp %q does not name the returned message %.40q", stamp, sent[0])
		}
	}
}

// longReplayMessage is long enough to go as several pastes (sessionio
// pasteChunks: 640 units or 2 line breaks a paste) and to wrap over many rows.
func longReplayMessage() string {
	var b strings.Builder
	for i := 1; i <= 6; i++ {
		fmt.Fprintf(&b, "Paragraph %d asks for a careful reading of the notes, a summary of what changed, and a list of the open questions that remain. ", i)
		b.WriteString(strings.Repeat("More words to make it long. ", 6))
		if i%2 == 0 {
			b.WriteString("\n")
		}
	}
	return strings.TrimSpace(b.String())
}

var replayPictureRE = regexp.MustCompile(`\[Image #\d+\]|/\S+\.(?:png|jpe?g|gif|webp)`)

// replayWords is a prompt's words with whitespace ignored and each picture,
// by path or by the "[Image #N]" Claude draws for it, read as one mark: the
// message as sent and the conversation's copy then compare equal.
func replayWords(s string) string {
	s = strings.ReplaceAll(s, "⏎", "\n")
	s = replayPictureRE.ReplaceAllString(s, "\x00")
	return strings.Join(strings.Fields(s), "")
}

func stampKey(stamp string) string {
	_, key, _ := strings.Cut(stamp, " ")
	return key
}

// settledPane reads the pane once the stand-in has stopped changing: a
// prompt it puts back on the input line lands FAKEINPUT_RESTORE_MS after the
// interrupt, and a picture attaches after its own delay.
func settledPane(t *testing.T, in *sessionio.Injector, osUser, session string) string {
	t.Helper()
	var last string
	stableSince := time.Now()
	deadline := time.Now().Add(5 * time.Second)
	for {
		pane, err := in.CapturePane(osUser, session)
		if err != nil {
			t.Fatalf("capture: %v", err)
		}
		if pane != last {
			last, stableSince = pane, time.Now()
		}
		if time.Since(stableSince) >= 700*time.Millisecond || !time.Now().Before(deadline) {
			return last
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// joinedPane is the pane with rows tmux wrapped joined back together, which
// is how a long SUBMITTED= line reads whole.
func joinedPane(t *testing.T, sock string) string {
	t.Helper()
	out, err := exec.Command("tmux", "-L", sock, "capture-pane", "-p", "-J", "-t", sock).Output()
	if err != nil {
		t.Fatalf("capture-pane -J: %v", err)
	}
	return string(out)
}

func paneRows(pane, prefix string) []string {
	var got []string
	for _, l := range strings.Split(pane, "\n") {
		if s, ok := strings.CutPrefix(l, prefix); ok {
			got = append(got, strings.TrimRight(s, " "))
		}
	}
	return got
}

// boxText is what the stand-in's input box holds: the rows from the prompt
// mark to the rule under it, the mark itself left out.
func boxText(pane string) string {
	lines := strings.Split(pane, "\n")
	for i, l := range lines {
		rest, ok := strings.CutPrefix(l, "❯")
		if !ok {
			continue
		}
		rows := []string{strings.TrimSpace(rest)}
		for _, r := range lines[i+1:] {
			if strings.HasPrefix(r, "─") {
				break
			}
			rows = append(rows, strings.TrimSpace(r))
		}
		return strings.TrimSpace(strings.Join(rows, "\n"))
	}
	return ""
}

var replaySeq atomic.Int64

// replayBox runs the stand-in input box with env in an isolated tmux server,
// in a session named like the server. The name is also what POST /prompt and
// POST /cancel hold the input line by (inputLines), so runs that shared one
// would wait on each other.
func replayBox(t *testing.T, env string) (*sessionio.Injector, string, string) {
	t.Helper()
	u, err := user.Current()
	if err != nil {
		t.Skip("no current user")
	}
	script, err := filepath.Abs("../sessionio/testdata/fakeinput.py")
	if err != nil {
		t.Fatal(err)
	}
	sock := fmt.Sprintf("se-replay-%d-%d", os.Getpid(), replaySeq.Add(1))
	t.Cleanup(func() {
		_ = exec.Command("tmux", "-L", sock, "kill-server").Run()
	})
	cmd := fmt.Sprintf("%s python3 %s", env, script)
	if err := exec.Command("tmux", "-L", sock, "new-session", "-d", "-s", sock,
		"-x", "120", "-y", "50", cmd).Run(); err != nil {
		t.Fatalf("new-session: %v", err)
	}
	in := sessionio.NewInjectorOnSocket(u.Username, sock)
	deadline := time.Now().Add(20 * time.Second)
	for {
		pane, err := in.CapturePane(u.Username, sock)
		if err == nil && strings.Contains(pane, "INPUT-READY") {
			return in, u.Username, sock
		}
		if !time.Now().Before(deadline) {
			t.Fatalf("the stand-in input box never started; pane:\n%s", pane)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func replayMux(t *testing.T, in *sessionio.Injector, osUser string) http.Handler {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	rg := newRegistry(ctx, time.Millisecond, t.TempDir(), siotest.NewFakeOptions(), osUser)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /prompt/{session}", handlePrompt(rg, in))
	mux.HandleFunc("POST /cancel/{session}", handleCancel(rg, in))
	return mux
}

func replayPost(h http.Handler, osUser, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req = req.WithContext(context.WithValue(req.Context(), osUserKey, osUser))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// requireReplayTools skips without tmux or python3 on a developer's box, and
// fails under CI, where a skip would let a Stop regression through in silence.
func requireReplayTools(t *testing.T) {
	t.Helper()
	for _, tool := range []string{"tmux", "python3"} {
		if _, err := exec.LookPath(tool); err != nil {
			if os.Getenv("CI") != "" {
				t.Fatalf("the Stop replay needs %s, and CI must run it", tool)
			}
			t.Skipf("%s not available", tool)
		}
	}
}
