package release

// The privileged surface: what runs as root or as another user on behalf of
// this package, and what state that leaves behind.
//
// Three pieces of it were in no artifact until 2026-09-05. The deploy grant at
// /etc/sudoers.d/tl-reconcile is a NOPASSWD root grant this repo describes
// nowhere, so a box rebuilt from the manifest alone stops accepting deploys.
// t3-mint's grant rests on the user map users.go renders, so this repo's output
// decides what a service account in another repo may mint tokens for.
// /usr/local/bin/tmux-persist is execed by a root-granted wrapper we do ship,
// and nothing reconciled installs it.
//
// None of that is a hole an attacker walks through today. It is the design
// under-reporting itself, which is how a rebuilt box comes up subtly different
// from this one and how the next person to widen a grant does it without seeing
// the whole picture.

// PrivilegedDep is a path this package does not install but depends on at
// privilege: either it runs as root, or a grant declared here points at it.
//
// External is the narrower list of paths a UNIT watches. A dependency can be
// both, and most are neither watched nor shipped, which is exactly why they go
// unnoticed.
type PrivilegedDep struct {
	// Path is where the binary must be on the box.
	Path string
	// Installer is what puts it there. A rebuild that does not run this comes
	// up with the grant and without the thing the grant points at.
	Installer string
	// RunsAs is the identity it executes as once it is reached.
	RunsAs string
	// Reached names what in THIS package invokes it, so the dependency can be
	// traced back from the path.
	Reached string
	// Grant is the sudoers file that makes it privileged, "" when it needs
	// none of its own.
	Grant string
	// Why is what it does and what it trusts.
	Why string
}

// PrivilegedDeps is the complete list. A new one belongs here at the moment a
// script starts calling it, not at the moment someone audits it.
var PrivilegedDeps = []PrivilegedDep{
	{
		Path:      "/usr/local/bin/tmux-persist",
		Installer: "infra: the devvm playbook, and setup-devvm.sh before it",
		RunsAs:    "root, through the tmux-restore-user grant in " + SudoersPath,
		Reached:   "devvm/tmux-restore-user and devvm/tmux-persist-forget exec it, after validating the user against the map",
		Why: "Snapshots and restores every user's tmux sessions into " +
			"/var/lib/tmux-persist. It is byte-identical to infra/scripts/tmux-persist.sh " +
			"and its three units live there too, so a box rebuilt from this package alone " +
			"has the root grant, the state tree, and no binary: restore fails silently and " +
			"no snapshots are taken. tmux-restore-user now says so instead of failing quietly.",
	},
	{
		Path:      "/usr/local/bin/t3-mint",
		Installer: "infra: setup-devvm.sh, as t3-autopair",
		RunsAs:    "root, through /etc/sudoers.d/t3-autopair",
		Reached:   "nothing here calls it; it reads " + UserMapPath + ", which this package renders",
		Grant:     "/etc/sudoers.d/t3-autopair",
		Why: "Mints a one-time T3 pairing token as a named user, validating the target " +
			"against " + UserMapPath + ". That makes this repo's map the sole input deciding " +
			"what an unprivileged, network-facing service account can mint root-issued " +
			"tokens for. Widening the map widens that grant, across a repo boundary, and " +
			"no test in either repo would notice.",
	},
}

// Grant is one sudoers file the lobby depends on. Who writes it matters as much
// as what is in it: the package authors none of them, because a grant is
// per-box identity data and a repository copy that has drifted revokes real
// users rather than merely going stale.
type Grant struct {
	// Path is the live file, always mode 0440 root:root.
	Path string
	// Writer is what authors it on a box.
	Writer string
	// Template is the reference copy in this repo, "" when another repo owns
	// the whole grant.
	Template string
	// Validate marks a grant postinst parses with visudo before the install
	// counts as done.
	Validate bool
	// Why is what the grant buys and what bounds it.
	Why string
}

