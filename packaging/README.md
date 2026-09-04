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
be monotonic because the box tracks latest with no pin.

Monotonic under **dpkg's** ordering, which is stricter than it looks.
`ttyd-devvm` was versioned `1.7.7+<short sha>`, and that scheme does not sort: a
version is split into alternating non-digit and digit runs, the non-digit run is
compared first, and end-of-string sorts below a letter. So `1.7.7+02cbf4b` is
*below* `1.7.7+c76b116`, and once c76b116 was published every later build whose
sha began with a digit was unreachable. Measured on 2026-09-04, four were:
`apt-cache policy` named c76b116 as the candidate while the sixel-less binary
sat in the same registry.

The scheme is now `1.7.7+git<commit date>.<sha>`, Debian's snapshot convention.
`git` beats every hex lead on the first non-digit run, which clears the ceiling,
and the date that follows is compared numerically, so a commit from a later
minute sorts higher whatever its sha is. The date comes from the commit rather
than the clock, so one commit still yields one version. An epoch
(`1:1.7.7+...`) was the alternative and does less: it lifts the whole package
above the ceiling but leaves the ordering inside the epoch just as unsortable,
so it would need a sortable suffix anyway, and then the epoch is a prefix every
later version has to carry. `dpkg --compare-versions A gt B` is the check.

Two things about the bootstrap, both learned by running it rather than by
reading: `svu` does **not** skip a non-semver tag — given this repo's
`v-vanilla-final` it stops with "invalid semantic version" — so the workflow
passes `--tag.pattern 'v[0-9]*'`. With that pattern and no semver tags yet it
has no baseline to count from, so the workflow names the first release `v0.1.0`
explicitly and lets `svu` take over from the second.

## What "deployed version" means

The box tracks latest with no pin, so a trigger means "go and see what the
source offers". The `VERSION` the pipeline passes through is a label for the
audit log, not an instruction: if two releases land close together, one trigger
can install the newer and the next finds nothing to do. `dpkg-query -W
terminal-lobby` on the box is the authority on what is actually installed.

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

A `ttyd-devvm` upgrade is the one restart that does not come from this package:
its own `postinst` restarts `ttyd`, at the same cost as the row below.
`tl-reconcile` installs both packages, so that restart lands in the same
reconcile as a lobby upgrade.

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

## Re-running a release

`ttyd-devvm` and `viu` derive their versions from their inputs, so re-running
either on an unchanged commit re-uploads an identical artefact and the registry
answers 409. Both treat that as "already published"; any other status still
fails the job. `ttyd-devvm`'s inputs are the upstream tag plus the commit's own
date and sha, and `--date=format:` renders the offset stored in the commit
object, so the version does not move with the builder's timezone either.

The main release is different, and deliberately not made idempotent: re-running
it on a commit that already released will fail at the tag push, because the tag
exists. That is the honest outcome — a released version is a released version.
To ship again, merge a commit and let `svu` cut the next one.

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
