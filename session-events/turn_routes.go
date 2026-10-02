package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"terminal-lobby/sessionio"
	"terminal-lobby/telemetry"
)

// The routes that drive a session's turn: POST /prompt, POST /cancel and
// POST /model. Each takes the harness in the pane into account, because the
// three the lobby starts (Claude Code, Codex and pi) differ in what "ready"
// looks like, which key interrupts them and how a model is picked.
//
// They were closures inside main() until pi arrived. Named, and handed a
// driver interface rather than the Injector, for the reason handleAnswer is:
// what a route decides is worth testing on a box with no tmux server
// (turn_routes_test.go), and how the Injector types and waits is tested in
// sessionio against real ones.

// inputLines makes POST /prompt and POST /cancel take turns on one session's
// input line. Both type onto it: a prompt clears the line, pastes and presses
// Enter, and a Stop pops the queue and takes an interrupted prompt back off it
// with Backspaces (sessionio.ClearQueue, ReclaimInterrupted). Interleaved, one
// erases the other. Found in the round 7 check on 2026-09-28: a prompt sent
// 300 ms after an early Stop was pasted while the Stop was still clearing the
// returned prompt, its text went with the Backspaces, its Enter landed on an
// empty line, and the route answered 204 for a prompt the CLI never saw.
//
// Keyed by user and session. Each holds a one-slot channel rather than a
// mutex, so a request whose caller has gone stops waiting. An entry is a few
// dozen bytes per session ever driven, so the map is left to grow, as
// sessionio's own session locks are.
var inputLines sync.Map // string -> chan struct{}

