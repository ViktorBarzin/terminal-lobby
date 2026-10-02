package main

import (
	"context"
	"encoding/json"
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
		// `-privop browser-bridge <socket>` relays one browser viewer
		// connection as this user (browser.go); bare `-privop` is the read
		// child. Anything else is refused rather than guessed at.
		switch {
		case flag.NArg() == 0:
			if err := runPrivop(); err != nil {
				log.Fatalf("privop: %v", err)
			}
		case flag.NArg() == 2 && flag.Arg(0) == browserBridgeOp:
			if err := runBrowserBridge(flag.Arg(1), os.Stdin, os.Stdout); err != nil {
				log.Fatalf("privop %s: %v", browserBridgeOp, err)
			}
		default:
			log.Fatalf("privop: unknown arguments %q", flag.Args())
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
	// A Caller's session is recorded with tl.caller (callertag.go).
	events.SetCallerRule(newCallerTags(injector).callerOf)
	rg := newRegistry(ctx, *poll, *homeBase, injector, self.Username)
	// The mod hub clears options in one tmux call; drill-ins nobody reads and
	// connections whose mod went quiet are swept on a ticker.
	rg.mods.unset = injector.UnsetOptions
	go rg.sweepEvery(ctx, SweepInterval)
	// Claudes started before the mod existed are restarted once they are safe
	// to, so each gets a stream (rollout.go).
	go newRollout(rg.mods, injector, mapUsers(*mapPath)).run(ctx, RolloutInterval)

	// Authed web surface (mounted behind authMiddleware).
	web := http.NewServeMux()
	web.HandleFunc("GET /events/{session}", func(w http.ResponseWriter, r *http.Request) {
		ls, ok := rg.live(osUserFrom(r.Context()), r.PathValue("session"))
		if !ok {
			// A Claude that started before the lobby's mod existed has no
			// stream. It is restarted once it is safe to (rollout.go), and the
			// stream says so until then, ending the moment the mod says hello
			// so the reader reconnects onto it.
			if claudeSession(injector, osUserFrom(r.Context()), r.PathValue("session")) {
				serveNoMod(w, r, rg, *hb)
				return
			}
			http.Error(w, "session not registered", http.StatusNotFound)
			return
		}
		osUser, session := osUserFrom(r.Context()), r.PathValue("session")
		// The opening cost, recorded where it is actually known. Nothing
		// measured this before: the reverse open exists to shrink it, and a
		// change nobody can see the size of is a change nobody can verify.
		// The session's agent set rides on the same stream (agentwatch.go).
		writeSSE(w, r, ls.fs, ls.agents, *hb, func(bytes, count int) {
			events.Emit("events.stream_opened", osUser, telemetry.Attrs{
				"tl.session": session, "tl.client": "api",
				"tl.bytes": bytes, "tl.count": count,
			})
		})
		events.Emit("events.stream_closed", osUser, telemetry.Attrs{
			"tl.session": session, "tl.client": "api",
		})
	})
	// One agent's own transcript, opened from the agent panel (drill.go), with
	// the paging and full results the session's transcript has. Under /events/
	// so the ingress already routes it.
	web.HandleFunc("GET /events/{session}/agents/{agent}", rg.handleDrillEvents(*hb))
	web.HandleFunc("GET /events/{session}/agents/{agent}/earlier", rg.handleDrillEarlier())
	web.HandleFunc("GET /events/{session}/agents/{agent}/result/{toolId}", rg.handleDrillResult())
	// Typing a prompt into the session: the harness decides what "ready" means,
	// and a suspended session or a pi trust question refuses (turn_routes.go).
	web.HandleFunc("POST /prompt/{session}", handlePrompt(rg, injector))
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
	// One picture out of a transcript, by position: the n-th image block of a
	// tool result (a Read of an image) or of a prompt (a picture pasted into
	// the terminal). Events name these by reference and never carry the bytes.
	// Under /result/ because the ingress already routes that prefix here; the
	// two patterns have five and six segments, so they overlap neither each
	// other nor the route above. See images.go.
	web.HandleFunc("GET /result/{session}/{toolId}/image/{n}", func(w http.ResponseWriter, r *http.Request) {
		serveImageBlock(w, r, rg, false)
	})
	web.HandleFunc("GET /result/{session}/user/{record}/image/{n}", func(w http.ResponseWriter, r *http.Request) {
		serveImageBlock(w, r, rg, true)
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
	web.HandleFunc("GET /pane/{session}", handlePane(injector))
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
	web.HandleFunc("POST /answer/{session}", handleAnswer(rg))
	// Interrupting the turn with the harness's own key, Escape for pi and Ctrl-C
	// for the rest (turn_routes.go).
	web.HandleFunc("POST /cancel/{session}", handleCancel(rg, injector))

	// Which model the session answers on, and how hard it thinks, applied to a
	// running session through the harness's own commands (turn_routes.go).
	web.HandleFunc("POST /model/{session}", handleModel(injector))

	// The browser a session's agent drives (browser.go, ADR-0035): its state,
	// and a WebSocket relaying the viewer protocol to the host's socket. Attach
	// mode is enforced here, before the host. A shared session names its owner
	// with ?owner=.
	browser := newBrowserRelay(injector, self.Username)
	web.HandleFunc("GET /browser/{session}", browser.handleState())
	web.HandleFunc("GET /browser/{session}/stream", browser.handleStream())
	root := http.NewServeMux()
	root.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	// The lobby's Claude mod (mod.go, ADR-0036). It runs inside each Claude as
	// the session's OS user on THIS box, so the routes are hard-gated to
	// loopback (the ingress does not route /mod/* publicly either). Hello
	// identifies the account that opened the connection by peer credentials;
	// the token it hands back is what authenticates the rest.
	root.HandleFunc("POST /mod/v1/hello", localhostOnly(rg.mods.handleHello()))
	root.HandleFunc("POST /mod/v1/events", localhostOnly(rg.mods.handleEvents()))
	root.HandleFunc("GET /mod/v1/poll", localhostOnly(rg.mods.handlePoll()))
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
	//
	// ONE store for both spend routes. Its mutex is what serialises writers to a
	// user's document inside this process, and a Claude reading and a pi reading
	// for the same user can arrive together; two stores would each hold their
	// own lock and the later write would drop the earlier one's change.
	spend := spendstore.New(spendDir)
	root.HandleFunc("POST /hooks/usage", localhostOnly(peerOwnsClaim(handleUsage(spend))))
	// What a pi conversation has spent, posted by the lobby's pi extension when a
	// turn settles (piusage.go). The same two gates as its neighbour, and the
	// same store: a reading is tool "pi" beside Claude's.
	root.HandleFunc("POST /hooks/pi-usage", localhostOnly(peerOwnsClaim(handlePiUsage(spend))))
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
func handleAnswer(rg *registry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		osUser, session := osUserFrom(r.Context()), r.PathValue("session")
		// The body is read BEFORE the session is placed, so that the record of
		// a session this box does not have can still say what was attempted
		// (tl.action). Reading it first costs nothing: it is bounded.
		var req sessionio.AnswerRequest
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, answerBodyLimit)).Decode(&req) != nil {
			// Over the cap and unparseable are one refusal on purpose: a
			// client can do nothing different about them. The cap is in the
			// message because it is the one of the two a caller might be
			// surprised by.
			http.Error(w, "bad body (an AnswerRequest under "+strconv.Itoa(answerBodyLimit)+" bytes)",
				http.StatusBadRequest)
			return
		}
		// A CLAUDE DIALOG IS ANSWERED THROUGH ITS MOD (ADR-0036): the question,
		// the plan approval and the permission prompt all go to the mod as
		// data, which settles the dialog inside Claude. Nothing is typed.
		c := rg.mods.conn(osUser, session)
		if c == nil {
			http.Error(w, "session not registered", http.StatusNotFound)
			// RECORDED, not merely refused: a card still on a reader's screen
			// with nothing behind it, which the client shows nothing for.
			emitAnswer(osUser, session, nil, sessionio.AnswerResponse{Reason: answerNoSession},
				sessionio.AnswerAction(req))
			return
		}
		var held []sessionio.DialogQuestion
		if d := c.dialogNow(); d != nil && d.kind == "ask" {
			for _, q := range d.questions {
				held = append(held, sessionio.DialogQuestion{Question: q.Question, MultiSelect: q.MultiSelect})
			}
		}
		resp := c.answer(r.Context(), req)
		resp.Action = sessionio.AnswerAction(req)
		emitAnswer(osUser, session, held, resp, resp.Action)
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
//
// A multi-select toggle never comes here (handleAnswer). Its answer is the
// commit that follows, so one multi-select answer counts once however many
// clicks built it. A commit whose set holds the free-text row carries the
// row's words in Text, so it counts as free text, api-text with the words'
// length, although the words normally went in on an earlier toggle and the
// commit itself only walks and presses Enter. That is deliberate: the commit
// is the one request that names the whole answer, words included, and the
// toggle that typed them is never counted. The live check on 2026-09-23 saw
// it as tl.count 4 for "Kiwi".
//
// The plan approval, since 2026-09-24, counts the same way: an approve option
// is one digit, and words typed into its feedback row are free text, api-text
// with their length, whether they went back for more planning or approved the
// plan with them. Either is one answer. A permission prompt declined with words
// (since 2026-09-27) is free text the same way; a permission row picked by its
// number is one digit, as an approve option is (through this route since
// 2026-09-28, through POST /keys before).
func emitAnswered(osUser, session string, req sessionio.AnswerRequest) {
	client, count := "api", 1
	switch {
	case req.Chat != nil:
		client, count = "api-text", len(*req.Chat)
	case req.Plan != nil && req.Plan.Feedback != "":
		client, count = "api-text", len(req.Plan.Feedback)
	case req.Permission != nil && req.Permission.Decline != "":
		client, count = "api-text", len(req.Permission.Decline)
	}
	events.Emit("claude.answered", osUser, telemetry.Attrs{
		"tl.session": session, "tl.count": count, "tl.client": client,
	})
}

// emitAnswer records the SHAPE of what happened, never what was on screen.
//
// A dialog quotes whatever the session was working on, so nothing here carries
// a question, an option label or the words typed (ADR-0006). tl.session ties a
// failure back to its transcript, tl.action says what kind of request it was
// (answers, chat, plan-approve, plan-feedback, permission-decline,
// permission-pick), and a held
// call adds how many questions it asked and whether any was multi-select.
//
// The two NAMES are the ones the browser walk emitted before 2026-09-10, so
// tl.client has to be read in every query over them: api-answer is this route,
// and the mode dial records into the same names as api-mode (emitMode).
func emitAnswer(osUser, session string, known []sessionio.DialogQuestion, resp sessionio.AnswerResponse, action string) {
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
	attrs := telemetry.Attrs{"tl.session": session, "tl.client": "api-answer"}
	// A plan answer carries no question shape; a held call's is the call's.
	if len(known) > 0 {
		multi := false
		for _, q := range known {
			multi = multi || q.MultiSelect
		}
		attrs["tl.questions"], attrs["tl.multi"] = len(known), multi
	}
	if action != "" {
		attrs["tl.action"] = action
	}
	if resp.Reason != "" {
		attrs["tl.reason"] = resp.Reason
	}
	events.Emit(event, osUser, attrs)
}
