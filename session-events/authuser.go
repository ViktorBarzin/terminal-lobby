package main

import (
	"bufio"
	"context"
	"log"
	"net/http"
	"os"
	"os/user"
	"strings"

	"terminal-lobby/authuser"
)

const authHeader = "X-Authentik-Username"

type ctxKey int

const osUserKey ctxKey = iota

// loadUserMap reads the Authentik→OS-user map ("<auth>=<os_user>[:<cwd>]" per
// line; # comments and blanks ignored). Ported verbatim from tmux-api so the two
// services share one contract. Re-read per request — small file, rare changes.
func loadUserMap(path string) map[string]string {
	m := map[string]string{}
	f, err := os.Open(path)
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

// mapAuthToOS resolves the OS user for an Authentik header value, stripping any
// "@domain" suffix. Returns "" when unmapped.
func mapAuthToOS(m map[string]string, authValue string) string {
	if authValue == "" {
		return ""
	}
	local := authValue
	if i := strings.IndexByte(local, '@'); i > 0 {
		local = local[:i]
	}
	return m[local]
}

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
// It also REFUSES an act-as request rather than ignoring it. This service reads
// /home/<user>/.claude/projects directly and has no cross-user path yet — other
// homes are 0750, and its tail polls every 200 ms, so it needs a persistent
// streaming child rather than the per-operation sudo re-exec file-api uses.
// Ignoring the parameter would be worse than refusing: the handler would resolve
// the CALLER and serve their own transcripts under the target's name. 501 says
// "this view is not available here" instead of quietly showing wrong data.
func authMiddleware(mapPath string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authValue := r.Header.Get(authHeader)
		if authValue == "" {
			http.Error(w, "missing "+authHeader, http.StatusUnauthorized)
			return
		}
		userMap := loadUserMap(mapPath)
		osUser := mapAuthToOS(userMap, authValue)
		if osUser == "" {
			http.Error(w, "no terminal account for '"+authValue+"'", http.StatusForbidden)
			return
		}
		if _, err := user.Lookup(osUser); err != nil {
			log.Printf("mapped OS user %q missing: %v", osUser, err)
			http.Error(w, "mapped OS user missing on this host", http.StatusInternalServerError)
			return
		}
		// Same gate as the other services, so an unauthorized ?as= is refused
		// for the same reason with the same status; an AUTHORIZED one still
		// stops here, because the reader behind it does not exist yet.
		isMapped := func(u string) bool {
			for _, v := range userMap {
				if v == u {
					return true
				}
			}
			return false
		}
		eff, err := actAsGate.Effective(osUser, r.URL.Query().Get("as"), isMapped)
		if err != nil {
			log.Printf("act-as refused: %s -> %q: %v (%s %s)",
				osUser, r.URL.Query().Get("as"), err, r.Method, r.URL.Path)
			http.Error(w, "not permitted to act as that user", http.StatusForbidden)
			return
		}
		if eff != osUser {
			http.Error(w, "the text view is not available while acting as another user",
				http.StatusNotImplemented)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), osUserKey, osUser)))
	})
}
