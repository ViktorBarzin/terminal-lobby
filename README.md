# terminal-lobby

Web tmux sessions, gated by Authentik, isolated per OS user. Lives at
`https://terminal.viktorbarzin.me/`.

The lobby is the SolidJS SPA in `frontend-v2/`, built to hashed chunks under
`/assets/` behind an `index.html` served by ttyd. The host is gated to the Home
Server Admins group.

Two things that used to be here are not any more. `terminal-dev.viktorbarzin.me`
ran the SPA as a canary beside the original vanilla page; it was retired on
2026-08-16 once the SPA became the daily driver. The vanilla page itself
(`frontend/index.html`) and the read-only tier (`terminal-ro.viktorbarzin.me`,
`ttyd-ro` :7682) were removed on 2026-08-29 — the SPA had been the only thing
deployed for a fortnight, and the read-only host had served no request in the
week before it went. Both are in git history if they are ever wanted back.

A sidebar lists the current user's tmux sessions — grouped into
collapsible **projects**, each session carrying a **Claude state dot**
(running / awaiting input / completed) — and the right pane is an
iframe that swaps between sessions on click. Direct-linked sessions
(`?arg=<name>` at the top level) bypass the lobby and render fullscreen
for bookmarks / CLI links.

![lobby with an active session, slate theme](docs/screenshots/lobby-active-session.png)

## Screenshots

<table>
  <tr>
    <td><img src="docs/screenshots/lobby-slate.png"  alt="Slate theme — default"></td>
    <td><img src="docs/screenshots/lobby-carbon.png" alt="Carbon theme — warm dark"></td>
  </tr>
  <tr>
    <td align="center"><sub>Slate (default) — cool dark, electric blue accent</sub></td>
    <td align="center"><sub>Carbon — warm dark, restrained amber</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/lobby-mono.png" alt="Mono theme — greyscale"></td>
    <td><img src="docs/screenshots/lobby-ink.png"  alt="Ink theme — warm paper light"></td>
  </tr>
  <tr>
    <td align="center"><sub>Mono — strict greyscale</sub></td>
    <td align="center"><sub>Ink — warm paper, terracotta accent</sub></td>
  </tr>
</table>

The `‹` toggle in the top of the sidebar collapses it for a fullscreen
terminal view; click `›` to bring it back. Choice persists per browser
(localStorage).

![sidebar collapsed — fullscreen terminal](docs/screenshots/sidebar-collapsed.png)

## Projects & session state

**Projects** are named folders that group sessions in the sidebar
(domain glossary: `CONTEXT.md`). Create one with **+ Project**; assign
sessions by dragging a card onto a project header, or via the card's
`⋯` menu (**Move to…**, which also holds Rename/Kill). Each project
header has a `+` (new session directly in the project) and a `⋯` menu
(move up / move down / rename / delete — deleting moves members to
**Ungrouped**, it never kills sessions). Drag any group header —
projects or the Ungrouped section itself — to reorder them; the `⋯`
move entries are the touch equivalent (Ungrouped's `⋯` has only
those). Sections collapse per browser; a collapsed header
shows its session count plus aggregated state dots. Membership and all
ordering live server-side per user (`GET`/`PUT /layout`), so the
arrangement follows you across desktop and phone and survives OOM
restores — see `docs/adr/0002-layout-store-in-tmux-api.md` for why
that beats tmux options or localStorage.

**Claude state dots** show what the Claude conversation inside each
session is doing: pulsing accent = *running* (turn in flight), amber =
*awaiting your input* (permission ask / question), green = *completed*
(turn done). No dot = no live Claude (plain shell, or Claude exited).
The browser tab title gains an `(N●)` badge while anything awaits
input. State comes from org-wide Claude Code hooks stamping
`@claude_state` on the tmux session (`devvm/claude-tmux-state`;
`docs/adr/0001-claude-state-via-hooks.md` — the pane title is a static
summary, so hooks it is). Claudes started before the hooks were
installed show no dot until their next restart/resume; worst-case
display lag is ~10 s (5 s API cache + 5 s poll).

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
**Act as user** in ⚙ Settings; the tab reloads at `?as=<osUser>` and becomes
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

## Keyboard shortcuts

