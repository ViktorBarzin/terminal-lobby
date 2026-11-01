package main

// Wiring the T3 client the session list and the T3 routes call through.

import (
	"log"
	"os"
	"path/filepath"

	"terminal-lobby/t3client"
)

// defaultT3TokenDir is where tmux-api keeps the T3 token it holds for each
// user, inside its 0700 state directory beside the prefs and layouts.
const defaultT3TokenDir = "/var/lib/tmux-api/t3"

// t3TokenDir is defaultT3TokenDir, or TMUX_API_T3_DIR for a scratch build
// (the same reason as TMUX_API_PREFS_DIR: a local run must not write the
// production store).
func t3TokenDir(getenv func(string) string) string {
	if d := getenv("TMUX_API_T3_DIR"); d != "" {
		return d
	}
	return defaultT3TokenDir
}

// ensurePrivateDir makes dir, or narrows it, to 0700. Each token in it acts
// as its user in T3 for 30 days.
func ensurePrivateDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	return os.Chmod(dir, 0o700)
}

// newT3Client builds the client tmux-api reads T3 threads through. It signs
// in to a user's T3 with `sudo -n /usr/local/bin/t3-mint <user>` the first
// time that user's list is polled, labelled terminal-lobby in the user's
// T3 Settings > Access, and keeps the token under t3TokenDir. Ports come from
// /etc/t3-serve (dispatch.json, since the per-user env files are root-only);
// hosts from TL_T3_HOSTS and TL_T3_DOMAIN.
func newT3Client(getenv func(string) string) *t3client.Client {
	dir := t3TokenDir(getenv)
	if err := ensurePrivateDir(dir); err != nil {
		// Reported, not fatal: the tmux sessions list without T3, and each
		// poll will say why it could not keep a token.
		log.Printf("tmux-api: cannot prepare the T3 token directory %s: %v", dir, err)
	}
	hosts, err := t3client.HostsFromEnv(getenv)
	if err != nil {
		log.Printf("tmux-api: %v; T3 links will use the default host", err)
		hosts = t3client.Hosts{Domain: t3client.DefaultDomain}
	}
	return t3client.New(t3client.Config{
		Service: "tmux-api",
		Locator: &t3client.Locator{Ports: t3client.PortFromFiles(t3client.DefaultConfigDir), Hosts: hosts},
		Credentials: &t3client.Credentials{
			Label:  "terminal-lobby",
			Minter: t3client.SudoMinter(),
			Store:  t3client.TokenStore{Dir: filepath.Clean(dir)},
			Logf:   log.Printf,
		},
		Metrics:  metrics,
		Toplevel: t3Toplevel,
	})
}
