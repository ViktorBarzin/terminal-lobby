# Multi-user: sharing, projects and per-user setup

How several people share one box: shares, project membership, and what an
operator adds for a new account. Single-user installs need none of this.

## Sharing (multi-user)

Projects and sessions can be **shared with other users on the same machine**
(the OS users behind each Authentik identity in `/etc/ttyd-user-map`).

- **Projects are first-class, multi-owner workspaces.** A project has a name, an
  optional directory, a member set, a session-attach mode, and a co-ownership
  flag; edit them all from **Project settings…** on the project `⋯` menu.
  Governance is co-equal — any member may rename, re-dir, add/remove members, or
  delete it (delete only dissolves the grouping, never kills sessions). Members
  see each other's sessions in the shared project.
- **Share a single session** from its `⋯` menu → **Share…**, read-only or
  read-write. A shared session is attached *as its owner*: read-only (`tmux
  attach -r`) lets a guest **watch**; read-write is a **full interactive shell
  as the owner** — so it is gated behind an extra confirm and is a deliberate
  trust grant. Revoking (or the guest leaving) detaches their live client
  immediately.
- **Filesystem co-ownership.** Enabling co-ownership on a project with a
  directory grants every member POSIX-ACL `rwX` on that tree (via an audited,
  root-run `setfacl` wrapper), so members can work on the shared files from
  their own sessions. Removed on unshare/leave. Trust-based: you choose what to
  share (a directory strictly under your home, never `~` itself).

The store is server-side (`GET`/`POST /projects`, `/shares`, …), so shares roam
across your devices. Design + security model: `docs/plans/2026-07-17-shared-multiuser-projects-and-sessions.md`.

### Act as another user (admins)

An administrator can work as another mapped user without asking them to share
anything — the way to see what is happening on a shared box. Pick them under
**Act as user** on the ⚙ Settings rail (admins only); the tab reloads at
`?as=<osUser>` and becomes
their lobby: their sessions, layout, projects, prefs, files and gallery. Per tab,
so another tab stays you.

- **The lens watches, it does not drive.** Every session a switched tab opens
  attaches read-only — including one a third party shared with the target
  read-write, since that grant is theirs. The Watch control in the session bar
  shows it and names who you are acting as; the sidebar's `Attach as` menu is
  fixed at *Watch only*; Paste, Upload and the pty writes go with them. A
  switched tab also cannot START a session in their account: a session that is
  not running there has nothing to watch, and the attach says so rather than
  creating one. To take control, leave the lens — ask the owner for a read-write
  share, or `sudo -u <user> tmux attach` from a shell.

- **Who is an admin** comes from `/etc/ttyd-admins`, which the hourly
  workstation reconcile derives from `roster.yaml`'s `tier: admin` alongside
  `/etc/ttyd-user-map`. Authentik groups cannot answer it: every devvm user is
  in *Home Server Admins*, which is what gets them to this host at all. No
  file means no admins, so the feature is unavailable rather than open.
- **Enforced in each service** (`tmux-api`, `file-api`, `clipboard-upload`,
  `session-events`) through one shared gate, `authuser`. The caller comes from
  the Authentik header Traefik sets; the target must already be a mapped
  account. Anyone else sending `?as=` gets a 403 and a log line.
- **Two carve-outs.** Push subscriptions and the push test button resolve the
  real caller, so an as-*user* tab cannot enrol your browser as one of their
  devices. And `session-events` answers **501** rather than ignoring the
  parameter — its cross-user transcript reader is not built yet, and serving
  your own transcripts under their name would be worse than refusing. The Text
  view is therefore unavailable while switched.
- **A switched tab looks different**: an amber frame and tinted bars (fixed
  across all nine themes) plus a chip naming the user, which returns you in one
  click. With a full identity switch there is no server-side difference between
  you and them, so this is what separates a deliberate action from typing into
  the wrong tab.
- **Every switch is recorded** — a journal line plus an `admin.actas` telemetry
  event carrying the real caller, the target, whether it came from a page load or
  a session attach, and (for an attach) the mode it resolved to. The mode is
  named in words in the journal, so `DRIVING (read-write)` is greppable on its
  own: enforcement of watch-only is client-side, which makes the audit trail the
  thing that answers "did anyone type in their session".

