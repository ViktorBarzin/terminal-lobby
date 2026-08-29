package authuser

// Resolution: the whole "which OS user is this request" question, in one place.
//
// This file is the answer to a duplication that had grown to five copies. Every
// service read the identity header itself, loaded /etc/ttyd-user-map itself, and
// then handed the act-as question to this package. The header's name, the proxy
// secret and the single/multi-user mode are all part of the same decision, so
// they live here too rather than becoming three more copies.
//
// The order inside Resolve is deliberate and is what the tests pin:
//
//  1. the proxy secret, when configured, BEFORE anything reads identity — an
//     unauthenticated caller must not reach identity resolution at all;
//  2. the identity header, by its configured name only;
//  3. the mode, which decides whether the user map is consulted;
//  4. act-as, unchanged, and only ever in multi-user mode.

import (
	"bufio"
	"crypto/subtle"
	"errors"
	"log"
	"net/http"
	"os"
	"os/user"
	"sort"
	"strings"
)

const (
	// DefaultAuthHeader is what most forward-auth proxies already emit
	// (oauth2-proxy, Caddy, Cloudflare Access, Tailscale). A vendor's header
	// name does not belong compiled into a public project, so Authentik is
	// configuration here rather than a default.
	DefaultAuthHeader = "X-Forwarded-User"

	// SecretHeader carries the shared secret between the reverse proxy and the
	// services. Its own header rather than Authorization, because Authorization
	// belongs to whatever the proxy is doing upstream and must pass through
	// untouched.
	SecretHeader = "X-TL-Proxy-Secret"

	// DefaultMapPath maps identity → OS user. Its EXISTENCE is also the signal
	// that this box is multi-user, which is what Config.MultiUser="auto" reads.
	DefaultMapPath = "/etc/ttyd-user-map"
)

var (
	// ErrNoIdentity — the configured identity header was absent or empty.
	// Callers answer 401.
	ErrNoIdentity = errors.New("missing identity header")
	// ErrBadSecret — a proxy secret is configured and the request did not
	// carry a matching one. Callers answer 401.
	ErrBadSecret = errors.New("missing or incorrect proxy secret")
	// ErrNoAccount — multi-user mode, and the identity maps to no terminal
	// account. Callers answer 403.
	ErrNoAccount = errors.New("no terminal account for that identity")
	// ErrNoSuchAccount — the map names an account this host does not have.
	// That is a misconfiguration rather than a refusal of the caller, so
	// callers answer 500 and say so, keeping it distinguishable from a 403.
	ErrNoSuchAccount = errors.New("mapped OS user missing on this host")
)

// Config is the operator-facing surface, one field per TL_* variable. Zero
// values are the documented defaults, so a Gate with an empty Config behaves
// the way an unconfigured install does.
type Config struct {
	AuthHeader  string // TL_AUTH_HEADER
	ProxySecret string // TL_PROXY_SECRET; empty disables the check
	MultiUser   string // TL_MULTI_USER: "auto" (default), "on", "off"
}

func (c Config) header() string {
	if c.AuthHeader == "" {
		return DefaultAuthHeader
	}
	return c.AuthHeader
}

// ConfigFromEnv reads the TL_* variables. Every unit sources the same
// EnvironmentFile, so all six processes see identical values.
func ConfigFromEnv() Config {
	return Config{
		AuthHeader:  strings.TrimSpace(os.Getenv("TL_AUTH_HEADER")),
		ProxySecret: os.Getenv("TL_PROXY_SECRET"),
		MultiUser:   strings.TrimSpace(os.Getenv("TL_MULTI_USER")),
	}
}

// Identity is the answer Resolve gives.
type Identity struct {
	// Header is the raw value the proxy supplied, kept for /whoami.
	Header string
	// OSUser is the account this request acts as — the target when an
	// administrator used ?as=, the caller otherwise.
	OSUser string
	// RealOSUser is the caller's own account, which differs from OSUser only
	// under act-as. Endpoints whose writes must never land under an act-as
	// target use this.
	RealOSUser string
	// MultiUser reports the mode, so /whoami can tell the frontend which
	// features exist without the frontend inferring it.
	MultiUser bool
	// Admin reports whether RealOSUser administers this box.
	Admin bool
}

