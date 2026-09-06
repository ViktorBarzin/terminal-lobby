// tl-users renders /etc/terminal-lobby.users into the two files the services
// read: the identity map, and the sudo grant that lets the service become each
// other account.
//
//	tl-users check    parse and print what would be written, touching nothing
//	tl-users apply    write both files, after validating the grant with visudo
//
// Two things ride along with apply. -deploy-grant additionally writes
// /etc/sudoers.d/tl-reconcile, the NOPASSWD root grant behind the deploy key's
// forced command, which no artifact carried until 2026-09-05; it is opt-in
// because a box that takes no CI deploys should not hold one. And an account
// the previous map carried that this declaration does not gets its
// /var/lib/tmux-persist snapshots renamed to <user>.revoked-<date>, so a
// revoked user's session titles and transcript ids stop being restorable to
// whoever holds that OS name next.
//
// It exists for installs with NO roster. Where a roster owns those files —
// the homelab devvm, where t3-provision-users.sh reconciles them hourly —
// apply refuses. Two writers of one file is the shape that revoked two users'
// terminals on 2026-08-29, and a tool that quietly became the second one would
// be the same bug wearing a different hat.
package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"terminal-lobby/release"
)

const (
	mapPath     = release.UserMapPath
	sudoersPath = release.SudoersPath
	deployPath  = release.DeploySudoersPath
)

func main() {
	var (
		usersPath = flag.String("config", release.LocalUsersPath, "the declaration to render")
		service   = flag.String("service-user", "", "the account the units run as (default: the current user)")
		force     = flag.Bool("force", false, "apply even if a roster appears to own these files")
		// Off by default and in a file of its own. It is a NOPASSWD root grant,
		// and a box that takes no CI deploys has no reason to hold one.
		deploy = flag.Bool("deploy-grant", false, "also write "+deployPath+", the grant behind the deploy key's forced command")
		// A prefix for the paths written, so the write path itself can be
		// exercised against a throwaway tree. This tool installs a sudoers
		// file; "it compiles" is not evidence that it does that correctly.
		root = flag.String("root", "", "prefix for the files written (testing)")
	)
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "usage: tl-users [flags] check|apply\n\n")
		flag.PrintDefaults()
	}
	flag.Parse()

	if flag.NArg() != 1 {
		flag.Usage()
		os.Exit(2)
	}
	cmd := flag.Arg(0)

	svc := *service
	if svc == "" {
		svc = currentUser()
	}
	if svc == "" {
		die("cannot determine the service user; pass -service-user")
	}

	raw, err := os.ReadFile(*usersPath)
	if err != nil {
		die("read %s: %v", *usersPath, err)
	}
	users, err := release.ParseUsers(string(raw))
	if err != nil {
		die("%s: %v", *usersPath, err)
	}
	if len(users) == 0 {
		die("%s declares nobody; a box with no users has nothing to render", *usersPath)
	}

	mapDest := *root + mapPath
	sudoersDest := *root + sudoersPath
	deployDest := *root + deployPath

	userMap := release.RenderUserMap(users)
	sudoers := release.RenderSudoers(users, svc)
	deployGrant := release.RenderDeploySudoers(svc)

	// Who this run takes off the box, read before anything is written. Losing
	// the grant is what stops them attaching; this is the state they leave
	// behind, which nothing used to touch.
	previous, _ := os.ReadFile(mapDest)
	dropped := release.DroppedOSUsers(string(previous), users)

	switch cmd {
	case "check":
		fmt.Printf("service user: %s\n%d account(s):\n", svc, len(users))
		for _, u := range users {
			fmt.Printf("  %-30s -> %s\n", u.Identity, u.OSUser)
		}
		for _, missing := range accountsMissingOnThisHost(users) {
			fmt.Printf("  WARNING: %q has no account on this host\n", missing)
		}
		for _, gone := range dropped {
			from, to := release.RevokedStateDir(*root+release.SnapshotStore, gone, today())
			fmt.Printf("  %q is on the map and not in this declaration: apply would rename\n    %s -> %s\n", gone, from, to)
		}
		fmt.Printf("\n--- %s ---\n%s", mapDest, userMap)
		fmt.Printf("\n--- %s ---\n%s", sudoersDest, sudoers)
		if err := validateSudoers(sudoers); err != nil {
			die("the grant this would write is not valid sudoers: %v", err)
		}
		if *deploy {
			fmt.Printf("\n--- %s ---\n%s", deployDest, deployGrant)
			if err := validateSudoers(deployGrant); err != nil {
				die("the deploy grant this would write is not valid sudoers: %v", err)
			}
		}
		fmt.Println("\nthe grant parses; `tl-users apply` would install both files")

	case "apply":
		if owner := release.RosterOwns(mapDest, sudoersDest); owner != "" && !*force {
			die("%s says it is generated from %s, so a roster owns these files.\n"+
				"Declare users there instead — it also creates the accounts.\n"+
				"Pass -force only if you are certain the roster is gone.", owner, release.RosterMarker)
		}
		// The grant is validated BEFORE either file moves. An invalid sudoers
		// file is not a degraded feature: it breaks every sudo call on the box,
		// including the one needed to repair it.
		if err := validateSudoers(sudoers); err != nil {
			die("refusing to install: %v", err)
		}
		if *deploy {
			if err := validateSudoers(deployGrant); err != nil {
				die("refusing to install the deploy grant: %v", err)
			}
		}
		for _, missing := range accountsMissingOnThisHost(users) {
			fmt.Fprintf(os.Stderr, "warning: %q has no account on this host; create it or that user cannot attach\n", missing)
		}
		if err := writeFile(mapDest, userMap, 0o644); err != nil {
			die("%v", err)
		}
		if err := writeFile(sudoersDest, sudoers, 0o440); err != nil {
			die("%v", err)
		}
		if *deploy {
			if err := writeFile(deployDest, deployGrant, 0o440); err != nil {
				die("%v", err)
			}
			fmt.Printf("wrote %s: %s may run tl-reconcile as root\n", deployDest, svc)
		}
		for _, gone := range dropped {
			tombstoneState(*root, gone)
		}
		fmt.Printf("wrote %s and %s for %d account(s)\n", mapDest, sudoersDest, len(users))
		fmt.Println("restart the services to pick up the map: systemctl restart ttyd tmux-api file-api session-events skills-api")

	default:
		flag.Usage()
		os.Exit(2)
	}
}

