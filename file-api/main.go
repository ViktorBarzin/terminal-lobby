// Command file-api is the per-user file read/write/list backend for the
// terminal-lobby v2 file preview + editor surface (roadmap pillar #6). It is a
// devvm systemd sibling of tmux-api (:7684) and clipboard-upload (:7683):
// stdlib net/http, per-user isolation via X-Authentik-Username → OS user
// (/etc/ttyd-user-map), every path confined to the caller's /home/<osUser> by
// the four-layer defense in paths.go. File ops run AS the mapped OS user in
// production (sudo, wired at deploy time); this binary enforces the path
// boundary before any op runs.
package main

import (
	"log"
	"net/http"
	"os"
)

// listenAddr — :7686, the next free port after clipboard-upload (:7683),
// tmux-api (:7684), and the planned session-events (:7685).
const listenAddr = "0.0.0.0:7686"

func main() {
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
	if a := os.Getenv("FILE_API_ADDR"); a != "" {
		addr = a
	}
	log.Printf("file-api listening on %s (homeBase=%s)", addr, homeBase)
	log.Fatal(http.ListenAndServe(addr, nil))
}
