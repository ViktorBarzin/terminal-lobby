package sessionio

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

// A Stop that lands before Claude has written anything for the turn takes the
// prompt OUT of the conversation: Claude Code puts it back on its input line
// and its own view shows no trace of it. The transcript keeps the prompt's
// record, so read naively the prompt stays in the chat as sent, and whatever
// starts the next turn (a task notification, the next prompt) reads as its
// answer. Found in the live check of the T3 pass on 2026-09-28.

func promptLine(text, ts string) []byte {
	return []byte(`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"` + text + `"}]},"timestamp":"` + ts + `"}`)
}

func rewoundOf(evs []Event) []Event {
	var out []Event
	for _, e := range evs {
		if e.Kind == KindMeta && e.Meta == MetaRewound {
			out = append(out, e)
		}
	}
	return out
}

// The next prompt arriving with nothing from Claude in between says the one
// before it was taken back. Measured on CLI 2.1.283: no assistant record and
// no interrupt notice separate the two.
func TestNormalizerPromptFollowedByAPromptWasRewound(t *testing.T) {
	n := NewNormalizer("demo")
	first := n.Line(promptLine("Write a long story, take 1500.", "2026-09-28T02:29:22Z"))
	next := n.Line(promptLine("Write a long story, take 2500.", "2026-09-28T02:29:29Z"))
	got := rewoundOf(next)
	if len(got) != 1 {
		t.Fatalf("next prompt produced %v, want one rewound marker before it", kinds(next))
	}
	if got[0].TurnID != first[0].TurnID {
		t.Fatalf("rewound names turn %q, want the taken-back prompt's %q", got[0].TurnID, first[0].TurnID)
	}
	if got[0].Body != "Write a long story, take 1500." {
		t.Fatalf("rewound body = %q, want the taken-back prompt's text", got[0].Body)
	}
	if next[0].Kind != KindMeta || next[len(next)-1].Kind != KindUser {
		t.Fatalf("order = %v, want the marker (and the old turn's end) before the new prompt", kinds(next))
	}
	if next[len(next)-1].TurnID == first[0].TurnID {
		t.Fatal("the new prompt landed in the taken-back prompt's turn")
	}
}

// The turn the taken-back prompt opened is closed with it, or a replay that
// never saw the interrupt leaves it open.
func TestNormalizerRewoundPromptClosesItsTurn(t *testing.T) {
	n := NewNormalizer("demo")
	first := n.Line(promptLine("Write a 300 word essay about kiwis.", "2026-09-28T02:20:37Z"))
	next := n.Line([]byte(`{"type":"user","message":{"role":"user","content":"<task-notification>\n<summary>Background command \"sleep 5\" completed (exit code 0)</summary>\n</task-notification>"},"timestamp":"2026-09-28T02:20:43Z"}`))
	if len(rewoundOf(next)) != 1 {
		t.Fatalf("a task notification after an unanswered prompt produced %v, want a rewound marker", kinds(next))
	}
	ended := false
	for _, e := range next {
		if e.Kind == KindTurnEnd && e.TurnID == first[0].TurnID {
			ended = true
		}
	}
	if !ended {
		t.Fatalf("events %v leave the taken-back prompt's turn open", kinds(next))
	}
}

// A prompt Claude answered, even with thinking alone, is part of the
// conversation, and so is one stopped with the CLI's own notice.
func TestNormalizerAnsweredPromptIsNotRewound(t *testing.T) {
	cases := map[string][]string{
		"answered": {
			`{"type":"assistant","message":{"id":"m1","role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"ok"}]},"timestamp":"2026-09-28T02:00:01Z"}`,
		},
		"thinking only": {
			`{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"thinking","thinking":"","signature":"x"}]},"timestamp":"2026-09-28T02:00:01Z"}`,
		},
		"interrupt notice": {
			`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]},"timestamp":"2026-09-28T02:00:01Z"}`,
		},
	}
	for name, between := range cases {
		t.Run(name, func(t *testing.T) {
			n := NewNormalizer("demo")
			var all []Event
			all = append(all, n.Line(promptLine("first", "2026-09-28T02:00:00Z"))...)
			for _, l := range between {
				all = append(all, n.Line([]byte(l))...)
			}
			all = append(all, n.Line(promptLine("second", "2026-09-28T02:00:05Z"))...)
			if got := rewoundOf(all); len(got) != 0 {
				t.Fatalf("got %+v, want no rewound marker", got)
			}
		})
	}
}

