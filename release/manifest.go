package release

import "os"

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
	AssetPayload: "/usr/share/terminal-lobby/assets",
	External:     []string{"/usr/local/bin/ttyd"},
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
		{Src: "devvm/clipboard-store-clean", Dest: "/usr/local/bin/clipboard-store-clean", Mode: 0o755, Unmanaged: true},

		{Src: "share/index.html", Dest: "/usr/local/share/ttyd/index.html", Mode: 0o644},
		{Src: "share/term.html", Dest: "/usr/local/share/ttyd/term.html", Mode: 0o644},

		{Src: "devvm/ttyd.service", Dest: "/etc/systemd/system/ttyd.service", Mode: 0o644},
		{Src: "devvm/tmux-api.service", Dest: "/etc/systemd/system/tmux-api.service", Mode: 0o644},
		{Src: "devvm/clipboard-upload.service", Dest: "/etc/systemd/system/clipboard-upload.service", Mode: 0o644},
		{Src: "devvm/session-events.service", Dest: "/etc/systemd/system/session-events.service", Mode: 0o644},
		{Src: "devvm/file-api.service", Dest: "/etc/systemd/system/file-api.service", Mode: 0o644},
		{Src: "devvm/skills-api.service", Dest: "/etc/systemd/system/skills-api.service", Mode: 0o644},
		{Src: "devvm/clipboard-cleanup.service", Dest: "/etc/systemd/system/clipboard-cleanup.service", Mode: 0o644},
		{Src: "devvm/clipboard-cleanup.timer", Dest: "/etc/systemd/system/clipboard-cleanup.timer", Mode: 0o644},
		{Src: "devvm/tl-t3-sync@.service", Dest: "/etc/systemd/system/tl-t3-sync@.service", Mode: 0o644},

		// The grant every attach depends on. visudo -cf gates it, because a
		// malformed grant locks every user out of every session.
		{Src: "devvm/sudoers.d-ttyd-users", Dest: "/etc/sudoers.d/ttyd-users", Mode: 0o440, Validate: true},
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
		{Name: "tl-t3-sync@", Template: true, Files: []string{
			"/usr/local/bin/tl-t3-sync",
			"/etc/systemd/system/tl-t3-sync@.service",
		}},
	},
}
