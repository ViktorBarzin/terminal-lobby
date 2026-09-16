package authuser

// Bearer credentials: the per-caller half of the gate.
//
// Everything else here answers "who is this request" from an identity header
// the service cannot verify plus one shared secret every caller sends. That is
// the right shape for a browser behind forward-auth, where the proxy did the
// authenticating and the lobby only has to learn the result. It is a poor fit
// for a program: the shared secret cannot be withdrawn from one caller without
// withdrawing it from all of them, and an identity header a program sets is a
// claim rather than a credential.
//
// A bearer credential is one line in a file that names one caller, carries its
// own token, and resolves to one OS user. Issuing is adding a line; revoking is
// deleting it, and it costs no other caller anything. agent-api is the first
// caller to require one, and it lives here rather than there because every
// lobby service resolves through this package and so every one of them can
// accept a machine caller.
//
// Format, one credential per line, # comments and blanks ignored:
//
//	<name>  <token>  <os-user>
//	muse    7f3c…    wizard
//
// Three fields separated by whitespace rather than the user map's '=', because
// there are three of them. A line that does not parse is skipped, the way the
// user map skips one, so a half-written entry costs that entry rather than
// every credential on the box.
//
// What the tests pin, and what a reader should be able to rely on:
//
//   - A request with no Authorization header never reaches this code and never
//     reads the tokens file. The path every browser takes is unchanged, which
//     matters because tmux-api's session poll runs every five seconds per tab.
//   - A request that presents a bearer is answered by the bearer. A token that
//     does not match is 401 rather than a second attempt at the header path,
//     which a caller could otherwise satisfy with a header it sets itself and a
//     secret every caller already holds. The single exception is a box with no
//     credentials at all: the feature is off there, and an Authorization header
//     belongs to whatever the proxy is doing upstream.
//   - Tokens are compared with crypto/subtle, every credential on every
//     request, and never reach a log line, a response body or Identity.
//
// The credential names an OS user, and that user must be a terminal account on
// this box. The file is meant to be root-owned, so that check is defence in
// depth rather than a boundary — the same argument the act-as charset check
// makes — but it is what stops one typo'd line handing out an account the lobby
// does not serve.

import (
	"crypto/subtle"
	"errors"
	"log"
	"net/http"
	"os"
	"regexp"
	"strings"
)

// DefaultBearerTokensPath is where the credentials live when TL_BEARER_TOKENS
// says nothing. An absent file means no credentials, which means the bearer
// path is simply unavailable.
const DefaultBearerTokensPath = "/etc/terminal-lobby-tokens"

// authorizationHeader and bearerScheme are RFC 6750's. The scheme is compared
// case-insensitively because RFC 7235 says it is case-insensitive and a caller
// writing its own client picks whichever case it likes.
const (
	authorizationHeader = "Authorization"
	bearerScheme        = "Bearer"
)

// ErrBadBearer — the request presented a bearer credential and it is not one
// this box issued. Callers answer 401.
var ErrBadBearer = errors.New("invalid bearer token")

// tokenRe bounds a token: RFC 6750's b64token charset, so hex, base64url and
// Vault's dotted tokens all pass, and nothing with whitespace, a quote or a
// shell metacharacter does.
//
// The 32-character floor is the part worth keeping. Without it, a line written
// in the user map's format — "muse = wizard" — parses into three fields whose
// middle one is "=", and a one-character token that anybody can guess would
// authenticate as a real account. A machine credential nobody types has no
// reason to be shorter than this.
var tokenRe = regexp.MustCompile(`^[A-Za-z0-9._~+/=-]{32,512}$`)

// bearerCred is one parsed line. The token is unexported and never leaves this
// file: Identity carries the NAME, which is what /whoami echoes and what
// tmux-api writes to the log.
type bearerCred struct {
	Name   string
	token  string
	OSUser string
}

// bearerTokensPath is the configured path, or the compiled default.
func (g *Gate) bearerTokensPath() string {
	if p := g.Config.BearerTokensPath; p != "" {
		return p
	}
	return DefaultBearerTokensPath
}

// bearerToken reports the token a request presents, and whether it presented
// one at all. The bare scheme with nothing after it counts as presenting an
// empty token rather than as presenting nothing: the caller asked to
// authenticate this way and got it wrong, which is a different thing from a
// browser that never mentioned the scheme.
func bearerToken(r *http.Request) (string, bool) {
	h := strings.TrimSpace(r.Header.Get(authorizationHeader))
	if h == "" {
		return "", false
	}
	scheme, rest, _ := strings.Cut(h, " ")
	if !strings.EqualFold(scheme, bearerScheme) {
		return "", false
	}
	return strings.TrimSpace(rest), true
}

