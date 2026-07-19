package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	addr := flag.String("addr", ":7685", "listen address")
	mapPath := flag.String("usermap", "/etc/ttyd-user-map", "Authentik→OS-user map")
	homeBase := flag.String("home-base", "/home", "base dir holding per-user homes")
	poll := flag.Duration("poll", 200*time.Millisecond, "transcript tail interval")
	hb := flag.Duration("heartbeat", 20*time.Second, "SSE heartbeat interval")
	permDeadline := flag.Duration("perm-deadline", 5*time.Minute, "max wait for a web permission decision (then fail-closed deny)")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	rg := newRegistry(ctx, *poll, *homeBase)
	broker := NewPermissionBroker(*permDeadline)

	// Authed web surface (mounted behind authMiddleware).
	web := http.NewServeMux()
	web.HandleFunc("GET /events/{session}", func(w http.ResponseWriter, r *http.Request) {
		fs, ok := rg.source(osUserFrom(r.Context()), r.PathValue("session"))
		if !ok {
			http.Error(w, "session not registered", http.StatusNotFound)
			return
		}
		writeSSE(w, r, fs, *hb)
	})
	web.HandleFunc("POST /permission/{id}", permissionResolveHandler(broker))
	web.HandleFunc("POST /prompt/{session}", notYetWired)  // task 8: tmux injection
	web.HandleFunc("POST /cancel/{session}", notYetWired)  // task 8: interrupt

	root := http.NewServeMux()
	root.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	// Hooks are localhost-only by deployment (the Claude Code hook runs as the OS
	// user on this box). The ingress MUST NOT route /hooks/* publicly.
	root.HandleFunc("POST /hooks/session-start", rg.handleSessionStart())
	root.HandleFunc("POST /hooks/permission-request", permissionRequestHandler(broker, rg.permResolve))
	root.Handle("/", authMiddleware(*mapPath, web))

	srv := &http.Server{Addr: *addr, Handler: root}
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

func notYetWired(w http.ResponseWriter, _ *http.Request) {
	http.Error(w, "not yet wired (pillar #1 task 8: tmux injection)", http.StatusNotImplemented)
}
