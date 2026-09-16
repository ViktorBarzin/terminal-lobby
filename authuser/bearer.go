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
//	<name>  sha256:<digest of the token>  <os-user>
//	muse    sha256:9f86d081…              wizard
//
// Three fields separated by whitespace rather than the user map's '=', because
// there are three of them. A line that does not parse is skipped, the way the
// user map skips one, so a half-written entry costs that entry rather than
// every credential on the box.
//
// The middle field is a verifier, not the token, and that is the whole reason
// this file can be trusted with anything. TL_PROXY_SECRET lives in
// /etc/terminal-lobby.local.conf, 0640 root:root: systemd reads it as root and
// hands it over after dropping to User=wizard, so nothing else running as
// wizard ever sees it. This file has no such help — the service opens it
// itself, at request time, as wizard — so it has to be readable by the account
// every other lobby process also runs as. Holding tokens there would make the
// per-caller credential weaker than the shared secret it replaces. Holding
// digests hands a reader something it cannot present.
//
// Which leaves who may WRITE it, and that one the file mode cannot answer: the
// service account owning the file is exactly the state 0600 describes, and an
// account that owns the file appends a line naming any terminal account on the
// box. So the owner must be root. Both halves are checked on every read, and
// either one failing means no credentials rather than an error.
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
//     request, and never reach a log line, a response body, Identity or the
//     file itself.
//
// The credential names an OS user, and that user must be a terminal account on
// this box. The file is root-owned, so that check is defence in depth rather
// than a boundary — the same argument the act-as charset check makes — but it
// is what stops one typo'd line handing out an account the lobby does not
// serve.

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"log"
	"net/http"
	"os"
	"regexp"
	"strings"
	"syscall"
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

// tokenRe bounds a token as PRESENTED: RFC 6750's b64token charset, so hex,
// base64url and Vault's dotted tokens all pass, and nothing with whitespace, a
// quote or a shell metacharacter does.
//
// The 32-character floor is the part worth keeping, and it is checked here
// rather than on the file because the file holds a digest — 64 hex characters
// whatever it digests, which would have left the floor nowhere to live. A
// credential nobody types has no reason to be shorter than this, and a token
// short enough to guess is also short enough to recover from its digest by
// anything that can read the file.
var tokenRe = regexp.MustCompile(`^[A-Za-z0-9._~+/=-]{32,512}$`)

// digestPrefix names the algorithm in the file, so a line carries what it is
// rather than 64 characters a reader has to recognise. It also means a
// pasted-in token fails to parse and says so, instead of being mistaken for a
// digest and silently never matching.
const digestPrefix = "sha256"

// BearerDigest is the middle field of a credentials line for a given token:
// the one definition of the format, so an issuing tool and the gate cannot
// drift. Equivalent to `printf %s "$TOKEN" | sha256sum`.
func BearerDigest(token string) string {
	sum := sha256.Sum256([]byte(token))
	return digestPrefix + ":" + hex.EncodeToString(sum[:])
}

// parseDigest reads that field back.
func parseDigest(field string) ([sha256.Size]byte, bool) {
	var out [sha256.Size]byte
	algo, digits, found := strings.Cut(field, ":")
	if !found || !strings.EqualFold(algo, digestPrefix) {
		return out, false
	}
	raw, err := hex.DecodeString(digits)
	if err != nil || len(raw) != len(out) {
		return out, false
	}
	copy(out[:], raw)
	return out, true
}

// bearerCred is one parsed line. The digest is unexported and never leaves
// this file: Identity carries the NAME, which is what /whoami echoes and what
// tmux-api writes to the log.
type bearerCred struct {
	Name   string
	digest [sha256.Size]byte
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

	// Owner and mode from the OPEN file rather than a separate stat, so what
	// is checked is what is read.
	info, err := f.Stat()
	if err != nil {
		return nil
	}
	// Who may write it. The services run as an ordinary account, so a file
	// that account owns is one it can append a line to, and a line names any
	// terminal account on the box. 0600 owned by the service account is the
	// mode an operator reaches for first and the one this refuses.
	owner, ok := fileOwnerUID(info)
	if !ok || owner != g.TokensOwnerUID {
		log.Printf("authuser: ignoring bearer credentials in %s: owned by uid %d, want %d — "+
			"an account that owns this file can issue itself a credential for any user on "+
			"this box; chown %d:<the group the services run as> and chmod 0640 it",
			path, owner, g.TokensOwnerUID, g.TokensOwnerUID)
		return nil
	}
	// Who may read it. Digests are not tokens, but the file still names which
	// accounts have machine callers, and group-write is a second account
	// issuing itself a credential.
	if perm := info.Mode().Perm(); perm&0o027 != 0 {
		log.Printf("authuser: ignoring bearer credentials in %s: mode %04o lets accounts "+
			"other than the owner read or change them; chmod 0640 it", path, perm)
		return nil
	}

	var out []bearerCred
	for _, line := range readNumberedLines(f) {
		fields := strings.Fields(line.Text)
		if len(fields) != 3 {
			g.skipLine(path, line.Number, "want three whitespace-separated fields, <name> sha256:<digest> <os-user>")
			continue
		}
		name, field, osUser := fields[0], fields[1], fields[2]
		digest, ok := parseDigest(field)
		if !ok {
			// The likeliest cause by far is a token written where its digest
			// goes, so the reason says what to write and the report says which
			// line — never what the line holds, which on this branch is the
			// one place a token could still be.
			g.skipLine(path, line.Number, "the second field is not sha256:<64 hex digits>; "+
				`store the digest, "printf %s \"$TOKEN\" | sha256sum", not the token`)
			continue
		}
		// The OS user is bound for `sudo -u <user>` argv and a /home/<user>
		// path, same as an act-as target, so it is held to the same charset.
		if !userRe.MatchString(name) || !userRe.MatchString(osUser) {
			g.skipLine(path, line.Number, "the credential name and the OS user must each be a plain account name")
			continue
		}
		out = append(out, bearerCred{Name: name, digest: digest, OSUser: osUser})
	}
	return out
}

// skipLine reports a line the parser could not use. By NUMBER and reason, with
// nothing copied out of the line: a line that does not parse is the one that
// might hold a token where a digest belongs.
func (g *Gate) skipLine(path string, number int, why string) {
	log.Printf("authuser: %s line %d skipped: %s", path, number, why)
}

// fileOwnerUID reports the uid that owns an open file. A platform that cannot
// answer gets no credentials, which is the same answer every other doubt on
// this path produces.
func fileOwnerUID(info os.FileInfo) (int, bool) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return -1, false
	}
	return int(st.Uid), true
}

// matchBearer finds the credential whose token was presented.
//
// It compares every credential whichever one matches. Returning early would be
// the obvious thing to write and would undo the constant-time comparison it
// sits inside: the number of comparisons would report which credential
// answered, and how long the loop ran would report how far down the file it is.
func (g *Gate) matchBearer(creds []bearerCred, presented string) (bearerCred, bool) {
	// The floor and the charset, on the one thing that still carries them. It
	// depends on the caller's own input and on no credential, so leaving early
	// here reports nothing about the file.
	if !tokenRe.MatchString(presented) {
		return bearerCred{}, false
	}
	want := sha256.Sum256([]byte(presented))
	var found bearerCred
	ok := false
	for _, c := range creds {
		if g.countTokenCompares != nil {
			g.countTokenCompares()
		}
		if subtle.ConstantTimeCompare(c.digest[:], want[:]) == 1 {
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
