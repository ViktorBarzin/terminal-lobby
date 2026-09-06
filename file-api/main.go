// Command file-api is the per-user file read/write/list backend for the
// terminal-lobby v2 file preview + editor surface (roadmap pillar #6). It is a
// devvm systemd sibling of tmux-api (:7684) and clipboard-upload (:7683):
// stdlib net/http, per-user isolation via the identity header → OS user
// (/etc/ttyd-user-map), every path confined to the caller's /home/<osUser> by
// the four-layer defense in paths.go. A request that maps to a DIFFERENT OS
// user than the service runs as re-execs this binary under `sudo -u <user>`
// (-privop mode) so validation + the file op happen AS that user, inside their
// 0750 home; same-user requests run inline. See privop.go.
package main

import (
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"os/user"
	"strings"
)

// listenAddr — :7686, the next free port after clipboard-upload (:7683),
// tmux-api (:7684), and session-events (:7685). Loopback by default: with
// no config file present, the identity header is all that authenticates a
// request, so the port must not be on the network until an operator says
// so (TL-3).
const listenAddr = "127.0.0.1:7686"

func main() {
	// -privop marks the privileged child (re-exec'd via sudo -u <user>): it runs
	// one op AS that user and prints a JSON envelope. These flags are internal
	// (set only by runPrivop), never by the systemd unit.
	privop := flag.String("privop", "", "internal: run one op (list|read|write) as the current sudo-ed user")
	// -home is accepted and ignored. The child used to take its containment
	// root from here, which let anyone holding the sudo grant choose it; it now
	// reads its own home from the password database. Still parsed so that
	// during a deploy an old parent's argv does not fail the new child on an
	// unknown flag. Drop it once no old parent can be running.
	_ = flag.String("home", "", "internal (-privop): ignored, kept for one upgrade")
	path := flag.String("path", "", "internal (-privop): target path or dir")
	all := flag.Bool("all", false, "internal (-privop): include dotfiles (list)")
	flag.Parse()

	if *privop != "" {
		runPrivopMain(*privop, *path, *all)
		return
	}

	// Record the service's own OS user so same-user requests skip sudo and read
	// inline; everyone else is reached via the -privop re-exec. A service that
	// cannot name itself cannot tell those two apart, so it does not start:
	// every decision below this line, inline or sudo, is keyed on this name.
	u, err := user.Current()
	if err != nil {
		log.Fatalf("file-api: cannot resolve my own OS user: %v", err)
	}
	selfUser = u.Username

	http.HandleFunc("/files/list", handleList)
	http.HandleFunc("/files/read", handleRead)
	http.HandleFunc("/files/write", handleWrite)
	http.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte("ok"))
	})

	// FILE_API_ADDR: scratch-build override for the dev harness (a local build
	// can't bind :7686 while the production service holds it). The systemd unit
	// sets no environment — production stays :7686. Mirrors TMUX_API_ADDR /
	// CLIPBOARD_UPLOAD_ADDR.
	addr := listenAddr
	// TL_BIND is the listen address. The compiled default is loopback, so a
	// process that reaches no configuration at all stays off the network;
	// the shipped conffile says the same. Widening to 0.0.0.0 for a proxy on
	// another host is the operator's explicit act, made in the file where
	// TL_PROXY_SECRET is set alongside it.
	if b := strings.TrimSpace(os.Getenv("TL_BIND")); b != "" {
		if _, port, err := net.SplitHostPort(addr); err == nil {
			addr = net.JoinHostPort(b, port)
		}
	}
	actAsGate.Configure("file-api", addr)
	if a := os.Getenv("FILE_API_ADDR"); a != "" {
		addr = a
	}
	log.Printf("file-api listening on %s (homeBase=%s, selfUser=%s)",
		addr, homeBase, selfUser)
	go timing.Run(nil)
	log.Fatal(http.ListenAndServe(addr, timing.Wrap(http.DefaultServeMux)))
}
