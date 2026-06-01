package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	listenAddr   = "0.0.0.0:7684"
	mapPath      = "/etc/ttyd-user-map"
	authHeader   = "X-Authentik-Username"
	tmuxBinary   = "/usr/bin/tmux"
	sudoBinary   = "/usr/bin/sudo"
	tmuxListFmt  = "#{session_name}|#{session_attached}|#{session_activity}|#{session_created}"

	// sessionsTTL coalesces repeat GET /sessions polls for the same OS
	// user. Foolery / lobby pollers hit at ~5 s cadence, so the TTL
	// matches that interval — every other poll lands inside the window
	// and skips the `sudo tmux list-sessions` fork. Concurrent
	// pollers (e.g. two browser tabs open by the same identity) also
	// coalesce. Mutations (kill / rename) invalidate per-user, so a
	// user's own action shows up immediately. New sessions created
	// outside the API (via ttyd / shell) can lag by up to one TTL.
	sessionsTTL = 5 * time.Second
)

var sessionsCacheInstance = newSessionsCache(sessionsTTL)

var sessionNameRe = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,32}$`)

var selfUser = func() string {
	if u, err := user.Current(); err == nil {
		return u.Username
	}
	return ""
}()

type Session struct {
	Name         string `json:"name"`
	Attached     int    `json:"attached"`
	LastActivity int64  `json:"lastActivity"`
	Created      int64  `json:"created"`
}

// loadUserMap reads /etc/ttyd-user-map → map[authentik_local]os_user.
// Format: "<auth>=<os_user>[:<cwd>]" per line. Comments (#) and blanks ignored.
// Re-read on every request — file is small and changes are rare.
func loadUserMap() map[string]string {
	m := map[string]string{}
	f, err := os.Open(mapPath)
	if err != nil {
		log.Printf("loadUserMap: %v", err)
		return m
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq <= 0 {
			continue
		}
		auth := strings.TrimSpace(line[:eq])
		rhs := strings.TrimSpace(line[eq+1:])
		if c := strings.IndexByte(rhs, ':'); c > 0 {
			rhs = rhs[:c]
		}
		if auth != "" && rhs != "" {
			m[auth] = rhs
		}
	}
	return m
}

// resolveOSUser → mapped OS user from the Authentik header, or "" after
// writing the appropriate 401/403/500 to w.
func resolveOSUser(w http.ResponseWriter, r *http.Request) string {
	authUser := r.Header.Get(authHeader)
	if authUser == "" {
		log.Printf("auth: missing %s header (%s %s)", authHeader, r.Method, r.URL.Path)
		http.Error(w, "missing "+authHeader, http.StatusUnauthorized)
		return ""
	}
	local := authUser
	if i := strings.IndexByte(local, '@'); i > 0 {
		local = local[:i]
	}
	osUser := loadUserMap()[local]
	if osUser == "" {
		log.Printf("auth: no terminal account for %q (local=%q, %s %s)", authUser, local, r.Method, r.URL.Path)
		http.Error(w, fmt.Sprintf("no terminal account for '%s'", authUser), http.StatusForbidden)
		return ""
	}
	if _, err := user.Lookup(osUser); err != nil {
		log.Printf("mapped OS user %q missing on this host: %v", osUser, err)
		http.Error(w, "mapped OS user missing on this host", http.StatusInternalServerError)
		return ""
	}
	return osUser
}

// tmuxCmd builds an exec.Cmd that runs `tmux <args...>` AS osUser. When
// osUser is the current process owner, sudo is skipped; otherwise we use
// `sudo -n -u <user> tmux ...` (passwordless grant via /etc/sudoers.d/ttyd-users).
func tmuxCmd(osUser string, args ...string) *exec.Cmd {
	if osUser == selfUser {
		return exec.Command(tmuxBinary, args...)
	}
	full := append([]string{"-n", "-u", osUser, tmuxBinary}, args...)
	return exec.Command(sudoBinary, full...)
}

func main() {
	http.HandleFunc("/sessions", handleSessions)
	http.HandleFunc("/sessions/", handleSessionByName)
	http.HandleFunc("/whoami", handleWhoami)
	http.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte("ok"))
	})

	log.Printf("tmux-api listening on %s (self=%s)", listenAddr, selfUser)
	log.Fatal(http.ListenAndServe(listenAddr, nil))
}

// /whoami → {authentik, osUser}. Used by the lobby HTML to render the
// current identity and to preflight access before opening a session.
//
// Side effect: invalidates the per-user /sessions cache. /whoami is
// called on every page load — both the outer lobby AND each iframe
// in terminal-mode (the iframe loads the same index.html with
// ?arg=<name>, which re-runs the preflight). So when the user clicks
// "Create & Open" and the iframe loads, the iframe's /whoami clears
// the outer lobby's stale cache for that user, and the lobby's next
// periodic poll shows the new session within one cycle — without
// having to drop the TTL or push a client-side invalidate call.
func handleWhoami(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	authUser := r.Header.Get(authHeader)
	osUser := resolveOSUser(w, r)
	if osUser == "" {
		return
	}
	log.Printf("whoami: auth=%q -> os=%q", authUser, osUser)
	sessionsCacheInstance.invalidate(osUser)
	// no-store: the browser MUST hit the server every page load, otherwise
	// the iframe's call gets served from the HTTP cache and the
	// invalidate side-effect above never fires — at which point the outer
	// lobby keeps polling its 5 s tmux-api cache and the freshly-created
	// session doesn't appear until the user manually refreshes.
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"authentik": authUser,
		"osUser":    osUser,
	})
}

func handleSessions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	osUser := resolveOSUser(w, r)
	if osUser == "" {
		return
	}
	// Same reason as /whoami: prevent the browser from caching the list,
	// otherwise the periodic poll never refreshes from the server's
	// (already-invalidated) cache.
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")

	if body, ok := sessionsCacheInstance.get(osUser); ok {
		w.Write(body)
		return
	}
	body := buildSessionsBody(osUser)
	sessionsCacheInstance.put(osUser, body)
	w.Write(body)
}

// buildSessionsBody runs `tmux list-sessions` as osUser and returns the
// JSON body to write on the wire. Mirrors the historic encoder output:
// success → marshaled slice + trailing newline; tmux error → "[]"
// without a newline.
func buildSessionsBody(osUser string) []byte {
	out, err := tmuxCmd(osUser, "list-sessions", "-F", tmuxListFmt).Output()
	if err != nil {
		return []byte("[]")
	}
	sessions := make([]Session, 0)
	for _, line := range strings.Split(strings.TrimRight(string(out), "\n"), "\n") {
		if line == "" {
			continue
		}
		parts := strings.Split(line, "|")
		if len(parts) != 4 {
			continue
		}
		attached, _ := strconv.Atoi(parts[1])
		activity, _ := strconv.ParseInt(parts[2], 10, 64)
		created, _ := strconv.ParseInt(parts[3], 10, 64)
		sessions = append(sessions, Session{
			Name:         parts[0],
			Attached:     attached,
			LastActivity: activity,
			Created:      created,
		})
	}
	body, err := json.Marshal(sessions)
	if err != nil {
		return []byte("[]")
	}
	return append(body, '\n')
}

func handleSessionByName(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/sessions/")
	path = strings.TrimSuffix(path, "/")
	parts := strings.Split(path, "/")
	name := parts[0]
	if !sessionNameRe.MatchString(name) {
		http.Error(w, "invalid session name", http.StatusBadRequest)
		return
	}
	osUser := resolveOSUser(w, r)
	if osUser == "" {
		return
	}

	if len(parts) == 1 {
		if r.Method != http.MethodDelete {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		killSession(w, osUser, name)
		return
	}
	if len(parts) == 2 && parts[1] == "rename" {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		renameSession(w, r, osUser, name)
		return
	}
	http.Error(w, "not found", http.StatusNotFound)
}

func killSession(w http.ResponseWriter, osUser, name string) {
	out, err := tmuxCmd(osUser, "kill-session", "-t", name).CombinedOutput()
	if err != nil {
		msg := string(out)
		if strings.Contains(msg, "can't find session") || strings.Contains(msg, "no server running") {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}
		log.Printf("kill-session %s as %s failed: %v: %s", name, osUser, err, msg)
		http.Error(w, "kill-session failed", http.StatusInternalServerError)
		return
	}
	sessionsCacheInstance.invalidate(osUser)
	w.WriteHeader(http.StatusNoContent)
}

func renameSession(w http.ResponseWriter, r *http.Request, osUser, oldName string) {
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	newName := strings.TrimSpace(body.Name)
	if !sessionNameRe.MatchString(newName) {
		http.Error(w, "invalid new name", http.StatusBadRequest)
		return
	}
	if newName == oldName {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	out, err := tmuxCmd(osUser, "rename-session", "-t", oldName, newName).CombinedOutput()
	if err != nil {
		msg := string(out)
		if strings.Contains(msg, "can't find session") || strings.Contains(msg, "no server running") {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}
		if strings.Contains(msg, "duplicate session") || strings.Contains(msg, "session already exists") {
			http.Error(w, "target name already exists", http.StatusConflict)
			return
		}
		log.Printf("rename-session %s→%s as %s failed: %v: %s", oldName, newName, osUser, err, msg)
		http.Error(w, "rename-session failed", http.StatusInternalServerError)
		return
	}
	sessionsCacheInstance.invalidate(osUser)
	w.WriteHeader(http.StatusNoContent)
}
