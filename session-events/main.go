package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"os/user"
	"strconv"
	"strings"
	"syscall"
	"time"

	"terminal-lobby/authuser"
	"terminal-lobby/sessionio"
	"terminal-lobby/spendstore"
	"terminal-lobby/telemetry"
)

func main() {
	// Loopback by default, like the four sibling services: with no config
	// file present, the identity header is all that authenticates a request,
	// so the port must not be on the network until an operator says so
	// (TL-3). TL_BIND below is what widens it.
	addr := flag.String("addr", "127.0.0.1:7685", "listen address")
	mapPath := flag.String("usermap", authuser.DefaultMapPath, "identity→OS-user map")
	homeBase := flag.String("home-base", "/home", "base dir holding per-user homes")
	poll := flag.Duration("poll", 200*time.Millisecond, "transcript tail interval")
	hb := flag.Duration("heartbeat", 20*time.Second, "SSE heartbeat interval")
	// The privileged read child (privop.go). It serves ONE user — whoever sudo
	// started it as — over stdin/stdout and never listens on anything, so it is
	// handled before any of the service's own setup.
	privop := flag.Bool("privop", false, "run as the privileged read child for the invoking user")
	flag.Parse()

	if *privop {
		if err := runPrivop(); err != nil {
			log.Fatalf("privop: %v", err)
		}
		return
	}

	self, err := user.Current()
	if err != nil {
		log.Fatalf("cannot determine current user: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	injector := sessionio.NewInjector(self.Username)
	rg := newRegistry(ctx, *poll, *homeBase, injector, self.Username)
	// A watched session whose transcript is swapped underneath it — a new Claude
	// in the same tmux window — has to be noticed without waiting for a request
	// that may never come while a browser sits on an open stream.
	go rg.sweepEvery(ctx, SweepInterval)
	// A blocking question is not always in the transcript while its dialog is up
	// (see registry.watchPanes), so the pane of a watched, working session is
	// read for one.
	rg.panes = injector
	go rg.watchPanesEvery(ctx, PaneWatchInterval)

	// Authed web surface (mounted behind authMiddleware).
	web := http.NewServeMux()
	web.HandleFunc("GET /events/{session}", func(w http.ResponseWriter, r *http.Request) {
		fs, ok := rg.source(osUserFrom(r.Context()), r.PathValue("session"))
		if !ok {
			http.Error(w, "session not registered", http.StatusNotFound)
			return
		}
		osUser, session := osUserFrom(r.Context()), r.PathValue("session")
		// The opening cost, recorded where it is actually known. Nothing
		// measured this before: the reverse open exists to shrink it, and a
		// change nobody can see the size of is a change nobody can verify.
		writeSSE(w, r, fs, *hb, func(bytes, count int) {
			events.Emit("events.stream_opened", osUser, telemetry.Attrs{
				"tl.session": session, "tl.client": "api",
				"tl.bytes": bytes, "tl.count": count,
			})
		})
		events.Emit("events.stream_closed", osUser, telemetry.Attrs{
			"tl.session": session, "tl.client": "api",
		})
	})
	web.HandleFunc("POST /prompt/{session}", func(w http.ResponseWriter, r *http.Request) {
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
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.Text == "" {
			http.Error(w, "bad body (need text)", http.StatusBadRequest)
			return
		}
		if body.AwaitReady {
			// Not distinguished from "no such session": both mean the caller
			// should come back, and the caller's retry ladder is what decides
			// how long to keep coming back for.
			if err := injector.AwaitInputReady(r.Context(), osUser, session,
				PromptReadyWait, PromptReadyPoll); err != nil {
				http.Error(w, "session is not ready for input", http.StatusServiceUnavailable)
				return
			}
		}
		// No turn gate. Claude Code queues typed input itself — its
		// queue-operation records are in the transcript — and the queued prompt
		// stays visible in the pane, so a mid-turn send is a normal thing to do
		// rather than an error (design decision 9). The 409 that used to live
		// here also made the two surfaces disagree: the bridge pastes whatever
		// T3 sends, so the same prompt at the same moment ran from one window
		// and was refused from the other.
		if err := injector.Prompt(osUser, session, body.Text); err != nil {
			http.Error(w, "inject failed", http.StatusBadGateway)
			return
		}
		// tl.count is the prompt LENGTH; the text itself is never recorded.
		events.Emit("claude.prompt_sent", osUser, telemetry.Attrs{
			"tl.session": session, "tl.count": len(body.Text), "tl.client": "api",
		})
		w.WriteHeader(http.StatusNoContent)
	})
	// One step further back — what a reader reaching the top of the transcript
	// asks for (see OpenBackfillBytes).
	web.HandleFunc("GET /earlier/{session}", func(w http.ResponseWriter, r *http.Request) {
		fs, ok := rg.source(osUserFrom(r.Context()), r.PathValue("session"))
		if !ok {
			http.Error(w, "session not registered", http.StatusNotFound)
			return
		}
		writeEarlier(w, r, fs)
	})
	// One tool result in full, after MaxInlineResult capped it on the wire.
	web.HandleFunc("GET /result/{session}/{toolId}", func(w http.ResponseWriter, r *http.Request) {
		fs, ok := rg.source(osUserFrom(r.Context()), r.PathValue("session"))
		if !ok {
			http.Error(w, "session not registered", http.StatusNotFound)
			return
		}
		body, result, err := fs.FullResult(r.PathValue("toolId"))
		if err != nil {
			http.Error(w, "no such result", http.StatusNotFound)
			return
		}
		writeJSON(w, struct {
			Body   string          `json:"body"`
			Result json.RawMessage `json:"result,omitempty"`
		}{body, result})
	})
	// Finding something in a session that has scrolled past. The view opens on a
	// 20-turn window, so most of a long session is not in the browser and a
	// client-side find would answer "no matches" for the part most worth
	// searching. Hits carry event ids, which the client resolves with /earlier.
	web.HandleFunc("GET /search/{session}", func(w http.ResponseWriter, r *http.Request) {
		fs, ok := rg.source(osUserFrom(r.Context()), r.PathValue("session"))
		if !ok {
			http.Error(w, "session not registered", http.StatusNotFound)
			return
		}
		q := r.URL.Query().Get("q")
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		hits := fs.Search(q, limit)
		if hits == nil {
			hits = []sessionio.SearchHit{} // an empty list, never a JSON null
		}
		writeJSON(w, hits)
	})
	// Free text for the "Other" option of an AskUserQuestion. Separate from
	// /prompt on purpose: Prompt clears the line first and forces an Enter,
	// neither of which is right inside a dialog field, and the answer sequence
	// sends its own Enter once it has read the pane back (design 2026-08-18).
	web.HandleFunc("POST /answer-text/{session}", func(w http.ResponseWriter, r *http.Request) {
		osUser, session := osUserFrom(r.Context()), r.PathValue("session")
		var body struct {
			Text string `json:"text"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			http.Error(w, "bad body (need text)", http.StatusBadRequest)
			return
		}
		if err := injector.AnswerText(osUser, session, body.Text); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		// The same event the keys route emits: from the session's point of view
		// this IS answering, and the text itself is never recorded.
		events.Emit("claude.answered", osUser, telemetry.Attrs{
			"tl.session": session, "tl.count": len(body.Text), "tl.client": "api-text",
		})
		w.WriteHeader(http.StatusNoContent)
	})
	// What the pane currently shows. The text view reads it to mirror a blocking
	// prompt, which the transcript does not report while it is pending (ADR-0010).
	web.HandleFunc("GET /pane/{session}", func(w http.ResponseWriter, r *http.Request) {
		osUser, session := osUserFrom(r.Context()), r.PathValue("session")
		if _, ok := rg.source(osUser, session); !ok {
			http.Error(w, "session not registered", http.StatusNotFound)
			return
		}
		text, err := injector.CapturePane(osUser, session)
		if err != nil {
			http.Error(w, "cannot read the pane", http.StatusBadGateway)
			return
		}
		writeJSON(w, struct {
			Pane  string `json:"pane"`
			State string `json:"state"`
		}{text, injector.State(osUser, session)})
	})
	// The slash commands this session can run that the CLI does not build in:
	// the user's skills and custom commands, the project's, and those of the
	// plugins they have switched on. The composer offers them beside the
	// built-ins it ships, so an unreachable catalogue costs completion of
	// /help and /clear nothing.
	// The catalogue for a directory rather than a session, for the new-session
	// composer's `/` menu — there is no session to name yet.
	//
	// Under /commands/ ON PURPOSE, not at a bare /commands. The production
	// ingress matches PathPrefix(`/commands/`) with the trailing slash, so a
	// bare path would miss the rule, fall through to ttyd and 404 — which is
	// exactly how /build-id spent its life. A path under the existing prefix
	// needs no ingress change to work.
	//
	// `_new` cannot collide with the {session} pattern below. Go's mux prefers
	// the literal over the wildcard, and a session name is a 12-character base32
	// id (ADR-0019) whose alphabet has no underscore, so nothing can be called
	// this. The leading underscore follows the pool slots' convention for a name
	// no client can mint.
	web.HandleFunc("GET /commands/_new", func(w http.ResponseWriter, r *http.Request) {
		cmds, ok := rg.catalogueForDir(osUserFrom(r.Context()), r.URL.Query().Get("dir"))
		if !ok {
			// Only reachable for a dir outside the caller's home, which is a
			// refusal rather than an empty catalogue.
			http.Error(w, "directory not readable", http.StatusBadRequest)
			return
		}
		writeJSON(w, cmds)
	})
	web.HandleFunc("GET /commands/{session}", func(w http.ResponseWriter, r *http.Request) {
		cmds, ok := rg.catalogue(osUserFrom(r.Context()), r.PathValue("session"))
		if !ok {
			http.Error(w, "session not registered", http.StatusNotFound)
			return
		}
		writeJSON(w, cmds)
	})
	// The answer to a blocking prompt, typed into the pane. sessionio.Injector
	// allowlists the keys; anything outside the answer alphabet is refused there.
	web.HandleFunc("POST /keys/{session}", func(w http.ResponseWriter, r *http.Request) {
		osUser, session := osUserFrom(r.Context()), r.PathValue("session")
		var body struct {
			Keys []string `json:"keys"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			http.Error(w, "bad body (need keys)", http.StatusBadRequest)
			return
		}
		if err := injector.Keys(osUser, session, body.Keys); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		events.Emit("claude.answered", osUser, telemetry.Attrs{
			"tl.session": session, "tl.count": len(body.Keys), "tl.client": "api",
		})
		w.WriteHeader(http.StatusNoContent)
	})
	// ONE CHOICE OF A BLOCKING AskUserQuestion, answered next to the parser
	// that reads these screens (handleAnswer, below). The reader taps an
	// option, the server answers the question the pane is drawing, and the
	// reply is a fresh reading of whatever it draws next.
	//
	// It replaces a walk that ran in the browser over /keys and /pane. That
	// one planned every step before typing anything and set each step's
	// expectation to the NEXT question's text; over 10 days of field data
	// four-question answers failed 4 times in 5, and all six failures were the
	// same thing — the prediction missed
	// (docs/plans/2026-09-10-text-mode-answers-dialogs-design.md). A browser
	// cannot see the pane it is racing, and its two sources are 10x apart in
	// freshness: the transcript tails at 200 ms and the pane watcher ticks at
	// PaneWatchInterval.
	//
	// WHAT IT COSTS. The keystrokes, the captures and the check now happen
	// inside one request, so the tapped row waits for all of them. Measured on
	// CLI 2.1.267, a digit reaches the next question in 154 ms and the review
	// screen in 63 ms, and the driver polls at keySettle up to a 600 ms
	// ceiling. The round trips it replaces — one POST plus up to two GETs from
	// a phone — cost more than that and got the wrong answer.
	//
	// A REFUSAL IS A 200, carrying applied:false, a reason, and the current
	// reading. That reading is the point: the card re-renders against what is
	// on screen instead of latching with Send disabled and telling the reader
	// to open the Terminal. Non-200 is kept for the two failures no reading
	// can fix — a session nobody registered, and a pane that cannot be read.
	web.HandleFunc("POST /answer/{session}", handleAnswer(rg, injector))
	web.HandleFunc("POST /cancel/{session}", func(w http.ResponseWriter, r *http.Request) {
		osUser, session := osUserFrom(r.Context()), r.PathValue("session")
		if err := injector.Cancel(osUser, session); err != nil {
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
		events.Emit("claude.cancelled", osUser, telemetry.Attrs{
			"tl.session": session, "tl.client": "api",
		})
		w.WriteHeader(http.StatusNoContent)
	})

	// Which model the session answers on, and how hard it thinks.
	//
	// It is a POST rather than a flag because neither setting is one: the attach
	// contract carries a command KEY, not a command line, so both are applied to
	// a session that is already running by driving the CLI's own picker
	// (sessionio/setmodel.go). The reply is what the session reports AFTERWARDS,
	// not an echo of the request — a change can be refused silently, and the
	// caller has to be able to see that it was.
	web.HandleFunc("POST /model/{session}", func(w http.ResponseWriter, r *http.Request) {
		osUser, session := osUserFrom(r.Context()), r.PathValue("session")
		var body struct {
			// Tool is which CLI is running in the pane — the same value the
			// session list carries. The two have different pickers and there is
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
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			http.Error(w, "bad body (need tool, and a model or an effort)", http.StatusBadRequest)
			return
		}
		h := sessionio.Harness(body.Tool)
		if h != sessionio.HarnessClaude && h != sessionio.HarnessCodex {
			http.Error(w, "no model to pick in a "+body.Tool+" session", http.StatusBadRequest)
			return
		}
		if body.AwaitReady {
			if err := injector.AwaitPromptMark(r.Context(), osUser, session,
				sessionio.PromptMark(h), PromptReadyWait, PromptReadyPoll); err != nil {
				http.Error(w, "session is not ready for input", http.StatusServiceUnavailable)
				return
			}
		}
		// A picker cannot open over a turn in flight: the command would sit in
		// Claude's own queue and run when the turn ends, by which time the
		// person who asked has gone. Said now, rather than eight seconds later
		// as a timeout. An unstamped session — no Claude has run in it — is not
		// a running one (ADR-0001).
		if injector.State(osUser, session) == sessionio.StateRunning {
			http.Error(w, "the session is working — stop it first", http.StatusConflict)
			return
		}
		state, err := injector.SetModel(r.Context(), osUser, session, h,
			sessionio.ModelState{Model: body.Model, Effort: body.Effort})
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		events.Emit("claude.model_set", osUser, telemetry.Attrs{
			"tl.session": session, "tl.tool": body.Tool,
			"tl.model": state.Model, "tl.effort": state.Effort, "tl.client": "api",
		})
		writeJSON(w, state)
	})
	root := http.NewServeMux()
	root.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	// The session-start hook runs as the OS user on THIS box, so it is hard-gated
	// to loopback (defense in depth alongside the ingress not routing /hooks/*
	// publicly) and, on top of that, to the account that opened the connection:
	// loopback authenticates a host, and every lobby user has a shell on this
	// host, so the "user" in the body was previously anyone's to choose.
	root.HandleFunc("POST /hooks/session-start", localhostOnly(peerOwnsClaim(rg.handleSessionStart())))
	// What a Claude Code session has spent, posted by devvm/tl-usage-record from
	// the statusLine slot (usage.go). Same two gates as its neighbour, for the
	// same reason. The readings land in /var/lib/tmux-api/spend/<user>.json,
	// which tmux-api reads to serve the Settings page; both services run as the
	// same OS user. TL_SPEND_DIR is the scratch-build override for the dev
	// harness, the same rationale as tmux-api's TMUX_API_PREFS_DIR: a battery
	// run against a local build must not write the production store. The
	// systemd unit sets no environment.
	spendDir := spendstore.Dir
	if d := strings.TrimSpace(os.Getenv("TL_SPEND_DIR")); d != "" {
		spendDir = d
	}
	root.HandleFunc("POST /hooks/usage", localhostOnly(peerOwnsClaim(handleUsage(spendstore.New(spendDir)))))
	// TL_BIND narrows the listener; the gate's Configure reports the mode and
	// warns when no proxy secret is set.
	if b := strings.TrimSpace(os.Getenv("TL_BIND")); b != "" {
		if _, port, err := net.SplitHostPort(*addr); err == nil {
			*addr = net.JoinHostPort(b, port)
		}
	}
	actAsGate.Configure("session-events", *addr)
	root.Handle("/", authMiddleware(*mapPath, web))

	go timing.Run(ctx.Done())
	srv := &http.Server{Addr: *addr, Handler: timing.Wrap(root)}
	go func() {
		<-ctx.Done()
		sh, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		srv.Shutdown(sh)
	}()
	log.Printf("session-events listening on %s (usermap=%s, homeBase=%s)", *addr, *mapPath, *homeBase)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

// answerDriver is the half of sessionio.Injector that POST /answer uses.
//
// An interface for the same reason paneReader is one (registry.go): the route
// is worth testing on a box with no tmux server, and production passes the
// Injector. It is also what keeps the answering rules out of this file —
// which question is drawn, which keys press it, how long to wait for the
// screen to move — all of which live in sessionio/answerdrive.go beside the
// parser that reads the same screens.
type answerDriver interface {
	Answer(ctx context.Context, osUser, session string, req sessionio.AnswerRequest,
		known []sessionio.DialogQuestion) (sessionio.AnswerResponse, error)
}

// answerBodyLimit bounds one AnswerRequest.
//
// The largest legitimate one is a free-text answer: sessionio.MaxAnswerText
// caps that at 2,000 bytes, and the rest is a header, an option label and at
// most sessionio.MaxKeys key names. 8 KiB clears all of it even when every
// character is a 4-byte rune, and stays well under the 64 KiB a hook payload
// carrying a whole session record gets (hookBodyLimit, peercred.go).
//
// http.MaxBytesReader rather than the io.LimitReader the hook middleware uses:
// a LimitReader TRUNCATES, so an oversized body whose first 8 KiB happen to
// close a JSON object would decode and be acted on as though it had arrived
// whole. This makes the decode fail instead.
const answerBodyLimit = 8 << 10

// answerKnownTurns is how far back the transcript is read for the call a
// request answers.
//
// A pending AskUserQuestion belongs to the turn that is still running, so one
// turn would do and two is slack for a transcript whose turn boundary lands
// awkwardly. Folding the whole log instead would copy every event of a
// transcript that reaches 28.9 MB on this box, per request, to read a fact
// that is always in the last thing that happened.
const answerKnownTurns = 2

// askQuestionTool is the tool whose recorded input carries the question list.
const askQuestionTool = "AskUserQuestion"

// answerUnreadable is the reason for a pane that could not be read at all.
//
// Not one of sessionio's Answer* constants, because it is not an outcome of
// the dialog: there was no screen to refuse anything against. The word is the
// browser walk's own (answer.logic.ts), kept because it means exactly the same
// thing there and keeps at least one value of tl.reason comparable across the
// cutover.
const answerUnreadable = "unreadable"

// answerNoSession is the reason for a request against a session this box does
// not have: killed, renamed onto a different transcript, or never registered
// (registry.go source).
//
// Also not one of sessionio's Answer* constants, and for the same reason as
// answerUnreadable — no dialog refused anything, because none was reached. It
// is a word of its own rather than the walk's `refused`, which meant "the
// keys were not taken" and still does (AnswerRefused); folding the two would
// leave neither of them countable.
const answerNoSession = "no-session"

// handleAnswer serves POST /answer/{session}: one choice in, the next reading
// out. The route's own comment, at its registration in main(), says why it
// exists and what it costs.
//
// Named rather than inline like its neighbours because it is the one web route
// here with a test of its own, and a closure inside main() cannot be handed a
// stand-in driver (answer_test.go).
func handleAnswer(rg *registry, drv answerDriver) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		osUser, session := osUserFrom(r.Context()), r.PathValue("session")
		fs, ok := rg.source(osUser, session)
		if !ok {
			http.Error(w, "session not registered", http.StatusNotFound)
			// RECORDED, not merely refused. rg.source answers false when the
			// tmux→transcript mapping has gone — the session was killed, or
			// its name now points at a different transcript — which is a card
			// still on a reader's screen with nothing behind it, and the
			// client shows them nothing (sendAnswer returns null, and
			// session.ts deliberately raises no toast). The walk this route
			// replaces counted the same failure: any POST the lobby did not
			// answer 2xx became `refused` (answer.logic.ts:330). Silence here
			// would take that class to zero at the cutover and read as a
			// failure that had stopped happening.
			emitAnswer(osUser, session, nil, sessionio.AnswerResponse{Reason: answerNoSession})
			return
		}
		var req sessionio.AnswerRequest
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, answerBodyLimit)).Decode(&req) != nil {
			// Over the cap and unparseable are one refusal on purpose: nothing
			// reached a pane in either case, and a client can do nothing
			// different about them. The cap is in the message because it is
			// the one of the two a caller might be surprised by.
			http.Error(w, "bad body (an AnswerRequest under "+strconv.Itoa(answerBodyLimit)+" bytes)",
				http.StatusBadRequest)
			return
		}
		// The call's question list rides along because the pane cannot supply
		// it: a multi-question dialog draws no per-question header and marks
		// the current tab in colour, which `capture-pane -p` does not carry.
		// With it the driver can prove which question is on screen and walk ←
		// to a named one; without it both fall back to weaker checks.
		known := pendingQuestions(fs)
		resp, err := drv.Answer(r.Context(), osUser, session, req, known)
		if err != nil {
			// The pane could not be read at all, which is a session that has
			// gone away — the same 502 GET /pane answers for the same failure.
			http.Error(w, "cannot read the pane", http.StatusBadGateway)
			// A reader who navigated away mid-request is not a failure of this
			// route. The driver polls to a 600 ms ceiling, so a dropped phone
			// connection part-way through is ordinary, and recording each one
			// would put the building's connection quality into the reason
			// breakdown this event exists to measure.
			//
			// The request's own context is checked as well as the error,
			// because a cancel can reach us as whatever the killed tmux
			// subprocess reported rather than as context.Canceled.
			if r.Context().Err() == nil && !errors.Is(err, context.Canceled) {
				emitAnswer(osUser, session, known, sessionio.AnswerResponse{Reason: answerUnreadable})
			}
			return
		}
		emitAnswer(osUser, session, known, resp)
		if resp.Applied {
			emitAnswered(osUser, session, req)
		}
		writeJSON(w, resp)
	}
}

