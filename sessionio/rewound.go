package sessionio

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
)

// MetaRewound says a prompt was taken back out of the conversation: Claude
// Code put it back on its input line and its own view no longer shows it.
// TurnID is the turn the prompt opened and Body its text. A client drops that
// turn's prompt, and the turn is closed with it.
//
// It happens when a Stop lands before Claude has written anything for the
// turn. Measured on CLI 2.1.283 on 2026-09-28 with a scratch session: C-c at
// 0.5, 1, 1.5, 2.5, 6 and 10 seconds after the prompt, with nothing from
// Claude yet, put the prompt back on the input line within 40 to 270 ms every
// time. The transcript keeps the prompt's record, writes no interrupt notice,
// and the next record in the thread is whatever starts the next turn, so read
// naively the prompt stays in the chat as sent and the next turn's reply reads
// as its answer.
const MetaRewound Meta = "rewound"

// batchWindow is how close two prompts are when the CLI wrote them together.
// Prompts queued behind a turn are submitted as one batch when it ends, each
// its own record and none answered until the last is in: 1 ms apart in all
// five batches in the transcripts on this box on 2026-09-28. A prompt taken
// back and the next record were 4.6 s apart at the least, over 21 cases.
const batchWindow = 1000

// openPrompt is the thread's latest prompt while Claude has written nothing
// for it.
type openPrompt struct {
	turnID string
	text   string
	at     int64
	// earlier are the prompts the CLI wrote in the same batch before this one,
	// oldest first. A Stop puts the whole batch back on the input line, one
	// prompt per line (deployed review round 4, 2026-09-28).
	earlier []openPrompt
}

// all is the batch, oldest first, this prompt last.
func (p *openPrompt) all() []openPrompt {
	return append(append([]openPrompt{}, p.earlier...), openPrompt{turnID: p.turnID, text: p.text, at: p.at})
}

// words is the batch's text as the input line holds it, one prompt per line.
func (p *openPrompt) words() string {
	var texts []string
	for _, q := range p.all() {
		texts = append(texts, q.text)
	}
	return strings.Join(texts, "\n")
}

// startsWith reports whether text is the batch's first prompts, all of them
// or some, whitespace ignored.
func (p *openPrompt) startsWith(text string) bool {
	if strings.TrimSpace(text) == "" {
		return false
	}
	var texts []string
	for _, q := range p.all() {
		texts = append(texts, q.text)
		if sameWords(strings.Join(texts, "\n"), text) {
			return true
		}
	}
	return false
}

// opened records a prompt that has just opened a turn as the one a Stop can
// still take back. A slash command never reaches Claude, and a `!` command's
// output follows it as another user record, so neither is one. A prompt
// written within batchWindow of the open one joins its batch.
func (n *Normalizer) opened(rec Record, blocks []Block, at int64) {
	prev := n.open
	n.open = nil
	if rec.IsSidechain && !n.agent {
		return
	}
	text := strings.TrimSpace(blockText(blocks))
	if text == "" || strings.HasPrefix(text, "/") || strings.HasPrefix(text, "<command-") ||
		strings.HasPrefix(text, "<bash-") {
		return
	}
	p := &openPrompt{turnID: n.turnID, text: text, at: at}
	if prev != nil && at > 0 && prev.at > 0 && at-prev.at < batchWindow {
		p.earlier = prev.all()
	}
	n.open = p
}

// takenBack reads a conversation record for what it says about the open
// prompt, and returns the marker when the record shows it was taken back.
//
// Claude writing anything in the thread answers the prompt, and the CLI's own
// interrupt notice settles it as stopped. A user record with words in it that
// starts the next turn (another prompt, a task notification, a command's
// caveat), with neither in between, says the prompt went back to the input
// line. A tool result is Claude's own work coming back and says nothing.
func (n *Normalizer) takenBack(rec Record, role string, blocks []Block, at int64) []Event {
	if n.open == nil || (rec.IsSidechain && !n.agent) {
		return nil
	}
	if role == "assistant" {
		n.open = nil
		return nil
	}
	if role != "user" || rec.IsMeta || !hasBlock(blocks, "text") {
		return nil
	}
	if _, ok := interruptNotice(role, rec.IsMeta, blocks); ok {
		n.open = nil
		return nil
	}
	if at > 0 && n.open.at > 0 && at-n.open.at < batchWindow {
		// Written with it: the same batch, answered or taken back together.
		// The prompt joins it as it opens its turn (opened).
		return nil
	}
	return n.rewound(at, true)
}

