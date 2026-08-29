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

check "the sudo grant ships read-only to root and its group" \
  "$(printf '%s' "$contents" | grep 'etc/sudoers.d/ttyd-users' | awk '{print $1}')" "-r--r-----"

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

check "the stamp endpoints ship (the healer polls them)" \
  "$(printf '%s' "$contents" | grep -cE 'usr/local/share/ttyd/(build-id|term-build-id)$' || true)" 2

check "the PWA surface ships" \
  "$(printf '%s' "$contents" | grep -cE 'usr/local/share/ttyd/(sw\.js|manifest\.webmanifest|icon-192\.png|icon-512\.png|icon-512-maskable\.png)$' || true)" 5

check "the six webfonts ship" \
  "$(printf '%s' "$contents" | grep -c 'usr/local/share/ttyd/fonts/.*\.woff2$' || true)" 6

# The lobby resolves the terminal page by content hash; a missing hashed copy
# 404s every attach.
check "the content-hashed terminal page is in the payload" \
  "$(printf '%s' "$contents" | grep -cE 'usr/share/terminal-lobby/assets/term-[0-9a-f]{12}\.html$' || true)" 1

check "the revert unit ships (the brake runs outside the dpkg transaction)" \
  "$(printf '%s' "$contents" | grep -c 'terminal-lobby-revert.service' || true)" 1

# libwebsockets is deliberately NOT here: it belongs to ttyd-devvm, which links
# it. A package should declare what its own contents need and nothing else.
for dep in ttyd-devvm viu tmux acl sudo; do
  check "declares a dependency on $dep" \
    "$(dpkg-deb -f "$DEB" Depends | grep -c "\\b$dep\\b" || true)" 1
done

check "the package's own tooling ships" \
  "$(printf '%s' "$contents" | grep -c 'usr/lib/terminal-lobby/tl-apply' || true)" 1

# A stray file is how a package quietly takes ownership of something it should
# not. The count moves deliberately, with the manifest.
echo "  info $(printf '%s' "$contents" | grep -c '^-') files in the package"

[ "$fail" -eq 0 ] || { echo "package verification FAILED"; exit 1; }
echo "package verification passed"
