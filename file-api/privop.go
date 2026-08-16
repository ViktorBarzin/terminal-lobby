package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

// Cross-user file access.
//
// file-api runs as one service user (wizard). Other users' homes are 0750, so
// the service cannot read/stat/write inside them directly — and file-api's own
// path validation (resolveWithin → EvalSymlinks) needs the user's read access
// to resolve symlinks safely. So for a request that maps to a DIFFERENT OS
// user, the whole validate+op runs AS that user by re-exec'ing this binary
// under `sudo -n -u <user> file-api -privop <op> ...` (the same NOPASSWD sudo
// pattern tmux-api / session-events use). The child validates + performs the op
// with the user's own view of the filesystem and returns a JSON envelope; the
// parent turns that envelope into the HTTP response. Requests that map to the
// service user itself take the inline path (no sudo) — the common case + tests.

// selfUser is the service's own OS user (set in main from user.Current()). When
// a request's mapped OS user equals this, ops run inline.
var selfUser string

// crossUser reports whether osUser's files must be reached via sudo.
func crossUser(osUser string) bool { return selfUser != "" && osUser != selfUser }

// privopResult is the envelope the privileged child returns on stdout, and the
// shape the shared op cores fill for both the inline and cross-user paths.
type privopResult struct {
	Status      int         `json:"status"`
	Error       string      `json:"error,omitempty"`
	Entries     []fileEntry `json:"entries,omitempty"`
	ContentB64  string      `json:"content_b64,omitempty"`
	ContentType string      `json:"content_type,omitempty"`
	MtimeUnix   int64       `json:"mtime_unix,omitempty"`
}

// --- op cores (run in whatever user context the process is in) ----------------

// opList implements GET /files/list. Shared by the inline handler and the
// privop child, so the containment logic (resolveWithin) has ONE implementation.
func opList(home, dir string, all bool) privopResult {
	resolved, err := resolveWithin(home, dir, true)
	if err != nil {
		return errResult(err)
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return errResult(err)
	}
	if !info.IsDir() {
		return privopResult{Status: http.StatusBadRequest, Error: "not a directory"}
	}
	dirents, err := os.ReadDir(resolved)
	if err != nil {
		log.Printf("readdir %s: %v", resolved, err)
		return privopResult{Status: http.StatusInternalServerError, Error: "internal error"}
	}
	entries := make([]fileEntry, 0, len(dirents))
	for _, d := range dirents {
		name := d.Name()
		if !all && strings.HasPrefix(name, ".") {
			continue
		}
		fi, err := d.Info()
		if err != nil {
			continue
		}
		entries = append(entries, fileEntry{
			Name:  name,
			Path:  filepath.Join(resolved, name),
			Size:  fi.Size(),
			Mtime: fi.ModTime().Unix(),
			IsDir: fi.IsDir(),
		})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsDir != entries[j].IsDir {
			return entries[i].IsDir
		}
		return entries[i].Name < entries[j].Name
	})
	return privopResult{Status: http.StatusOK, Entries: entries}
}

// opReadEnvelope implements GET /files/read for the cross-user path: it reads
// the whole (≤maxFileSize) file and returns it base64-encoded in the envelope.
// The inline self path uses http.ServeContent directly (Range/streaming) — both
// share resolveWithin + checkReadable so validation never diverges.
func opReadEnvelope(home, path string) privopResult {
	resolved, err := resolveWithin(home, path, true)
	if err != nil {
		return errResult(err)
	}
	info, status, msg := checkReadable(resolved)
	if status != http.StatusOK {
		return privopResult{Status: status, Error: msg}
	}
	data, err := os.ReadFile(resolved)
	if err != nil {
		return errResult(err)
	}
	head := data
	if len(head) > 512 {
		head = head[:512]
	}
	return privopResult{
		Status:      http.StatusOK,
		ContentB64:  base64.StdEncoding.EncodeToString(data),
		ContentType: http.DetectContentType(head),
		MtimeUnix:   info.ModTime().Unix(),
	}
}

// opWrite implements POST /files/write. Shared by the inline handler and the
// privop child. In the child it runs AS the user, so the file is created with
// the user's ownership (never root/wizard) — the reason writes go through sudo
// rather than the service writing as itself.
func opWrite(home, path string, content []byte) privopResult {
	if len(content) > maxFileSize {
		return privopResult{Status: http.StatusRequestEntityTooLarge, Error: "file too large (max 10MB)"}
	}
	resolved, err := resolveWithin(home, path, false)
	if err != nil {
		return errResult(err)
	}
	if info, err := os.Lstat(resolved); err == nil && !info.Mode().IsRegular() {
		return privopResult{Status: http.StatusBadRequest, Error: "target is not a regular file"}
	}
	if err := os.WriteFile(resolved, content, 0o644); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return privopResult{Status: http.StatusNotFound, Error: "parent directory does not exist"}
		}
		log.Printf("write %s: %v", resolved, err)
		return privopResult{Status: http.StatusInternalServerError, Error: "internal error"}
	}
	return privopResult{Status: http.StatusNoContent}
}

