# Deployment

How a change reaches the box. Nothing here is run by hand.

A push to master builds a Debian package and the box installs it. That is the
whole mechanism, and it replaced three hand-run scripts on 2026-08-29. The
reasoning is in [adr/0013-the-box-installs-the-lobby-nobody-ships-it.md](adr/0013-the-box-installs-the-lobby-nobody-ships-it.md).

```mermaid
sequenceDiagram
  participant D as developer
  participant G as GitHub Actions
  participant F as Forgejo registry
  participant W as Woodpecker
  participant B as the box
  D->>G: push to master
  G->>G: svu cuts the version, build the .deb
  G->>F: publish the package
  G->>W: POST /pipelines
  W->>B: ssh, forced command
  B->>F: apt-get install terminal-lobby
  B->>B: postinst restarts what changed, verifies
  Note over B: failure → reinstall the cached previous .deb, apt-mark hold
```

## What each piece does

**GitHub Actions** builds. CI compute is external by ADR-0002, so nothing is
built in the cluster. `svu` derives the version from conventional commits, so a
`feat:` bumps the minor and a `fix:` the patch.

**The Forgejo Debian registry** distributes. It serves its index and signing key
anonymously, so the box needs no apt credential. GitHub releases carry the same
package as an off-site copy, which is what to reach for if the cluster is down.

**Woodpecker** carries the trigger and nothing else. Runners cannot route to the
box, and Woodpecker is deploy-only by ADR-0002.

**`tl-reconcile`** is the only command the deploy key may run. It takes no
arguments and ignores `SSH_ORIGINAL_COMMAND`: a forced command still receives
whatever the client asked for, and acting on it would hand back the freedom the
forced command exists to remove. It holds a lock so two pushes cannot interleave
inside dpkg, refreshes only this project's apt source, and reports every unit's
state.

**`postinst`** restarts only the units whose files changed, verifies them, and on
failure reinstalls the cached previous package and `apt-mark hold`s it.

## Versions and rollback

The box tracks whatever the registry publishes as latest. There is no version
pin, so **rollback is fix-forward**: publish a higher version. A hand-run
downgrade is undone by the next push.

## Setting it up on a new box

Two pieces are not in the package, because both need root and neither belongs in
a repository.

The apt source, from `devvm/terminal-lobby.sources.template`:

```sh
sudo install -m 0644 devvm/terminal-lobby.sources.template \
  /etc/apt/sources.list.d/terminal-lobby.list
sudo curl -fsSL -o /etc/apt/keyrings/forgejo-viktor.asc \
  https://forgejo.viktorbarzin.me/api/packages/viktor/debian/repository.key
```

And the forced command, in root's `authorized_keys`:

```
command="/usr/local/bin/tl-reconcile",no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,restrict ssh-ed25519 AAAA... woodpecker-deploy
```

The public half of `secret/woodpecker/devvm_ssh_key` is the key to install. Every
restriction there matters: without `command=` the key is a root shell.

## Stopping a deploy

```sh
gh variable set TL_DEPLOY_ENABLED --body false --repo ViktorBarzin/terminal-lobby
```

The build and publish still run; only the trigger stops. Unset it or set it to
anything else to resume.

## Watching one

```sh
gh run list --repo ViktorBarzin/terminal-lobby --workflow=release --limit 1
homelab logs query '{unit="ttyd"}' --since 15m
```

## The container

The single-user image is built and published by `.github/workflows/container.yml`,
which smoke-tests it before pushing, so a broken image is never published. It is
for people running terminal-lobby elsewhere; this box installs the package.

## What used to be here

`deploy.sh`, `deploy-v2.sh` and `deploy-services.sh`, 929 lines that
cross-built, SCPed to `/tmp`, installed under sudo and smoke-tested. They were
hardened against a real incident where a deploy from a stale worktree reinstated
an older lobby. The package pipeline removes that class of problem rather than
guarding against it: the box has exactly one writer, holding dpkg's lock. They
are in git history if the detail is ever wanted.