// validateSudoers runs the real parser over the real text. Nothing else can
// tell us the file is safe to install.
func validateSudoers(body string) error {
	f, err := os.CreateTemp("", "tl-users-*.sudoers")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err := f.WriteString(body); err != nil {
		f.Close()
		return err
	}
	f.Close()
	out, err := exec.Command("visudo", "-cf", f.Name()).CombinedOutput()
	if err != nil {
		return fmt.Errorf("visudo rejected it: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

// writeFile installs atomically via a temp file in the same directory, so a
// crash or a full disk cannot leave a half-written sudoers file behind.
func writeFile(path, body string, mode os.FileMode) error {
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, filepath.Base(path)+".*")
	if err != nil {
		return fmt.Errorf("create temp beside %s: %w", path, err)
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, err := f.WriteString(body); err != nil {
		f.Close()
		return fmt.Errorf("write %s: %w", tmp, err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("close %s: %w", tmp, err)
	}
	if err := os.Chmod(tmp, mode); err != nil {
		return fmt.Errorf("chmod %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("install %s: %w", path, err)
	}
	return nil
}

// tombstoneState renames what a revoked user leaves outside their home, rather
// than deleting it.
//
// Dropping a name stops that person attaching the moment the map is written,
// because every privileged wrapper re-validates against it. Their snapshots do
// not go anywhere: session titles and transcript ids sit root-owned under
// /var/lib/tmux-persist/snapshots indefinitely, and re-adding the same OS name
// would silently make months-old snapshots restorable to whoever holds that
// account next. Renaming closes that and keeps the bytes, because this runs as
// root over someone else's data and deleting is the half that cannot be undone.
//
// A failure here is reported, never fatal: the map and the grant are already
// written, and the revocation itself has taken effect.
func tombstoneState(root, osUser string) {
	from, to := release.RevokedStateDir(root+release.SnapshotStore, osUser, today())
	if _, err := os.Stat(from); err != nil {
		return
	}
	if _, err := os.Stat(to); err == nil {
		fmt.Fprintf(os.Stderr, "warning: %s already exists; leaving %s alone\n", to, from)
		return
	}
	if err := os.Rename(from, to); err != nil {
		fmt.Fprintf(os.Stderr, "warning: could not tombstone %s: %v\n", from, err)
		return
	}
	fmt.Printf("%q is no longer declared: renamed %s -> %s (not deleted)\n", osUser, from, to)
}

func today() string { return time.Now().Format("20060102") }

// accountsMissingOnThisHost warns rather than refuses: declaring someone before
// creating their account is a reasonable order to work in.
func accountsMissingOnThisHost(users []release.User) []string {
	var missing []string
	for _, u := range users {
		if _, err := exec.Command("id", "-u", u.OSUser).Output(); err != nil {
			missing = append(missing, u.OSUser)
		}
	}
	return missing
}

func currentUser() string {
	out, err := exec.Command("id", "-un").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func die(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "tl-users: "+format+"\n", a...)
	os.Exit(1)
}