Switch sessions and drive the lobby without the mouse. The shortcut layer
is **on by default** (per-browser; uncheck **App shortcuts** in ⚙ Settings
to send these keys to the terminal instead — the opt-out persists). Chords
are user-overridable via the `tl:keybindings:v1` localStorage key.

**Hold `Alt`** for ~100 ms to reveal numbered chips on the first ten
sidebar cards, then press the digit to jump (on macOS the UI shows `Alt`
as `Option` — the labels in the help overlay, tooltip and hint follow the
viewer's platform):

| Chord | Action |
|---|---|
| `Alt+1` … `Alt+9` | Attach the 1st–9th session (sidebar order) |
| `Alt+0` | Attach the 10th session |
| `Alt+Shift+[` / `Alt+Shift+]` | Cycle to the previous / next session |
| `Alt+Shift+Enter` | Jump to the next session **awaiting input** (amber dot) |
| `Alt+Shift+S` | Toggle the sidebar (fullscreen terminal ⇄ lobby) |
| `Alt+Shift+N` | New session (focus the name box) |
| `Alt+Shift+W` / `Alt+Shift+R` | Kill / rename the current session |
| `Alt+Shift+Backspace` | Kill the **attached** session — from anywhere, even mid-type (always on) |
| `Ctrl+Shift+K` | Command palette (fuzzy session + action search) |
| `Ctrl+J` / `Cmd+J` | Toggle a docked scratch shell (always on) |
| `/` or `?` / `Alt+/` | Show this shortcuts help (`Alt+/` works in a session too) |

Sessions past the tenth aren't digit-jumpable — cycle with
`Alt+Shift+[` / `]` or search with the palette. The chords work while
focus is inside the terminal too (the iframe forwards them up to the
lobby). **Alt**, not Cmd/Ctrl: the browser reserves `Cmd/Ctrl+digit` for
tab-switching and a page in a normal tab can't override them, whereas
`Alt+digit` is capturable everywhere.

`/` (or `?`) opens the shortcuts help from the lobby — it's a plain key,
so it only fires when the lobby chrome has focus (never while you're
typing in the terminal, where `/` belongs to the shell). Inside a session,
use **`Alt+/`** (`Option+/` on Mac) — a modifier chord, so it opens the
help from anywhere — or the `Ctrl+Shift+K` palette → **Keyboard shortcuts**.

**Backspace** / **Delete** kill the selected session straight from the
sidebar — select a session card (click it, or Tab/arrow to it) and press
Backspace or Delete (a confirm guards it). Like `/`, these are plain keys, so
they only fire when the sidebar has focus, never while you're typing in a
terminal. From inside a session — where those keys belong to the shell — use
`Alt+Shift+Backspace` (in the table above), which kills the attached session
from anywhere. Rename a session by **double-clicking** its name (single click
just selects), or from the card's `⋯` menu.

## Session image gallery

Every image pasted, uploaded, or drag-dropped into a session, and
every image rendered with `show-image`, persists under
`/var/lib/clipboard-store/<user>/<session>/` and is re-viewable from
the terminal view: the floating 🖼 button (next to Img/Paste) opens
an overlay grid — newest first, `show-image` renders badged "shown" —
and a thumbnail click enlarges in the usual lightbox (Escape/click
steps back to the grid). Images live as long as their session does
(live in tmux, or still in your saved sidebar layout) plus a 30-day
grace after it dies; *non-image* drops remain 7-day ephemera in
`/tmp` — they're transfer conveniences, not gallery content. Details
and trade-offs: `docs/adr/0005-session-image-store.md`.

## Components

| Piece | Where it runs | Port | Purpose |
|---|---|---|---|
| `frontend-v2/` (SolidJS + Vite) | Built to a single `index.html`, served by ttyd on the DevVM | 7681 | **The lobby.** Terminal is an iframe of `/term.html`; backends are tmux-api / clipboard / session-events / file-api. Build: `npm run build` (vite-plugin-singlefile → one inlined file) |
| `tmux-api/` (Go) | DevVM systemd service | 7684 | `GET /sessions` (incl. per-session `state` + `project`), `DELETE /sessions/<n>`, `POST /sessions/<n>/rename`, `GET /whoami`, `POST /restore` (blanket, or a `{snapshot, sessions[]}` body from the picker), `GET /snapshots` + `GET /snapshots/<ts>` (the session-snapshot series and one snapshot resolved against what is live), `GET`/`PUT /layout` (per-user sidebar layout, stored under `/var/lib/tmux-api/layout/`) |
| `clipboard-upload/` (Go) | DevVM systemd service | 7683 | Per-session attachment store (`/var/lib/clipboard-store/<user>/<session>/`): `POST /upload` persists pasted/uploaded/dropped images, and documents up to 25MB under a `file-` prefix, replying `{path, stored}` — `stored:false` means it stayed an ephemeral `/tmp/clipboard-files` transfer, which is what a document over the cap does. `POST /register` records `show-image` renders (localhost). `GET /list` serves the gallery and lists the `pasted-`/`displayed-` prefixes only, so a document is never drawn as a thumbnail; `GET /img/…` serves image bytes and refuses anything that does not sniff as an image; `GET /file/…` serves a stored document with sniffing disabled, forcing a download for anything that could execute as markup. Per-user isolation via `X-Authentik-Username` → `/etc/ttyd-user-map`, like tmux-api. See `docs/adr/0005-session-image-store.md` |
| `skills-api/` (Go) | DevVM systemd service | 7688 | **The skill manager's backend** — reached from the **Skills** overlay on the shell bar, beside Settings (`docs/adr/0011-skills-move-between-users-by-copy.md`). `GET /skills` answers the whole Settings group in one round trip — this account's skills and marketplace plugins, then every other terminal account's skills with a `same`/`differs`/`absent` verdict against your own — and `/skills/view` (a skill's `SKILL.md`, its file list and where it lives on disk), `/skills/edit` (write one of your OWN skill files back — no `owner` field, so a peer's skill cannot be written through it), `/skills/diff`, `/skills/install`, `/skills/toggle`, `/skills/remove` (keeps a backup), `/skills/delete` (permanent — the skill, its backups, its enabled state and its provenance), `/skills/plugin-update`, `/skills/plugin-uninstall`, `/skills/restart`, and `/skills/source/inspect` + `/skills/source/install` (bring a skill or plugin in from a GitHub repo — one read-only look, then that project's own installer run as the caller; `docs/adr/0012-installing-from-a-source-runs-its-installer-as-you.md`) do the rest. Unlike its siblings one request acts as TWO users: peer homes are `0700`, so an install packs the owner's skill in one privileged child (`sudo -n -u <user> skills-api -privop pack`) and unpacks it in the recipient's. Filesystem semantics live in `skillscan/` |
| `skillscan/` (Go) | Shared package | — | What a skill IS on disk: scan, inspect, hash, compare, diff, pack/unpack, backup, and the two bits of state the manager keeps — Claude Code's own `enabledPlugins` key in `settings.json`, and `.manager.json` beside the skills for provenance. The hash covers content, path and the executable bit only, because users here have different umasks and hashing the full mode would report every shared skill as divergent |
| `devvm/tmux-attach.sh` | DevVM, invoked by ttyd | — | Validates `X-authentik-username`, maps to OS user via `/etc/ttyd-user-map`, `sudo -u <user> tmux new-session -A` |
| `devvm/claude-tmux-state` | DevVM, invoked by Claude Code hooks | — | Stamps `@claude_state` (running / awaiting / done) on the enclosing tmux session; wired org-wide via `/etc/claude-code/managed-settings.json` (infra repo, `scripts/workstation/`, self-deploys hourly). No-ops outside tmux. See `docs/adr/0001-claude-state-via-hooks.md` |
| `devvm/tmux-restore-user` | DevVM, invoked by `tmux-api` via sudo (`POST /restore`, `GET /snapshots*`) | — | The tmux-persist gateway behind the Restore picker. Validates the user against `/etc/ttyd-user-map`, then runs one of `tmux-persist restore\|snapshots\|snapshot\|restore-selection`. The bare one-argument form still means "restore now". Snapshot ids and session names are re-validated here because the sudo grant places no restriction on argv. Idempotent — live sessions are left alone. Useful after an OOM kills sessions without a reboot (the boot-only restore never fires) |
| `devvm/show-image` | DevVM, `/usr/local/bin/show-image`, run inside sessions | — | Shows an image at the terminal. Inside tmux: temporary split pane running `viu` (sixel; Enter closes) — the reliable path for Claude/agents, whose captured stdout breaks bare `viu` — then fire-and-forgets a localhost `/register` so the image joins the session gallery. Outside tmux: plain `viu`. See "Showing images in sessions" |
| `devvm/ttyd.service`, `tmux-api.service`, `clipboard-upload.service` | DevVM | — | systemd units. `ttyd` :7681 serves the lobby. (`ttyd-v2` :7687 served the retired terminal-dev canary, removed 2026-08-16; `ttyd-ro` :7682 served the read-only host, removed 2026-08-29.) |
| `devvm/clipboard-cleanup.service` + `.timer` + `clipboard-store-clean` | DevVM | — | Daily retention sweep: store dirs live while their session does (live tmux or saved layout) + 30-day `.deleted-at` grace; `_unsorted` 90 d; `/tmp/clipboard-files` 7 d |
| `devvm/sudoers.d-ttyd-users` | `/etc/sudoers.d/ttyd-users` on DevVM | — | The per-user sudo grant every attach depends on. Hand-maintained here; validated with `visudo -cf` on install |
| *(not in this repo)* `/etc/ttyd-user-map`, `/etc/ttyd-admins` | `/etc/` on DevVM | — | The Authentik → OS-user mapping and the admin list, **generated** from `infra/scripts/workstation/roster.yaml` by the hourly `t3-provision-users` reconcile. Read by every service here; written by nothing here (see "Per-user setup") |
| `devvm/start-claude.sh` | Per-user, e.g. `/home/emo/` | — | Optional Claude-Code launcher invoked by tmux `default-command` |