// Resolve answers the whole question for one request.
func (g *Gate) Resolve(r *http.Request) (Identity, error) {
	if err := g.checkSecret(r); err != nil {
		return Identity{}, err
	}

	raw := strings.TrimSpace(r.Header.Get(g.Config.header()))
	if raw == "" {
		return Identity{}, ErrNoIdentity
	}

	multi := g.MultiUser()
	out := Identity{Header: raw, MultiUser: multi}

	if !multi {
		// Single-user: the account is whoever the service runs as. The header
		// still had to be present — that is what proves the request came
		// through the proxy — but its value names nobody here, and the user map
		// is not consulted even if one happens to be on disk.
		self := g.self()
		out.OSUser, out.RealOSUser = self, self
		out.Admin = false
		if as := strings.TrimSpace(r.URL.Query().Get("as")); as != "" && as != self {
			// No second account exists to act as. ErrNotAdmin rather than a new
			// error: from the caller's side this is the same refusal, and the
			// services already map it to 403.
			return Identity{}, ErrNotAdmin
		}
		return out, nil
	}

	// The map is keyed on the LOCAL part: proxies emit either "alice" or
	// "alice@example.com" depending on the flow, and both name one account.
	local := raw
	if i := strings.IndexByte(local, '@'); i > 0 {
		local = local[:i]
	}

	m := g.userMap()
	real, ok := m[local]
	if !ok || real == "" {
		return Identity{}, ErrNoAccount
	}
	if !g.SkipAccountCheck {
		if err := g.lookupUser(real); err != nil {
			return Identity{}, ErrNoSuchAccount
		}
	}
	out.RealOSUser = real
	out.Admin = g.IsAdmin(real)

	eff, err := g.Effective(real, strings.TrimSpace(r.URL.Query().Get("as")), func(u string) bool {
		return isTarget(m, u)
	})
	if err != nil {
		return Identity{}, err
	}
	out.OSUser = eff
	return out, nil
}

// checkSecret compares the shared secret in constant time. Unset means the
// check is disabled, which preserves the behaviour every install had before
// this existed.
func (g *Gate) checkSecret(r *http.Request) error {
	want := g.Config.ProxySecret
	if want == "" {
		return nil
	}
	got := r.Header.Get(SecretHeader)
	if subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
		return ErrBadSecret
	}
	return nil
}

// MultiUser reports the mode. "auto" — the default — reads the presence of the
// user map, so an existing multi-user box needs no new setting and a fresh
// install is single-user without being told.
func (g *Gate) MultiUser() bool {
	switch strings.ToLower(g.Config.MultiUser) {
	case "on", "true", "1", "yes":
		return true
	case "off", "false", "0", "no":
		return false
	default: // "auto" and anything unset
		_, err := os.Stat(g.mapPath())
		return err == nil
	}
}

// lookupUser verifies the mapped account exists on this host. A field so the
// tests can drive the misconfiguration case without creating accounts.
func (g *Gate) lookupUser(osUser string) error {
	if g.LookupUser != nil {
		return g.LookupUser(osUser)
	}
	_, err := user.Lookup(osUser)
	return err
}

func (g *Gate) mapPath() string {
	if g.MapPath != "" {
		return g.MapPath
	}
	return DefaultMapPath
}

// self is the OS user this process runs as, and therefore the only account a
// single-user install serves. Looked up once and cached: it cannot change while
// the process lives.
func (g *Gate) self() string {
	if g.SelfUser != "" {
		return g.SelfUser
	}
	if u, err := user.Current(); err == nil {
		g.SelfUser = u.Username
	}
	return g.SelfUser
}

// userMap parses identity → OS user. Format "<identity>=<os_user>[:<cwd>]", one
// per line, # comments and blanks ignored. Re-read per request for the same
// reason the admin list is: the file is small, and the hourly reconcile rewrites
// it, so a change takes effect on the next request rather than the next restart.
//
// An unreadable file yields an empty map, which in multi-user mode refuses
// everyone. That is the fail-closed direction, and it matches what the five
// per-service copies of this function already did.
func (g *Gate) userMap() map[string]string {
	out := map[string]string{}
	f, err := os.Open(g.mapPath())
	if err != nil {
		return out
	}
	defer f.Close()
	for _, line := range readLines(f) {
		eq := strings.IndexByte(line, '=')
		if eq <= 0 {
			continue
		}
		identity := strings.TrimSpace(line[:eq])
		osUser := strings.TrimSpace(line[eq+1:])
		if c := strings.IndexByte(osUser, ':'); c > 0 {
			osUser = osUser[:c]
		}
		if identity != "" && osUser != "" {
			out[identity] = osUser
		}
	}
	return out
}