// emitAnswered is ADR-0006's record of a blocking prompt being answered, kept
// alive on the surface that now does the answering.
//
// docs/adr/0006-usage-telemetry.md lists claude.answered under session-events
// as "a blocking prompt answered", and POST /keys and POST /answer-text above
// are where it has always come from. Once the card drives this route instead
// of those two, the name goes to roughly zero while answers carry on — a
// series that reads as a feature nobody uses any more, on every panel built
// over it. text.answer_sent does not stand in for it: that one counts what
// the TEXT VIEW attempted, and this one counts prompts answered from any
// surface, the raw-keys hatch and a future client included.
//
// tl.client keeps the ADR's two values rather than inventing a third, because
// what reaches the pane is unchanged: free text goes in through
// Injector.AnswerText exactly as POST /answer-text sends it, and everything
// else is keys. The cutover is still visible where it belongs — tl.client on
// text.answer_sent is `api-answer`, and nothing else emits that.
//
// The free-text case is named by Text being present, which is the only thing
// it is for: the contract (answerapi.go) defines Text as what to type when
// Choice is the free-text row, and the driver reads it nowhere else. Keys
// wins over it because the raw-key hatch never carries text.
//
// tl.count is the answer's SIZE in the same unit each of those routes used —
// characters for text, keys for the hatch. A choice is 1, which is also what
// the walk's own single-select answer was: one digit.
func emitAnswered(osUser, session string, req sessionio.AnswerRequest) {
	client, count := "api", 1
	switch {
	case len(req.Keys) > 0:
		count = len(req.Keys)
	case req.Text != "":
		client, count = "api-text", len(req.Text)
	}
	events.Emit("claude.answered", osUser, telemetry.Attrs{
		"tl.session": session, "tl.count": count, "tl.client": client,
	})
}

