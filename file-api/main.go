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
// tmux-api (:7684), and session-events (:7685).
const listenAddr = "0.0.0.0:7686"

func main() {
	// -privop marks the privileged child (re-exec'd via sudo -u <user>): it runs
	// one op AS that user and prints a JSON envelope. These flags are internal
	// (set only by runPrivop), never by the systemd unit.
	privop := flag.String("privop", "", "internal: run one op (list|read|write) as the current sudo-ed user")
	home := flag.String("home", "", "internal (-privop): user home containment root")
	path := flag.String("path", "", "internal (-privop): target path or dir")
	all := flag.Bool("all", false, "internal (-privop): include dotfiles (list)")
	flag.Parse()

	if *privop != "" {
		runPrivopMain(*privop, *home, *path, *all)
		return
	}

	// Record the service's own OS user so same-user requests skip sudo and read
	// inline; everyone else is reached via the -privop re-exec.
	if u, err := user.Current(); err == nil {
		selfUser = u.Username
	}

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
	// TL_BIND narrows the listener. The default is unchanged; an operator who
	// puts the proxy on the same host can set 127.0.0.1 and remove the LAN
	// path entirely without needing a shared secret.
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
