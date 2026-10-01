package main

// tl-browser — a session's playwright MCP server, which starts its browser
// only when the agent first uses it.
//
// Claude is configured with this binary as its "playwright" MCP server over
// stdio, so every session gets its own. The launcher answers Claude's startup
// handshake from a cache and costs a few MB; on the first real browser call it
// starts the Node host (tl-browser/host), which runs playwright-mcp and Chrome
// and serves the viewer socket the lobby watches through. Because the launcher
// is Claude's child it inherits TMUX_PANE, which is how the lobby knows exactly
// which session a browser belongs to.
//
// Decision: docs/adr/0029-each-session-gets-its-own-browser-started-on-first-use.md
// Design:   docs/plans/2026-10-01-session-browser-design.md

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
)

const defaultHostPath = "/usr/lib/terminal-lobby/tl-browser-host/host.mjs"

func main() {
	flag.Usage = func() {
		os.Stderr.WriteString("usage: tl-browser\n\n" +
			"Speaks MCP on stdin/stdout. Claude starts it; there is nothing to pass.\n" +
			"TL_BROWSER_HOST overrides the host (default " + defaultHostPath + ").\n")
	}
	flag.Parse()

	logger := log.New(os.Stderr, "tl-browser: ", 0) // Claude's MCP log stamps the lines

	hostPath := os.Getenv("TL_BROWSER_HOST")
	if hostPath == "" {
		hostPath = defaultHostPath
	}
	if abs, err := filepath.Abs(hostPath); err == nil {
		hostPath = abs
	}
	version, err := HostVersion(hostPath)
	if err != nil {
		logger.Fatalf("read the browser host: %v", err)
	}

	env := passthroughEnv(os.Environ())
	hostArgv := []string{"node", hostPath}
	home, _ := os.UserHomeDir()

	l := &Launcher{
		In:       os.Stdin,
		Out:      os.Stdout,
		Log:      logger,
		HostArgv: hostArgv,
		Env:      env,
		Handshake: &HandshakeCache{
			Dir:      CacheDir(os.Getenv("XDG_CACHE_HOME"), home),
			Version:  version,
			Describe: append(append([]string{}, hostArgv...), "--describe"),
			Env:      env,
		},
		ChooseSpawner: func() Spawner {
			if userSystemdWorks(env) {
				return SystemdSpawner{Base: unitBase(tmuxSessionID(env), os.Getppid(), os.Getpid())}
			}
			logger.Print("no user systemd here, so the browser runs without its memory ceiling")
			return DirectSpawner{}
		},
		StopUnit: func(unit string) { stopUnit(unit, env) },
		HostGone: Registration{Env: env, UID: os.Getuid(), Tmux: func(args ...string) (string, error) {
			return runTmux(env, args...)
		}}.Clear,
	}

	// Claude closing our stdin is the usual end. SIGTERM and SIGHUP end the
	// same way, stopping the browser first. A Ctrl-C reaching the pane's
	// process group is not a reason to drop the browser, and a write to a
	// Claude that has gone should return an error rather than kill us before
	// the host is stopped.
	signal.Ignore(syscall.SIGINT, syscall.SIGPIPE)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGHUP)
	defer stop()

	if err := l.Run(ctx); err != nil {
		logger.Printf("stopped: %v", err)
	}
}