Design: `docs/plans/2026-08-16-admin-act-as-user-design.md`.

## Per-user setup

**The identity map lives in one place, and it is not this repo.**
`infra/scripts/workstation/roster.yaml` is the source of truth for who exists
(`os_user` → `authentik_user` / `k8s_user` / `tier`); `roster_engine.py` derives
`/etc/ttyd-user-map` and `/etc/ttyd-admins` from it and the hourly
`t3-provision-users` reconcile installs them, alongside creating the OS account.
Every service here reads that map and none of them write it. This repo carried a
second copy at `devvm/ttyd-user-map` until 2026-08-17, installed on every
`deploy.sh`; it had drifted from the roster, so it was removed rather than
re-synced. Do not add it back — a user added to a file here would not exist to
`t3-dispatch`, and a user removed from the roster would come back on the next
deploy.

Adding a new user:

1. **Add them to `roster.yaml`** in the infra repo and let the reconcile run (or
   run whatever provisioning script owns the roster on your box). That
   creates the account and regenerates the map and the admin list.
2. **Append their sudo grant** to `devvm/sudoers.d-ttyd-users` here — one
   `<service_user> ALL=(os_user) NOPASSWD: …` line, copying an existing user's binary
   list — and deploy. This step is deliberately by hand and deliberately
   separate: the roster says who exists, this file says what may be run as them.
   **A roster entry alone is not enough.** Without the grant the user reaches the
   lobby and sees their sidebar, but every attach fails, because `tmux-attach.sh`
   cannot `sudo -u` into their account.
3. (Optional) Copy `devvm/start-claude.sh` into the user's home and reference it from their `~/.tmux.conf` via `set -g default-command "$HOME/start-claude.sh"`.

The K8s + Terraform side (services, endpoints, ingress, Traefik
middlewares) lives in the `infra` repo at `infra/stacks/terminal/`.
The DNS record, TLS secret, and Authentik forward-auth integration
all come from there — this repo only owns the application code and
the DevVM-side artefacts that the application binds to.

## Declaring users without a roster

On a box with no roster, declare everyone in one file and let the tool render
what the services read:

```sh
sudo cp /usr/share/terminal-lobby/terminal-lobby.users.template /etc/terminal-lobby.users
sudo $EDITOR /etc/terminal-lobby.users     # <identity> = <os_user>, one per line
sudo useradd -m bob                        # tl-users does not create accounts
sudo tl-users check                        # show what would be written
sudo tl-users apply                        # write both files
sudo systemctl restart ttyd tmux-api file-api session-events skills-api
```

`apply` renders `/etc/ttyd-user-map` and `/etc/sudoers.d/ttyd-users` from that
one declaration, so the two cannot drift apart. It validates the grant with
`visudo` before installing anything, and writes both files atomically: an
invalid sudoers file is not a degraded feature, it breaks every `sudo` call on
the box including the one needed to repair it.

On a box where a roster owns those files, `apply` refuses. It reads the header
of the files themselves rather than probing for a roster, so it works on a
machine that has never heard of this homelab. `-force` overrides, and should be
needed only if the roster is genuinely gone.

Single-user installs need none of this: one account needs no map and no sudo.

## Why the package does not ship the sudo grant

`/etc/sudoers.d/ttyd-users` is per-box identity data: it names the accounts the
service may become. The roster owns that, the same way it owns
`/etc/ttyd-user-map`, which stopped shipping on 2026-08-17 for drifting.

A drifted copy of a sudo grant fails worse than a stale map. Installing one does
not merely miss a new user, it **revokes** every user the copy has forgotten, and
their terminals stop attaching. That nearly shipped on 2026-08-29: a history
scrub replaced the real accounts with placeholder names while the package was
still installing the file.

`devvm/sudoers.d-ttyd-users.template` is the reference. `postinst` still runs
`visudo -cf` against the live file and refuses the install if it is malformed, so
the safety check survives on a file the package no longer writes.

Both generators are the answer to the same question. On this homelab
`roster.yaml` derives the grant, alongside the identity map and the admin list it
already produced — one writer, reconciled hourly, with offboarding for free.
Everywhere else `tl-users` renders it from a local declaration. Neither ships
content in the package.