## How a request flows

1. Browser hits `https://terminal.viktorbarzin.me/`.
2. Traefik forward-auth → Authentik → adds `X-authentik-username` header.
3. K8s ingress (in `infra/stacks/terminal/`) routes:
   - `/api/sessions/*` → `tmux-api` (port 7684 on the DevVM)
   - `/clipboard/*` → `clipboard-upload` (port 7683)
   - `/skills/*` → `skills-api` (port 7688)
   - everything else → `ttyd` (port 7681) which serves `index.html` + WebSocket
4. The browser preflights `/api/sessions/whoami` to discover its OS user, then either renders the lobby or opens a session iframe with `?arg=<name>`.
5. ttyd, on each WS connection, runs `tmux-attach.sh` with `X-authentik-username` in `$TTYD_USER`. The script `sudo`s into the mapped OS user and `exec tmux new-session -A -s <name>`. Each OS user has its own `/tmp/tmux-<uid>/default` socket — kernel-level isolation.
6. `tmux-api` reads the same `X-Authentik-Username` header on every API call and runs tmux under the mapped OS user, so users only see their own sessions.

## Deployment

**Being replaced** — see "CI and the release pipeline" below. What follows is
the deploy path in use until the package pipeline is switched on.

For now: **manual deploy**, from a workstation that can SSH
`wizard@10.0.10.10`. There are **three** scripts, split by blast radius — each
cross-builds what it owns, SCPs to `/tmp`, installs under `sudo`, runs
`daemon-reload`, and smoke-tests what it just shipped. Nothing is shipped by
two of them:

