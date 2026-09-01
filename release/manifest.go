package release

import (
	"os"
	"strings"
)

// ServedAssetDir is where ttyd's shared assets live on the box. The lobby's
// content-hashed chunks land here, and clipboard-upload serves them from its
// exact-path whitelist.
const ServedAssetDir = "/usr/local/share/ttyd/assets"

// File is one file the package installs.
type File struct {
	// Src is the path within the built staging tree.
	Src string
	// Dest is the absolute path on the box.
	Dest string
	Mode os.FileMode
	// Validate marks a file that is checked for syntactic validity before it is
	// installed, because installing a broken one is worse than not installing.
	Validate bool
	// Unmanaged marks a binary no unit runs — invoked per-request or per-turn
	// rather than supervised.
	Unmanaged bool
	// Conffile marks a file dpkg must treat as configuration: an operator's
	// local edit survives the upgrade, and a package that changes the shipped
	// version prompts with a diff instead of overwriting.
	Conffile bool
}

// ConfigPath is the one file an operator edits. Every unit sources it as an
// EnvironmentFile, and systemd expands environment variables in ExecStart, so
// ttyd's -H reads the same value the Go services do.
const ConfigPath = "/etc/terminal-lobby.conf"

// DefaultConfig is what the package ships at ConfigPath. It names every
// variable, including the ones a given install is not using, because the
// alternative is finding them in source.
//
// TL_PROXY_SECRET ships commented out on purpose: writing a live value here
// without the proxy also sending it would refuse every request after the next
// restart.
func DefaultConfig() string {
	return `# terminal-lobby configuration.
#
# Every service reads this file (systemd EnvironmentFile), including ttyd,
# whose -H flag expands ${TL_AUTH_HEADER} from here. Restart the units after
# editing: systemctl restart ttyd tmux-api file-api session-events skills-api
#
# This file belongs to the package and is replaced when the defaults change.
# Put YOUR settings in /etc/terminal-lobby.local.conf instead: the units read
# it second, so it wins on any key it sets, and dpkg never prompts about it.

# Which request header carries the username, set by whatever reverse proxy
# authenticates in front of the lobby. The default is what oauth2-proxy, Caddy,
# Cloudflare Access and Tailscale emit.
#   Authentik:  X-Authentik-Username
#   Others:     X-Forwarded-User, X-Remote-User
TL_AUTH_HEADER=X-Forwarded-User

# A shared secret the proxy must also send, in X-TL-Proxy-Secret. Unset means
# the check is off: any caller that can reach the ports below may send
# TL_AUTH_HEADER and be treated as that user. Set this AND configure your proxy
# to send it in the same change, or the next restart refuses every request.
#TL_PROXY_SECRET=

# auto  multi-user when /etc/ttyd-user-map exists, single-user otherwise
# on    force multi-user (needs the user map and the sudoers grant)
# off   force single-user: everything runs as the invoking user, no sudo
TL_MULTI_USER=auto

# Listen address for the services. The default admits only a proxy on this same
# host, which is the arrangement that needs no shared secret at all. Widen it to
# 0.0.0.0 when the proxy is somewhere else — an ingress in a cluster, say — and
# set TL_PROXY_SECRET in the same change, because a service reachable from the
# network trusts TL_AUTH_HEADER from anything that reaches it.
TL_BIND=127.0.0.1
`
}

// Check is one verification probe: a URL on the box and the status it must
// answer. Health endpoints are unauthenticated by design; the 401 probes assert
// that an authed surface still refuses an unauthenticated request, because a
// surface that answers 200 without credentials is worse than one that is down.
type Check struct {
	Unit       string
	Name       string
	URL        string
	WantStatus int
}

