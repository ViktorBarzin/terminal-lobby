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
	"context"
	"fmt"
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
// nothing else, on loopback until an operator names another address in
// TL_AGENT_BIND. listenAddress has the reason that key exists.
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
	modelList := loadModels(os.Getenv("TL_MANAGED_SETTINGS"))

	self, err := user.Current()
	if err != nil {
		log.Fatalf("agent-api: cannot resolve my own OS user: %v", err)
	}

	addrs, err := bindAddresses(os.Getenv, resolveHost)
	if err != nil {
		// Fatal, and deliberately so. Every other doubt in this file is
		// reported and worked around; a bind is the one setting where the
		// wrong answer is silently serving something to somebody, so a value
		// this service cannot honour stops it rather than moving it.
		log.Fatalf("agent-api: %v", err)
	}
	if note := ignoredBoxWideBind(addrs, os.Getenv("TL_BIND")); note != "" {
		log.Print(note)
	}
	for _, a := range addrs {
		if warning := bindWarning(a, self.Username); warning != "" {
			log.Print(warning)
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
			"Write one credential per line as `<name>  sha256:<digest>  <os-user>` in %s, "+
			"the digest being `printf %%s \"$TOKEN\" | sha256sum`. Own the file as root, "+
			"group-readable by this service's account, mode 0640: a file this account owns "+
			"is one anything running as it can add a credential to.", bearerTokensPath())
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
		Models:    modelList,
	}
	srv.Runner = NewRunner(srv.runTurn)

	log.Printf("agent-api: listening on %s (selfUser=%s, claude=%s, trace=%v)",
		strings.Join(addrs, ", "), self.Username, srv.ClaudeBin, trace.Enabled())
	go timing.Run(nil)

	server := &http.Server{
		Handler: timing.Wrap(srv.Routes()),
		// A turn is watched by a background goroutine, never by a request, so
		// no handler here has any business taking minutes. These bound a
		// stuck tmux call rather than a slow agent.
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	// One server, one listener per address. Every listener is opened BEFORE
	// any of them is served, so a box where the tailnet address is not up yet
	// fails at startup with the address in the message rather than coming up
	// half-bound and answering the health probe as if it were fine.
	listeners := make([]net.Listener, 0, len(addrs))
	for _, a := range addrs {
		l, err := net.Listen("tcp", a)
		if err != nil {
			log.Fatalf("agent-api: cannot listen on %s: %v", a, err)
		}
		listeners = append(listeners, l)
	}
	failed := make(chan error, len(listeners))
	for _, l := range listeners {
		go func(l net.Listener) { failed <- server.Serve(l) }(l)
	}
	log.Fatal(<-failed)
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

// resolveTimeout bounds the one name lookup startup makes. Long enough for a
// resolver on a loaded box, short enough that a broken one is a failed start
// rather than a service that never finishes starting.
const resolveTimeout = 5 * time.Second

// resolveHost reports whether this machine can turn a configured host into an
// address. A literal IP needs no resolver and never consults one.
func resolveHost(host string) error {
	if net.ParseIP(host) != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), resolveTimeout)
	defer cancel()
	addrs, err := net.DefaultResolver.LookupHost(ctx, host)
	if err != nil {
		return err
	}
	if len(addrs) == 0 {
		return fmt.Errorf("it resolves to no address")
	}
	return nil
}

