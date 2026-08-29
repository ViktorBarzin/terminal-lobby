package main

import (
	"log"
	"net/http"
	"path/filepath"

	"terminal-lobby/authuser"
)

// authHeader is the identity header this build resolves by default. The name
// is configuration now (TL_AUTH_HEADER); the constant remains so tests can set
// the header the running gate is actually reading.
const authHeader = authuser.DefaultAuthHeader

// mapPath is the Authentik→OS-user map consumed by resolveOSUser. A var (not
// const) purely as a test seam: handler tests point it at a fixture so the real
// header→user path runs hermetically (see auth_test.go). Production never
// reassigns it.
var mapPath = authuser.DefaultMapPath

// setMapPath keeps the gate in step, since the gate is what reads the file.
func setMapPath(p string) {
	mapPath = p
	actAsGate.MapPath = p
}

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
func isMappedOSUser(osUser string) bool { return actAsGate.IsTarget(osUser) }

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
// privop re-exec runs as, so an admin acting as bob is confined to bob's home
// and their writes land with bob's ownership — the cross-user path built for
// this service already does the rest.
func resolveOSUser(w http.ResponseWriter, r *http.Request) string {
	id, ok := actAsGate.Authorize(w, r)
	if !ok {
		return ""
	}
	if id.OSUser != id.RealOSUser {
		// Logged per request here, unlike tmux-api: file-api is not polled, so
		// these lines are one per user action rather than one per five seconds,
		// and a write under someone else's account is worth a record.
		log.Printf("act-as: %s acting as %s (%s %s)", id.RealOSUser, id.OSUser, r.Method, r.URL.Path)
	}
	return id.OSUser
}

// resolveRealOSUser → the CALLER's own mapped OS user, ignoring ?as= entirely.
func resolveRealOSUser(w http.ResponseWriter, r *http.Request) string {
	id, ok := actAsGate.Authorize(w, r)
	if !ok {
		return ""
	}
	return id.RealOSUser
}
