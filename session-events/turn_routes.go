package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
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

// promptDriver is the half of sessionio.Injector that POST /prompt uses. It
// has no way to read the turn state, on purpose: see handlePrompt.
type promptDriver interface {
	AwaitInputReady(ctx context.Context, osUser, session string, wait, poll time.Duration) error
	AwaitPiReady(ctx context.Context, osUser, session string, wait, poll time.Duration) error
	PiTrustPending(osUser, session string) bool
	Option(osUser, session, name string) (string, bool)
	Prompt(osUser, session, text string) error
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
// asked for the wait.
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
			// answered; Claude's ❯ says nothing about pi.
			Tool string `json:"tool"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.Text == "" {
			http.Error(w, "bad body (need text)", http.StatusBadRequest)
			return
		}
		pi := sessionio.Harness(body.Tool) == sessionio.HarnessPi
		if body.AwaitReady {
			// Not distinguished from "no such session": both mean the caller
			// should come back, and the caller's retry ladder is what decides
			// how long to keep coming back for.
			var err error
			if pi {
				err = drv.AwaitPiReady(r.Context(), osUser, session, PromptReadyWait, PromptReadyPoll)
			} else {
				err = drv.AwaitInputReady(r.Context(), osUser, session, PromptReadyWait, PromptReadyPoll)
			}
			if err != nil {
				http.Error(w, "session is not ready for input", http.StatusServiceUnavailable)
				return
			}
		}
		if pi && drv.PiTrustPending(osUser, session) {
			http.Error(w, "pi is asking whether to trust this folder; answer it in the terminal first", http.StatusConflict)
			return
		}
		if at, _ := drv.Option(osUser, session, sessionio.OptionSuspended); at != "" {
			http.Error(w, "session "+session+" is suspended — resume it before sending", http.StatusConflict)
			return
		}
		// The plan approval is the one screen a prompt must never reach: the
		// Enter at its end would select the menu's highlighted row, which
		// approves the plan (plan.go). The Text view sends feedback there
		// through POST /answer instead; this refuses everything else, with the
		// reason, so the sender keeps its text. A tool permission prompt is
		// refused the same way. Claude Code draws both, so a pi session is not
		// read for them.
		if !pi {
			if reason := promptRefusal(rg, drv, osUser, session); reason != "" {
				writePromptRefusal(w, reason)
				return
			}
		}
		if err := drv.Prompt(osUser, session, body.Text); err != nil {
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

// cancelDriver is the half of sessionio.Injector that POST /cancel uses.
type cancelDriver interface {
	CancelHarness(osUser, session string, h sessionio.Harness) error
	HarnessOf(osUser, session string) sessionio.Harness
}

// cancelBodyLimit bounds the optional body, which carries one short field.
const cancelBodyLimit = 4 << 10

// handleCancel interrupts the session's turn with its harness's own key:
// Ctrl-C for Claude and Codex, Escape for pi, whose Ctrl-C clears its editor
// and exits on the second press.
//
// The body is optional and names the harness as {"tool": "pi"}. Every caller
// from before pi sends none, so with no tool named the pane is asked: pi titles
// its pane, and nothing else does, so the title is enough to tell pi from the
// rest without the caller's help.
func handleCancel(rg *registry, drv cancelDriver) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		osUser, session := osUserFrom(r.Context()), r.PathValue("session")
		var body struct {
			Tool string `json:"tool"`
		}
		// An empty body is the ordinary case, and a malformed one names nothing,
		// which is what asking the pane is for.
		_ = json.NewDecoder(io.LimitReader(r.Body, cancelBodyLimit)).Decode(&body)
		h := sessionio.Harness(body.Tool)
		if h == "" {
			h = drv.HarnessOf(osUser, session)
		}
		if err := drv.CancelHarness(osUser, session, h); err != nil {
			http.Error(w, "cancel failed", http.StatusBadGateway)
			return
		}
		// An interrupt that lands before Claude's first token is never written
		// to the transcript, and the transcript is where every other settle
		// rule lives — so the turn is settled here, on the stream, or the
		// composer sits on "Working…" + Stop for the life of the session.
		if fs, ok := rg.source(osUser, session); ok {
			fs.Interrupt(time.Now().UnixMilli())
		}
		attrs := telemetry.Attrs{"tl.session": session, "tl.client": "api"}
		if h != "" {
			attrs["tl.tool"] = string(h)
		}
		events.Emit("claude.cancelled", osUser, attrs)
		w.WriteHeader(http.StatusNoContent)
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