// A slash command the CLI answers itself never reaches Claude, and a `!`
// command's output follows its input as another user record. Neither was
// taken back.
func TestNormalizerCommandsAreNotRewound(t *testing.T) {
	n := NewNormalizer("demo")
	var all []Event
	all = append(all, n.Line([]byte(`{"type":"user","message":{"role":"user","content":"<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>"},"timestamp":"2026-09-28T02:00:00Z"}`))...)
	all = append(all, n.Line([]byte(`{"type":"user","message":{"role":"user","content":"<local-command-stdout>Set model to opus</local-command-stdout>"},"timestamp":"2026-09-28T02:00:01Z"}`))...)
	all = append(all, n.Line([]byte(`{"type":"user","message":{"role":"user","content":"<bash-input>ls</bash-input>"},"timestamp":"2026-09-28T02:00:02Z"}`))...)
	all = append(all, n.Line([]byte(`{"type":"user","message":{"role":"user","content":"<bash-stdout>a.txt</bash-stdout><bash-stderr></bash-stderr>"},"timestamp":"2026-09-28T02:00:03Z"}`))...)
	all = append(all, n.Line(promptLine("hello", "2026-09-28T02:00:04Z"))...)
	if got := rewoundOf(all); len(got) != 0 {
		t.Fatalf("got %+v, want no rewound marker", got)
	}
}

// The live path: the cancel route saw the prompt land back on the input line
// and says so, and the marker goes out now rather than when the next turn
// starts.
func TestNormalizerRewindMarksTheOpenPrompt(t *testing.T) {
	n := NewNormalizer("demo")
	first := n.Line(promptLine("Write a long story about a lighthouse keeper.", "2026-09-28T02:29:22Z"))
	n.Interrupt(mustAt(t, "2026-09-28T02:29:24Z"))
	out := n.Rewind("  Write a long story about a lighthouse keeper.\n", mustAt(t, "2026-09-28T02:29:24Z"))
	got := rewoundOf(out)
	if len(got) != 1 || got[0].TurnID != first[0].TurnID {
		t.Fatalf("Rewind produced %+v, want one marker for turn %q", out, first[0].TurnID)
	}
	if countKind(out, KindTurnEnd) != 0 {
		t.Fatalf("the interrupt already closed the turn; Rewind closed it again: %v", kinds(out))
	}
	// The next prompt does not take back the same one twice.
	if again := rewoundOf(n.Line(promptLine("next", "2026-09-28T02:29:30Z"))); len(again) != 0 {
		t.Fatalf("next prompt marked the same prompt again: %+v", again)
	}
}

// A different text is not the prompt that went back, and nothing is marked.
func TestNormalizerRewindIgnoresAnotherText(t *testing.T) {
	n := NewNormalizer("demo")
	n.Line(promptLine("one thing", "2026-09-28T02:29:22Z"))
	if out := n.Rewind("another thing", mustAt(t, "2026-09-28T02:29:24Z")); len(rewoundOf(out)) != 0 {
		t.Fatalf("Rewind marked a prompt with other words: %+v", out)
	}
}

// The tail reads the transcript on a tick, so the prompt's record can arrive
// after the cancel said it went back. It is marked as it lands.
func TestNormalizerRewindBeforeTheRecordMarksItOnArrival(t *testing.T) {
	n := NewNormalizer("demo")
	at := mustAt(t, "2026-09-28T02:29:24Z")
	n.Interrupt(at)
	if out := n.Rewind("say KIWI", at); len(out) != 0 {
		t.Fatalf("nothing recorded yet, Rewind produced %v", kinds(out))
	}
	out := n.Line(promptLine("say KIWI", "2026-09-28T02:29:23Z"))
	got := rewoundOf(out)
	if len(got) != 1 || got[0].TurnID != out[0].TurnID {
		t.Fatalf("late record produced %v, want its user event and a marker for its turn", kinds(out))
	}
	// A prompt sent after that is not caught by it.
	if later := rewoundOf(n.Line(promptLine("say KIWI", "2026-09-28T02:29:40Z"))); len(later) != 0 {
		t.Fatalf("a later prompt with the same words was marked: %+v", later)
	}
}