// holdInputLine waits for the session's input line and returns the release.
func holdInputLine(ctx context.Context, osUser, session string) (func(), error) {
	v, _ := inputLines.LoadOrStore(osUser+"\x00"+session, make(chan struct{}, 1))
	turn := v.(chan struct{})
	select {
	case turn <- struct{}{}:
		return func() { <-turn }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// promptDriver is the half of sessionio.Injector that POST /prompt uses. It
// has no way to read the turn state, on purpose: see handlePrompt.
type promptDriver interface {
	AwaitInputReady(ctx context.Context, osUser, session string, wait, poll time.Duration) error
	AwaitPiReady(ctx context.Context, osUser, session string, wait, poll time.Duration) error
	// AwaitReady is the harness-aware wait; POST /prompt uses it for codex,
	// whose › is a menu cursor as well as its input mark.
	AwaitReady(ctx context.Context, osUser, session string, h sessionio.Harness, wait, poll time.Duration) error
	PiTrustPending(osUser, session string) bool
	Option(osUser, session, name string) (string, bool)
	// PromptInto is sessionio's Prompt told whether the guard's read of the
	// pane showed Claude's input box.
	PromptInto(osUser, session, text string, box bool) error
	// CapturePane is for the plan guard (plan.go promptRefusal), which reads the
	// pane for the plan approval and nothing else.
	CapturePane(osUser, session string) (string, error)
}

// handlePrompt types a prompt into the session.
//
// No turn gate. Claude Code queues typed input itself (its queue-operation
// records are in the transcript) and the queued prompt stays visible in the
// pane, so a mid-turn send is a normal thing to do rather than an error (design
// decision 9). The 409 that used to live here also made the two surfaces
// disagree: the bridge pasted whatever T3 sent, so the same prompt at the same
// moment ran from one window and was refused from the other.
//
// A SUSPENDED session is refused, because there is no Claude in it to queue
// anything. The idle sweep killed it and froze the pane (tmux-api/suspend.go),
// and every layer below reports success anyway: measured on tmux 3.4,
// 2026-09-19, send-keys into a dead pane exits 0 and the text vanishes, and a
// session whose wrapper shell outlived its Claude takes the prompt at a BASH
// PROMPT and runs it as a command. awaitReady does not catch either one: a
// frozen scrollback still shows a settled prompt. The lobby's composer wakes
// the session first and then sends with awaitReady
// (frontend-v2/src/store/wake-send.ts), since respawn-pane clears the frozen
// screen and the wait then reads the new Claude's own input line; this is for
// every other caller, and it names the session so the answer says what to do.
//
// A pi session asking whether to trust its folder is refused too. That
// question is a list, and a pasted line plus Enter answers it with its first
// row, "Trust", so nothing is typed while it is up, whether or not the caller
// asked for the wait. Claude's own trust dialog is refused the same way
// (promptRefusal): its highlighted row is "No, exit".
func handlePrompt(rg *registry, drv promptDriver) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		osUser, session := osUserFrom(r.Context()), r.PathValue("session")
		var body struct {
			Text string `json:"text"`
			// AwaitReady asks this to wait until the pane can actually take the
			// text, and to answer 503 rather than inject if it cannot.
			//
			// A session tmux has just created accepts send-keys immediately,
			// while the Claude in its pane takes another ~2s to draw its input,
			// and text sent into that window is lost with every layer reporting
			// success. That is invisible to a caller and expensive to the person
			// who typed it, so the FIRST prompt of a session asks for the wait
			// (frontend-v2/src/lib/first-prompt.ts). Off by default, which is
			// every other caller: a session someone is looking at is ready by
			// definition, and the check costs a capture-pane.
			AwaitReady bool `json:"awaitReady"`
			// Tool is the harness in the pane, the value the session list
			// carries. Absent means Claude, which is every caller from before
			// pi. For pi, ready means pi has titled its pane `π - <dir>`, which
			// it does once startup has finished and any trust question is
			// answered; Claude's ❯ says nothing about pi. For codex, ready
			// means its input line with no menu over it (AwaitCodexReady).
			Tool string `json:"tool"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.Text == "" {
			http.Error(w, "bad body (need text)", http.StatusBadRequest)
			return
		}
		// Claude takes its prompts through its mod (ADR-0036): submitted inside
		// the process, so nothing is typed, no dialog can catch the Enter, and
		// a prompt sent mid-turn waits for the turn to end.
		if h := sessionio.Harness(body.Tool); h == "" || h == sessionio.HarnessClaude {
			servePromptViaMod(w, r, rg, drv, osUser, session, body.Text, body.AwaitReady)
			return
		}
		pi := sessionio.Harness(body.Tool) == sessionio.HarnessPi
		if body.AwaitReady {
			// Not distinguished from "no such session": both mean the caller
			// should come back, and the caller's retry ladder is what decides
			// how long to keep coming back for.
			var err error
			switch {
			case pi:
				err = drv.AwaitPiReady(r.Context(), osUser, session, PromptReadyWait, PromptReadyPoll)
			case sessionio.Harness(body.Tool) == sessionio.HarnessCodex:
				err = drv.AwaitReady(r.Context(), osUser, session, sessionio.HarnessCodex, PromptReadyWait, PromptReadyPoll)
			default:
				err = drv.AwaitInputReady(r.Context(), osUser, session, PromptReadyWait, PromptReadyPoll)
			}
			if err != nil {
				// Claude asking whether to trust the folder never draws its
				// input box, so the wait cannot end until someone answers in
				// the Terminal. Said now, rather than as a 503 the caller
				// would retry against the same dialog.
				if !pi && sessionio.Harness(body.Tool) != sessionio.HarnessCodex {
					if pane, perr := drv.CapturePane(osUser, session); perr == nil && sessionio.ClaudeTrustPending(pane) {
						writePromptRefusal(w, trustOpenReason)
						return
					}
				}
				http.Error(w, "session is not ready for input", http.StatusServiceUnavailable)
				return
			}
		}
		// From here to the Enter the input line is this prompt's: a Stop that is
		// clearing it goes first, and one pressed now waits (inputLines). After
		// the ready wait, which can take seconds and types nothing.
		release, err := holdInputLine(r.Context(), osUser, session)
		if err != nil {
			return
		}
		defer release()
		if pi && drv.PiTrustPending(osUser, session) {
			http.Error(w, "pi is asking whether to trust this folder; answer it in the terminal first", http.StatusConflict)
			return
		}
		if at, _ := drv.Option(osUser, session, sessionio.OptionSuspended); at != "" {
			http.Error(w, "session "+session+" is suspended — resume it before sending", http.StatusConflict)
			return
		}
		// A codex menu is the screen a typed prompt must not reach: the Enter at
		// its end would pick the menu's highlighted row (refusal.go). Pi draws
		// none of codex's menus, so a pi session is not read for them.
		box := false
		if !pi {
			var reason string
			if reason, box = paneRefusal(drv, osUser, session); reason != "" {
				writePromptRefusal(w, reason)
				return
			}
		}
		err = drv.PromptInto(osUser, session, body.Text, box)
		if err != nil {
			// A menu took the input line's place between the guard above and
			// the Enter (sessionio.ErrInputGone), or stood there by the read
			// after it (sessionio.ErrSubmitUnconfirmed). Refused as though it
			// had been up all along, so the sender keeps its text and says
			// where to answer.
			if errors.Is(err, sessionio.ErrInputGone) || errors.Is(err, sessionio.ErrSubmitUnconfirmed) {
				writePromptRefusal(w, metDialogReason(r.Context(), drv, osUser, session))
				return
			}
			// The paste landed and no Enter took it: the text is on Claude's
			// input line, unsent. Said by name so the sender keeps its text
			// rather than reading a generic failure as a transport problem.
			if errors.Is(err, sessionio.ErrPromptNotSubmitted) {
				http.Error(w, "prompt not submitted: it is still on the session's input line", http.StatusBadGateway)
				return
			}
			http.Error(w, "inject failed", http.StatusBadGateway)
			return
		}
		// tl.count is the prompt LENGTH; the text itself is never recorded.
		attrs := telemetry.Attrs{"tl.session": session, "tl.count": len(body.Text), "tl.client": "api"}
		if body.Tool != "" {
			attrs["tl.tool"] = body.Tool
		}
		events.Emit("claude.prompt_sent", osUser, attrs)
		w.WriteHeader(http.StatusNoContent)
	}
}

// servePromptViaMod sends a prompt to a Claude session through its mod.
//
// A session the lobby has just created has no mod yet: Claude takes a couple
// of seconds to start, and its mod says hello as it does. With awaitReady the
// route waits for that, as it used to wait for the input line. A Claude asking
// whether to trust its folder loads no mod until it is answered, so that is
// said by name.
func servePromptViaMod(w http.ResponseWriter, r *http.Request, rg *registry, drv promptDriver, osUser, session, text string, awaitReady bool) {
	c := rg.mods.conn(osUser, session)
	if c == nil && awaitReady {
		hello, stop := rg.mods.awaitHello(osUser, session)
		if c = rg.mods.conn(osUser, session); c == nil {
			t := time.NewTimer(PromptReadyWait)
			select {
			case <-hello:
			case <-t.C:
			case <-r.Context().Done():
			}
			t.Stop()
			c = rg.mods.conn(osUser, session)
		}
		stop()
	}
	if c == nil {
		if pane, err := drv.CapturePane(osUser, session); err == nil && sessionio.ClaudeTrustPending(pane) {
			writePromptRefusal(w, trustOpenReason)
			return
		}
		http.Error(w, "session is not ready for input: its Claude has not connected to the lobby", http.StatusServiceUnavailable)
		return
	}
	if at, _ := drv.Option(osUser, session, sessionio.OptionSuspended); at != "" {
		http.Error(w, "session "+session+" is suspended — resume it before sending", http.StatusConflict)
		return
	}
	ack, err := c.send(r.Context(), modCommand{Op: "prompt", Text: text})
	if err != nil {
		http.Error(w, "the session's Claude did not take the prompt", http.StatusBadGateway)
		return
	}
	if !ack.OK {
		http.Error(w, "the session's Claude refused the prompt: "+ack.Error, http.StatusBadGateway)
		return
	}
	events.Emit("claude.prompt_sent", osUser, telemetry.Attrs{
		"tl.session": session, "tl.count": len(text), "tl.client": "mod",
	})
	w.WriteHeader(http.StatusNoContent)
}

// metDialogWait bounds how long metDialogReason reads the pane for the
// dialog a prompt met. It had taken the box's place already, so it is mostly
// drawn; the bound is for one still finishing its first frames.
const metDialogWait = 600 * time.Millisecond

// metDialogReason names the dialog a prompt met (sessionio.ErrInputGone):
// the guard's own reason once the pane reads as one, or dialogOpenReason for
// one it does not know, or not by metDialogWait.
func metDialogReason(ctx context.Context, drv promptDriver, osUser, session string) string {
	deadline := time.Now().Add(metDialogWait)
	for {
		if reason := promptRefusal(drv, osUser, session); reason != "" {
			return reason
		}
		if !time.Now().Before(deadline) {
			return dialogOpenReason
		}
		select {
		case <-ctx.Done():
			return dialogOpenReason
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// cancelDriver is the half of sessionio.Injector that POST /cancel uses.
type cancelDriver interface {
	CancelHarness(osUser, session string, h sessionio.Harness) error
	HarnessOf(osUser, session string) sessionio.Harness
	ClearQueue(osUser, session string, queued []string) (bool, error)
	ReclaimInterrupted(osUser, session, text string) (bool, error)
	// SetOption stamps sessionio.OptionRewound for a prompt that came back.
	SetOption(osUser, session, name, value string) error
}

// cancelBodyLimit bounds the optional body. It carries the harness's name and,
// for a Stop that hands queued prompts back, their text, which can be as long
// as a prompt: a paste into the composer reaches a couple of MB.
const cancelBodyLimit = 4 << 20

// handleCancel interrupts the session's turn with its harness's own key:
// Ctrl-C for Claude and Codex, Escape for pi, whose Ctrl-C clears its editor
// and exits on the second press.
//
// The body is optional and names the harness as {"tool": "pi"}. Every caller
// from before pi sends none, so with no tool named the pane is asked: pi titles
// its pane, and nothing else does, so the title is enough to tell pi from the
// rest without the caller's help.
//
// {"restoreQueue": [...]} is a Stop that hands the prompts Claude queued
// mid-turn back to the composer, oldest first. On an interrupt CLI 2.1.283
// submits every queued prompt as the next turn (measured 2026-09-27), so the
// queue is taken off first (sessionio.ClearQueue) and the reply is 200 with
// {"restored": bool}: whether it came off, which is when the caller puts the
// text back in its field. Otherwise the queued prompts run, as they did
// before. Only Claude's queue is popped this way. Without the field the reply
// is the empty 204 every earlier caller reads.
//
// {"returnPrompt": "..."} names the prompt of the turn being stopped when
// Claude has written nothing for it yet. A Stop then takes the prompt out of
// the conversation and Claude Code puts it back on its input line (CLI
// 2.1.283, measured 2026-09-28), where the Text view never shows it and the
// next send's clear erases it. So after the interrupt it is taken off that
// line (sessionio.ReclaimInterrupted), the stream is told the prompt left the
// conversation (MetaRewound), and the reply carries "returned": true, which is
// when the caller puts it back in its field. It rides the same 200 reply as
// "restored", and is absent when nothing came back.
func handleCancel(rg *registry, drv cancelDriver) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		osUser, session := osUserFrom(r.Context()), r.PathValue("session")
		var body struct {
			Tool         string   `json:"tool"`
			RestoreQueue []string `json:"restoreQueue"`
			ReturnPrompt string   `json:"returnPrompt"`
		}
		// An empty body is the ordinary case, and a malformed one names nothing,
		// which is what asking the pane is for. One over the limit is refused
		// rather than read as empty: that would interrupt and run the queue the
		// caller asked to have back.
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, cancelBodyLimit)).Decode(&body); err != nil {
			var tooBig *http.MaxBytesError
			if errors.As(err, &tooBig) {
				http.Error(w, "body too large", http.StatusRequestEntityTooLarge)
				return
			}
		}
		// The queue pop, the interrupt and the reclaim all act on the input
		// line, so a prompt being typed finishes first and one sent now waits
		// until the line is clear again (inputLines).
		release, err := holdInputLine(r.Context(), osUser, session)
		if err != nil {
			return
		}
		defer release()
		h := sessionio.Harness(body.Tool)
		if h == "" {
			h = drv.HarnessOf(osUser, session)
		}
		// A Claude with a mod is stopped inside the process (ADR-0036): the
		// turn ends cleanly and its turn_end settles the stream. Its queue is
		// not popped: Claude submits queued prompts as the next turn and no mod
		// API takes them back, so the reply says nothing came back and the
		// caller leaves its ghosts in place.
		if c := rg.mods.conn(osUser, session); c != nil && (h == "" || h == sessionio.HarnessClaude) {
			if _, err := c.send(r.Context(), modCommand{Op: "abort"}); err != nil {
				http.Error(w, "cancel failed", http.StatusBadGateway)
				return
			}
			events.Emit("claude.cancelled", osUser, telemetry.Attrs{"tl.session": session, "tl.client": "mod"})
			if len(body.RestoreQueue) == 0 && strings.TrimSpace(body.ReturnPrompt) == "" {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			writeJSON(w, struct {
				Restored bool `json:"restored"`
			}{false})
			return
		}
		restoring := len(body.RestoreQueue) > 0
		restored := false
		if restoring && (h == "" || h == sessionio.HarnessClaude) {
			took, err := drv.ClearQueue(osUser, session, body.RestoreQueue)
			if err != nil {
				// The pop may have left the queue drawn in the box, where the
				// interrupt would not stop the turn. The caller keeps its ghosts.
				http.Error(w, "cancel failed", http.StatusBadGateway)
				return
			}
			restored = took
		}
		if err := drv.CancelHarness(osUser, session, h); err != nil {
			http.Error(w, "cancel failed", http.StatusBadGateway)
			return
		}
		// An interrupt that lands before Claude's first token is never written
		// to the transcript, and the transcript is where every other settle
		// rule lives — so the turn is settled here, on the stream, or the
		// composer sits on "Working…" + Stop for the life of the session.
		stopped := time.Now().UnixMilli()
		fs, hasSource := rg.source(osUser, session)
		if hasSource {
			fs.Interrupt(stopped)
		}
		returning := strings.TrimSpace(body.ReturnPrompt) != ""
		returned := false
		if returning && (h == "" || h == sessionio.HarnessClaude) {
			took, err := drv.ReclaimInterrupted(osUser, session, body.ReturnPrompt)
			if err != nil {
				// The interrupt landed; only the read of the input line failed.
				// The caller keeps the prompt where it shows it.
				log.Printf("cancel %s/%s: reclaiming the interrupted prompt failed: %v", osUser, session, err)
			}
			returned = took && err == nil
			// The words that left the conversation: the whole batch when the
			// caller named only its first prompt (sessionio Rewind).
			rewound := body.ReturnPrompt
			if returned && hasSource {
				rewound = fs.Rewind(body.ReturnPrompt, stopped)
			}
			// The marker and the turn end above live in this process only. A
			// session-events started later reads the transcript alone, which
			// ends on this prompt with nothing after it, so the session keeps
			// the fact (sessionio.OptionRewound).
			if returned {
				if err := drv.SetOption(osUser, session, sessionio.OptionRewound, sessionio.RewoundStamp(rewound, stopped)); err != nil {
					log.Printf("cancel %s/%s: stamping the returned prompt: %v", osUser, session, err)
				}
			}
		}
		attrs := telemetry.Attrs{"tl.session": session, "tl.client": "api"}
		if h != "" {
			attrs["tl.tool"] = string(h)
		}
		if restored {
			attrs["tl.count"] = len(body.RestoreQueue)
		}
		if returned {
			attrs["tl.returned"] = true
		}
		events.Emit("claude.cancelled", osUser, attrs)
		if !restoring && !returning {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(struct {
			Restored bool `json:"restored"`
			Returned bool `json:"returned,omitempty"`
		}{restored, returned})
	}
}

// modelDriver is the half of sessionio.Injector that POST /model uses.
type modelDriver interface {
	AwaitReady(ctx context.Context, osUser, session string, h sessionio.Harness, wait, poll time.Duration) error
	State(osUser, session string) string
	Option(osUser, session, name string) (string, bool)
	PiTrustPending(osUser, session string) bool
	SetModel(ctx context.Context, osUser, session string, h sessionio.Harness, want sessionio.ModelState) (sessionio.ModelState, error)
	modeSetter
}

// handleModel changes which model the session answers on, and how hard it
// thinks.
//
// It is a POST rather than a flag because neither setting is one: the attach
// contract carries a command KEY, not a command line, so both are applied to a
// session that is already running, by driving the CLI's own picker for Claude
// and Codex and by typing pi's own `/model` and `/thinking` lines for pi
// (sessionio/setmodel.go, sessionio/pi.go). The reply is what the session
// reports AFTERWARDS, not an echo of the request: a change can be refused
// silently, and the caller has to be able to see that it was.
func handleModel(drv modelDriver) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		osUser, session := osUserFrom(r.Context()), r.PathValue("session")
		var body struct {
			// Tool is which CLI is running in the pane — the same value the
			// session list carries. They have different pickers and there is
			// nothing on a pane that reliably says which is which, so the
			// caller names it.
			Tool string `json:"tool"`
			// Either may be empty, meaning "leave this one alone".
			Model  string `json:"model"`
			Effort string `json:"effort"`
			// AwaitReady waits for the pane to be able to take input first, for
			// the same reason POST /prompt has it: a session that has just been
			// created accepts keys seconds before its TUI reads any.
			AwaitReady bool `json:"awaitReady"`
			// Mode is the permission mode for the Text view's mode dial, by the
			// CLI's identifier, and a request carrying it is that and nothing
			// else (mode.go). It is walked with Shift+Tab rather than a picker,
			// so it takes no tool, and it is for a session somebody has open,
			// so AwaitReady does not apply.
			Mode string `json:"mode"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			http.Error(w, "bad body (need tool, and a model or an effort)", http.StatusBadRequest)
			return
		}
		// BEFORE the refusals below. The mode walk runs while Claude works,
		// which is what the safety rule in sessionio/setmode.go is for, and it
		// checks for a dialog itself; refusing either outright would make the
		// dial a 409 for every working session.
		if body.Mode != "" {
			if body.Model != "" || body.Effort != "" {
				http.Error(w, "bad body (a mode, or a model and an effort, not both)", http.StatusBadRequest)
				return
			}
			serveMode(w, r, drv, osUser, session, body.Mode)
			return
		}
		h := sessionio.Harness(body.Tool)
		switch h {
		case sessionio.HarnessClaude, sessionio.HarnessCodex:
		case sessionio.HarnessPi:
			// Typed into the pane as lines, so held to the launch gate first:
			// a newline would submit a second line of somebody's choosing.
			if body.Model != "" && !sessionio.ValidPiModelRef(body.Model) {
				http.Error(w, "not a pi model reference (provider/id)", http.StatusBadRequest)
				return
			}
			if body.Effort != "" && !sessionio.ValidPiThinking(body.Effort) {
				http.Error(w, "not one of pi's thinking levels", http.StatusBadRequest)
				return
			}
		default:
			http.Error(w, "no model to pick in a "+body.Tool+" session", http.StatusBadRequest)
			return
		}
		if body.AwaitReady {
			if err := drv.AwaitReady(r.Context(), osUser, session, h, PromptReadyWait, PromptReadyPoll); err != nil {
				http.Error(w, "session is not ready for input", http.StatusServiceUnavailable)
				return
			}
		}
		// A picker cannot open over a turn in flight: the command would sit in
		// Claude's own queue and run when the turn ends, by which time the
		// person who asked has gone. Said now, rather than eight seconds later
		// as a timeout. An unstamped session — no Claude has run in it — is not
		// a running one (ADR-0001).
		state := drv.State(osUser, session)
		if state == sessionio.StateRunning {
			http.Error(w, "the session is working — stop it first", http.StatusConflict)
			return
		}
		// Nor over a drawn dialog, where `/model` would be typed into the
		// question rather than at the prompt. The state alone does not say so
		// for Claude: a session sitting on a question reads `awaiting`, which is
		// also what a session waiting at its prompt reads (ADR-0001).
		if ask, _ := drv.Option(osUser, session, sessionio.OptionAsk); ask != "" {
			http.Error(w, "the session is asking something — answer it first", http.StatusConflict)
			return
		}
		// For pi it does. The lobby's pi extension stamps awaiting for a
		// blocking prompt and for the trust question and for nothing else, so an
		// awaiting pi has a dialog up. The trust question is also read off the
		// pane, for a pi running without the extension, which stamps nothing.
		if h == sessionio.HarnessPi && (state == sessionio.StateAwaiting || drv.PiTrustPending(osUser, session)) {
			http.Error(w, "the session is asking something — answer it first", http.StatusConflict)
			return
		}
		st, err := drv.SetModel(r.Context(), osUser, session, h,
			sessionio.ModelState{Model: body.Model, Effort: body.Effort})
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		events.Emit("claude.model_set", osUser, telemetry.Attrs{
			"tl.session": session, "tl.tool": body.Tool,
			"tl.model": st.Model, "tl.effort": st.Effort, "tl.client": "api",
		})
		writeJSON(w, st)
	}
}