// Manifest is what the package contains and what watches it. Both halves of the
// pipeline read this: the build to lay the package out, the box to decide what
// to restart.
type Manifest struct {
	Files []File
	Units []Unit
	// AssetPayload is where the content-hashed chunks travel inside the package.
	// They are copied into ServedAssetDir by the maintainer script rather than
	// installed by dpkg: dpkg removes files a new version stops shipping, and a
	// tab on the previous build — or a rollback — still requests the old names.
	AssetPayload string
	// External lists paths a unit watches that another package installs.
	External []string
	// Checks is what the box runs after installing, to decide whether to keep
	// the version or revert to the previous one.
	Checks []Check
	// Enable is the units to enable, not merely restart. Restarting a unit that
	// was never enabled starts it exactly once; enabling is what brings the box
	// back after a reboot.
	Enable []string
	// HashedTermPage records that the build generates a content-hashed copy of
	// the terminal page into the asset payload. The lobby resolves the terminal
	// page by hash and only falls back to /term.html when the meta tag is
	// absent -- which stamping never leaves it.
	HashedTermPage bool
}

// ExternalFile reports whether a watched path is installed by another package.
func (m Manifest) ExternalFile(dest string) bool {
	for _, e := range m.External {
		if e == dest {
			return true
		}
	}
	return false
}

