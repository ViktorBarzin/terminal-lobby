package sessionio

import (
	"regexp"
	"strings"
)

// OriginTest is what the harnesses that drive the real deployed lobby stamp as
// OptionOrigin on their own sessions (scripts/qa-harness.py, qa_driver). This
// package never writes it; it is here so CallerOf can say what it is not.
const OriginTest = "test"

// callerNameRe is the charset a bearer credential's name is held to. authuser
// skips a tokens-file line whose name fails its userRe, and agent-api stamps
// that name as the origin of every session it creates, so a value outside it
// cannot have come from a Caller. Repeated rather than imported because this
// package depends on nothing in the repo, and the two are one regexp each.
var callerNameRe = regexp.MustCompile(`^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,31}$`)

// CallerOf reads an OptionOrigin value as the name of the Caller that made the
// session, or "" when the value names no Caller (CONTEXT.md: Origin, Caller).
//
// A Caller origin is whatever is not one of the lobby's own two words and not
// absent. That is what agent-api writes (CreateSpec.Origin is the credential's
// name, "agent-api" when there was none), and it means a new Caller needs no
// change here: issuing the credential is enough for its sessions to be filed
// under it.
//
// The two reserved words are compared without case, so a stamper that wrote
// "User" stays a stray rather than becoming a Caller with its own sidebar
// group. Every reader that files, mutes or tags by Caller goes through this one
// function, which is what keeps the sidebar, the push sender and telemetry
// agreeing about which sessions are a Caller's.
//
// The session NAME is not consulted. tmux-api's reserved name prefixes force a
// session to System whatever its origin says, and that half belongs to the
// service that owns the prefixes.
func CallerOf(origin string) string {
	if strings.EqualFold(origin, OriginUser) || strings.EqualFold(origin, OriginTest) {
		return ""
	}
	if !callerNameRe.MatchString(origin) {
		return ""
	}
	return origin
}
