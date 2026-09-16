// Command agent-api is Terminal Lobby's machine-facing interface: the same
// tmux-resident Claude conversations the browser front door serves, served to
// a program instead.
//
// A devvm systemd sibling of tmux-api (:7684), session-events (:7685),
// file-api (:7686) and skills-api (:7688), on :8710. It shares their identity
// module (authuser) and their session module (sessionio), and it calls neither
// of their ports: everything it does, it does in-process, so the shared
// TL_PROXY_SECRET is never handed to anything on a caller's behalf.
//
// What is different about this one, and why it exists rather than being four
// more routes on tmux-api:
//
//   - Its callers are programs, so it requires a per-caller bearer credential
//     (authuser/bearer.go) rather than an identity header a proxy set.
//   - Its work is asynchronous. A turn takes minutes; the API takes a message,
//     hands back a task id, and the caller polls.
//   - Everything it is asked to do is written to a replayable trace, which the
//     design doc names as the main control over a caller nobody approves
//     requests for.
//
// Design: infra/docs/plans/2026-09-14-muse-agent-broker-design.md.
package main

import (
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"strings"
	"time"

	"terminal-lobby/authuser"
	"terminal-lobby/sessionio"
	"terminal-lobby/telemetry"
)

// listenAddr — :8710, the port the Headscale ACL opens to the caller's tag and
// nothing else. Loopback by default, like every other lobby service: with no
// configuration on the box, nothing should be reachable from the network until
// an operator says so in the file where the credentials live.
const listenAddr = "127.0.0.1:8710"

// buildID is stamped at deploy time (-ldflags -X main.buildID=<rev>).
var buildID = "dev"

var (
	// diagEvents and timing are the shared request middleware every lobby
	// service runs (docs/adr/0008-client-diagnostics.md). It measures; the
	// trace records. The two are not alternatives: one answers "how fast is
	// this service", the other answers "what was this service asked to do".
	diagEvents = telemetry.NewDiag("agent-api", buildID, nil)
	timing     = telemetry.NewTiming(diagEvents, telemetry.TimingOpts{})
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	validateOpenAPI()

	self, err := user.Current()
	if err != nil {
		log.Fatalf("agent-api: cannot resolve my own OS user: %v", err)
	}

	addr := listenAddr
	// TL_BIND is the listen address, shared with the other lobby services.
	// The compiled default is loopback; widening it is the operator's
	// explicit act, made in the file where the credentials are set.
	if b := strings.TrimSpace(os.Getenv("TL_BIND")); b != "" {
		if _, port, err := net.SplitHostPort(addr); err == nil {
			addr = net.JoinHostPort(b, port)
		}
	}

	// The gate is built by hand rather than through authuser.Configure, and
	// the reason is its log line rather than its behaviour. Configure warns
	// that without TL_PROXY_SECRET anyone reaching the port may send the
	// identity header and be treated as that user — true of the five browser-
	// facing services, and false here, because requireAuth strips that header
	// before the gate ever sees it. An operator reading a startup line that
	// misdescribes the port it names is worse off than one reading nothing.
	//
	// Everything Configure does that matters is done here: the environment is
	// read once, and SelfUser is resolved before any handler goroutine exists
	// so the request path never writes to the shared Gate.
	gate := &authuser.Gate{
		AdminsPath: authuser.DefaultAdminsPath,
		Config:     authuser.ConfigFromEnv(),
		SelfUser:   self.Username,
	}
	// Nothing here can be reached without a credential that names its caller,
	// so a box with no credentials file is a box where this service can do
	// nothing at all. Worth one line at startup rather than a stream of 401s
	// nobody can explain.
	if hasBearerCredentials(gate) {
		log.Printf("agent-api: bearer credentials loaded from %s; the identity header and "+
			"TL_PROXY_SECRET are not accepted on this port", bearerTokensPath())
	} else {
		log.Printf("agent-api: no bearer credentials are loaded, so every /v1 request will be refused. "+
			"Write one credential per line as `<name>  <token>  <os-user>` in %s, "+
			"owned by this service's account and mode 0640.", bearerTokensPath())
	}

	trace := OpenTrace(tracePath())
	defer trace.Close()

	srv := &Server{
		Gate:      gate,
		Sessions:  &tmuxSessions{in: sessionio.NewInjector(self.Username), homeBase: "/home"},
		Tasks:     NewTaskStore(nil),
		Trace:     trace,
		IDs:       newIDGen(nil),
		HomeBase:  "/home",
		ClaudeBin: claudeBinary(),
	}
	srv.Runner = NewRunner(srv.runTurn)

	log.Printf("agent-api: listening on %s (selfUser=%s, claude=%s, trace=%v)",
		addr, self.Username, srv.ClaudeBin, trace.Enabled())
	go timing.Run(nil)

	server := &http.Server{
		Addr:    addr,
		Handler: timing.Wrap(srv.Routes()),
		// A turn is watched by a background goroutine, never by a request, so
		// no handler here has any business taking minutes. These bound a
		// stuck tmux call rather than a slow agent.
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	log.Fatal(server.ListenAndServe())
}

// hasBearerCredentials reports whether the box has any. authuser deliberately
// exposes no count, and it should not — the answer would be a file read on the
// request path. This asks the one question a startup line needs by making a
// request that presents a token nothing will match: ErrBadBearer means the
// file was read and had credentials in it; anything else means it did not.
func hasBearerCredentials(g *authuser.Gate) bool {
	probe, err := http.NewRequest(http.MethodGet, "http://localhost/", nil)
	if err != nil {
		return false
	}
	probe.Header.Set("Authorization", "Bearer "+strings.Repeat("0", 64))
	_, err = g.Resolve(probe)
	return err == authuser.ErrBadBearer
}

// bearerTokensPath is the credentials file this process will read, for the
// startup line. authuser resolves the same thing internally and keeps it
// private, which is right — it is read per request and should not be cached —
// but an operator being told to write a file needs its name.
func bearerTokensPath() string {
	if p := strings.TrimSpace(os.Getenv("TL_BEARER_TOKENS")); p != "" {
		return p
	}
	return authuser.DefaultBearerTokensPath
}

// tracePath is TL_AGENT_TRACE, or the compiled default.
func tracePath() string {
	if p := strings.TrimSpace(os.Getenv("TL_AGENT_TRACE")); p != "" {
		return p
	}
	return DefaultTracePath
}

// claudeBinary is the harness a new conversation runs.
//
// Absolute, resolved once at startup, so a conversation is not started by
// whatever `claude` happens to be first on the PATH a unit inherited. TL_CLAUDE_BIN
// overrides it for a box that keeps the harness somewhere else.
func claudeBinary() string {
	if p := strings.TrimSpace(os.Getenv("TL_CLAUDE_BIN")); p != "" {
		return p
	}
	if p, err := exec.LookPath("claude"); err == nil {
		return p
	}
	// Reported rather than fatal: the service still lists, reads and answers
	// every other route, and a box with no harness installed should say so
	// once at startup rather than refuse to run at all.
	log.Printf("agent-api: no `claude` on PATH and no TL_CLAUDE_BIN; " +
		"new conversations will be created and die immediately. Set TL_CLAUDE_BIN.")
	return "claude"
}