// Package describes terminal-lobby. It carries the application at one version,
// which is what makes a frontend/backend version skew unreachable.
//
// The patched terminal server and the image viewer are separate packages: they
// are slow to build, almost never change, and CI's hot path should not pay for
// them. They arrive as declared dependencies.
var Package = Manifest{
	AssetPayload:   "/usr/share/terminal-lobby/assets",
	HashedTermPage: true,
	// Enabled, not just restarted: a unit that was only ever restarted does not
	// come back after a reboot.
	Enable: []string{
		"ttyd", "tmux-api", "clipboard-upload",
		"session-events", "file-api", "skills-api",
		"clipboard-cleanup.timer",
		// A long-running service rather than a timer: the comparison is between
		// consecutive looks, so the previous snapshot has to survive the tick.
		"tl-session-watch",
	},
	External: []string{"/usr/local/bin/ttyd"},
	Checks: []Check{
		{Unit: "tmux-api", Name: "tmux-api /health", URL: "http://127.0.0.1:7684/health", WantStatus: 200},
		{Unit: "tmux-api", Name: "tmux-api /whoami refuses anonymous", URL: "http://127.0.0.1:7684/whoami", WantStatus: 401},
		{Unit: "clipboard-upload", Name: "clipboard-upload /health", URL: "http://127.0.0.1:7683/health", WantStatus: 200},
		{Unit: "clipboard-upload", Name: "clipboard-upload /list refuses anonymous", URL: "http://127.0.0.1:7683/list", WantStatus: 401},
		{Unit: "session-events", Name: "session-events /health", URL: "http://127.0.0.1:7685/health", WantStatus: 200},
		{Unit: "session-events", Name: "session-events /events refuses anonymous", URL: "http://127.0.0.1:7685/events/probe", WantStatus: 401},
		{Unit: "file-api", Name: "file-api /health", URL: "http://127.0.0.1:7686/health", WantStatus: 200},
		{Unit: "file-api", Name: "file-api /files/list refuses anonymous", URL: "http://127.0.0.1:7686/files/list", WantStatus: 401},
		{Unit: "skills-api", Name: "skills-api /health", URL: "http://127.0.0.1:7688/health", WantStatus: 200},
		{Unit: "skills-api", Name: "skills-api /skills refuses anonymous", URL: "http://127.0.0.1:7688/skills", WantStatus: 401},
		// Reports stale rather than up once ticks stop, so a watcher that is
		// running but no longer looking fails the release check instead of
		// passing it. It carries no authed surface, so there is no refusal to
		// assert alongside it.
		{Unit: "tl-session-watch", Name: "tl-session-watch /health", URL: "http://127.0.0.1:7689/health", WantStatus: 200},
		// ttyd is launched with -H X-authentik-username, so an unauthenticated
		// request is refused by the proxy-auth layer with 407, not 401. Verified
		// against the live service rather than assumed.
		{Unit: "ttyd", Name: "ttyd refuses anonymous", URL: "http://127.0.0.1:7681/", WantStatus: 407},
	},
	Files: []File{
		{Src: "bin/tmux-api", Dest: "/usr/local/bin/tmux-api", Mode: 0o755},
		{Src: "bin/clipboard-upload", Dest: "/usr/local/bin/clipboard-upload", Mode: 0o755},
		{Src: "bin/session-events", Dest: "/usr/local/bin/session-events", Mode: 0o755},
		{Src: "bin/file-api", Dest: "/usr/local/bin/file-api", Mode: 0o755},
		{Src: "bin/skills-api", Dest: "/usr/local/bin/skills-api", Mode: 0o755},
		{Src: "bin/tl-t3-sync", Dest: "/usr/local/bin/tl-t3-sync", Mode: 0o755},
		{Src: "bin/tl-session-watch", Dest: "/usr/local/bin/tl-session-watch", Mode: 0o755},
		// Spawned by T3 in place of claude, once per thread — no unit supervises it.
		{Src: "bin/tl-t3-bridge", Dest: "/usr/local/bin/tl-t3-bridge", Mode: 0o755, Unmanaged: true},
		// Invoked by ttyd per WebSocket, by sessions, and by tmux-api via sudo.
		{Src: "devvm/tmux-attach.sh", Dest: "/usr/local/bin/tmux-attach.sh", Mode: 0o755, Unmanaged: true},
		{Src: "devvm/tmux-user-attach", Dest: "/usr/local/bin/tmux-user-attach", Mode: 0o755, Unmanaged: true},
		{Src: "devvm/tmux-user-dirlist", Dest: "/usr/local/bin/tmux-user-dirlist", Mode: 0o755, Unmanaged: true},
		{Src: "devvm/tmux-user-setfacl", Dest: "/usr/local/bin/tmux-user-setfacl", Mode: 0o755, Unmanaged: true},
		{Src: "devvm/tmux-restore-user", Dest: "/usr/local/bin/tmux-restore-user", Mode: 0o755, Unmanaged: true},
		{Src: "devvm/tmux-persist-forget", Dest: "/usr/local/bin/tmux-persist-forget", Mode: 0o755, Unmanaged: true},
		{Src: "devvm/show-image", Dest: "/usr/local/bin/show-image", Mode: 0o755, Unmanaged: true},
		{Src: "devvm/claude-tmux-state", Dest: "/usr/local/bin/claude-tmux-state", Mode: 0o755, Unmanaged: true},
		{Src: "devvm/claude-se-hook", Dest: "/usr/local/bin/claude-se-hook", Mode: 0o755, Unmanaged: true},
		{Src: "devvm/clipboard-store-clean", Dest: "/usr/local/bin/clipboard-store-clean", Mode: 0o755},

		{Src: "share/index.html", Dest: "/usr/local/share/ttyd/index.html", Mode: 0o644},
		{Src: "share/term.html", Dest: "/usr/local/share/ttyd/term.html", Mode: 0o644},

		// The two endpoints the self-update healer polls to learn a version
		// shipped. Generated at stamp time; without them no open tab ever
		// updates itself again.
		{Src: "share/build-id", Dest: "/usr/local/share/ttyd/build-id", Mode: 0o644},
		{Src: "share/term-build-id", Dest: "/usr/local/share/ttyd/term-build-id", Mode: 0o644},

		// The PWA surface, served by clipboard-upload from an exact-path
		// whitelist -- a missing file here is a 404 the client cannot route around.
		{Src: "frontend/sw.js", Dest: "/usr/local/share/ttyd/sw.js", Mode: 0o644},
		{Src: "frontend/manifest.webmanifest", Dest: "/usr/local/share/ttyd/manifest.webmanifest", Mode: 0o644},
		{Src: "frontend/icon-192.png", Dest: "/usr/local/share/ttyd/icon-192.png", Mode: 0o644},
		{Src: "frontend/icon-512.png", Dest: "/usr/local/share/ttyd/icon-512.png", Mode: 0o644},
		{Src: "frontend/icon-512-maskable.png", Dest: "/usr/local/share/ttyd/icon-512-maskable.png", Mode: 0o644},

		{Src: "frontend/fonts/dm-sans-latin-wght-normal.woff2", Dest: "/usr/local/share/ttyd/fonts/dm-sans-latin-wght-normal.woff2", Mode: 0o644},
		{Src: "frontend/fonts/JetBrainsMono-Regular.woff2", Dest: "/usr/local/share/ttyd/fonts/JetBrainsMono-Regular.woff2", Mode: 0o644},
		{Src: "frontend/fonts/JetBrainsMono-Bold.woff2", Dest: "/usr/local/share/ttyd/fonts/JetBrainsMono-Bold.woff2", Mode: 0o644},
		{Src: "frontend/fonts/JetBrainsMono-Italic.woff2", Dest: "/usr/local/share/ttyd/fonts/JetBrainsMono-Italic.woff2", Mode: 0o644},
		{Src: "frontend/fonts/JetBrainsMono-BoldItalic.woff2", Dest: "/usr/local/share/ttyd/fonts/JetBrainsMono-BoldItalic.woff2", Mode: 0o644},
		{Src: "frontend/fonts/tl-symbols.woff2", Dest: "/usr/local/share/ttyd/fonts/tl-symbols.woff2", Mode: 0o644},

		// Shared tmux UX, and the per-user units the session pool runs. Marked
		// unwatched: they are read at session start and by `systemctl --user`,
		// not by a system service this package restarts.
		// The one file an operator edits. Conffile so a local header name or
		// secret survives every upgrade; Unmanaged because no unit runs it,
		// though every unit sources it.
		{Src: "devvm/terminal-lobby.conf", Dest: ConfigPath, Mode: 0o644, Unmanaged: true, Conffile: true},
		// The only command the deploy SSH key may run. Unmanaged: no unit runs
		// it, the forced command does.
		{Src: "devvm/tl-reconcile", Dest: "/usr/local/bin/tl-reconcile", Mode: 0o755, Unmanaged: true},
		// Renders /etc/terminal-lobby.users into the identity map and the sudo
		// grant, for boxes with no roster. Unmanaged: an operator runs it, no
		// unit does, and it refuses to run where a roster owns those files.
		{Src: "bin/tl-users", Dest: "/usr/local/bin/tl-users", Mode: 0o755, Unmanaged: true},
		// The declaration's TEMPLATE, not the declaration. It lands beside the
		// real path rather than on it: shipping content to
		// /etc/terminal-lobby.users would make the package a writer of identity
		// data, which is the thing that revoked two users' terminals.
		{Src: "devvm/terminal-lobby.users.template", Dest: "/usr/share/terminal-lobby/terminal-lobby.users.template", Mode: 0o644, Unmanaged: true},
		{Src: "devvm/tmux.conf.system", Dest: "/etc/tmux.conf", Mode: 0o644, Unmanaged: true},
		{Src: "devvm/tl-pool-warm@.service", Dest: "/etc/systemd/user/tl-pool-warm@.service", Mode: 0o644, Unmanaged: true},
		{Src: "devvm/tl-prewarm@.service", Dest: "/etc/systemd/user/tl-prewarm@.service", Mode: 0o644, Unmanaged: true},

		{Src: "devvm/ttyd.service", Dest: "/etc/systemd/system/ttyd.service", Mode: 0o644},
		{Src: "devvm/tmux-api.service", Dest: "/etc/systemd/system/tmux-api.service", Mode: 0o644},
		{Src: "devvm/clipboard-upload.service", Dest: "/etc/systemd/system/clipboard-upload.service", Mode: 0o644},
		{Src: "devvm/session-events.service", Dest: "/etc/systemd/system/session-events.service", Mode: 0o644},
		{Src: "devvm/file-api.service", Dest: "/etc/systemd/system/file-api.service", Mode: 0o644},
		{Src: "devvm/skills-api.service", Dest: "/etc/systemd/system/skills-api.service", Mode: 0o644},
		{Src: "devvm/clipboard-cleanup.service", Dest: "/etc/systemd/system/clipboard-cleanup.service", Mode: 0o644},
		{Src: "devvm/clipboard-cleanup.timer", Dest: "/etc/systemd/system/clipboard-cleanup.timer", Mode: 0o644},
		{Src: "devvm/tl-t3-sync@.service", Dest: "/etc/systemd/system/tl-t3-sync@.service", Mode: 0o644},
		{Src: "devvm/tl-session-watch.service", Dest: "/etc/systemd/system/tl-session-watch.service", Mode: 0o644},

		// The grant every attach depends on. visudo -cf gates it, because a
		// malformed grant locks every user out of every session.
		// The sudo grant is NOT shipped. It is per-box identity data owned by
		// the roster, and installing a repository copy revokes the grants of
		// every user that copy has forgotten. devvm/sudoers.d-ttyd-users.template
		// is the reference; postinst still validates the live file before
		// counting the install as done.
	},
	// ttyd watches the terminal server binary, which ttyd-devvm installs; that
	// package restarts it when it upgrades. It is listed here so a change to the
	// lobby page or to its own unit still restarts it.
	//
	// There is no ttyd-ro: the read-only tier was retired in 58f6ee0.
	Units: []Unit{
		{Name: "ttyd", Files: []string{
			"/usr/local/bin/ttyd",
			"/usr/local/share/ttyd/index.html",
			"/etc/systemd/system/ttyd.service",
		}},
		{Name: "tmux-api", Files: []string{
			"/usr/local/bin/tmux-api",
			"/etc/systemd/system/tmux-api.service",
		}},
		{Name: "clipboard-upload", Files: []string{
			"/usr/local/bin/clipboard-upload",
			"/etc/systemd/system/clipboard-upload.service",
		}},
		{Name: "session-events", Files: []string{
			"/usr/local/bin/session-events",
			"/etc/systemd/system/session-events.service",
		}},
		{Name: "file-api", Files: []string{
			"/usr/local/bin/file-api",
			"/etc/systemd/system/file-api.service",
		}},
		{Name: "skills-api", Files: []string{
			"/usr/local/bin/skills-api",
			"/etc/systemd/system/skills-api.service",
		}},
		{Name: "clipboard-cleanup.timer", Files: []string{
			"/etc/systemd/system/clipboard-cleanup.service",
			"/etc/systemd/system/clipboard-cleanup.timer",
			"/usr/local/bin/clipboard-store-clean",
		}},
		{Name: "tl-session-watch", Files: []string{
			"/usr/local/bin/tl-session-watch",
			"/etc/systemd/system/tl-session-watch.service",
		}},
		{Name: "tl-t3-sync@", Template: true, Files: []string{
			"/usr/local/bin/tl-t3-sync",
			"/etc/systemd/system/tl-t3-sync@.service",
		}},
	},
}

