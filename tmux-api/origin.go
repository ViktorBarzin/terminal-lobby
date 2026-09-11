package main

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
// Only two values are ever written. `user` comes from the lobby's own create
// path (devvm/tmux-user-attach), `test` from the harnesses that drive the real
// deployed lobby on purpose — scripts/qa-harness.py, qa_driver and
// t3-bridge/e2e/lib.sh. A third state exists and has no constant, because it is
// the ABSENCE of the option: nobody stamped it.
const (
	originUser = "user"
	originTest = "test"
)

// isSystemSession reports whether a session belongs to tooling rather than to a
// person. System sessions collect in one collapsed group at the foot of the
// sidebar, they do not fire Web Push, and they are not recorded in telemetry.
// They stay fully addressable: attach, prompt, kill and open-by-URL are
// unchanged.
//
// Phrased as "not user" rather than "is test" on purpose, and that inversion is
// the point of the whole feature. Measured on the box on 2026-09-06, four
// sessions in the list were made by tooling and THREE of them matched no
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
func isSystemSession(s Session) bool {
	return s.Origin != originUser || reservedName(s.Name)
}