// checkReadable applies the read-eligibility checks (exists, not a dir, regular,
// size cap) shared by the inline and cross-user read paths.
func checkReadable(resolved string) (os.FileInfo, int, string) {
	info, err := os.Stat(resolved)
	if err != nil {
		r := errResult(err)
		return nil, r.Status, r.Error
	}
	if info.IsDir() {
		return nil, http.StatusBadRequest, "path is a directory"
	}
	if !info.Mode().IsRegular() {
		return nil, http.StatusBadRequest, "not a regular file"
	}
	if info.Size() > maxFileSize {
		return nil, http.StatusRequestEntityTooLarge, "file too large (max 10MB)"
	}
	return info, http.StatusOK, ""
}

// errResult maps a resolveWithin/os error to a privopResult status the same way
// pathHTTPError maps it to an HTTP response.
func errResult(err error) privopResult {
	switch {
	case errors.Is(err, errNotAbsolute):
		return privopResult{Status: http.StatusBadRequest, Error: "path must be absolute"}
	case errors.Is(err, errOutsideHome):
		return privopResult{Status: http.StatusBadRequest, Error: "invalid path"}
	case errors.Is(err, fs.ErrNotExist):
		return privopResult{Status: http.StatusNotFound, Error: "not found"}
	default:
		log.Printf("path resolution error: %v", err)
		return privopResult{Status: http.StatusInternalServerError, Error: "internal error"}
	}
}

// --- parent side: re-exec as the mapped user --------------------------------

// runPrivop re-execs this binary AS osUser to run one op inside that user's
// home. stdin carries the write payload (nil otherwise); the JSON envelope
// comes back on stdout. Any sudo/grant/child failure collapses to an opaque 500
// (the path is never echoed).
// sudoBinary is absolute, and a var only as a test seam — the same reason
// tmux-api pins it. An absolute path keeps the privileged call independent of
// whatever PATH the unit happens to inherit.
var sudoBinary = "/usr/bin/sudo"

// privopCommand builds the exec for one privileged op. Split out of runPrivop
// so the argv can be asserted directly: the sudoers grant permits exactly this
// binary as the target user, so every value has to arrive as its own argv
// element. Nothing here is ever interpolated into a shell string — a filename
// containing `;` is one argument, not two commands.
func privopCommand(osUser, op, home, path string, all bool) *exec.Cmd {
	args := []string{"-n", "-u", osUser, exeSelf(), "-privop", op, "-home", home, "-path", path}
	if all {
		args = append(args, "-all")
	}
	return exec.Command(sudoBinary, args...)
}

func runPrivop(osUser, op, home, path string, all bool, stdin []byte) privopResult {
	cmd := privopCommand(osUser, op, home, path, all)
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	out, err := cmd.Output()
	if err != nil {
		log.Printf("privop %s as %s failed: %v", op, osUser, err)
		return privopResult{Status: http.StatusInternalServerError, Error: "internal error"}
	}
	var res privopResult
	if json.Unmarshal(out, &res) != nil || res.Status == 0 {
		log.Printf("privop %s as %s: bad envelope", op, osUser)
		return privopResult{Status: http.StatusInternalServerError, Error: "internal error"}
	}
	return res
}

// exeSelf resolves this binary's path for the sudo re-exec. The sudoers grant
// is keyed on /usr/local/bin/file-api, so production resolves there; the
// os.Executable fallback keeps a dev build self-consistent.
func exeSelf() string {
	if p, err := os.Executable(); err == nil {
		return p
	}
	return "/usr/local/bin/file-api"
}

// --- child side: this process is already running AS the target user ---------

// runPrivopMain is the -privop entrypoint. It performs one op with the user's
// own filesystem view and writes the envelope to stdout.
func runPrivopMain(op, home, path string, all bool) {
	var res privopResult
	switch op {
	case "list":
		res = opList(home, path, all)
	case "read":
		res = opReadEnvelope(home, path)
	case "write":
		content, _ := io.ReadAll(io.LimitReader(os.Stdin, maxFileSize+1))
		res = opWrite(home, path, content)
	default:
		res = privopResult{Status: http.StatusInternalServerError, Error: "unknown op"}
	}
	json.NewEncoder(os.Stdout).Encode(res)
}