// pendingQuestions is the call's own question list, as the transcript records
// it: the newest AskUserQuestion whose result has not arrived.
//
// It is a HINT, and the driver treats it as one — but it is the ONLY supplier
// of that hint, and what a MISSING one costs is worth stating plainly here,
// because this is the function that decides whether there is one.
//
// A multi-question dialog draws no per-question header: verified 2026-09-11
// against the real parser, both sessionio/testdata/dialog-multi.txt and
// dialog-multi-second.txt parse to Questions[0].Header == "" with Headers
// ["Fruit" "Drink"]. So with no list, nothing on the pane says WHICH question
// of the call is on screen, and placement falls back to the weaker checks the
// driver's own comment sets out — the header being one the tab bar carries,
// and the option being one the drawn question offers. The window is real:
// measured 2026-08-28 over five consecutive calls, two records were not
// written until after the question had been answered, one of them 112 s
// later. An earlier version of this comment claimed a missing list cost only
// a ← walk that refuses; it does not, and placement while the record is late
// is the driver's to get right rather than something this route can prove.
// tl.source on the event says which of the two branches a request ran under,
// so how often that happens is a query rather than a guess.
//
// The frontend's extra rule — that the call must also be the last thing that
// happened (timeline.logic.ts pendingQuestion) — is deliberately not copied.
// There it stops a card docking over a question Claude Code abandoned,
// re-asked and never resolved; here the reply is a fresh reading either way,
// so the rule would only withhold a list the driver can use.
func pendingQuestions(fs *sessionio.FileSource) []sessionio.DialogQuestion {
	var known []sessionio.DialogQuestion
	var from string // the tool id the list was read out of
	for _, e := range fs.ReplayWindow(0, answerKnownTurns) {
		switch {
		case e.Kind == sessionio.KindToolUse && e.Tool == askQuestionTool:
			// Body is the tool's raw input, uncapped for a tool_use
			// (normalize.go), and AskUserQuestion's input is shaped exactly
			// like DialogQuestion down to the option descriptions.
			var input struct {
				Questions []sessionio.DialogQuestion `json:"questions"`
			}
			if json.Unmarshal([]byte(e.Body), &input) == nil && len(input.Questions) > 0 {
				known, from = input.Questions, e.ToolID
			}
		case from != "" && e.Kind == sessionio.KindToolResult && e.ToolID == from:
			known, from = nil, ""
		}
	}
	return known
}