// Deployed review round 1 (2026-09-28): the marker and the Stop's own turn end
// live only in the running session-events. After a restart the transcript
// ends on the taken-back prompt with nothing after it, and every device drew
// it as a sent bubble under a "Working…" row that never ended. The cancel
// route stamps the session (RewoundStamp), and a fresh source reads it back.
func TestNormalizerRestoreRewoundMarksTheTrailingPrompt(t *testing.T) {
	n := NewNormalizer("demo")
	n.Line(promptLine("hello", "2026-09-28T08:20:00Z"))
	n.Line([]byte(`{"type":"assistant","message":{"id":"m1","role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"hi"}]},"timestamp":"2026-09-28T08:20:02Z"}`))
	opened := n.Line(promptLine("Run sleep 20 then say finished", "2026-09-28T08:30:48Z"))
	stopped := parseAt("2026-09-28T08:30:50Z")
	got := n.RestoreRewound(RewoundStamp("Run sleep 20  then say finished", stopped))
	marks := rewoundOf(got)
	if len(marks) != 1 || marks[0].TurnID != opened[0].TurnID {
		t.Fatalf("restore produced %v, want one rewound marker for the trailing prompt", kinds(got))
	}
	ended := false
	for _, e := range got {
		if e.Kind == KindTurnEnd {
			ended = true
		}
	}
	if !ended {
		t.Fatalf("restore produced %v and left the taken-back turn open", kinds(got))
	}
}

func TestNormalizerRestoreRewoundLeavesOtherPromptsAlone(t *testing.T) {
	stamp := RewoundStamp("Run sleep 20 then say finished", parseAt("2026-09-28T08:30:50Z"))
	cases := map[string][][]byte{
		"a different prompt": {promptLine("something else", "2026-09-28T08:30:48Z")},
		// The same words sent again after the Stop, and running now.
		"the same words sent later": {promptLine("Run sleep 20 then say finished", "2026-09-28T08:31:10Z")},
		"an answered prompt": {
			promptLine("Run sleep 20 then say finished", "2026-09-28T08:30:48Z"),
			[]byte(`{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"ok"}]},"timestamp":"2026-09-28T08:30:49Z"}`),
		},
	}
	for name, lines := range cases {
		n := NewNormalizer("demo")
		for _, l := range lines {
			n.Line(l)
		}
		if got := n.RestoreRewound(stamp); len(got) != 0 {
			t.Errorf("%s: restore produced %v, want nothing", name, kinds(got))
		}
	}
	n := NewNormalizer("demo")
	n.Line(promptLine("Run sleep 20 then say finished", "2026-09-28T08:30:48Z"))
	for _, bad := range []string{"", "garbage", "12 ", "x abc"} {
		if got := n.RestoreRewound(bad); len(got) != 0 {
			t.Errorf("stamp %q: restore produced %v, want nothing", bad, kinds(got))
		}
	}
}

// Deployed review round 4 (2026-09-28): two prompts queued behind Claude's
// final reply ran as one batch, each its own record 2 ms apart, and a Stop
// before Claude answered put both back on the input line. The cancel route
// names the whole batch, and every prompt in it leaves the conversation.
func batchLines() [][]byte {
	return [][]byte{
		promptLine("Write a paragraph", "2026-09-28T19:10:30Z"),
		[]byte(`{"type":"assistant","message":{"id":"m1","role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"A paragraph."}]},"timestamp":"2026-09-28T19:10:40Z"}`),
		promptLine("queued msg 1", "2026-09-28T19:10:41.100Z"),
		promptLine("queued msg 2", "2026-09-28T19:10:41.102Z"),
	}
}

func userTurns(evs []Event) []string {
	var out []string
	for _, e := range evs {
		if e.Kind == KindUser {
			out = append(out, e.TurnID)
		}
	}
	return out
}

func rewoundTurns(evs []Event) []string {
	var out []string
	for _, e := range rewoundOf(evs) {
		out = append(out, e.TurnID)
	}
	return out
}