| Script | Ships | Restarts | Blast radius |
|---|---|---|---|
| `./scripts/deploy.sh` | PWA assets + webfonts, `tmux-api`, `clipboard-upload`, the patched `ttyd`, the devvm helper scripts + `/etc` config | `ttyd`, `tmux-api`, `clipboard-upload` | **Shared** — every user |
| `./scripts/deploy-v2.sh` | the lobby `index.html`, `term.html` | `ttyd` only | **Shared** — every user of the lobby |
| `./scripts/deploy-services.sh` | `session-events` (:7685), `file-api` (:7686), `skills-api` (:7688) + their units | those three only | the Text view, file preview + the Skills settings group |

```bash
./scripts/deploy.sh                      # full deploy
DEVVM=10.0.10.10 ./scripts/deploy.sh     # explicit host
SKIP_BUILD=1 ./scripts/deploy.sh         # reuse ./out/ binaries
```

`deploy.sh` cross-builds **`tmux-api` and `clipboard-upload`** (not every Go
service in the tree — `session-events` and `file-api` are
`deploy-services.sh`'s), ships the patched `ttyd` only if `out/ttyd` exists,
and smoke-tests `/whoami` + `/health` + the public assets.

### The lobby page (deploy-v2.sh)

| Host | ttyd | `-I` index | Deploy |
|---|---|---|---|
| `terminal.viktorbarzin.me` | `ttyd` :7681 | `index.html` (the SolidJS SPA) | `./scripts/deploy-v2.sh` |

> **Pull master before you deploy, and claim `service:ttyd` while you do.**
> Several agent sessions work this repo at once, each from its own worktree, and
> a deploy ships whatever *that* worktree's HEAD builds. On 2026-08-28 three
> deploys from stale worktrees put an older lobby back over a newer one — one of
> them shipping a placeholder verbatim, because the older script did not know
> that placeholder existed — and two runs in the same checkout collided in
> `frontend-v2/dist` mid-build.
>
> `deploy-v2.sh` now refuses both: it will not run while another session holds
> `service:ttyd` (`~/code/scripts/presence claim service:ttyd`), and it will not
> install a page whose commit is not an ancestor of the one already installed
> (recorded in `/usr/local/share/ttyd/lobby-build`). `TL_FORCE=1` overrides
> both, for a deliberate rollback. **A worktree that has not pulled runs its own
> older copy of this script and has neither check** — which is why pulling first
> is the actual protection.

`deploy-v2.sh` builds `frontend-v2` into `index.html` plus its hashed chunks and
**restarts only ttyd** — never a shared backend. It installs no
systemd unit: `ttyd.service` belongs to `deploy.sh` and its `ExecStart` already
points at `index.html`, so shipping the lobby swaps the *file*, not the unit.
That is what keeps the rollback a single `install` of `index.html.prev` plus a
restart (the command is printed at the end of every deploy).

`deploy.sh` deliberately does **not** install the lobby page — it ships the
shared backends and the PWA assets. Having it write `index.html` too would
silently revert whatever `deploy-v2.sh` last deployed.

It also installs **`term.html`**, the terminal-mode page the SPA frames
(`config.TERMINAL_BASE = "/term.html"`, emitted by the `copyTermHtml` plugin in
`frontend-v2/vite.config.ts`): that one file lands in the *shared* asset dir
`/usr/local/share/ttyd/`, where **clipboard-upload** serves it from its
exact-path whitelist — so no service is restarted for it.

Both artefacts are stamped independently (`__TL_BUILD__` = git SHA,
`__TL_ASSET__` = a fingerprint of the file's own bytes, ADR-0007) because each
runs the zero-touch self-update healer against its *own* identity. Two skips
keep repeated deploys cheap: `npm ci` is skipped while `package-lock.json`
hashes the same as the last install (stamp at
`frontend-v2/node_modules/.tl-lock-hash`), and the `ttyd` restart is skipped
when the installed artefacts were byte-identical — an unnecessary restart drops
every attached terminal's WebSocket. `enable --now` still runs either way, so a
stopped unit comes back up.

Every client attaches the SAME per-uid tmux server, so sessions, clipboard and
prefs are shared across them. Opening one session from two clients at once
makes tmux clamp to the smaller client's viewport (use different sessions, or
one client at a time).

The k8s routing (ingress + per-path routes to tmux-api / clipboard-upload /
session-events / file-api + the PWA carve-out) lives in
`infra/stacks/terminal/main.tf`; the Authentik admin-gate for the host is in
`infra/stacks/authentik/admin-services-restriction.tf` (`ADMIN_ONLY_HOSTS`).

```bash
./scripts/deploy-v2.sh                    # build frontend-v2 + deploy the lobby
SKIP_BUILD=1 ./scripts/deploy-v2.sh       # reuse frontend-v2/dist/{index,term}.html
```

### SPA-only backends (session-events + file-api + skills-api)

`session-events` (:7685, the Text view's SSE transcript stream + `/prompt` +
`/cancel`), `file-api` (:7686, the file preview/editor) and `skills-api` (:7688,
the Skills settings group) back the SPA. They were installed by hand until
`deploy-services.sh` gave them a release path:

```bash
./scripts/deploy-services.sh                    # cross-build + install both
DEVVM=10.0.10.10 ./scripts/deploy-services.sh   # explicit host
SKIP_BUILD=1 ./scripts/deploy-services.sh       # reuse ./out/ binaries
```

It installs each binary and unit only when the bytes differ, and **restarts a
service only if something about it changed** — a needless `session-events`
restart drops every text-view client's open SSE stream. Verification is
`systemctl is-active` plus, per service, `/health` (unauthenticated by design)
and an unauthenticated hit on the authed surface that must answer `401`. It
deliberately does **not** touch `ttyd`, `tmux-api` or `clipboard-upload`: those
are shared by every user and are `deploy.sh`'s to release.

Hook wiring and the ingress routes for session-events are gated separately —
see `session-events/DEPLOY.md`.

### ttyd (patched)

The devvm runs a locally-patched ttyd (`devvm/ttyd-local.patch`, two
fixes):

- **Pixel size → pty (sixel):** stock 1.7.7 reports a 0×0 pixel size to
  the pty, which makes tmux swallow sixel images — the patch forwards
  the browser's pixel size so `viu` & co. render inline (see
  `docs/adr/0004-sixel-images-in-the-terminal.md`).
