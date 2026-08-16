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

	"terminal-lobby/authuser"
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

// isMappedOSUser reports whether osUser is a real terminal account — a target
// in the Authentik→OS-user map. The population an admin may act as; existing
// as a Unix account is not authorization on its own.
func isMappedOSUser(osUser string) bool {
	for _, u := range loadUserMap() {
		if u == osUser {
			return true
		}
	}
	return false
}

// actAsGate decides whether a ?as= request may proceed. A var only as a test
// seam (actas_test.go points it at a fixture admin list); production never
// reassigns it. Shared with tmux-api and clipboard-upload so the admin check
// has exactly one implementation.
var actAsGate = authuser.Default

// resolveOSUser → the OS user this request ACTS AS: normally the caller from
// the Authentik header, or an act-as target when an administrator asked for one
// and is entitled to it. Returns "" after writing the appropriate 401/403/500.
//
// The resolved name is what userHome() confines the request to and what the
// privop re-exec runs as, so an admin acting as emo is confined to emo's home
// and their writes land with emo's ownership — the cross-user path built for
// this service already does the rest.
func resolveOSUser(w http.ResponseWriter, r *http.Request) string {
	real := resolveRealOSUser(w, r)
	if real == "" {
		return ""
	}
	eff, err := actAsGate.Effective(real, r.URL.Query().Get("as"), isMappedOSUser)
	if err != nil {
		log.Printf("act-as refused: %s -> %q: %v (%s %s)",
			real, r.URL.Query().Get("as"), err, r.Method, r.URL.Path)
		http.Error(w, "not permitted to act as that user", http.StatusForbidden)
		return ""
	}
	if eff != real {
		// Logged per request here, unlike tmux-api: file-api is not polled, so
		// these lines are one per user action rather than one per five seconds,
		// and a write under someone else's account is worth a record.
		log.Printf("act-as: %s acting as %s (%s %s)", real, eff, r.Method, r.URL.Path)
	}
	return eff
}

// resolveRealOSUser → the CALLER's own mapped OS user, ignoring ?as= entirely.
// Ported verbatim from tmux-api/main.go: this service execs file ops as the
// mapped user in production, so the user.Lookup gate (500 when the mapped
// account is missing on this host) is kept.
func resolveRealOSUser(w http.ResponseWriter, r *http.Request) string {
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
