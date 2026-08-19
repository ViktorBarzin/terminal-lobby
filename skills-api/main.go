// Command skills-api is the skill manager's backend: the Skills group in the
// lobby's Settings overlay talks to it, and it owns every filesystem change that
// group can cause.
//
// A devvm systemd sibling of tmux-api (:7684), session-events (:7685) and
// file-api (:7686): stdlib net/http, per-user isolation via
// X-Authentik-Username → OS user (/etc/ttyd-user-map), the same ?as= admin
// switch. What it does that they do not is act as TWO users in one request — an
// install reads the owner's skill and writes the recipient's, in homes neither
// user can enter — which is why it is its own binary with its own narrow sudoers
// grant rather than more surface on a service that also streams transcripts.
// See docs/adr/0011-skills-move-between-users-by-copy.md.
package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"os/user"
)

// listenAddr — :7688. :7687 is deliberately skipped: it belonged to the retired
// terminal-dev ttyd and a stale bookmark reaching a new service on that port is
// a worse outcome than leaving a gap.
const listenAddr = "0.0.0.0:7688"

func main() {
	// -privop marks the privileged child, re-exec'd through sudo to act as one
	// user. Internal: set by run(), never by the systemd unit.
	privop := flag.String("privop", "", "internal: perform one op as the invoking user (stdin: JSON request)")
	flag.Parse()
	if *privop != "" {
		runPrivopChild(*privop)
		return
	}

	if u, err := user.Current(); err == nil {
		selfUser = u.Username
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /skills", handleInventory)
	mux.HandleFunc("GET /skills/view", handleView)
	mux.HandleFunc("GET /skills/diff", handleDiff)
	mux.HandleFunc("POST /skills/install", handleInstall)
	mux.HandleFunc("POST /skills/toggle", handleToggle)
	mux.HandleFunc("POST /skills/remove", handleRemove)
	mux.HandleFunc("POST /skills/plugin-update", handlePluginUpdate)
	mux.HandleFunc("POST /skills/restart", handleRestart)
	// Unauthenticated by design, like every sibling: the deploy script and the
	// systemd health check ask this and nothing else.
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte("ok"))
	})

	// SKILLS_API_ADDR: scratch-build override for the dev harness, since a local
	// build cannot bind :7688 while the production service holds it. The systemd
	// unit sets no environment, so production stays :7688. Mirrors
	// FILE_API_ADDR / TMUX_API_ADDR.
	addr := listenAddr
	if a := os.Getenv("SKILLS_API_ADDR"); a != "" {
		addr = a
	}
	log.Printf("skills-api listening on %s (homeBase=%s, selfUser=%s)", addr, homeBase, selfUser)
	go timing.Run(nil)
	log.Fatal(http.ListenAndServe(addr, timing.Wrap(mux)))
}