// LocalConfigPath is where local settings go. The units read it after
// ConfigPath, so it wins on any key it sets, and it is deliberately NOT a
// conffile: the package never replaces it, and dpkg never prompts about it.
const LocalConfigPath = "/etc/terminal-lobby.local.conf"

// MigrateConfigSnippet runs once in postinst. Its whole job is the upgrade
// where a box already serving users on the Authentik header takes a package
// whose compiled default is X-Forwarded-User: without it, every user is locked
// out at the next restart.
//
// The presence of a user map is what identifies such a box — a fresh install
// has none, and the compiled default is right there. An override that already
// exists is the operator's, and is never touched.
//
// TL_LOCAL_CONF and TL_USER_MAP are overridable so the test can run this
// against a fake root rather than asserting on the text of it.
const MigrateConfigSnippet = `
: "${TL_LOCAL_CONF:=/etc/terminal-lobby.local.conf}"
: "${TL_USER_MAP:=/etc/ttyd-user-map}"

if [ ! -e "$TL_LOCAL_CONF" ] && [ -e "$TL_USER_MAP" ]; then
  cat > "$TL_LOCAL_CONF" <<'TLEOF'
# Written once, when terminal-lobby first shipped a configurable identity
# header and found this box already running multi-user. Before that the header
# name was compiled in as X-Authentik-Username; the package default is now
# X-Forwarded-User, so this preserves what your proxy already sends.
#
# Yours to edit. The package replaces /etc/terminal-lobby.conf on upgrade and
# never touches this file.
TL_AUTH_HEADER=X-Authentik-Username

# This box was already serving before TL_BIND had a default, and its proxy is
# not on this host, so narrowing to 127.0.0.1 would take the lobby down. Set to
# what it was. If your proxy can send a shared secret, set TL_PROXY_SECRET here
# and have it send X-TL-Proxy-Secret — that is what closes the network path.
TL_BIND=0.0.0.0
TLEOF
  chmod 0644 "$TL_LOCAL_CONF"
  echo "terminal-lobby: pinned TL_AUTH_HEADER=X-Authentik-Username in $TL_LOCAL_CONF (existing multi-user box)"
fi
`

