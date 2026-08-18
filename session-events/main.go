package main

import (
	"context"
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"os/signal"
	"os/user"
	"strconv"
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
	// Keeps the context meter current, and touches nothing nobody is watching.
	refresh := newRefresher(injector)

	// Authed web surface (mounted behind authMiddleware).
	web := http.NewServeMux()
	web.HandleFunc("GET /events/{session}", func(w http.ResponseWriter, r *http.Request) {
		fs, ok := rg.source(osUserFrom(r.Context()), r.PathValue("session"))
		if !ok {
			http.Error(w, "session not registered", http.StatusNotFound)
			return
		}
		osUser, session := osUserFrom(r.Context()), r.PathValue("session")
		events.Emit("events.stream_opened", osUser, telemetry.Attrs{
			"tl.session": session, "tl.client": "api",
		})
		// A text viewer is attached for exactly the life of its stream, which is
		// the whole window in which the context refresh may touch this pane.
		refresh.attach(osUser, session)
		defer refresh.detach(osUser, session)

		writeSSE(w, r, fs, *hb, func(id int64) { refresh.turnSettled(osUser, session, id) })
		events.Emit("events.stream_closed", osUser, telemetry.Attrs{
			"tl.session": session, "tl.client": "api",
		})
	})
	web.HandleFunc("POST /prompt/{session}", func(w http.ResponseWriter, r *http.Request) {
		osUser, session := osUserFrom(r.Context()), r.PathValue("session")
		var body struct {
			Text string `json:"text"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.Text == "" {
			http.Error(w, "bad body (need text)", http.StatusBadRequest)
			return
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
	// Older turns, one window at a time — the "Load earlier" step above a view
	// that opened on the recent window (see OpenWindowTurns).
	web.HandleFunc("GET /earlier/{session}", func(w http.ResponseWriter, r *http.Request) {
		fs, ok := rg.source(osUserFrom(r.Context()), r.PathValue("session"))
		if !ok {
			http.Error(w, "session not registered", http.StatusNotFound)
			return
		}
		before, err := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
		if err != nil || before <= 0 {
			http.Error(w, "bad before (need the id of the oldest event held)", http.StatusBadRequest)
			return
		}
		writeJSON(w, fs.Earlier(before, OpenWindowTurns))
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

	root := http.NewServeMux()
	root.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	// The session-start hook runs as the OS user on THIS box, so it is hard-gated
	// to loopback (defense in depth alongside the ingress not routing /hooks/*
	// publicly).
	root.HandleFunc("POST /hooks/session-start", localhostOnly(rg.handleSessionStart()))
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
