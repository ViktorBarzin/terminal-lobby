package main

// Wiring the T3 client the /mcp pass-through forwards through.

import (
	"log"
	"os"
	"path/filepath"

	"terminal-lobby/t3client"
	"terminal-lobby/telemetry"
)

// t3TokenDir is where agent-api keeps the T3 token it holds for each user:
// <state dir>/t3, inside the unit's 0700 StateDirectory=.
func t3TokenDir(getenv func(string) string) string {
	return filepath.Join(stateDir(getenv), "t3")
}

// ensurePrivateDir makes dir, or narrows it, to 0700. Each token in it acts
// as its user in T3 for 30 days.
func ensurePrivateDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	return os.Chmod(dir, 0o700)
}

// newT3Client builds the client /mcp forwards through. It signs in to a
// user's T3 with `sudo -n /usr/local/bin/t3-mint <user>` the first time that
// user's caller arrives, and keeps the token under t3TokenDir. Ports come
// from /etc/t3-serve (dispatch.json, since the per-user env files are
// root-only); hosts from TL_T3_HOSTS and TL_T3_DOMAIN.
func newT3Client(getenv func(string) string, metrics *telemetry.Metrics) *t3client.Client {
	dir := t3TokenDir(getenv)
	if err := ensurePrivateDir(dir); err != nil {
		// Reported, not fatal: /v1 does not need it, and the first /mcp
		// call will say why it could not keep a token.
		log.Printf("agent-api: cannot prepare the T3 token directory %s: %v", dir, err)
	}
	hosts, err := t3client.HostsFromEnv(getenv)
	if err != nil {
		log.Printf("agent-api: %v; T3 links will use the default host", err)
		hosts = t3client.Hosts{Domain: t3client.DefaultDomain}
	}
	cfg := t3client.Config{
		Service: "agent-api",
		Locator: &t3client.Locator{Ports: t3client.PortFromFiles(t3client.DefaultConfigDir), Hosts: hosts},
		Credentials: &t3client.Credentials{
			Label:  "agent-api",
			Minter: t3client.SudoMinter(),
			Store:  t3client.TokenStore{Dir: dir},
			Logf:   log.Printf,
		},
		// A nil *Metrics is inert, so this is safe unwired.
		Metrics: metrics,
	}
	return t3client.New(cfg)
}