// Rewind marks the open prompt as taken back, for the cancel route that saw
// its text land back on the input line at `at` (epoch ms). The marker goes
// out now rather than when the next turn starts.
//
// The tail reads the transcript on a tick, so the prompt's record may not have
// been read yet. Then the next prompt record with the same words, written at
// or before `at`, is marked as it arrives (rewindOnArrival).
//
// The caller has just interrupted the turn, and Interrupt has already streamed
// its end, so the turn is closed here without a second one.
//
// The text may name only the batch's first prompts: the client's copy of the
// first was still waiting on the transcript when the batch started. The
// reclaim clears the whole input line, which holds the whole batch, so the
// whole batch is marked (deployed review round 5, 2026-09-29).
func (n *Normalizer) Rewind(text string, at int64) []Event {
	if n.open != nil && n.open.startsWith(text) {
		return n.rewound(at, false)
	}
	n.rewindText, n.rewindAt = text, at
	return nil
}

// rewindOnArrival marks a prompt that has just opened its turn when the cancel
// route already said it went back (Rewind). Any prompt written after that
// moment ends the wait.
func (n *Normalizer) rewindOnArrival(at int64) []Event {
	if n.rewindAt == 0 {
		return nil
	}
	if at > n.rewindAt {
		n.rewindText, n.rewindAt = "", 0
		return nil
	}
	if n.open == nil || !sameWords(n.open.words(), n.rewindText) {
		return nil
	}
	n.rewindText, n.rewindAt = "", 0
	return n.rewound(at, true)
}

// rewound emits a marker for each prompt of the open batch and closes the
// last one's turn when nothing has, streaming the turn's end when `end` says
// nobody else has.
func (n *Normalizer) rewound(at int64, end bool) []Event {
	p := n.open
	n.open = nil
	var out []Event
	for _, q := range p.all() {
		e := n.emit(KindMeta, at)
		e.Meta, e.Body, e.TurnID = MetaRewound, q.text, q.turnID
		out = append(out, e)
	}
	if n.turnID == p.turnID && !n.turnDone {
		n.turnDone, n.doneMsg = true, ""
		if end {
			out = append(out, n.emit(KindTurnEnd, at))
		}
	}
	return out
}

// sameWords compares two texts with all whitespace ignored: the client's copy
// of a prompt is trimmed, and the pane wraps what it shows. A picture reads
// the same named by its path, as the client sends it, or by the "[Image #N]"
// the transcript records (pictureWords).
func sameWords(a, b string) bool {
	return pictureWords(a) == pictureWords(b)
}

// OptionRewound is the session option the cancel route stamps when a Stop
// took a prompt back (RewoundStamp): when it happened and which words. The
// marker Rewind streams, and the turn end the Stop streams, live only in the
// running session-events, and the transcript keeps the prompt's record with
// nothing after it. So after a restart the prompt read as a turn still
// running, on every device, until the next prompt (deployed review round 1,
// 2026-09-28). A fresh source reads the stamp back (RestoreRewound). It is a
// session option, so it goes with the session.
const OptionRewound = "@tl_rewound"

// RewoundStamp is OptionRewound's value for a prompt that went back to the
// input line at `at` (epoch ms): the time and a hash of its words, whitespace
// ignored. The hash keeps a long prompt out of tmux.
func RewoundStamp(text string, at int64) string {
	return strconv.FormatInt(at, 10) + " " + wordsKey(text)
}

// wordsKey is a hash of a text's words, read as sameWords reads them. Text
// without pictures hashes as it did before pictures were read this way, so an
// older stamp still names its prompt.
func wordsKey(text string) string {
	sum := sha256.Sum256([]byte(pictureWords(text)))
	return hex.EncodeToString(sum[:16])
}

// parseRewoundStamp reads RewoundStamp back.
func parseRewoundStamp(v string) (int64, string, error) {
	atStr, key, ok := strings.Cut(strings.TrimSpace(v), " ")
	if !ok || key == "" {
		return 0, "", fmt.Errorf("rewound stamp %q: want \"<ms> <key>\"", v)
	}
	at, err := strconv.ParseInt(atStr, 10, 64)
	if err != nil || at <= 0 {
		return 0, "", fmt.Errorf("rewound stamp %q: bad time", v)
	}
	return at, key, nil
}

// RestoreRewound marks the thread's trailing prompt as taken back when the
// stamp names it: the prompt is still unanswered, was written at or before
// the Stop, and has the stamp's words. A replay reads the transcript first,
// so only the last prompt can match; an earlier one with the same words was
// answered or taken back in its own right. Anything else, a malformed stamp
// included, is nothing.
func (n *Normalizer) RestoreRewound(stamp string) []Event {
	at, key, err := parseRewoundStamp(stamp)
	if err != nil || n.open == nil {
		return nil
	}
	if n.open.at > at || wordsKey(n.open.words()) != key {
		return nil
	}
	return n.rewound(at, true)
}