func TestNormalizerRewindMarksEveryPromptOfABatch(t *testing.T) {
	n := NewNormalizer("demo")
	var all []Event
	for _, l := range batchLines() {
		all = append(all, n.Line(l)...)
	}
	users := userTurns(all)
	at := mustAt(t, "2026-09-28T19:10:42Z")
	n.Interrupt(at)
	out := n.Rewind("queued msg 1\n\nqueued msg 2", at)
	got := rewoundTurns(out)
	if len(got) != 2 || got[0] != users[1] || got[1] != users[2] {
		t.Fatalf("Rewind marked turns %v, want both batch prompts' %v", got, users[1:])
	}
	if b := rewoundOf(out); b[0].Body != "queued msg 1" || b[1].Body != "queued msg 2" {
		t.Fatalf("marker bodies = %q, %q, want each prompt's own words", b[0].Body, b[1].Body)
	}
}

func TestNormalizerRewindBeforeABatchArrivesMarksItAll(t *testing.T) {
	n := NewNormalizer("demo")
	lines := batchLines()
	n.Line(lines[0])
	n.Line(lines[1])
	at := mustAt(t, "2026-09-28T19:10:42Z")
	n.Interrupt(at)
	if out := n.Rewind("queued msg 1\n\nqueued msg 2", at); len(out) != 0 {
		t.Fatalf("nothing of the batch recorded yet, Rewind produced %v", kinds(out))
	}
	first := n.Line(lines[2])
	second := n.Line(lines[3])
	got := append(rewoundTurns(first), rewoundTurns(second)...)
	want := append(userTurns(first), userTurns(second)...)
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("batch arriving after the Stop marked %v, want %v", got, want)
	}
}

func TestNormalizerRestoreRewoundMarksATrailingBatch(t *testing.T) {
	n := NewNormalizer("demo")
	var all []Event
	for _, l := range batchLines() {
		all = append(all, n.Line(l)...)
	}
	got := rewoundTurns(n.RestoreRewound(RewoundStamp("queued msg 1\n\nqueued msg 2", parseAt("2026-09-28T19:10:42Z"))))
	if users := userTurns(all); len(got) != 2 || got[0] != users[1] || got[1] != users[2] {
		t.Fatalf("restore marked %v, want both batch prompts' turns %v", got, users[1:])
	}
}

// A batch the next prompt follows with nothing from Claude in between went
// back to the input line whole.
func TestNormalizerBatchFollowedByAPromptWasRewoundWhole(t *testing.T) {
	n := NewNormalizer("demo")
	for _, l := range batchLines() {
		n.Line(l)
	}
	next := n.Line(promptLine("THIRD", "2026-09-28T19:10:50Z"))
	if got := rewoundOf(next); len(got) != 2 {
		t.Fatalf("next prompt after a taken-back batch produced %d markers, want 2", len(got))
	}
}

// A Stop can name only the first prompt of a batch: the client's own copy of
// it was still waiting on the transcript when the batch started. The reclaim
// clears the whole input line, which holds the whole batch, so every prompt of
// it went back and every one is marked (deployed review round 5, 2026-09-29:
// the others' bubbles stayed in the conversation as if sent).
func TestNormalizerRewindOfABatchsFirstPromptMarksItAll(t *testing.T) {
	n := NewNormalizer("demo")
	var all []Event
	for _, l := range batchLines() {
		all = append(all, n.Line(l)...)
	}
	users := userTurns(all)
	at := mustAt(t, "2026-09-28T19:10:42Z")
	n.Interrupt(at)
	got := rewoundTurns(n.Rewind("queued msg 1", at))
	if len(got) != 2 || got[0] != users[1] || got[1] != users[2] {
		t.Fatalf("Rewind of the first prompt marked %v, want the whole batch %v", got, users[1:])
	}
}

// Words that are not how the batch starts still mark nothing.
func TestNormalizerRewindOfTheBatchsLastPromptAloneMarksNothing(t *testing.T) {
	n := NewNormalizer("demo")
	for _, l := range batchLines() {
		n.Line(l)
	}
	at := mustAt(t, "2026-09-28T19:10:42Z")
	n.Interrupt(at)
	if got := rewoundOf(n.Rewind("queued msg 2", at)); len(got) != 0 {
		t.Fatalf("Rewind of words the batch does not start with marked %d prompts", len(got))
	}
}

