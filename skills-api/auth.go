package main

import (
	"log"
	"net/http"
	"path/filepath"
	"sort"

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
// A var so tests can point the filesystem root at a temp dir.
//
// It is a fallback, not the authority: an operation runs in a privileged child
// which reads its own home out of the password database, because sudo's
// environment handling makes $HOME an unreliable thing to trust. This path is
// used for the inline same-user case and for tests.
var homeBase = "/home"

// userHome is one OS user's home. Every skill this service reads or writes lives
// under <home>/.claude/skills, which skillscan.Root spells.
func userHome(osUser string) string {
	return filepath.Join(homeBase, osUser)
}

// peers lists the other terminal accounts on this box — everyone whose skills the
// caller can see. Visibility is deliberately symmetric and total: the file modes
// already allow each user to read the others' skill files, so the panel surfaces
// what the OS permits rather than opening anything new (ADR-0011).
func peers(self string) []string {
	seen := map[string]bool{}
	var out []string
	for _, u := range actAsGate.Targets() {
		if u == self || seen[u] {
			continue
		}
		seen[u] = true
		out = append(out, u)
	}
	sort.Strings(out)
	return out
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
		// Logged per request here, unlike tmux-api: skills-api is not polled, so
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
