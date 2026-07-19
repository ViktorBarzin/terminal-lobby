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
)

func main() {
	addr := flag.String("addr", ":7685", "listen address")
	mapPath := flag.String("usermap", "/etc/ttyd-user-map", "Authentik→OS-user map")
	homeBase := flag.String("home-base", "/home", "base dir holding per-user homes")
	poll := flag.Duration("poll", 200*time.Millisecond, "transcript tail interval")
	hb := flag.Duration("heartbeat", 20*time.Second, "SSE heartbeat interval")
	permDeadline := flag.Duration("perm-deadline", 5*time.Minute, "max wait for a web permission decision (then fail-closed deny)")
	flag.Parse()

	self, err := user.Current()
	if err != nil {
		log.Fatalf("cannot determine current user: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	rg := newRegistry(ctx, *poll, *homeBase)
	broker := NewPermissionBroker(*permDeadline)
	injector := &Injector{selfUser: self.Username}

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
	web.HandleFunc("POST /prompt/{session}", func(w http.ResponseWriter, r *http.Request) {
		osUser, session := osUserFrom(r.Context()), r.PathValue("session")
		var body struct {
			Text string `json:"text"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.Text == "" {
			http.Error(w, "bad body (need text)", http.StatusBadRequest)
			return
		}
		if injector.State(osUser, session) == stateRunning {
			http.Error(w, "turn in progress", http.StatusConflict)
			return
		}
		if err := injector.Prompt(osUser, session, body.Text); err != nil {
			http.Error(w, "inject failed", http.StatusBadGateway)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	web.HandleFunc("POST /cancel/{session}", func(w http.ResponseWriter, r *http.Request) {
		osUser, session := osUserFrom(r.Context()), r.PathValue("session")
		if err := injector.Cancel(osUser, session); err != nil {
			http.Error(w, "cancel failed", http.StatusBadGateway)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})

	root := http.NewServeMux()
	root.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	// Hooks come from the Claude Code hook running as the OS user on THIS box, so
	// they are hard-gated to loopback: an unauthenticated /hooks/permission-request
	// from the LAN could otherwise approve tool calls. Defense in depth alongside
	// the ingress not routing /hooks/* publicly.
	root.HandleFunc("POST /hooks/session-start", localhostOnly(rg.handleSessionStart()))
	root.HandleFunc("POST /hooks/permission-request", localhostOnly(permissionRequestHandler(broker, rg.permResolve)))
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

const stateRunning = "running"
