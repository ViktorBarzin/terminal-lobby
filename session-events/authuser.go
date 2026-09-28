package main

import (
	"context"
	"log"
	"net/http"
	"strings"

	"terminal-lobby/authuser"
	"terminal-lobby/telemetry"
)

// authHeader is the identity header this build resolves by default. The name
// is configuration now (TL_AUTH_HEADER); the constant remains so tests can set
// the header the running gate is actually reading.
const authHeader = authuser.DefaultAuthHeader

type ctxKey int

const (
	osUserKey ctxKey = iota
	realOSUserKey
)

// osUserFrom retrieves the resolved OS user stashed by authMiddleware: the
// target when an administrator used ?as=, the caller otherwise.
func osUserFrom(ctx context.Context) string {
	s, _ := ctx.Value(osUserKey).(string)
	return s
}

// realOSUserFrom retrieves the caller's own OS user, which differs from
// osUserFrom only under act-as.
func realOSUserFrom(ctx context.Context) string {
	s, _ := ctx.Value(realOSUserKey).(string)
	return s
}

// actAsGate decides whether a ?as= request may proceed. A var only as a test
// seam; production never reassigns it. Shared with tmux-api, file-api and
// clipboard-upload so the admin check has exactly one implementation.
var actAsGate = authuser.Default

// authMiddleware resolves the Authentik header to an OS user (401 missing / 403
// unmapped / 500 if the OS user is absent) and stashes it in the request context.
//
// An administrator's ?as= resolves to the target, so the text view shows that
// user's sessions, the same access the terminal already gives through an
// act-as attach (tmux-api/shares.go). The cross-user file read goes through the
// target's persistent read child (privreader.go), built on 2026-08-18. Before
// 2026-09-28 this answered 501 instead, which left the text view empty in an
// act-as tab while the terminal worked. A non-admin's ?as= is still refused
// by the gate with a 403.
//
// The audit record matches the terminal's: a stream opened and every write
// made under act-as log a line and emit admin.actas under the real caller.
// The other reads (earlier pages, tool results, search, pictures) follow from
// an open stream and would only repeat it.
func authMiddleware(mapPath string, next http.Handler) http.Handler {
	gate := *actAsGate
	if mapPath != "" {
		gate.MapPath = mapPath
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// A refusal is never cached: the picture routes behind this gate are
		// cached for a year and promise no-store on every error. A request that
		// passes reaches its route with the header cleared again, so each route
		// still picks its own policy.
		w.Header().Set("Cache-Control", "no-store")
		id, ok := gate.Authorize(w, r)
		if !ok {
			return
		}
		real, eff := id.RealOSUser, id.OSUser
		if eff != real && (r.Method != http.MethodGet || strings.HasPrefix(r.URL.Path, "/events/")) {
			log.Printf("act-as: %s acting as %s — %s %s", real, eff, r.Method, r.URL.Path)
			events.Emit("admin.actas", real, telemetry.Attrs{
				"tl.to": eff, "tl.client": "text", "tl.session": sessionOf(r.URL.Path),
			})
		}
		w.Header().Del("Cache-Control")
		ctx := context.WithValue(r.Context(), osUserKey, eff)
		ctx = context.WithValue(ctx, realOSUserKey, real)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// sessionOf names the session a route path addresses: the segment after the
// route name, as in /events/<session> or /prompt/<session>.
func sessionOf(path string) string {
	parts := strings.SplitN(strings.TrimPrefix(path, "/"), "/", 3)
	if len(parts) < 2 {
		return ""
	}
	return parts[1]
}
