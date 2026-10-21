#!/usr/bin/env bash
# Assert the built package's shape. These are the properties that are cheap to
# break and expensive to notice: they are about what the package OWNS, which is
# what decides what dpkg deletes on the next upgrade.
#
#   ./packaging/verify-deb.sh out/terminal-lobby_0.1.0_amd64.deb
set -euo pipefail

DEB="${1:?usage: verify-deb.sh <package.deb>}"
fail=0
check() { # check <description> <actual> <expected>
  if [ "$2" = "$3" ]; then printf '  ok   %s\n' "$1"
  else printf '  FAIL %s (got %s, want %s)\n' "$1" "$2" "$3"; fail=1; fi
}

contents="$(dpkg-deb -c "$DEB")"
ctrl="$(dpkg-deb --ctrl-tarfile "$DEB" | tar t)"

echo "verifying $DEB"

# dpkg removes files a new version stops shipping. The lobby's chunks are
# content-hashed and a tab on the previous build still requests the old names,
# as does a rollback -- so the served directory must not be package-owned.
# The trailing $ here used to anchor after a single character class, so this
# matched only one-character filenames and could never see a real chunk name.
check "no dpkg-owned files in the served asset dir" \
  "$(printf '%s' "$contents" | grep -c '^-.*usr/local/share/ttyd/assets/.' || true)" 0

# A real build carries dozens of chunks, so this asserts "at least one file",
# not an exact count -- and counts files rather than the directory entry.
chunks="$(printf '%s' "$contents" | grep -c '^-.*usr/share/terminal-lobby/assets/' || true)"
if [ "$chunks" -ge 1 ]; then printf '  ok   the chunks ship as payload (%s file(s))\n' "$chunks"
else printf '  FAIL no chunk files in the payload\n'; fail=1; fi

# The identity map and the admin list are generated from roster.yaml by the
# hourly reconcile and have exactly one writer. Packaging them makes a second.
check "the generated identity files are not shipped" \
  "$(printf '%s' "$contents" | grep -cE 'etc/ttyd-(user-map|admins)' || true)" 0

# The package must NOT carry the sudo grant. It is per-box identity data owned
# by the roster, and installing a drifted copy revokes the grants of every user
# it has forgotten. postinst validates the LIVE file instead.
check "the sudo grant is NOT shipped" \
  "$(printf '%s' "$contents" | grep -c 'etc/sudoers.d/ttyd-users' || true)" 0
check "no identity map is shipped" \
  "$(printf '%s' "$contents" | grep -c 'etc/ttyd-user-map' || true)" 0

check "preinst is present (without it, every release restarts everything)" \
  "$(printf '%s' "$ctrl" | grep -c '^./preinst$' || true)" 1
# Without this, dpkg replaces /etc/terminal-lobby.conf on every upgrade and an
# operator's header name or secret goes with it.
check "conffiles declares the config file" \
  "$(printf '%s' "$ctrl" | grep -c '^./conffiles$' || true)" 1
check "the config file is listed as a conffile" \
  "$(dpkg-deb --ctrl-tarfile "$DEB" | tar -xO ./conffiles 2>/dev/null | grep -c '^/etc/terminal-lobby.conf$' || true)" 1
check "the local override is NOT a conffile" \
  "$(dpkg-deb --ctrl-tarfile "$DEB" | tar -xO ./conffiles 2>/dev/null | grep -c '^/etc/terminal-lobby.local.conf$' || true)" 0

check "postinst is present" \
  "$(printf '%s' "$ctrl" | grep -c '^./postinst$' || true)" 1
# Without it, a revert to a version that binds 7685 itself finds pid 1 still
# holding the port, and session-events never starts (release.PostrmScript).
check "postrm is present (it lets go of the ports systemd holds on a downgrade)" \
  "$(printf '%s' "$ctrl" | grep -c '^./postrm$' || true)" 1
check "session-events' socket unit ships" \
  "$(printf '%s' "$contents" | grep -c '^-.*etc/systemd/system/session-events\.socket$' || true)" 1

check "the stamp endpoint ships (the healer polls it)" \
  "$(printf '%s' "$contents" | grep -cE 'usr/local/share/ttyd/build-id$' || true)" 1

# The Claude half of Agent spend has exactly one source: the CLI hands its own
# cost arithmetic to the statusLine command and to nothing else (ADR-0022).
# A package that omits the recorder still installs, still passes verify, and
# shows a panel that can never fill. The mode is part of the check because
# Claude Code execs it.
check "the spend recorder ships, executable" \
  "$(printf '%s' "$contents" | grep -c '^-rwxr-xr-x.*usr/local/bin/tl-usage-record$' || true)" 1

check "the PWA surface ships" \
  "$(printf '%s' "$contents" | grep -cE 'usr/local/share/ttyd/(sw\.js|manifest\.webmanifest|icon-192\.png|icon-512\.png|icon-512-maskable\.png)$' || true)" 5

check "the six webfonts ship" \
  "$(printf '%s' "$contents" | grep -c 'usr/local/share/ttyd/fonts/.*\.woff2$' || true)" 6

check "the revert unit ships (the brake runs outside the dpkg transaction)" \
  "$(printf '%s' "$contents" | grep -c 'terminal-lobby-revert.service' || true)" 1

# libwebsockets is deliberately NOT here: it belongs to ttyd-devvm, which links
# it. A package should declare what its own contents need and nothing else.
for dep in ttyd-devvm viu tmux acl sudo; do
  check "declares a dependency on $dep" \
    "$(dpkg-deb -f "$DEB" Depends | grep -c "\\b$dep\\b" || true)" 1
