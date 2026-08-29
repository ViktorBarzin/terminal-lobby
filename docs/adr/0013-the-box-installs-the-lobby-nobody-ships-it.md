# The box installs the lobby; nobody ships it

Viktor, 2026-08-29: *"right now it's outside of the cluster and terraform and I
feel the builds are not reproducible and the env is only one time setup."*

Terminal Lobby reaches the devvm by three hand-run scripts — `deploy.sh`,
`deploy-v2.sh`, `deploy-services.sh`. Each cross-builds on whichever machine the
operator runs them on, `scp`s to `/tmp`, `sudo install`s, reloads systemd and
smoke-tests. They are careful scripts: they install only changed bytes, restart
only what moved, keep `.prev` copies for rollback, and `deploy.sh` refuses to
write `index.html` because doing so *"would silently undo that promotion on the
next backend deploy, which is the one way a cutover quietly reverts itself."*

That guard is a hand-maintained single-writer rule protecting one file, in a
system where any workstation may write any file at any time.

## What we decided

**Terminal Lobby becomes a Debian package that the box installs.** GitHub Actions
builds it off-infra (ADR-0002), `svu` cuts the semver version from conventional
commits, the `.deb` lands in Forgejo's Debian registry, and a push — GHA to the
Woodpecker API to one SSH forced command — tells the box to upgrade. The box
tracks latest; there is no version pin. `postinst` installs changed files,
restarts only changed units, runs the smoke tests the scripts run today, and on
failure reinstalls the cached previous `.deb` and holds the package.

`ttyd-devvm` (the locally-patched build) and `viu` become their own packages, so
CI's hot path does not rebuild a C program and a Rust binary on every lobby
commit. Everything else — the seven Go binaries, the SPA, `term.html`, the devvm helper
scripts, the units, `sudoers.d/ttyd-users` — is one package, at one version.

Design, phases and open questions:
`docs/plans/2026-08-29-iac-native-deployment-design.md`.

## Why one package, when the scripts are three

The three-way split exists to bound restarts, and that is worth keeping: a
needless `session-events` restart drops every Text-view client's SSE stream, and
a needless `ttyd` restart drops every attached terminal's WebSocket. But bounding
restarts does not require separate versions, and separate versions cost
something real.

On the night this was designed, two sessions deploying minutes apart left the box
with a new `term.html`, a rolled-back `index.html` and an unreferenced 319-file
`assets/` directory. Restart-if-changed inside one package keeps the restart
property; one version makes that skew unreachable.

## Why push the trigger and pull the bytes

GitHub Actions runners cannot route to `10.0.10.10`, so any push needs a hop
through something of ours. Woodpecker is already deploy-only by ADR-0002, already
activated on the infra repo, and `secret/woodpecker/devvm_ssh_key` was already
provisioned for the deploy that never got activated. The key is restricted to a
single forced command; it can start a reconcile and nothing else. The package
bytes still travel the ordinary apt path, so `dpkg -l` and `apt-cache policy`
keep telling the truth about what is installed.

## Considered and not chosen

- **Move the services into the cluster.** Rejected: **Share**, **Lens** and
  `skills-api`'s cross-user install all work because every user is a uid on one
  kernel and the services `sudo -u` between them. Across pods those need a
  network protocol. That is a rewrite, not a deployment change. Gitpod's 2024
  move away from Kubernetes for dev environments, and Coder's finding that 44% of
  their users pick VMs, both point the same way for stateful workspaces.
- **A committed version pin, auto-promoted by CI.** Rejected in favour of
  tracking latest. The consequence is accepted and written down: rollback is
  fix-forward, because a hand-run downgrade is undone by the next push. The
  automatic hold on a failed verify is the brake.
- **An OCI artifact on ghcr, extracted on the box.** A stronger provenance story —
  immutable digests, and it survives homelab loss. Rejected because it keeps the
  bespoke install logic that the `.deb` replaces, and declares no dependencies:
  `viu`, `libwebsockets` and the patched `ttyd` would remain a hand-run
  `cargo install` — documented in README, installed by nothing.
- **Bit-identical reproducible builds.** Viktor's call: install dependencies at
  latest in a clean CI environment, no pin machinery. It holds because artifacts
  are versioned and immutable — you never rebuild `1.4.2`. `ttyd` keeps its
  upstream pin because it is a patch target, not a dependency.

## Consequences

- Deploying stops being an action and becomes a merge. The box has one writer;
  concurrent deploys become commits that git serialises.
- `deploy.sh`, `deploy-v2.sh` and `deploy-services.sh` are deleted, and with them
  the ability to ship uncommitted edits. Local iteration is `scripts/devserve`
  and `dev-harness.py`.
- ADR-0007's stamps move from deploy time to build time, carrying ADR-0008's
  constraint with them: each surface's fingerprint hashes its own source
  concatenated with `frontend/diag.js`, or a `diag.js`-only fix would never reach
  an open tab. `deploy.sh`'s two assertions about `diag.js` — that it lands inside
  an open `<script>` block, and contains no literal script tag — become CI tests.
- The package's `Depends:` becomes the record of what the host needs, which is
  what retires "the env is a one-time setup" for this repo's footprint. The rest
  of the host follows in the Ansible phase.
- `/etc/ttyd-user-map` and `/etc/ttyd-admins` stay generated from `roster.yaml`
  and are deliberately not package files.
- Upgrades land at moments nobody chose, `emo`'s mid-turn included. Bounded by
  restart-if-changed; tmux sessions survive, browsers reconnect.
