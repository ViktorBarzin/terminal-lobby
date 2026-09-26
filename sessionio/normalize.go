package sessionio

import (
	"encoding/json"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Normalizer turns Claude Code transcript records into normalized Events.
// It is stateful only for the monotonic sequence, the current turn, the
// directory the session was launched in and the screenshot calls still waiting
// for their results, all of which the transcript itself decides, so a fresh
// Normalizer replays a transcript identically from the start.
//
// Turn model — the renderer folds finished turns and shows "Working…" only while
// one is running, so the wire has to carry the structure the transcript implies:
//
//   - a turn OPENS at the human's prompt: a non-meta line whose role is "user"
//     and which carries a text block. Lines typed "user" that carry only a
//     tool_result are the harness feeding Claude back its own tool output, not
//     the human speaking, and stay inside the running turn.
//   - a turn CLOSES when Claude's message stops for a reason other than
//     continuing (see EndsTurn), or when the operator interrupts it (see
//     InterruptNotice), which emits one KindTurnEnd.
//   - work that appears after a turn closed without a new prompt (a Stop hook
//     continuing the agent) opens a fresh turn, so it is never filed under a
//     turn the renderer has already settled.
type Normalizer struct {
	session     string
	seq         int64
	turnID      string
	turnN       int
	turnDone    bool   // the current turn has already emitted its turn_end
	doneMsg     string // message.id of the assistant response that closed it
	interruptAt int64  // epoch ms of an interrupt the transcript has not caught up with
	// skillPending is the skill named by the last "Launching skill:" receipt,
	// waiting for the body that follows it. Held for exactly one isMeta record:
	// the injection lands immediately after the receipt, and everything else
	// injected into a session (system reminders, caveats) must not be claimed by
	// a receipt still lying around. See skill.go for why the receipt rather than
	// the marker.
	skillPending string
	// model is the last model/effort pair reported, so the next one is only
	// reported when it differs. Every assistant record carries the pair, and a
	// marker on each of them would say nothing.
	model ModelState
	// root is the directory Claude Code was launched in: the cwd of the first
	// record that carries one. A screenshot's link is relative to it (see
	// shotFiles), and it is NOT the cwd of the record holding the link, which
	// differed in 65 of 85 census screenshots because Claude had cd'd. It is
	// the directory the transcript is filed under too (layout.go).
	root string
	// shots are the ids of browser_take_screenshot calls whose results have not
	// arrived yet. Each is deleted when its result lands.
	shots map[string]bool
	// agent is set when the transcript is one agent's own agent-<id>.jsonl,
	// where every record is a sidechain record (see NewAgentNormalizer).
	agent bool
}

func NewNormalizer(session string) *Normalizer { return &Normalizer{session: session} }

// NewAgentNormalizer reads one agent's own transcript, agent-<id>.jsonl, as a
// conversation of its own: the drill-in's stream. Every record in that file is
// a sidechain record, and there the flag says whose file it is rather than that
// the work nests under a call in someone else's thread. So nothing is marked
// for nesting, the agent's model is reported as this thread's model, and the
// prompt the agent was given opens its turn like any prompt.
func NewAgentNormalizer(session string) *Normalizer {
	return &Normalizer{session: session, agent: true}
}

// MaxInlineResult caps what one tool result may put on the wire. Measured over
// the transcripts on this box, tool results run to 673 KB and one session holds
// 5.5 MB of them; replaying that to a phone on open is not worth doing for
// output that renders collapsed. Past the cap the flattened text is cut with a
// marker and the structured form is dropped whole — truncating JSON would only
// produce something no reader can parse — and the event is marked Truncated so
// the renderer can offer to fetch the rest (see FullResult).
const MaxInlineResult = 8 << 10

// cap returns s cut to MaxInlineResult with a marker, and whether it cut.
func capText(s string) (string, bool) { return capTextTo(s, MaxInlineResult) }

// capTextTo is capText against an explicit budget. A string nested INSIDE a
// result has to leave room for the rest of the object, so it gets a smaller
// one — cut to the full cap, the enclosing JSON came out over the limit again
// and the whole result was dropped, which is the failure this exists to avoid.
func capTextTo(s string, max int) (string, bool) {
	if len(s) <= max {
		return s, false
	}
	return s[:max] + "\n… truncated, " + strconv.Itoa(len(s)-max) + " bytes not shown", true
}

// bulkyResultFields are the keys a structured tool result carries for the
// harness's benefit rather than a reader's. An Edit records `originalFile` —
// the ENTIRE file as it was before the change — beside the structuredPatch that
// describes the change itself, and a Write records the whole new `content`.
// They are what pushes a result past the cap, and they are the parts nothing
// renders.
var bulkyResultFields = []string{"originalFile", "content", "oldString", "newString"}

// pruneResult trims an oversized structured result to the parts a reader needs,
// and reports whether it had to change anything.
//
// Dropping an oversized result whole cost the diff: measured across the six most
// recent transcripts on this box, 209 tool results carried a structuredPatch and
// 54 of them exceeded MaxInlineResult — every one of those would have rendered
// as a file change with no visible change. Removing the bulky fields brings 48
// of the 54 back under the cap; the remaining 6 are patches that are genuinely
// enormous, and those are dropped rather than shown in part.
//
// Pruning is deliberately shallow and key-based. A result is a different shape
// per tool family, and guessing at nested structure would be how a future tool's
// output gets mangled; anything this does not recognise is left alone and judged
// on size, the same as before.
func pruneResult(raw json.RawMessage) (json.RawMessage, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	if len(raw) <= MaxInlineResult {
		return raw, false
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return nil, true // not an object — nothing safe to prune
	}
	for _, k := range bulkyResultFields {
		delete(fields, k)
	}
	// Command output is trimmed rather than removed: its head is usually the
	// part that says what happened, and stderr is short and almost always worth
	// keeping whole.
	for _, k := range []string{"stdout", "stderr"} {
		var s string
		if raw, ok := fields[k]; ok && json.Unmarshal(raw, &s) == nil {
			if cut, did := capTextTo(s, MaxInlineResult/2); did {
				if b, err := json.Marshal(cut); err == nil {
					fields[k] = b
				}
			}
		}
	}
	out, err := json.Marshal(fields)
	if err != nil || len(out) > MaxInlineResult {
		return nil, true
	}
	return out, true
}

func (n *Normalizer) next() int64 { n.seq++; return n.seq }

func (n *Normalizer) emit(k Kind, at int64) Event {
	return Event{ID: n.next(), Kind: k, Session: n.session, TurnID: n.turnID, At: at}
}

// startTurn opens a new turn; every event emitted from here on carries its id
// until the next boundary.
func (n *Normalizer) startTurn() {
	n.turnN++
	n.turnID = "t" + strconv.Itoa(n.turnN)
	n.turnDone, n.doneMsg = false, ""
}

// sameResponse reports whether this line is a further block of the assistant
// response that already closed the current turn. Claude writes one transcript
// line per content block (thinking, then text) and repeats the response's
// stop_reason on each, so the trailing lines of a finished reply must not be
// mistaken for work that resumed after the turn.
func (n *Normalizer) sameResponse(role, msgID string) bool {
	return role == "assistant" && msgID != "" && msgID == n.doneMsg
}

// Line normalizes one transcript JSONL line into zero or more Events.
// Unparseable input yields nil.
func (n *Normalizer) Line(b []byte) []Event {
	rec, ok := DecodeRecord(b)
	if !ok {
		return nil
	}
	return n.Record(rec)
}

// Record normalizes an already-decoded transcript record. Non-conversation
// records (meta lines: mode, permission-mode, last-prompt, attachment, …) yield
// nil.
func (n *Normalizer) Record(rec Record) []Event {
	// Taken from every record type, conversation or not: whichever comes first
	// and names a directory names the launch directory. A FileSource's first
	// read is the whole transcript (registry.start), so this sees the top.
	if n.root == "" && filepath.IsAbs(rec.CWD) {
		n.root = rec.CWD
	}
	if !rec.Conversational() {
		return n.meta(rec)
	}
	// What the session is answering AS leads what it answered, because it is
	// true of the record that follows rather than of the one before it.
	if lead := n.modelChange(rec); len(lead) > 0 {
		return append(lead, n.conversation(rec)...)
	}
	return n.conversation(rec)
}

// modelChange reports the model and effort of an assistant record when they
// differ from the last pair reported, and nothing otherwise.
//
// Sidechains are skipped: a subagent answers on whatever model it was
// dispatched with, and reporting that would show the session running on Haiku
// while the thread in front of the operator is on Opus. In the agent's own
// file the subagent IS the thread, so its model is the one to report. A record
// naming no model is skipped too — an older transcript, or a line the CLI
// writes without one, must not blank out a model that is still in force.
func (n *Normalizer) modelChange(rec Record) []Event {
	if rec.Type != RecordAssistant || (rec.IsSidechain && !n.agent) || rec.Message.Model == "" {
		return nil
	}
	// EXACT comparison, not the family one the receipt path uses. A record
	// names the slug where a receipt names the family, and the slug is the
	// better answer — so `claude-opus-5` arriving over a receipt's `opus` is a
	// reading worth reporting, even though the two name one model. The receipt
	// path stays family-wise, which is what stops it walking the slug back.
	now := ModelState{Model: rec.Message.Model, Effort: rec.Effort}
	if now == n.model {
		return nil
	}
	n.model = now
	e := n.emit(KindMeta, parseAt(rec.Timestamp))
	e.Meta, e.Model = MetaModel, &now
	return []Event{e}
}

// conversation is the rest of Record: what was actually said.
func (n *Normalizer) conversation(rec Record) []Event {
	// A compaction boundary is written as a user-role record, so the "the human
	// spoke" test claims it and the summary renders as an enormous prompt
	// nobody typed — and opens a turn around it. It is session lifecycle, not
	// conversation.
	if rec.IsCompactSummary {
		e := n.emit(KindMeta, parseAt(rec.Timestamp))
		e.Meta = MetaCompact
		return []Event{e}
	}
	// The message role is authoritative; the line type is the fallback for the
	// older lines that omit it.
	role := rec.Role()
	blocks := rec.Blocks()
	at := parseAt(rec.Timestamp)

	// An interrupt is the transcript reporting a key press, not a prompt: it
	// settles the turn it landed in instead of opening one.
	if notice, ok := interruptNotice(role, rec.IsMeta, blocks); ok {
		e := n.emit(KindState, at)
		e.Body = notice
		out := []Event{e}
		if !n.turnDone {
			n.turnDone, n.doneMsg = true, ""
			out = append(out, n.emit(KindTurnEnd, at))
		}
		return out
	}

	// The harness writes its own bookkeeping as user-role records too — a
	// background task finishing, the caveat that precedes a slash command, the
	// command's captured output. None of it is a prompt, so it renders as a
	// muted status line inside whatever turn is open and opens none of its own
	// (see harness.go). A shape with nothing worth reading earns no row.
	if role == "user" {
		if line, settles, ok := harnessRow(blockText(blocks)); ok {
			var out []Event
			// A `/model` or `/effort` receipt is the only source that reports a
			// change the moment it happens: the assistant records that name
			// either are written by a TURN, so until the session takes one they
			// all still report what the change replaced (see MetaModel).
			//
			// One event for the pair, because that is what a reader is shown
			// and each receipt speaks for only half of it.
			moved := false
			if m, ok := ModelFromReceipt(line); ok && !SameModel(m, n.model.Model) {
				n.model.Model, moved = m, true
			}
			if e, ok := EffortFromReceipt(line); ok && e != n.model.Effort {
				n.model.Effort, moved = e, true
			}
			if moved {
				e := n.emit(KindMeta, at)
				now := n.model
				e.Meta, e.Model = MetaModel, &now
				out = append(out, e)
			}
			if line != "" {
				e := n.emit(KindState, at)
				e.Body = line
				out = append(out, e)
			}
			// A slash command the CLI answered itself is over when its receipt
			// lands, and the turn the command's own record opened has to end
			// with it — nothing else ever will, since the model was never
			// called (see harnessRow). For /compact the receipt arrives 2.5
			// minutes later, so the turn stays open for as long as the
			// compaction actually runs, which is honest.
			if settles && !n.turnDone {
				n.turnDone, n.doneMsg = true, ""
				out = append(out, n.emit(KindTurnEnd, at))
			}
			return out
		}
	}

	// Loading a skill injects the WHOLE SKILL.md as an isMeta user record, and
	// it rendered as an enormous message nobody wrote — 364 of them across this
	// box's transcripts, median 3.1 kB and up to 23.3 kB (see skill.go). The
	// load is worth one line, so that a skill the MODEL chose is not a silent
	// change in how it behaves; the body is not.
	//
	// The receipt is preferred over the marker because it is present for every
	// load: 24 of the 364 bodies carry no marker, all of them from skills that
	// are not on disk under ~/.claude/skills, and those rendered in full.
	if rec.IsMeta && role == "user" {
		text := blockText(blocks)
		name, ok := skillLoad(text)
		if !ok && n.skillPending != "" {
			name, ok = n.skillPending, true
		}
		// Spent either way. A receipt kept past the record that follows it would
		// eventually claim an unrelated injection.
		n.skillPending = ""
		if ok {
			e := n.emit(KindMeta, at)
			e.Meta, e.Body, e.Bytes = MetaSkill, name, blockTextLen(blocks)
			return []Event{e}
		}
		// `/context` writes its own markdown here — 14,930 characters of it,
		// which otherwise renders as a block attributed to Claude. It is a
		// reading of session state, so it leaves as structure (see context.go).
		if r, ok := contextReading(text); ok {
			e := n.emit(KindMeta, at)
			e.Meta, e.Context = MetaContext, r
			return []Event{e}
		}
		// A path pasted into the terminal becomes a picture on the prompt,
		// which the bubble draws, and this note of where it came from. Shown,
		// it read as Claude speaking and drew the same picture again under it.
		if imageSourceNote(text) {
			return nil
		}
	}

	// isPrompt: the human actually said something (see the turn model above).
	// isMeta lines are skill/system text injected as if the user typed it.
	isPrompt := role == "user" && !rec.IsMeta && hasBlock(blocks, "text")
	switch {
	case isPrompt:
		n.startTurn()
	case n.turnDone && !n.sameResponse(role, rec.Message.ID) &&
		hasBlock(blocks, "text", "tool_use", "tool_result"):
		n.startTurn() // work resumed after the turn closed
	}

	var out []Event
	// imgN counts every image block in content order, whatever its source,
	// because the image-block route counts the same way: a reference's N is
	// the route's n.
	imgN := 0
	var pics []ImageRef
	for _, bl := range blocks {
		switch bl.Type {
		case "image":
			// A picture pasted into the terminal. Until 2026-09-24 this block
			// was dropped and the bubble showed the literal "[Image #1]" its
			// text carries. It travels as a reference (see ImageRef), and only
			// a prompt's: a harness or meta record was never shown, so its
			// pictures are not either.
			if isPrompt {
				if ref, ok := imageRef(bl, imgN); ok {
					pics = append(pics, ref)
				}
			}
			imgN++
		case "text":
			k := KindText
			body := bl.Text
			if isPrompt {
				k = KindUser // rendered as a plain bubble, never as markdown
				// A slash command is recorded as markup rather than as the line
				// the operator typed; unwrapped here so the chat shows the
				// command (see command.go).
				if line, ok := commandLine(body); ok {
					body = line
				}
			}
			e := n.emit(k, at)
			e.Body = plainText(body)
			// The record the plan approval's clear context opens a
			// conversation with (see Event.Origin).
			if isPrompt && rec.OriginKind() == OriginAutoContinuation && rec.PlanContent != "" {
				e.Origin, e.Plan = OriginAutoContinuation, rec.PlanContent
			}
			out = append(out, e)
		case "thinking":
			// A thinking block whose text is empty has nothing to render, and
			// it renders as a bare "Thought" label floating in the transcript.
			// They are not rare: across 60 transcripts on this box, 4,602 of
			// 4,602 thinking blocks carry an empty `thinking` and only a
			// `signature` — the reasoning itself is never written to the
			// transcript. So every one of these rows was a stub with nothing
			// behind it (Viktor, 2026-08-18).
			//
			// Emitting on the TEXT rather than on the block's presence means a
			// future CLI that does persist it needs no change here.
			if strings.TrimSpace(bl.Thinking) == "" {
				break
			}
			e := n.emit(KindThinking, at)
			e.Body = plainText(bl.Thinking)
			out = append(out, e)
		case "tool_use":
			e := n.emit(KindToolUse, at)
			e.Tool, e.ToolID = bl.Name, bl.ID
			e.Body = string(bl.Input)
			// The suffix covers the plain MCP name, which all 92 census calls
			// used (mcp__playwright__browser_take_screenshot), and any
			// plugin-scoped spelling of the same tool.
			if strings.HasSuffix(bl.Name, "browser_take_screenshot") && bl.ID != "" {
				if n.shots == nil {
					n.shots = map[string]bool{}
				}
				n.shots[bl.ID] = true
			}
			out = append(out, e)
		case "tool_result":
			e := n.emit(KindToolResult, at)
			e.ToolID, e.IsError = bl.ToolUseID, bl.IsError
			text, images, pictures := decodeToolContent(bl.Content)
			// "Launching skill: <name>" says a skill is about to inject its
			// body, and names it even when the body will carry no marker.
			if name, ok := skillReceipt(text); ok && !bl.IsError {
				n.skillPending = name
			}
			body, cut := capText(plainText(text))
			e.Body = body
			if pictures > 0 {
				// A result carrying pictures sends references and its text, and
				// nothing else. The structured toolUseResult is dropped because
				// it repeats the pictures (a Read writes a second copy of the
				// bytes in file.base64, beside originalSize and dimensions) and
				// nothing renders it for these tools. Until 2026-09-24 an
				// image-only result reached the wire as its raw content JSON,
				// 8 KiB of base64 in a <pre>. Truncated now means the TEXT was
				// cut, so a Read of an image offers no "Show full output".
				e.Images, e.Truncated = images, cut
			} else {
				// The structured result is where the stdout/stderr split and the
				// diff live, so an oversized one is PRUNED down to those parts
				// rather than dropped whole (see pruneResult).
				res, pruned := pruneResult(rec.ToolUseResult)
				e.Result = plainResult(res)
				e.Truncated = cut || pruned
				// A screenshot saved to a file comes back as text linking it
				// relative to the launch directory. An error names no file of
				// its own, and one that quotes a path in prose is not a link.
				if n.shots[bl.ToolUseID] && !bl.IsError {
					e.Files = shotFiles(text, n.root)
				}
			}
			delete(n.shots, bl.ToolUseID)
			out = append(out, e)
		}
	}

	// The prompt's pictures ride on its first bubble. A paste id is trusted
	// only when the record lists exactly one per image block, which both census
	// pastes did ([1] beside one block); matching a shorter list to the blocks
	// would be a guess about which picture a placeholder meant. Without its
	// record's uuid a reference could never be fetched, so none is sent.
	if len(pics) > 0 && rec.UUID != "" {
		if len(rec.ImagePasteIDs) == imgN {
			for i := range pics {
				pics[i].Paste = rec.ImagePasteIDs[pics[i].N]
			}
		}
		for i := range out {
			if out[i].Kind == KindUser {
				out[i].Images, out[i].RecordID = pics, rec.UUID
				break
			}
		}
	}

	// Subagent work shares the transcript with the main thread; the renderer
	// nests it rather than interleaving it, under the call of the agent the
	// record names. In the agent's own file it is the thread itself.
	if rec.IsSidechain && !n.agent {
		for i := range out {
			out[i].Sidechain, out[i].AgentID = true, rec.AgentID
		}
	}

	// A tool result can end the turn by itself: a workflow member returns its
	// answer through StructuredOutput and writes no end_turn record at all (37
	// of the 38 members of one real run), so without this its turn stays open
	// for good.
	if rec.ToolEndsTurn && !n.turnDone {
		n.turnDone, n.doneMsg = true, ""
		out = append(out, n.emit(KindTurnEnd, at))
	}

	// One turn_end per turn: Claude splits a single reply across several lines
	// (thinking, then text) that all repeat the same terminal stop_reason.
	if role == "assistant" && !n.turnDone && EndsTurn(rec.Message.StopReason) {
		n.turnDone, n.doneMsg = true, rec.Message.ID
		end := n.emit(KindTurnEnd, at)
		end.Usage = rec.Message.Usage
		out = append(out, end)
	}
	// A prompt the operator has already interrupted arrives dead: it opens a
	// turn nobody is working on, and Claude will write nothing further about
	// it. Settle it as it opens (see Interrupt).
	if isPrompt && n.interruptAt > 0 && at > 0 && at <= n.interruptAt {
		n.interruptAt = 0
		out = append(out, n.emit(KindTurnEnd, at))
	}
	return out
}

// meta turns a non-conversation record into the session-lifecycle events the
// renderer shows as inline markers: the mode in force, a prompt sitting in the
// queue, a hook that failed. Records that say nothing a reader would act on —
// a system summary with no errors, a dequeue (the queue being drained is just
// the prompt arriving, which the transcript reports anyway) — yield nothing.
//
// This is the one place that reads past Conversational(). That whitelist stays
// exactly as it is: the T3 bridge mirrors conversation only, and a `mode` record
// is not something to put in a thread.
func (n *Normalizer) meta(rec Record) []Event {
	at := parseAt(rec.Timestamp)
	emit := func(m Meta, body string) []Event {
		e := n.emit(KindMeta, at)
		e.Meta, e.Body = m, body
		return []Event{e}
	}
	switch rec.Type {
	case RecordMode:
		if rec.Mode != "" {
			return emit(MetaMode, rec.Mode)
		}
	case RecordPermissionMode:
		if rec.PermissionMode != "" {
			return emit(MetaPermissionMode, rec.PermissionMode)
		}
	case RecordQueueOperation:
		// A queue that is only ever added to is not a queue. The CLI reports
		// every departure too — see the Meta constants — and without them the
		// list of "waiting" prompts grows for the life of the session, which is
		// how a session with an empty queue came to show three.
		switch rec.Operation {
		case "enqueue":
			if rec.Content != "" {
				return emit(MetaQueued, rec.Content)
			}
		case "remove":
			if rec.Content != "" {
				return emit(MetaUnqueued, rec.Content)
			}
		case "dequeue":
			// Carries no content: the head was taken.
			return emit(MetaDequeued, "")
		case "popAll":
			// Drains the whole queue; the content names what it took.
			return emit(MetaQueueCleared, rec.Content)
		}
	case RecordSystem:
		if s := string(rec.HookErrors); s != "" && s != "[]" && s != "null" {
			return emit(MetaHookError, s)
		}
	}
	return nil
}

// Interrupt reports that the operator interrupted this session at `at` (epoch
// ms) and returns the event that settles the turn it landed in, if one is open.
//
// It exists because the transcript cannot always tell. Interrupting after
// Claude has started streaming leaves "[Request interrupted by user]" behind
// and InterruptNotice settles the turn from the file. Interrupting BEFORE the
// first token leaves nothing at all — no notice, sometimes not even the prompt
// line — so a turn the renderer has already opened would never close and the
// composer would sit on "Working…" + Stop for the life of the session. Whoever
// injects the interrupt owns the transition, the same way Injector.Cancel owns
// @claude_state (see tmux.go).
//
// The transcript stays the authority for what a turn CONTAINS: this marks no
// normalizer state as done, so lines still in flight keep landing in the turn
// they belong to instead of opening a spurious new one. A transcript notice
// arriving later settles the same turn a second time, which the renderer folds
// into the same "this turn is over".
//
// The timestamp is also kept as a watermark for the tail: see Record.
func (n *Normalizer) Interrupt(at int64) (Event, bool) {
	n.interruptAt = at
	if n.turnID == "" || n.turnDone {
		return Event{}, false
	}
	return n.emit(KindTurnEnd, at), true
}

// parseAt converts a transcript RFC3339 timestamp to epoch milliseconds — the
// unit the renderer's turn duration is computed in. An absent or unparseable
// timestamp yields 0 (omitted on the wire) rather than a wall-clock guess, so a
// replay of the same transcript always produces the same events.
func parseAt(ts string) int64 {
	if ts == "" {
		return 0
	}
	t, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return 0
	}
	return t.UnixMilli()
}