// Grants is every sudoers file in the picture, ours or not.
var Grants = []Grant{
	{
		Path:     SudoersPath,
		Writer:   "the roster reconcile, or `tl-users apply` on a box with no roster",
		Template: "devvm/sudoers.d-ttyd-users.template",
		Validate: true,
		Why: "Lets the service user become each OTHER account for a fixed set of " +
			"binaries, and root for the three wrappers. This is the boundary between " +
			"two people's accounts on one machine.",
	},
	{
		Path:     DeploySudoersPath,
		Writer:   "`tl-users apply -deploy-grant`, or the operator, once per box",
		Template: "devvm/sudoers.d-tl-reconcile.template",
		Validate: true,
		Why: "The forced command on the deploy SSH key runs `sudo -n /usr/local/bin/tl-reconcile`, " +
			"and this is the grant that permits it. tl-reconcile runs apt-get install, and dpkg " +
			"runs maintainer scripts as root, so the grant is really \"run whatever root code the " +
			"configured apt source publishes\". It is not steerable by argument: the script reads " +
			"no argv at all. Nothing installs this file, on purpose: it names a box-specific " +
			"account, and a package that shipped it would grant root to whoever happens to hold " +
			"that name elsewhere.",
	},
	{
		Path:     "/etc/sudoers.d/t3-autopair",
		Writer:   "infra: setup-devvm.sh",
		Validate: false,
		Why: "t3-dispatch may run /usr/local/bin/t3-mint as root. It belongs to another " +
			"repo and this package neither writes nor reads it; it is here because its " +
			"target trusts " + UserMapPath + ", which this package renders. Not validated at " +
			"install for the same reason: refusing to configure the lobby over a foreign " +
			"grant would take the terminal down for a fault it has no part in.",
	},
}

// UserState is state one user accumulates OUTSIDE their home directory, which
// is what a revocation has to account for and a home-directory sweep misses.
type UserState struct {
	// Path is the parent; each user's state is a <Path>/<os_user> entry.
	Path string
	// Owner is who owns the entries on disk.
	Owner string
	// OnRevoke is what happens to a dropped user's entry, and it is the whole
	// point of the list.
	OnRevoke string
}

// SnapshotStore is where tmux-persist keeps each user's sessions. Root-owned,
// 0700 per user, and untouched by anything that removes a user.
const SnapshotStore = "/var/lib/tmux-persist/snapshots"

// ClipboardStore is where clipboard-upload keeps each user's images and
// telemetry. Service-user-owned; modes are ADR-0005's accepted decision.
const ClipboardStore = "/var/lib/clipboard-store"

// PerUserState is the revocation checklist.
//
// Dropping someone from the map stops them attaching immediately: every
// privileged wrapper re-validates the name against the map before it does
// anything, so the enforcement sits upstream of all of this. What it does not
// do is remove what they left behind. Session titles and transcript ids sit in
// root-owned directories indefinitely, and re-adding the same OS name would
// silently make months-old snapshots restorable to whoever holds that account
// next. Measured on this box: /var/lib/tmux-persist/snapshots/ancamilea, root
// 0700, three weeks after the grant went.
//
// Tombstoned rather than deleted. The tool doing it runs as root over another
// person's data, so the reversible half of the choice is the one to make; an
// operator who wants the bytes gone removes the tombstone by hand.
var PerUserState = []UserState{
	{
		Path:     SnapshotStore,
		Owner:    "root:root, 0700 per user",
		OnRevoke: "renamed to <user>.revoked-<date> by `tl-users apply`, never deleted",
	},
	{
		Path:  ClipboardStore,
		Owner: "the service user",
		OnRevoke: "left in place: the store is pruned by age on its own timer, and the " +
			"per-user directory is recreated on first upload",
	},
	{
		Path:  "/home",
		Owner: "the user",
		OnRevoke: "left in place. Homes belong to the OS, and removing one is `userdel -r` " +
			"and a decision about backups, not something a grant renderer should do.",
	},
}

// RevokedStateDir names a dropped user's state directory and the tombstone to
// rename it to. day is YYYYMMDD, taken from the caller so the result is
// testable.
func RevokedStateDir(parent, osUser, day string) (from, to string) {
	from = parent + "/" + osUser
	return from, from + ".revoked-" + day
}