// emitAnswer records the SHAPE of what happened, never what was on screen.
//
// A dialog quotes whatever the session was working on — a file path, a
// customer's name, a diff — so nothing here carries the question, an option
// label or the free text. That is the rule POST /answer-text follows above and
// the one ADR-0006 sets for every usage record.
//
// tl.session is the addition this route makes. The browser emitted the same
// pair with user.id and tl.device and no session name, so a recorded failure
// could not be tied back to the transcript it came from; the design doc lists
// that as the thing that would have made the investigation short.
//
// The two NAMES are the browser's, so its records and these stay one series —
// but tl.client has to be read in every query over them. The historical
// failures are failures of the walk this route replaces, and 3 of the 5 were
// multi-question calls, which never once succeeded; a panel that folds both
// surfaces together renders a rewrite as a trend. tl.reason spans two
// vocabularies for the same reason: the walk had three words (refused,
// desync, unreadable) and this path has sessionio's five Answer* constants
// plus answerUnreadable, of which `refused` and `unreadable` still mean what
// they always did.
//
// tl.markers_missing is the drift signal, and the reason this route emits
// anything sessionio computed. Claude Code ships roughly daily and the captures
// under testdata/ do not, so a restyle that moves a string the parser hangs off
// passes CI and arrives as a reader stuck on a dialog. Recording which
// landmarks the screen carried makes the next one a query instead, at the cost
// of nothing: it rides on dialogs that are happening anyway, and it is our own
// names for the CLI's furniture, never a fragment of what was drawn.
//
// It answers "which landmark has been missing since Tuesday", NOT "how often is
// it missing". sessionio takes a fingerprint only when the parse failed
// (answerdrive.go reply), so a healthy dialog contributes no reading at all and
// the denominator a rate needs is not in this series. The attribute is also
// absent when every landmark was lit, which is a parser bug rather than drift
// and is already described by tl.reason.
//
// Readings either side of 2026-09-11 are not the same measurement. Before that
// date ParseDialogMarkers read the whole capture, so a marker could be lit by
// the wording appearing anywhere in the scrollback. It now reads only the
// dialog's own lines (markerScope), the footer included, so a dark marker means
// the dialog did not draw it. That is stricter than what came before, and a
// panel spanning the cutover will show a step that is the parser changing, not
// the CLI.
func emitAnswer(osUser, session string, known []sessionio.DialogQuestion, resp sessionio.AnswerResponse) {
	// `event` rather than `name`: frontend-v2/test/docs.truth.test.ts checks
	// every event name a Go service emits against the catalog in
	// telemetry/events.go, which is a gate that drops an uncatalogued name
	// silently. Its parser reads names straight out of a literal Emit call,
	// and out of assignments to a variable spelled `event` for the call sites
	// that choose a name first. Under any other spelling these two names are
	// invisible to that check, and a rename would take them off the journal
	// with nothing failing.
	event := "text.answer_sent"
	if !resp.Applied {
		event = "text.answer_failed"
	}
	count, multi, source := answerShape(known, resp)
	attrs := telemetry.Attrs{
		"tl.session": session, "tl.client": "api-answer",
		"tl.questions": count, "tl.multi": multi,
	}
	if source != "" {
		attrs["tl.source"] = source
	}
	if resp.Reason != "" {
		attrs["tl.reason"] = resp.Reason
	}
	// Recorded only when the TRANSCRIPT says a question is open and the
	// fingerprint came back partial. Both halves were measured rather than
	// reasoned about, and the first replaced a filter on tl.reason that threw
	// away the readings this attribute exists for.
	//
	// Why not the reason. AnswerNoDialog does not mean what answerapi.go's
	// comment says: answerdrive.go returns it for `before.dialog == nil`,
	// which covers "no dialog on the pane" AND "a dialog the parser could not
	// read". The second is drift itself. Measured live 2026-09-11 against a
	// real pane holding a frame the parser refuses: reason no-dialog, with
	// openBox, footer and numberedList lit against six dark. Skipping
	// no-dialog dropped exactly that.
	//
	// Why `known`. An operator menu is the noise this has to exclude: /model,
	// /effort and the resume picker are the same select widget, and
	// markerScope falls back to the option list when it finds no footer, so
	// they light numberedList the way a dialog does. The fingerprint narrows
	// them and does not settle them. Measured 2026-09-11 over every capture
	// in sessionio/testdata: six of the nine non-dialog screens light
	// numberedList and nothing else, three light nothing at all, and a
	// restyled dialog — dialog-single.txt with its free-text and chat rows
	// renamed — lights openBox, footer and numberedList against six dark. So
	// "a dialog-only landmark is lit" would sort today's captures correctly
	// and would file a restyle total enough to drop all of them as a picker,
	// which is the reading this attribute most wants to keep. What separates
	// the two without depending on which landmarks survived is that nobody is
	// waiting on an AskUserQuestion when a picker is on screen. A non-empty
	// `known` is the transcript saying a call is open and unresolved, so a
	// screen we cannot read while one is means the dialog moved. The cost is
	// a false negative in the window where Claude Code has not written the
	// record yet, measured 2026-08-28 at up to 112 s; drift is a multi-day
	// signal, so losing the readings inside that window changes nothing.
	//
	// Why partial. All nine dark is markerScope finding no dialog at all, a
	// pane that has scrolled or a restyle so total the answer path cannot
	// drive the screen anyway. None dark is every landmark present and the
	// parse still failing, which is a parser bug that tl.reason already
	// names. Neither is a landmark going missing.
	if resp.Markers != nil && len(known) > 0 {
		if dark := darkMarkers(*resp.Markers); len(dark) > 0 && len(dark) < markerCount {
			attrs["tl.markers_missing"] = strings.Join(dark, ",")
		}
	}
	events.Emit(event, osUser, attrs)
}