// bearerCreds parses the tokens file. Every failure — absent, unreadable, too
// permissive, malformed — yields no credentials rather than an error, because
// the only question the caller asks is which credentials exist, and with none
// the bearer path is unavailable.
func (g *Gate) bearerCreds() []bearerCred {
	if g.countTokenReads != nil {
		g.countTokenReads()
	}
	path := g.bearerTokensPath()
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	// Mode from the open file rather than a separate stat, so what is checked
	// is what is read. The services run as an ordinary account, so this file
	// cannot be 0600 root-owned the way /etc/terminal-lobby.local.conf is —
	// which is exactly why the mode is worth checking rather than assuming. On
	// a shared box a world-readable token is every local account's token, and a
	// group-writable file lets a second account issue itself one.
	info, err := f.Stat()
	if err != nil {
		return nil
	}
	if perm := info.Mode().Perm(); perm&0o027 != 0 {
		log.Printf("authuser: ignoring bearer credentials in %s: mode %04o lets accounts "+
			"other than the owner read or change them; chmod 0640 (or 0600) it", path, perm)
		return nil
	}

	var out []bearerCred
	for _, line := range readLines(f) {
		fields := strings.Fields(line)
		if len(fields) != 3 {
			continue
		}
		name, token, osUser := fields[0], fields[1], fields[2]
		// The OS user is bound for `sudo -u <user>` argv and a /home/<user>
		// path, same as an act-as target, so it is held to the same charset.
		if !userRe.MatchString(name) || !tokenRe.MatchString(token) || !userRe.MatchString(osUser) {
			continue
		}
		out = append(out, bearerCred{Name: name, token: token, OSUser: osUser})
	}
	return out
}

// matchBearer finds the credential whose token was presented.
//
// It compares every credential whichever one matches. Returning early would be
// the obvious thing to write and would undo the constant-time comparison it
// sits inside: the number of comparisons would report which credential
// answered, and how long the loop ran would report how far down the file it is.
func (g *Gate) matchBearer(creds []bearerCred, presented string) (bearerCred, bool) {
	var found bearerCred
	ok := false
	want := []byte(presented)
	for _, c := range creds {
		if g.countTokenCompares != nil {
			g.countTokenCompares()
		}
		if subtle.ConstantTimeCompare([]byte(c.token), want) == 1 {
			found, ok = c, true
		}
	}
	return found, ok
}

// resolveBearer answers a request that presented a bearer. It never falls back
// to the header path: a caller that offered a token and got it wrong is
// refused, not invited to try the other door.
func (g *Gate) resolveBearer(r *http.Request, token string, creds []bearerCred) (Identity, error) {
	cred, ok := g.matchBearer(creds, token)
	if !ok {
		return Identity{}, ErrBadBearer
	}
	// The credential names an OS user; the box decides whether that is one of
	// its terminal accounts. In single-user mode that population is the one
	// account the process runs as, so a credential cannot name a second user on
	// a box that has no way to become one.
	if !g.IsTarget(cred.OSUser) {
		return Identity{}, ErrNoAccount
	}
	if !g.SkipAccountCheck {
		if err := g.lookupUser(cred.OSUser); err != nil {
			return Identity{}, ErrNoSuchAccount
		}
	}
	// Act-as is the affordance the lobby offers an administrator at a keyboard,
	// and a machine credential names exactly one account. ?as= pointing
	// anywhere else is refused rather than quietly ignored — the same answer,
	// and the same reported refusal, that single-user mode gives.
	if as := strings.TrimSpace(r.URL.Query().Get("as")); as != "" && as != cred.OSUser {
		if g.OnActAsRefused != nil {
			g.OnActAsRefused(cred.OSUser, as, ErrNotAdmin.Error())
		}
		return Identity{}, ErrNotAdmin
	}
	return Identity{
		// The NAME, never the token. /whoami echoes this field and tmux-api
		// logs it, so a token here would be a token in Loki for 30 days.
		Header:     cred.Name,
		OSUser:     cred.OSUser,
		RealOSUser: cred.OSUser,
		MultiUser:  g.MultiUser(),
		// Admin drives whether the SPA offers the act-as picker. A bearer
		// cannot act as anyone whatever account it resolves to, so reporting it
		// as an administrator would advertise a control that could only fail.
		Admin: false,
	}, nil
}