// decodeToolResult is the text a reader sees for a tool_result content: the
// text half of decodeToolContent, so the wire, "Show full output", the search
// and the skill receipt all follow one rule.
func decodeToolResult(raw json.RawMessage) string {
	text, _, _ := decodeToolContent(raw)
	return text
}

// decodeToolContent splits a tool_result content into the text a reader sees
// and the pictures it carried.
//
// A JSON string is its own text. A block array's text is its first text block,
// "" when there is none, and each image block adds a reference when its source
// is base64; pictures counts every image block, whatever its source, which is
// what decides that a result holds pictures at all. The raw JSON is the text
// only for an array holding neither text nor pictures, so a block type nobody
// has seen yet still shows something, while a picture never shows as its
// base64 again.
func decodeToolContent(raw json.RawMessage) (text string, images []ImageRef, pictures int) {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s, nil, 0
	}
	var blocks []Block
	if json.Unmarshal(raw, &blocks) != nil {
		return string(raw), nil, 0
	}
	hasText := false
	for _, b := range blocks {
		switch b.Type {
		case "text":
			if !hasText {
				text, hasText = b.Text, true
			}
		case "image":
			if ref, ok := imageRef(b, pictures); ok {
				images = append(images, ref)
			}
			pictures++
		}
	}
	if !hasText && pictures == 0 {
		return string(raw), nil, 0
	}
	return text, images, pictures
}

