// tl-pkg stages the Debian package tree from the manifest.
//
// The layout is generated rather than restated in a script, so the list of what
// ships and the list of what the box watches cannot drift apart — which is the
// class of failure this whole pipeline exists to remove.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"terminal-lobby/release"
)

func main() {
	var (
		stage   = flag.String("stage", "", "directory holding the built artefacts (bin/, share/, devvm/)")
		out     = flag.String("out", "", "directory to write the package tree into")
		version = flag.String("version", "", "package version, without the leading v")
		assets  = flag.String("assets", "", "directory of content-hashed chunks to carry as payload")
		commit  = flag.String("commit", "", "commit the artefacts were built from")
		tools   = flag.String("tools", "", "directory holding the built tl-apply binary")
	)
	flag.Parse()
	for name, v := range map[string]*string{"stage": stage, "out": out, "version": version, "tools": tools} {
		if *v == "" {
			fmt.Fprintf(os.Stderr, "tl-pkg: -%s is required\n", name)
			os.Exit(2)
		}
	}

	for _, f := range release.Package.Files {
		check(copyFile(filepath.Join(*stage, f.Src), filepath.Join(*out, f.Dest), f.Mode))
	}
	// tl-apply is the package's own tooling: the maintainer scripts call it.
	check(copyFile(filepath.Join(*tools, "tl-apply"), filepath.Join(*out, "/usr/lib/terminal-lobby/tl-apply"), 0o755))

	// The chunks travel as payload and are installed additively by postinst.
	// dpkg removes files a new version stops shipping, and a tab on the previous
	// build — or a rollback — still requests the old hashed names.
	if *assets != "" {
		entries, err := os.ReadDir(*assets)
		check(err)
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			check(copyFile(filepath.Join(*assets, e.Name()),
				filepath.Join(*out, release.Package.AssetPayload, e.Name()), 0o644))
		}
	}

	check(os.MkdirAll(filepath.Join(*out, "DEBIAN"), 0o755))
	check(os.WriteFile(filepath.Join(*out, "DEBIAN/control"), []byte(control(*version, *commit)), 0o644))
	check(os.WriteFile(filepath.Join(*out, "DEBIAN/preinst"), []byte(preinst), 0o755))
	check(os.WriteFile(filepath.Join(*out, "DEBIAN/postinst"), []byte(postinst), 0o755))
	fmt.Printf("tl-pkg: staged %d files at version %s\n", len(release.Package.Files), *version)
}

func control(version, commit string) string {
	return strings.Join([]string{
		"Package: terminal-lobby",
		"Version: " + version,
		"Architecture: amd64",
		"Maintainer: Viktor Barzin <me@viktorbarzin.me>",
		"Section: admin",
		"Priority: optional",
		// What the box needs, declared rather than remembered. This line is what
		// retires "the environment is a one-time setup" for this repo's footprint.
		"Depends: ttyd-devvm, viu, tmux, acl, sudo, libwebsockets19 | libwebsockets-dev, libjson-c5 | libjson-c-dev",
		"Description: Terminal Lobby - web tmux sessions for the devvm workstation",
		" The lobby UI, its Go backends, the systemd units and the devvm helper",
		" scripts, at one version. Built from commit " + commit + ".",
		"",
	}, "\n")
}

// preinst records what is installed before dpkg replaces it. Without this,
// postinst cannot tell what actually changed and would have to restart
// everything -- dropping every attached terminal on every release.
const preinst = `#!/bin/sh
set -e
[ -x /usr/lib/terminal-lobby/tl-apply ] && /usr/lib/terminal-lobby/tl-apply snapshot || true
exit 0
`

// postinst installs the chunks additively, validates the sudo grant, then hands
// over to tl-apply for restart, verification and the revert decision.
const postinst = `#!/bin/sh
set -e
[ "$1" = "configure" ] || exit 0

# A malformed sudo grant locks every user out of every session, so it is checked
# before it counts as installed.
if ! visudo -cf /etc/sudoers.d/ttyd-users >/dev/null; then
  echo "terminal-lobby: /etc/sudoers.d/ttyd-users is malformed; refusing to configure" >&2
  exit 1
fi

# Chunks are copied, never synced: old hashed names must stay valid for tabs on
# the previous build and for a rollback. Pruned by age, not by absence.
mkdir -p /usr/local/share/ttyd/assets
if [ -d /usr/share/terminal-lobby/assets ]; then
  cp -a /usr/share/terminal-lobby/assets/. /usr/local/share/ttyd/assets/
  find /usr/local/share/ttyd/assets -type f -mtime +14 -delete 2>/dev/null || true
fi

systemctl daemon-reload

# Set when tl-apply is reverting: the previous version has already been verified,
# and re-running the check from inside a revert risks a loop.
[ -n "$TL_SKIP_VERIFY" ] && exit 0

/usr/lib/terminal-lobby/tl-apply apply
`

func copyFile(src, dst string, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Chmod(mode)
}

func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "tl-pkg:", err)
		os.Exit(1)
	}
}