- **Client PAUSE honored (flow control):** stock 1.7.7's pause opcode is
  a no-op (`process->paused` is stuck true from spawn, so `pty_pause`
  early-returns, and the write pump unconditionally resumes) — under a
  Claude-style output flood a slow client tab just drowns. The patch
  makes PAUSE stop pty reads until RESUME; the frontend's flow control
  rides on it. Verified by `scripts/devserve/flowprobe.py` (red/green +
  an un-paused throughput control run).

Run `./scripts/build-ttyd.sh` once before deploying whenever the ttyd
binary needs (re)building — it pins upstream tag 1.7.7, applies
`devvm/ttyd-local.patch`, and drops the binary at `out/ttyd`;
`deploy.sh` ships it only if it exists and says so either way (and keeps
the previously installed binary at `/usr/local/bin/ttyd.prev` as the
fastest rollback).

### viu

`viu` is a system binary on the devvm, installed once, outside
`deploy.sh`: `cargo install viu --features icy_sixel` (the sixel
feature is off by default), then
`sudo install ~/.cargo/bin/viu /usr/local/bin/viu`.

### Showing images in sessions

Humans at the terminal just run `viu <file>` — sixel renders inline.
Claude/agents must run `show-image <file>` instead: Claude Code's Bash
tool captures stdout, so bare `viu` from a tool call prints garbage
into the transcript and leaks terminal query replies into the input
line. `show-image` opens a temporary tmux split pane on the real pane
tty (viu at 12 rows; Enter closes it). A split — not `display-popup` —
is deliberate: tmux 3.4 popups don't pass sixel through, so an image
in a popup renders as an empty box.