done

# tmux-user-attach reads it to tell a pre-warmed slot booted on an older mod
# from a current one. Missing, every slot reads current and keeps the old mod.
check "the Claude mod ships its build id" \
  "$(printf '%s' "$contents" | grep -c '^-.*usr/share/terminal-lobby/claude-plugins/plugins/terminal-lobby/\.mod-id$' || true)" 1

# The session browser (ADR-0035). Claude Code execs the launcher, the launcher
# runs node on host.mjs at a compiled-in path, and the host imports
# @playwright/mcp from the node_modules beside it. Any one missing leaves a
# package that installs clean and a browser that fails on its first call.
check "the browser launcher ships, executable" \
  "$(printf '%s' "$contents" | grep -c '^-rwxr-xr-x.*usr/local/bin/tl-browser$' || true)" 1
check "the browser host ships" \
  "$(printf '%s' "$contents" | grep -c '^-.*usr/lib/terminal-lobby/tl-browser-host/host\.mjs$' || true)" 1
# host.mjs imports lib/, and tl-browser hashes lib/ into its handshake cache key.
check "the browser host ships its lib" \
  "$(printf '%s' "$contents" | grep -c '^-.*usr/lib/terminal-lobby/tl-browser-host/lib/protocol\.mjs$' || true)" 1
check "the browser host carries playwright-mcp" \
  "$(printf '%s' "$contents" | grep -c '^-.*usr/lib/terminal-lobby/tl-browser-host/node_modules/@playwright/mcp/package\.json$' || true)" 1
check "the browser host ships without its tests" \
  "$(printf '%s' "$contents" | grep -c 'usr/lib/terminal-lobby/tl-browser-host/test/' || true)" 0
check "the browser slice ships as a user unit" \
  "$(printf '%s' "$contents" | grep -c '^-.*usr/lib/systemd/user/tl-browser\.slice$' || true)" 1
# Without the cap, a box-wide scope.d drop-in overrides the per-browser
# MemoryMax tl-browser asks for (devvm/tl-browser-scope-cap.conf says why).
check "the per-browser memory cap ships" \
  "$(printf '%s' "$contents" | grep -c '^-.*usr/lib/systemd/user/tl-browser-\.scope\.d/60-tl-browser-cap\.conf$' || true)" 1
check "the browser's runtime is recommended" \
  "$(dpkg-deb -f "$DEB" Recommends | grep -c 'nodejs' || true)" 1

# The T3 view (ADR-0044). The unit runs node on the bundle, and the bundle
# serves the web client from the directory beside it; either missing leaves a
# view that answers nothing or answers 404.
check "the T3 view's sidecar bundle ships" \
  "$(printf '%s' "$contents" | grep -c '^-.*usr/lib/terminal-lobby/tl-t3-view/tl-t3-view\.mjs$' || true)" 1
check "the T3 view's unit ships" \
  "$(printf '%s' "$contents" | grep -c '^-.*etc/systemd/system/tl-t3-view\.service$' || true)" 1
check "the T3 web client ships its page" \
  "$(printf '%s' "$contents" | grep -c '^-.*usr/lib/terminal-lobby/tl-t3-view/web/index\.html$' || true)" 1
check "the T3 web client says which pin and patch built it" \
  "$(printf '%s' "$contents" | grep -c '^-.*usr/lib/terminal-lobby/tl-t3-view/web/BUILD_KEY$' || true)" 1
t3assets="$(printf '%s' "$contents" | grep -c '^-.*usr/lib/terminal-lobby/tl-t3-view/web/assets/.*\.js$' || true)"
if [ "$t3assets" -ge 1 ]; then printf '  ok   the T3 web client ships its chunks (%s file(s))\n' "$t3assets"
else printf '  FAIL no T3 web chunks in the payload\n'; fail=1; fi
# The embed patch is what hides T3's own chrome and forwards the lobby's keys;
# an unpatched client renders a second sidebar inside the lobby.
t3x="$(mktemp -d)"
dpkg-deb -x "$DEB" "$t3x"
check "the T3 web client carries the embed patch" \
  "$(grep -lq 'tl-bindings' "$t3x"/usr/lib/terminal-lobby/tl-t3-view/web/assets/*.js 2>/dev/null && echo yes || echo no)" yes
rm -rf "$t3x"

# The hold alert's input (ADR-0045): a daily timer compares the pin the package
# was built from with T3 Code's latest stable release. Without the pin the
# check fails every day; without the timer it never runs.
check "the T3 pin ships beside the sidecar" \
  "$(printf '%s' "$contents" | grep -c '^-.*usr/lib/terminal-lobby/tl-t3-view/T3_PIN$' || true)" 1
check "the T3 upstream check ships, executable" \
  "$(printf '%s' "$contents" | grep -c '^-rwxr-xr-x.*usr/local/bin/tl-t3-upstream-check$' || true)" 1
check "the T3 upstream check's service and timer ship" \
  "$(printf '%s' "$contents" | grep -cE '^-.*etc/systemd/system/tl-t3-upstream-check\.(service|timer)$' || true)" 2

check "the package's own tooling ships" \
  "$(printf '%s' "$contents" | grep -c 'usr/lib/terminal-lobby/tl-apply' || true)" 1

# A stray file is how a package quietly takes ownership of something it should
# not. The count moves deliberately, with the manifest.
echo "  info $(printf '%s' "$contents" | grep -c '^-') files in the package"

[ "$fail" -eq 0 ] || { echo "package verification FAILED"; exit 1; }
echo "package verification passed"
