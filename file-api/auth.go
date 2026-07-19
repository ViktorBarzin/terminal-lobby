package main

import (
	"bufio"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"strings"
)

const authHeader = "X-Authentik-Username"

// mapPath is the Authentik→OS-user map consumed by resolveOSUser. A var (not
// const) purely as a test seam: handler tests point it at a fixture so the real
// header→user path runs hermetically (see auth_test.go). Production never
// reassigns it.
var mapPath = "/etc/ttyd-user-map"

// homeBase is the parent directory of every user's home; production "/home".
// A var so tests can point the filesystem root at a temp dir — the per-user
// containment root is homeBase/<osUser>. Running file ops AS the mapped OS user
// is out of scope for this package (production sudos, like tmux-api); the home
// path is needed only to enforce that every request stays inside the caller's
// own home.
var homeBase = "/home"

// userHome is the containment root for one OS user: /home/<osUser>. Every path
// a request touches must resolve inside this directory.
func userHome(osUser string) string {
	return filepath.Join(homeBase, osUser)
}

// loadUserMap reads /etc/ttyd-user-map → map[authentik_local]os_user.
// Format: "<auth>=<os_user>[:<cwd>]" per line. Comments (#) and blanks ignored.
// Re-read on every request — file is small and changes are rare. Ported
// verbatim from tmux-api/main.go (and clipboard-upload/main.go).
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

// resolveOSUser → mapped OS user from the Authentik header, or "" after writing
// the appropriate 401/403/500 to w. Ported verbatim from tmux-api/main.go: this
// service execs file ops as the mapped user in production, so the user.Lookup
// gate (500 when the mapped account is missing on this host) is kept.
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
