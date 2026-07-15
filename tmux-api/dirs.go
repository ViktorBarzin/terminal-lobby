package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os/exec"
	"strings"
)

// GET /dirs feeds the project directory picker (frontend): the candidate
// directories under the calling user's $HOME that a project can be rooted at.
// Read-only — it lists directory names, never file contents, and mutates
// nothing.
//
// The scan runs the audited, ARGUMENT-FREE wrapper tmux-user-dirlist. Keeping
// the fd flags (type=dir, hidden + .gitignore excluded, depth/count caps)
// hardcoded inside that wrapper — rather than whitelisting fd itself under
// sudo — is deliberate: fd's --exec would otherwise be a code-exec vector as
// another user. The wrapper takes no input, so there is nothing to inject.

// dirlistWrapper is the audited dir-list binary. A var only as a test seam,
// exactly like tmuxBinary; production never reassigns it (dirs_test.go swaps
// it for a stub).
var dirlistWrapper = "/usr/local/bin/tmux-user-dirlist"

// maxDirsResponse caps how many directory paths /dirs returns. The wrapper
// enforces the same ceiling on its side; hitting it means the scan was
// truncated, and the picker should keep its typed-path fallback for anything
// the fuzzy list didn't surface.
const maxDirsResponse = 4000

// dirlistCmd runs the wrapper AS osUser: directly when osUser owns this
// process (wizard → no sudo), else `sudo -n -H -u <user>`. The -H is load-
// bearing — it hands the wrapper the target user's $HOME — mirroring the
// `sudo -n -H -u` that tmux-attach.sh uses for tmux-user-attach.
func dirlistCmd(osUser string) *exec.Cmd {
	if osUser == selfUser {
		return exec.Command(dirlistWrapper)
	}
	return exec.Command(sudoBinary, "-n", "-H", "-u", osUser, dirlistWrapper)
}

type dirsBody struct {
	Dirs      []string `json:"dirs"`
	Truncated bool     `json:"truncated"`
}

func handleDirs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	osUser := resolveOSUser(w, r)
	if osUser == "" {
		return
	}

	// Output() keeps stdout (the dir list) apart from stderr (fd/sudo
	// chatter) and exposes the stderr on the ExitError for the log line.
	out, err := dirlistCmd(osUser).Output()
	if err != nil {
		var msg string
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			msg = string(exitErr.Stderr)
		}
		log.Printf("dir-list as %s failed: %v: %s", osUser, err, msg)
		http.Error(w, "dir list failed", http.StatusInternalServerError)
		return
	}

	dirs := make([]string, 0, 256)
	truncated := false
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		if len(dirs) >= maxDirsResponse {
			truncated = true
			break
		}
		dirs = append(dirs, line)
	}

	// no-store: the picker fetches this fresh each time it opens; a cached
	// copy would hand back a stale directory set after the tree changed.
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(dirsBody{Dirs: dirs, Truncated: truncated})
}