// markerCount is how many landmarks DialogMarkers carries. A reading with all
// of them dark is markerScope failing to find a dialog, not a dialog that lost
// its furniture, so the emit site tells the two apart by this number.
const markerCount = 9

// darkMarkers names the CLI landmarks a capture did NOT carry, comma-joined in
// the order DialogMarkers declares them: "reviewTitle,chatOption".
//
// The names are the JSON field names, so a query over this series, the response
// body a stuck reader is looking at, and the field the client declares
// (answer-api.ts) all say the marker the same way.
//
// One joined string rather than nine booleans. Attributes do not become Loki
// labels here — promtail strips them to hold the 5000-stream cap — so the
// cardinality that would normally argue against a joined value costs nothing,
// while nine bools would spend nine of the 48 an event is allowed
// (telemetry.MaxAttrs) on one reading.
func darkMarkers(m sessionio.DialogMarkers) []string {
	var dark []string
	for _, mk := range []struct {
		name string
		lit  bool
	}{
		{"tabBar", m.TabBar},
		{"answeredBox", m.AnsweredBox},
		{"openBox", m.OpenBox},
		{"reviewTitle", m.ReviewTitle},
		{"readyPrompt", m.ReadyPrompt},
		{"footer", m.Footer},
		{"numberedList", m.NumberedList},
		{"freeText", m.FreeText},
		{"chatOption", m.ChatOption},
	} {
		if !mk.lit {
			dark = append(dark, mk.name)
		}
	}
	return dark
}