// imageRef is the reference for the n-th image block, when its bytes are in
// the transcript. Every census block was base64 (2 pastes, 134 Reads); a url
// source has nothing for the route to serve.
func imageRef(bl Block, n int) (ImageRef, bool) {
	if bl.Source == nil || bl.Source.Type != "base64" {
		return ImageRef{}, false
	}
	return ImageRef{N: n, MediaType: bl.Source.MediaType, Bytes: int64(bl.Source.Size)}, true
}

// imageSourceRE is the note Claude Code writes after a prompt that attached a
// pasted file path as a picture: "[Image: source: <path>]", one per picture.
var imageSourceRE = regexp.MustCompile(`^\[Image: source: [^\]\n]+\]$`)

// imageSourceNote reports whether a meta record's text is nothing but such
// notes. Text around one is something else, and keeps its row.
func imageSourceNote(text string) bool {
	text = strings.TrimSpace(text)
	if text == "" {
		return false
	}
	for _, line := range strings.Split(text, "\n") {
		if !imageSourceRE.MatchString(strings.TrimSpace(line)) {
			return false
		}
	}
	return true
}

// shotLinkRE is a markdown link to a PNG or JPEG, the two formats
// browser_take_screenshot writes. Its result reads
// "- [Screenshot of viewport](./page-top.png)"; the "Ran Playwright code"
// section below it names the same file in code, not as a link.
var shotLinkRE = regexp.MustCompile(`\]\(([^)\s]+\.(?i:png|jpe?g))\)`)

// shotFiles resolves the pictures a screenshot result links to absolute paths.
//
// Playwright MCP 0.0.76 resolves a relative filename against the MCP client's
// workspace, which is the directory Claude was launched in, and prints the
// link relative to the same directory (path.relative, with "./" added when the
// name has no directory part). A call with no filename writes under
// <workspace>/.playwright-mcp, and its result carries the picture as a block
// instead, which the caller takes first. Measured 2026-09-24 over 143
// transcripts: link == relative(first cwd, file) for 85 screenshots of 85.
// The browser never learns a cwd, so the path is made absolute here, where the
// one fact the rule needs is already known.
//
// A relative link with no launch directory known resolves to nothing, and so
// does anything carrying a scheme. An absolute link is kept as written.
func shotFiles(text, root string) []string {
	var out []string
	seen := map[string]bool{}
	for _, m := range shotLinkRE.FindAllStringSubmatch(text, -1) {
		p := m[1]
		switch {
		case strings.Contains(p, "://"):
			continue
		case filepath.IsAbs(p):
			p = filepath.Clean(p)
		case root != "":
			p = filepath.Join(root, p)
		default:
			continue
		}
		if !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	return out
}
