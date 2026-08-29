# Releasing Terminal Lobby

The box installs the lobby; nobody ships it. A merge to master becomes the
running version without anyone running anything.

Design: `docs/plans/2026-08-29-iac-native-deployment-design.md` ·
decision record: `docs/adr/0013-the-box-installs-the-lobby-nobody-ships-it.md` ·
spec: ViktorBarzin/infra#87.

## The path a commit takes

```
merge to master
  → GitHub Actions (.github/workflows/release.yml)
      svu cuts vX.Y.Z from the conventional commits, tags canonical Forgejo
      builds the Go services, the lobby, and stamps both surfaces
      packaging/build-deb.sh → packaging/verify-deb.sh
      publishes to Forgejo's Debian registry + a GitHub release
      POSTs Woodpecker
  → Woodpecker (infra .woodpecker/terminal-lobby-deploy.yml)
      refreshes the apt credential from Vault
      ssh devvm-deploy@192.0.2.10   (forced command, nothing else)
  → devvm (/usr/local/sbin/devvm-apply)
      apt-get update from ONE source, apt-get install terminal-lobby
  → dpkg
      preinst  → tl-apply snapshot   (what is installed, before it is replaced)
      postinst → validate sudoers, install chunks additively, daemon-reload,
                 tl-apply apply → restart what changed, verify, keep or revert
```

## What lives where

| Piece | Where | Why there |
|---|---|---|
| Every decision | the `release` Go package | One seam, one test suite. The wrappers hold no logic. |
| Surface identities | `tl-stamp`, at build time | The identity a client compares is fixed when the artefact is built. |
| Package layout | `tl-pkg`, from the manifest | Generated, not restated, so the ship list and the watch list cannot drift. |
| Box behaviour | `tl-apply`, from the manifest | Same manifest both sides. |
| Package shape assertions | `packaging/verify-deb.sh` | What the package *owns* decides what dpkg deletes next upgrade. |

## Versions

`svu` computes the next semver from conventional commit messages. Versions must
be monotonic because the box tracks latest with no pin. The repository's one
pre-existing tag is not semver, so `svu` does not see it and the first release
is `v0.1.0`.

## Rolling back

**The normal way back is forward.** Revert the commit and let the next release
carry the working code at a higher version. With no pin, a hand-run
`apt install terminal-lobby=<older>` is undone by the next trigger.

**The emergency brake is automatic.** A failed verify makes the box reinstall
the previous package from apt's cache and `apt-mark hold` it. While held,
`devvm-apply` refuses to upgrade and exits 75, so a subsequent trigger cannot
re-break the box. Clearing it is deliberate:

```sh
apt-mark unhold terminal-lobby
```

## What restarts, and what that costs

A unit restarts only when its own bytes changed. This is the rule the three
deploy scripts hand-maintained, now enforced from the manifest.

| Unit | Restarting it costs |
|---|---|
| `ttyd` | every attached terminal's WebSocket (tmux sessions survive; browsers reconnect) |
| `session-events` | every Text-view client's open SSE stream |
| `tmux-api` | about a second of API gap, which the sidebar's poll rides out |
| `clipboard-upload` | in-flight uploads and asset requests |
| `file-api`, `skills-api` | in-flight requests to the file preview and the Skills overlay |
| `tl-t3-sync@<user>` | that user's T3 thread mirroring only |

The lobby's content-hashed chunks are installed **additively** and pruned by
age, never owned by dpkg: a tab on the previous build still requests the old
names, and so does a rollback.

## Building locally

CI is the only thing that installs on the box — there is no local deploy path by
design. Building locally is for inspecting what CI would produce:

```sh
./packaging/build-deb.sh 0.0.0-dev
./packaging/verify-deb.sh out/terminal-lobby_0.0.0-dev_amd64.deb
dpkg-deb -c out/terminal-lobby_0.0.0-dev_amd64.deb
```

## Checking the port against what it replaced

`tl-stamp` reproduces the deploy scripts' sed pipeline exactly. Worth re-running
if either side changes, because a divergence would silently invalidate every
open tab at the cutover:

```sh
sed -e '/__TL_DIAG__/{r frontend/diag.js' -e 'd;}' frontend/term.html | sha256sum | cut -c1-12
sed -e '/__TL_DIAG__/{r frontend/diag.js' -e 'd;}' frontend-v2/index.html | sha256sum | cut -c1-12
```

must equal the `term_asset` and `lobby_asset` in `tl-stamp`'s `stamps.json`.
Verified identical on 2026-08-29 against the real 58 KB `diag.js`.

## Before the trigger can be switched on

Three things need confirming, and none of them are confirmed yet:

1. **The apt credential.** Root on the devvm has no unattended Vault access, so
   the deploy pipeline installs the read-only token into `/etc/apt/auth.conf.d`
   on every deploy. That needs a Vault path (`secret/terminal-lobby/apt`), a
   read-only Forgejo token in it, and the second forced-command account that
   accepts it.
2. **`secret/woodpecker/devvm_ssh_key`.** Recorded in README as provisioned. It
   should be confirmed to exist and to be a key we are willing to restrict.
3. **Woodpecker pods reaching TCP 22 on the box.** Pod-to-box routing works for
   the lobby's own ports, and the box runs no host firewall, but nothing has
   been observed crossing to 22 specifically.
