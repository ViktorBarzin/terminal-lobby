package main

import (
	"context"
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"os/signal"
	"os/user"
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
	flag.Parse()

	self, err := user.Current()
	if err != nil {
		log.Fatalf("cannot determine current user: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	injector := sessionio.NewInjector(self.Username)
	rg := newRegistry(ctx, *poll, *homeBase, injector)

	// Authed web surface (mounted behind authMiddleware).
	web := http.NewServeMux()
	web.HandleFunc("GET /events/{session}", func(w http.ResponseWriter, r *http.Request) {
		fs, ok := rg.source(osUserFrom(r.Context()), r.PathValue("session"))
		if !ok {
			http.Error(w, "session not registered", http.StatusNotFound)
			return
		}
		events.Emit("events.stream_opened", osUserFrom(r.Context()), telemetry.Attrs{
			"tl.session": r.PathValue("session"), "tl.client": "api",
		})
		writeSSE(w, r, fs, *hb)
		events.Emit("events.stream_closed", osUserFrom(r.Context()), telemetry.Attrs{
			"tl.session": r.PathValue("session"), "tl.client": "api",
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
		if injector.State(osUser, session) == sessionio.StateRunning {
			http.Error(w, "turn in progress", http.StatusConflict)
			return
		}
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