// answerShape is how many questions the call carries and whether any of them
// is multi-select — the two numbers the browser's own records carried, so a
// query can still compare like with like — plus the word for WHERE the two
// came from.
//
// The source is not decoration, because the two branches below do not compute
// the same thing. From the call's record, `multi` is "any question in this
// call is multi-select", which is what the name suggests. From the reply's
// reading it can only be "the question the pane was drawing when the reply
// was taken is multi-select": the reading happens AFTER the keys went in, and
// a multi-question dialog draws one question at a time. Folded together under
// one name, the same call reports multi=true or multi=false depending only on
// whether Claude Code had written the record yet, and a panel splitting on
// tl.multi would be reading transcript freshness rather than call shape. The
// walk this route replaces had the same two branches and the same word for
// them, "transcript" or "pane" (TextView.tsx:384 in the build being deleted),
// so the series still splits the way it always did.
//
// The record wins when there is one: it does not move under the request, and
// it holds every question of the call with its multiSelect flag. The reading
// is the fallback for the window where Claude Code has not written the record
// yet — measured 2026-08-28 over five consecutive calls, two were not written
// until the question had been answered, 112 s later in one case — and there
// the tab bar's count is the only description of the call there is.
//
// With neither, the shape is unknown rather than zero and the caller leaves
// the attribute off. Two requests land there, and a query wanting answered
// calls should exclude both: one against a session this box does not have,
// and a Submit that worked, whose reply carries no reading at all because the
// dialog it describes has gone.
func answerShape(known []sessionio.DialogQuestion, resp sessionio.AnswerResponse) (int, bool, string) {
	multi := func(qs []sessionio.DialogQuestion) bool {
		for _, q := range qs {
			if q.MultiSelect {
				return true
			}
		}
		return false
	}
	if len(known) > 0 {
		return len(known), multi(known), "transcript"
	}
	if resp.Dialog == nil {
		return 0, false, ""
	}
	// Count comes from the tab bar, which a single-question call does not
	// draw, so it can read lower than the questions actually in hand.
	if resp.Dialog.Count < len(resp.Dialog.Questions) {
		return len(resp.Dialog.Questions), multi(resp.Dialog.Questions), "pane"
	}
	return resp.Dialog.Count, multi(resp.Dialog.Questions), "pane"
}