// bindAddresses is every address this service listens on, or the reason it
// will not start.
//
// Loopback is always one of them, and not for convenience: tl-apply verifies
// an install by probing http://127.0.0.1:8710/health and an anonymous
// /v1/conversations on the same port (release/manifest.go), so a service that
// MOVED to its tailnet address rather than adding it would fail its own
// verification and be reverted. The rest come from TL_AGENT_BIND, comma
// separated.
//
// They do not come from TL_BIND, and that is the point of the key existing.
// The five browser-facing services share TL_BIND because they sit behind the
// cluster ingress, which runs on another host — so it is 0.0.0.0 on this
// devvm, and 7683 to 7688 all listen on `*` (measured 2026-09-16). This
// service is reached over the Headscale tailnet instead, where the ACL opens
// :8710 to tag:muse and to nothing else, and it has no proxy in front of it
// at all. Inheriting a box-wide 0.0.0.0 would have put a port that creates
// and drives Claude sessions on the LAN the moment the package installed.
//
// Three values are refused rather than narrowed or widened:
//
//   - The unspecified address — 0.0.0.0, ::, or a bare :port. September 2026
//     is the reason: every lobby service bound 0.0.0.0 because the box-wide
//     conf said so, the identity header was the only authentication, and the
//     box has no host firewall, so anything routable to it was whichever user
//     it claimed to be. Traefik stamping X-TL-Proxy-Secret closed that on
//     2026-09-11, and it does not cover this port. An operator who means every
//     interface names every interface.
//   - A host this machine cannot resolve. That is a typo in a configuration
//     file, and serving somewhere else because of one is how a port ends up
//     somewhere nobody chose.
//   - A value that is not a host or a host:port.
//
// A bare host takes the compiled port; host:port is taken whole, so a box that
// needs another port says so in the same place.
func bindAddresses(getenv func(string) string, resolve func(host string) error) ([]string, error) {
	_, defaultPort, err := net.SplitHostPort(listenAddr)
	if err != nil {
		return nil, fmt.Errorf("the compiled default %q is not an address", listenAddr)
	}
	out := []string{listenAddr}
	seen := map[string]bool{listenAddr: true}

	for _, raw := range strings.Split(getenv("TL_AGENT_BIND"), ",") {
		value := strings.TrimSpace(raw)
		if value == "" {
			continue
		}
		host, port, err := net.SplitHostPort(value)
		if err != nil {
			// No port in it, so the whole value is the host.
			host, port = value, defaultPort
		}
		if port == "" {
			port = defaultPort
		}
		if host == "" {
			return nil, fmt.Errorf("TL_AGENT_BIND %q names a port and no address, which listens on "+
				"every interface; name the address this service should answer on, or unset it for loopback", value)
		}
		if ip := net.ParseIP(host); ip != nil && ip.IsUnspecified() {
			return nil, fmt.Errorf("TL_AGENT_BIND %q is the unspecified address, which listens on every "+
				"interface. This port creates and drives Claude sessions behind one bearer credential, with "+
				"no proxy and no source check in front of it; name this host's tailnet address instead, or "+
				"unset it for loopback", value)
		}
		if err := resolve(host); err != nil {
			return nil, fmt.Errorf("TL_AGENT_BIND names %q, which this host cannot resolve (%v); "+
				"nothing is served until it can, because the alternative is serving on an address "+
				"nobody chose", host, err)
		}
		addr := net.JoinHostPort(host, port)
		if seen[addr] {
			continue
		}
		seen[addr] = true
		out = append(out, addr)
	}
	return out, nil
}

// ignoredBoxWideBind is the line for an operator who set TL_BIND, expected
// this service to follow it, and would otherwise spend the afternoon working
// out why the caller cannot connect. Empty when there is nothing to say.
func ignoredBoxWideBind(addrs []string, tlBind string) string {
	tlBind = strings.TrimSpace(tlBind)
	if tlBind == "" {
		return ""
	}
	for _, addr := range addrs {
		if host, _, err := net.SplitHostPort(addr); err == nil && host == tlBind {
			return ""
		}
	}
	return fmt.Sprintf("agent-api: TL_BIND=%s belongs to the browser-facing services and this one "+
		"ignores it; it binds %s. Set TL_AGENT_BIND to this host's tailnet address to let its "+
		"caller reach it.", tlBind, strings.Join(addrs, ", "))
}

// tailnetCGNAT is 100.64.0.0/10, the range Headscale allocates from. An
// address inside it is reachable from the tailnet, whose policy we own, and
// that is the network the design puts this port on.
var tailnetCGNAT = &net.IPNet{IP: net.IP{100, 64, 0, 0}, Mask: net.CIDRMask(10, 32)}

// bindWarning says so when the bind reaches somewhere no policy covers.
// Loopback and the tailnet are quiet. Anything else is a port that starts
// programs as selfUser, on a network, behind one credential — worth a line an
// operator can act on rather than a silent listen. Empty means nothing to warn
// about.
func bindWarning(addr, selfUser string) string {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return ""
	}
	ip := net.ParseIP(host)
	switch {
	case ip == nil:
		// A name, not an address. What it resolves to belongs to the
		// resolver, and guessing at it in a log line reads as fact.
		return ""
	case ip.IsLoopback(), tailnetCGNAT.Contains(ip):
		return ""
	}
	where := "the networks " + host + " is on"
	if ip.IsUnspecified() {
		where = "every network this host is on"
	}
	return fmt.Sprintf("agent-api: listening on %s, which is reachable from %s. This port creates "+
		"and drives Claude sessions as %s, and a bearer credential is the only control in front of "+
		"it: there is no proxy and no ACL in the request path. The design gives it one caller over "+
		"the tailnet, so set TL_AGENT_BIND to this host's tailnet address, or unset it for loopback.",
		addr, where, selfUser)
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