### CI and the release pipeline

**Being replaced by a package the box installs itself** — design in
`docs/plans/2026-08-29-iac-native-deployment-design.md`, decision in
`docs/adr/0013-the-box-installs-the-lobby-nobody-ships-it.md`, runbook in
`packaging/README.md`, spec in ViktorBarzin/infra#87.

A merge to master becomes the running version without anyone running anything:
GitHub Actions builds off-infra, `svu` cuts the semver, a `.deb` lands in
Forgejo's Debian registry, and a trigger (GHA → Woodpecker → one SSH forced
command) tells the box to upgrade. `postinst` restarts only the units whose bytes
changed, verifies, and on failure reverts to the previous package and holds it.

What is built and what is not:

| Phase | State |
|---|---|
| The `release` package, `tl-stamp`, `tl-pkg`, `tl-apply`, the packaging scripts | built and tested |
| `.github/workflows/{release,ttyd,viu}.yml` | written; needs the GitHub mirror to exist |
| `infra/.woodpecker/terminal-lobby-deploy.yml`, `devvm/devvm-apply` | written; needs the three confirmations in `packaging/README.md` |
| The apt source on the box, the first install | not done — a deliberately observed step |
| Deleting the three deploy scripts | not done — they remain the deploy path until the pipeline is proven |

