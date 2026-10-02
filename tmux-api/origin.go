package main

import "terminal-lobby/sessionio"

// originOption is the tmux session option carrying who made the session. It
// sits beside @title, @last_drive, @claude_state and @tl_created for the reason
// ADR-0001 and ADR-0019 give: the option belongs to the session, it dies with
// the session, there is no store to keep in sync, and anything that can reach
// the tmux server can read or write it.
//
// Spelled as a literal here rather than via sessionio, the way @tl_created is:
// the writers are a shell script (devvm/tmux-user-attach), a Python harness and
// a bash harness, none of which can import a Go package, so a shared constant
// would agree with nobody. A test against the script is what keeps the
// spellings together.
//
// It rides tmuxListFmt (main.go), so it arrives with every other field and
// costs no extra fork.
const originOption = "@tl_origin"

// Who made a session, as stamped into @tl_origin.
//
// `user` comes from the lobby's own create path (devvm/tmux-user-attach),
// `test` from the harnesses that drive the real deployed lobby on purpose —
// scripts/qa-harness.py and qa_driver. agent-api writes the name of the
// credential that asked for the session, which is a Caller's name
// (sessionio.CallerOf decides that). A further state exists and has no
// constant, because it is the ABSENCE of the option: nobody stamped it.
const (
	originUser = sessionio.OriginUser
	originTest = sessionio.OriginTest
)

// Every session is exactly one of three kinds (CONTEXT.md: Origin), and these
// three functions are the only place the kinds are told apart:
//
//   - a person's (isUserSession): it pushes, it is recorded, it sits wherever
//     its layout puts it;
//   - a Caller's (callerOf names the Caller): it sits in a sidebar group of the
//     Caller's own, it is recorded with tl.caller, and it raises no push;
//   - System's (isSystemSession): test harnesses, strays, reserved names. It
//     sits in System, it is not recorded, and it raises no push.
//
// So "raises a push" is isUserSession, "is recorded" is !isSystemSession, and
// no consumer has to combine the two by hand.

// isUserSession reports whether a person made this session through the
// lobby's own create path. It is what the push sender and the 72-hour suspend
// fuse ask, because those two are about a person's attention and a person's
// memory, and neither a harness nor a Caller is a person.
//
// Phrased as "is exactly user" rather than "is not test", and that inversion is
// the point of the whole origin feature. Measured on the box on 2026-09-06,
// four sessions in the list were made by tooling and THREE of them matched no
// harness convention at all — `shell`, `shell-2` and `kbfix-probe`, created by
// hand or by a script that is not in this repo. A predicate that asked "is this
// a harness session" would have caught one in four. Asking "did the lobby make
// this" catches all four, and catches whatever creates sessions next year
// without telling us. It fails closed: the cost of a wrong answer is a session
// one click away in a collapsed group, against a phone buzzing at 3am for a
// robot's turn.
//
// The name half needs no new rule. reservedName (migrate_ids.go) already
// answers "does this name belong to something other than a person" over
// reservedNamePrefixes, and it is the same question. It also covers the window
// the stamping order opens: a QA agent driving /?session=qa-foo goes through
// the lobby's own create path and is stamped `user` on the way in, and the
// harness only overwrites that to `test` afterwards.
func isUserSession(s Session) bool {
	return s.Origin == originUser && !reservedName(s.Name)
}

// callerOf names the Caller that made this session, or "" when no Caller did.
// The origin half is sessionio.CallerOf, shared with session-events so both
// services tag the same sessions; the name half is reservedName, which wins
// over a Caller stamp exactly as it wins over a user one.
func callerOf(s Session) string {
	if reservedName(s.Name) {
		return ""
	}
	return sessionio.CallerOf(s.Origin)
}

// isSystemSession reports whether a session belongs to tooling that is neither
// a person nor a Caller: a test harness, a stray nobody stamped, or a reserved
// name. System sessions collect in one collapsed group at the foot of the
// sidebar, they do not fire Web Push, and they are not recorded in telemetry.
// They stay fully addressable: attach, prompt, kill and open-by-URL are
// unchanged.
//
// Until 2026-10-02 a Caller's sessions were System sessions too. They have
// their own group now and are recorded, so this excludes them; a consumer that
// means "not a person's" asks !isUserSession instead.
func isSystemSession(s Session) bool {
	return !isUserSession(s) && callerOf(s) == ""
}