// PostinstScript is the postinst template tl-pkg installs. It lives here,
// beside the manifest it acts on, so the tests can run and assert on it.
// PostinstScript installs the chunks additively, validates the sudo grant, then hands
// over to tl-apply for restart, verification and the revert decision.
const PostinstScript = `#!/bin/sh
set -e
[ "$1" = "configure" ] || exit 0

# A malformed sudo grant locks every user out of every session, so it is checked
# before it counts as installed. A single-user install has no grant at all — it
# never runs sudo — so its absence is not a failure.
if [ -e /etc/sudoers.d/ttyd-users ] && ! visudo -cf /etc/sudoers.d/ttyd-users >/dev/null; then
  echo "terminal-lobby: /etc/sudoers.d/ttyd-users is malformed; refusing to configure" >&2
  exit 1
fi

MIGRATE_CONFIG

# Chunks are copied, never synced: old hashed names must stay valid for tabs on
# the previous build and for a rollback.
#
# install(1), not cp -a: payload files carry their BUILD mtime, and preserving it
# means the prune below deletes the chunks it just installed whenever the package
# is older than the window -- which is exactly the revert path.
mkdir -p /usr/local/share/ttyd/assets
if [ -d /usr/share/terminal-lobby/assets ]; then
  for f in /usr/share/terminal-lobby/assets/*; do
    [ -e "$f" ] || continue
    install -m 0644 "$f" /usr/local/share/ttyd/assets/
  done
  # Pruned by age of INSTALL, which install(1) has just set to now.
  find /usr/local/share/ttyd/assets -type f -mtime +14 -delete 2>/dev/null || true
fi

# daemon-reload can transiently time out under heavy devvm load; both deploy
# scripts retried once and so does this. Without the retry, set -e aborts
# postinst before anything is restarted and dpkg leaves the package half-configured.
systemctl daemon-reload || { sleep 3; systemctl daemon-reload; }

# Enabling, not just restarting: a unit that was only ever restarted does not
# come back after a reboot. Idempotent, and run every time so a unit that was
# stopped or never enabled comes up even when its bytes did not change.
for unit in UNITS_TO_ENABLE; do
  systemctl enable --now "$unit" >/dev/null 2>&1 || true
done

# Set when reverting: the previous version has already been verified, and
# re-running the check from inside a revert risks a loop.
[ -n "$TL_SKIP_VERIFY" ] && exit 0

# Restart what changed and verify. A failed verify does NOT revert from here:
# dpkg still holds its lock, so a nested apt-get would deadlock. tl-apply arms a
# oneshot unit instead, which runs once dpkg has released the transaction.
/usr/lib/terminal-lobby/tl-apply apply
`

// ConffilesContent is DEBIAN/conffiles: the paths dpkg must treat as
// configuration. Marking a File as a conffile in the manifest is only half of
// it — dpkg reads this list, and a path absent from it is overwritten on every
// upgrade regardless of what the manifest says.
//
// LocalConfigPath is deliberately not here. postinst writes it, and a conffile
// written by a maintainer script shows up as locally modified on every later
// upgrade, which is the prompt the two-file split exists to avoid.
func ConffilesContent() string {
	var b strings.Builder
	for _, f := range Package.Files {
		if f.Conffile {
			b.WriteString(f.Dest)
			b.WriteString("\n")
		}
	}
	return b.String()
}