// The source reports the words it marked, so the stamp a later source reads
// back names the whole batch (RestoreRewound).
func TestFileSourceRewindReportsTheWordsItMarked(t *testing.T) {
	n := NewNormalizer("demo")
	for _, l := range batchLines() {
		n.Line(l)
	}
	f := &FileSource{norm: n}
	at := mustAt(t, "2026-09-28T19:10:42Z")
	n.Interrupt(at)
	if got := f.Rewind("queued msg 1", at); !sameWords(got, "queued msg 1\nqueued msg 2") {
		t.Fatalf("Rewind reported %q, want the batch's words", got)
	}
}

// Deployed review round 3 of the T3 pass (CLI 2.1.284, 2026-09-29): the Stop
// names each picture by the path the lobby sent, and the transcript records
// "[Image #N]" in its place, beside the picture's image block. Compared as
// plain words the two never matched, so a picture prompt a Stop took back
// stayed in the chat as sent, on every device and after a reload.
const (
	picturePrompt = "[Image #1] [Image #2]  Which words are in these pictures?"
	pictureReturn = "/var/lib/clipboard-store/wizard/s/pasted-a.png /var/lib/clipboard-store/wizard/s/pasted-b.png  Which words are in these pictures?"
)

func picturePromptLine(ts string) []byte {
	return []byte(`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"` + picturePrompt + `"},` +
		`{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo="}},` +
		`{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo="}}]},"timestamp":"` + ts + `"}`)
}

func TestNormalizerRewindMarksAPicturePrompt(t *testing.T) {
	n := NewNormalizer("demo")
	first := n.Line(picturePromptLine("2026-09-29T11:52:24Z"))
	at := mustAt(t, "2026-09-29T11:52:25Z")
	n.Interrupt(at)
	got := rewoundOf(n.Rewind(pictureReturn, at))
	if len(got) != 1 || got[0].TurnID != first[0].TurnID {
		t.Fatalf("Rewind of the picture prompt produced %+v, want one marker for turn %q", got, first[0].TurnID)
	}
}

func TestNormalizerRewindBeforeAPicturePromptArrivesMarksIt(t *testing.T) {
	n := NewNormalizer("demo")
	at := mustAt(t, "2026-09-29T11:52:25Z")
	n.Interrupt(at)
	if out := n.Rewind(pictureReturn, at); len(out) != 0 {
		t.Fatalf("nothing recorded yet, Rewind produced %v", kinds(out))
	}
	if got := rewoundOf(n.Line(picturePromptLine("2026-09-29T11:52:24Z"))); len(got) != 1 {
		t.Fatalf("the picture prompt arrived unmarked: %+v", got)
	}
}

func TestNormalizerRestoreRewoundMarksAPicturePrompt(t *testing.T) {
	n := NewNormalizer("demo")
	n.Line(picturePromptLine("2026-09-29T11:52:24Z"))
	stamp := RewoundStamp(pictureReturn, parseAt("2026-09-29T11:52:25Z"))
	if got := rewoundOf(n.RestoreRewound(stamp)); len(got) != 1 {
		t.Fatalf("restore left the picture prompt as sent: %+v", got)
	}
}

// Other words around the same pictures are another prompt.
func TestNormalizerRewindOfOtherWordsAroundPicturesMarksNothing(t *testing.T) {
	n := NewNormalizer("demo")
	n.Line(picturePromptLine("2026-09-29T11:52:24Z"))
	other := "/var/lib/clipboard-store/wizard/s/pasted-a.png /var/lib/clipboard-store/wizard/s/pasted-b.png  Something else entirely"
	if got := rewoundOf(n.Rewind(other, mustAt(t, "2026-09-29T11:52:25Z"))); len(got) != 0 {
		t.Fatalf("Rewind marked a picture prompt with other words: %+v", got)
	}
}

// A stamp written before pictures were read this way names a text-only
// prompt by the same key, so a session stamped by the previous build still
// restores.
func TestRewoundStampOfPlainWordsIsUnchanged(t *testing.T) {
	const want = "1790682744917 "
	stamp := RewoundStamp("Run sleep 20 then say finished", 1790682744917)
	sum := sha256.Sum256([]byte("Runsleep20thensayfinished"))
	if stamp != want+hex.EncodeToString(sum[:16]) {
		t.Fatalf("stamp %q no longer matches the previous build's key", stamp)
	}
}