Note on the previous state of this section: it described a `.woodpecker.yml` as
"ready" and blocked on a Forgejo activation returning HTTP 500. That file was
removed in `c9853e6` as part of the ADR-0002 decommission. The activation
failure is real and unchanged, which is why the deploy pipeline lives in the
infra repository — already activated — rather than in this one.

**Until the pipeline is switched on: `./scripts/deploy.sh` after each push**, as
before.

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
   run it: `sudo /home/wizard/code/infra/scripts/t3-provision-users.sh`). That
   creates the account and regenerates the map and the admin list.
2. **Append their sudo grant** to `devvm/sudoers.d-ttyd-users` here — one
   `wizard ALL=(os_user) NOPASSWD: …` line, copying an existing user's binary
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

## Local development

The Go services are small and self-contained. To run locally:

```bash
# tmux-api needs a /etc/ttyd-user-map (read-only) and an Authentik header.
cd tmux-api && go run .

# Then:
curl -H "X-Authentik-Username: $(whoami)" http://localhost:7684/whoami
curl -H "X-Authentik-Username: $(whoami)" http://localhost:7684/sessions
```

`clipboard-upload` reads the same user map and header for its store
routes (`/upload` — pastes, uploads and dropped files alike — plus
`/list`, `/img/…` and `/file/…`). Identity is now required on both
upload fields, since a document joins the same per-user store; only a
document over the 25MB cap still lands in `/tmp/clipboard-files`. Locally it needs a writable
`/var/lib/clipboard-store` (`sudo install -d -o $USER
/var/lib/clipboard-store`) — without it only the store routes 500.

For end-to-end frontend work there's a loopback harness:
`python3 scripts/qa-harness.py` puts the production routing (auth header
injection, prefix-stripped API routes, WS passthrough, the split bundle's
`/assets/` chunks) in front of the DEPLOYED page and the REAL backends, with a
mutation guard that confines writes to `qa-*` sessions.

## Theme

Nine presets shipped as CSS variables on `body.theme-*`: `carbon`, `slate`
(default), `mono`, `ink`, `t3-dark`, `t3-light`, `catppuccin-mocha`,
`catppuccin-latte`, plus `system`, which follows the OS light/dark setting
(as T3 Light / T3 Dark, tracking scheme changes live). The picker is a
9-button grid in the ⚙ Settings panel. Choice persists per device in
`localStorage` (`tmux-theme`) — deliberately not part of the roamed prefs
doc. Switches apply live: the lobby posts `tl-theme` to the attached
terminal iframe, which re-reads the CSS vars and repaints xterm without a
reload; a stale iframe build that doesn't ACK gets the old full-reload
fallback after ~1s.

## Mobile

The lobby works on phones and tablets. The viewport meta declares
`viewport-fit=cover` + `interactive-widget=resizes-content` so the
soft keyboard pushes the layout up instead of overlaying it, and the
xterm pane refits whenever `visualViewport` reports a size change.

**Soft-key toolbar.** On any device that reports `pointer: coarse`, a
docked toolbar appears above the soft keyboard with keys mobile
keyboards lack: `Esc`, `Tab`, `Ctrl`, `Alt`, arrow keys, `|`, `` ` ``,
plus `Copy` / `Paste` / `Kbd` (re-summon keyboard). `Ctrl` and `Alt`
are one-shot on a single tap and **latch** on a double-tap (within
400 ms); a small dot on the button indicates latch state. Latched
modifiers apply to subsequent letters typed on the system soft
keyboard until you tap the modifier again to release.

**Install as a PWA.** A `manifest.webmanifest` (served from `/`) plus
the two icons (`/icon-192.png`, `/icon-512.png`) let iOS Safari and
Chrome Android "Add to Home Screen" install the lobby as a standalone
app. Run in standalone mode and the URL bar / tab strip disappear,
giving the terminal the full screen. iOS PWA cookies are sandboxed
per-app, so on first launch you may need to re-authenticate via
Authentik.

**Gestures.** `overscroll-behavior: none` suppresses Chrome
pull-to-refresh and iOS rubber-band on the terminal. `touch-action`
keeps pinch-zoom available for accessibility but kills double-tap
zoom. The sidebar auto-collapses on first session activation on
mobile so the terminal gets the full viewport; the toggle in the
top-right re-opens it (choice persists in `localStorage`).
