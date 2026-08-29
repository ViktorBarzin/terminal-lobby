// Package authuser resolves WHICH OS user a lobby request acts as.
//
// Ordinarily that is the caller themselves: every service maps the
// Authentik header through /etc/ttyd-user-map and works as the result. This
// package adds the one exception — an administrator may act as another mapped
// user by sending ?as=<osUser>, and the whole lobby (sessions, layout, files,
// gallery, terminal) then belongs to that user.
//
// It exists as a shared module rather than a fourth copy of the auth code
// because it is the security decision. tmux-api, file-api and clipboard-upload
// each keep their own resolveOSUser (which reads the header and the user map);
// all three route the act-as question through this one implementation, so the
// admin check cannot drift between services.
//
// Two properties the tests pin down and the callers rely on:
//
//   - Without ?as= — every request the lobby has ever made — this package is
//     inert: Effective returns the caller unchanged and never reads a file.
//   - The admin set is read from a root-owned file. A missing, empty or
//     unreadable file yields NO admins, so the feature becomes unavailable
//     rather than open.
//
// Nothing client-supplied decides anything here. The caller is derived from
// the Authentik header, which Traefik strips from the incoming request and
// re-sets from its own auth result; the admin list is on disk; and the target
// must already be a mapped terminal account.
package authuser

import (
	"errors"
	"os"
	"regexp"
)

// DefaultAdminsPath is where t3-provision-users.sh installs the admin list,
// derived from roster.yaml's `tier: admin` alongside /etc/ttyd-user-map.
// Format: one OS user per line; blank lines and # comments ignored.
const DefaultAdminsPath = "/etc/ttyd-admins"

var (
	// ErrNotAdmin — the caller asked to act as someone else and is not an
	// administrator. Callers answer 403.
	ErrNotAdmin = errors.New("not permitted to act as another user")
	// ErrUnknownTarget — the caller is an administrator, but the requested
	// target is not a mapped terminal account (or could never be a username).
	// Callers answer 403.
	ErrUnknownTarget = errors.New("unknown act-as target")
)

// userRe bounds an act-as target. Same charset and length as tmux-api's
// sessionNameRe (what shares.go already validates owner/guest against), with
// one deliberate tightening: the first character may not be a dash.
//
// The target reaches `sudo -n -u <user>` argv and a /home/<user> path. A
// leading dash is the argv-injection shape — sudo would read it as a flag — and
// no real account here starts with one, so it is refused on charset rather than
// left to the isMapped lookup that would also catch it. Defence in depth: the
// lookup stays, this just means nothing malformed reaches it.
var userRe = regexp.MustCompile(`^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,31}$`)

// Gate answers the whole "which OS user is this request" question against one
// set of files and one Config. See resolve.go for the resolution itself; this
// file keeps the act-as half, which Resolve calls.
type Gate struct {
	// AdminsPath is the admin list. Read on demand rather than cached: the
	// file is three lines, changes are rare, and the hourly reconcile rewrites
	// it — so a promotion or demotion takes effect on the next request rather
	// than on the next service restart. The user map is read the same way.
	AdminsPath string

	// MapPath is the identity → OS user map. Empty means DefaultMapPath. Its
	// existence is also what Config.MultiUser="auto" reads.
	MapPath string

	// Config carries the operator-facing TL_* settings.
	Config Config

	// SelfUser is the OS user this process runs as, and the only account a
	// single-user install serves. Empty means "look it up on first use".
	SelfUser string

	// LookupUser verifies a mapped account exists on this host. Nil means
	// os/user.Lookup; the tests supply their own.
	LookupUser func(string) error

	// SkipAccountCheck omits that verification. Set by services that never
	// exec as the mapped user and only need a name — clipboard-upload keys a
	// directory by it. The zero value keeps the check, so opting out is a
	// deliberate act rather than an omission.
	SkipAccountCheck bool
}

// Default is the production gate.
var Default = &Gate{AdminsPath: DefaultAdminsPath}

// IsAdmin reports whether osUser administers this box. False for the empty
// user, and false whenever the list cannot be read — the fail-closed direction.
func (g *Gate) IsAdmin(osUser string) bool {
	if osUser == "" {
		return false
	}
	return g.admins()[osUser]
}

// admins parses the admin list. An unreadable file is not an error to report
// but an empty set to return: the caller's next question is only ever "is this
// user an admin", and with no list the answer is no.
func (g *Gate) admins() map[string]bool {
	out := map[string]bool{}
	f, err := os.Open(g.AdminsPath)
	if err != nil {
		return out
	}
	defer f.Close()
	for _, line := range readLines(f) {
		out[line] = true
	}
	return out
}

// Effective resolves the OS user a request acts as.
//
//	real     the caller's own mapped OS user, from the Authentik header
//	as       the ?as= parameter verbatim; "" means no request was made
//	isMapped the service's own "is this a real terminal account" predicate
//
// Returns the effective user, or ErrNotAdmin / ErrUnknownTarget. The two
// no-op cases — no parameter, or a parameter naming the caller — resolve
// identically and are allowed for everyone, so a client that always sends the
// parameter is not a special case anywhere downstream.
func (g *Gate) Effective(real, as string, isMapped func(string) bool) (string, error) {
	if as == "" || as == real {
		return real, nil
	}
	// Charset first, before the admin check and before isMapped: this value
	// is bound for `sudo -u <user>` argv and a /home/<user> path, and a
	// caller's isMapped reads a file. Nothing malformed should reach either,
	// whoever is asking.
	if !userRe.MatchString(as) {
		return "", ErrUnknownTarget
	}
	if !g.IsAdmin(real) {
		return "", ErrNotAdmin
	}
	if !isMapped(as) {
		return "", ErrUnknownTarget
	}
	return as, nil
}