// readLines returns the meaningful lines of a small config file: trimmed, with
// blanks and # comments dropped. Both the admin list and the user map are this
// shape, and both are read per request.
func readLines(f *os.File) []string {
	var out []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		out = append(out, line)
	}
	return out
}

// isTarget answers Effective's "is this a real terminal account" question
// against the map's RIGHT-hand side, because ?as= names an OS user rather than
// an identity.
func isTarget(m map[string]string, osUser string) bool {
	for _, v := range m {
		if v == osUser {
			return true
		}
	}
	return false
}

// IsTarget reports whether osUser is a real terminal account: a right-hand side
// of the user map. This is the population that may be added to a project, named
// as a share guest, or used as an act-as target. Each service had its own copy
// of this, all reading the same file.
//
// In single-user mode the only account is the one the process runs as, and the
// map is not consulted.
func (g *Gate) IsTarget(osUser string) bool {
	if osUser == "" {
		return false
	}
	if !g.MultiUser() {
		return osUser == g.self()
	}
	return isTarget(g.userMap(), osUser)
}

// Targets lists every terminal account, for the pickers. Single-user returns
// just the invoking user, so a Share dialog cannot come up empty.
func (g *Gate) Targets() []string {
	if !g.MultiUser() {
		if self := g.self(); self != "" {
			return []string{self}
		}
		return nil
	}
	seen := map[string]bool{}
	var out []string
	for _, u := range g.userMap() {
		if u != "" && !seen[u] {
			seen[u] = true
			out = append(out, u)
		}
	}
	sort.Strings(out)
	return out
}

// Authorize is Resolve plus the HTTP answer, which is what every handler
// actually wants. It returns the identity and true, or writes the refusal and
// returns false.
//
// The three statuses are kept distinguishable on purpose. 401 says the request
// did not authenticate, 403 says it did and may not do this, and 500 says the
// box is misconfigured rather than the caller being at fault — an operator
// reading logs needs to tell a bad map entry from a denied user.
func (g *Gate) Authorize(w http.ResponseWriter, r *http.Request) (Identity, bool) {
	id, err := g.Resolve(r)
	if err == nil {
		return id, true
	}
	switch {
	case errors.Is(err, ErrBadSecret):
		log.Printf("auth: bad or missing proxy secret (%s %s)", r.Method, r.URL.Path)
		http.Error(w, "missing or incorrect proxy secret", http.StatusUnauthorized)
	case errors.Is(err, ErrNoIdentity):
		log.Printf("auth: missing identity header (%s %s)", r.Method, r.URL.Path)
		http.Error(w, "missing identity header", http.StatusUnauthorized)
	case errors.Is(err, ErrNoAccount):
		log.Printf("auth: no terminal account (%s %s)", r.Method, r.URL.Path)
		http.Error(w, "no terminal account for that identity", http.StatusForbidden)
	case errors.Is(err, ErrNoSuchAccount):
		log.Printf("auth: %v (%s %s)", err, r.Method, r.URL.Path)
		http.Error(w, "mapped OS user missing on this host", http.StatusInternalServerError)
	default:
		log.Printf("act-as refused: %v (%s %s)", err, r.Method, r.URL.Path)
		http.Error(w, "not permitted to act as that user", http.StatusForbidden)
	}
	return Identity{}, false
}

// Configure wires a service's gate from the environment and reports what it
// found. Called once at startup by each service, so the six processes agree
// because they read the same EnvironmentFile.
//
// The warning exists because the secret is optional by decision, and an
// operator who has not set one should be able to learn that from the log rather
// than from a security review. It names the bind address and what a caller
// reaching it can do, rather than saying something is "insecure".
func (g *Gate) Configure(service, bindAddr string) {
	g.Config = ConfigFromEnv()
	if g.AdminsPath == "" {
		g.AdminsPath = DefaultAdminsPath
	}
	mode := "single-user"
	if g.MultiUser() {
		mode = "multi-user"
	}
	log.Printf("%s: identity header %q, %s mode", service, g.Config.header(), mode)
	if g.Config.ProxySecret == "" {
		log.Printf("%s: no TL_PROXY_SECRET set — any caller that can reach %s may "+
			"send %s and be treated as that user. Set TL_PROXY_SECRET in "+
			"/etc/terminal-lobby.conf and have your proxy send %s to require one.",
			service, bindAddr, g.Config.header(), SecretHeader)
	}
}
