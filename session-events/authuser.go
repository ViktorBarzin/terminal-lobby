package main

import (
	"context"
	"net/http"

	"terminal-lobby/authuser"
)

// authHeader is the identity header this build resolves by default. The name
// is configuration now (TL_AUTH_HEADER); the constant remains so tests can set
// the header the running gate is actually reading.
const authHeader = authuser.DefaultAuthHeader

type ctxKey int

const osUserKey ctxKey = iota

// osUserFrom retrieves the resolved OS user stashed by authMiddleware.
func osUserFrom(ctx context.Context) string {
	s, _ := ctx.Value(osUserKey).(string)
	return s
}

// actAsGate decides whether a ?as= request may proceed. A var only as a test
// seam; production never reassigns it. Shared with tmux-api, file-api and
// clipboard-upload so the admin check has exactly one implementation.
var actAsGate = authuser.Default

// authMiddleware resolves the Authentik header to an OS user (401 missing / 403
// unmapped / 500 if the OS user is absent) and stashes it in the request context.
//
// It also REFUSES an act-as request rather than ignoring it, and still does now
// that the cross-user read exists (privreader.go — the persistent streaming
// child this comment used to describe as missing, built on 2026-08-18 so that a
// user's OWN text view works at all). The mechanism is no longer the obstacle;
// whether an administrator may READ another person's conversations is a separate
// decision from whether that person can read their own, and it has not been
// taken. Ignoring the parameter would still be the worst option: the handler
// would resolve the CALLER and serve their own transcripts under the target's
// name. 501 says "this view is not available here" rather than quietly showing
// wrong data.
func authMiddleware(mapPath string, next http.Handler) http.Handler {
	gate := *actAsGate
	if mapPath != "" {
		gate.MapPath = mapPath
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, ok := gate.Authorize(w, r)
		if !ok {
			return
		}
		osUser, eff := id.RealOSUser, id.OSUser
		if eff != osUser {
			http.Error(w, "the text view is not available while acting as another user",
				http.StatusNotImplemented)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), osUserKey, osUser)))
	})
}
