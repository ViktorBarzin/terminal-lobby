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

	"terminal-lobby/sessionio"
	"terminal-lobby/telemetry"
)

func main() {
	addr := flag.String("addr", ":7685", "listen address")
	mapPath := flag.String("usermap", "/etc/ttyd-user-map", "Authentik→OS-user map")
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
	// publicly).
	root.HandleFunc("POST /hooks/session-start", localhostOnly(rg.handleSessionStart()))
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
