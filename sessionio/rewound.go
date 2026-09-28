package sessionio

import "strings"

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
}

// opened records a prompt that has just opened a turn as the one a Stop can
// still take back. A slash command never reaches Claude, and a `!` command's
// output follows it as another user record, so neither is one.
func (n *Normalizer) opened(rec Record, blocks []Block, at int64) {
	n.open = nil
	if rec.IsSidechain && !n.agent {
		return
	}
	text := strings.TrimSpace(blockText(blocks))
	if text == "" || strings.HasPrefix(text, "/") || strings.HasPrefix(text, "<command-") ||
		strings.HasPrefix(text, "<bash-") {
		return
	}
	n.open = &openPrompt{turnID: n.turnID, text: text, at: at}
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
		// Written with it: the same batch, answered together.
		n.open = nil
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
func (n *Normalizer) Rewind(text string, at int64) []Event {
	if n.open != nil && sameWords(n.open.text, text) {
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
	if n.open == nil || !sameWords(n.open.text, n.rewindText) {
		return nil
	}
	n.rewindText, n.rewindAt = "", 0
	return n.rewound(at, true)
}

// rewound emits the marker for the open prompt and closes its turn when
// nothing has, streaming the turn's end when `end` says nobody else has.
func (n *Normalizer) rewound(at int64, end bool) []Event {
	p := n.open
	n.open = nil
	e := n.emit(KindMeta, at)
	e.Meta, e.Body, e.TurnID = MetaRewound, p.text, p.turnID
	out := []Event{e}
	if n.turnID == p.turnID && !n.turnDone {
		n.turnDone, n.doneMsg = true, ""
		if end {
			out = append(out, n.emit(KindTurnEnd, at))
		}
	}
	return out
}

// sameWords compares two texts with all whitespace ignored: the client's copy
// of a prompt is trimmed, and the pane wraps what it shows.
func sameWords(a, b string) bool {
	return squashSpace(a) == squashSpace(b)
}
