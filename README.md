# terminal-lobby

Web tmux sessions, gated by Authentik, isolated per OS user. Lives at
`https://terminal.viktorbarzin.me/`.

A second, experimental frontend — the SolidJS **v2** rewrite (`frontend-v2/`) —
runs at `https://terminal-dev.viktorbarzin.me/` over the **same backend**, so
both frontends drive one shared set of tmux sessions. The vanilla page stays the
stable daily driver; terminal-dev is where v2 is iterated on. Both hosts are gated
to the Home Server Admins group. See **Two frontends** under Deployment.

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
| `frontend/index.html` | Served by ttyd on the DevVM | 7681 | Lobby UI + xterm.js terminal |
| `frontend-v2/` (SolidJS + Vite) | Built to a single `index-v2.html`, served by **ttyd-v2** on the DevVM | 7687 | The **v2** rewrite at `terminal-dev.viktorbarzin.me`. Same tmux-api / clipboard / session-events / file-api backends as the vanilla page; the terminal is an iframe of `/term.html`. Build: `npm run build` (vite-plugin-singlefile → one inlined file) |
| `tmux-api/` (Go) | DevVM systemd service | 7684 | `GET /sessions` (incl. per-session `state` + `project`), `DELETE /sessions/<n>`, `POST /sessions/<n>/rename`, `GET /whoami`, `POST /restore`, `GET`/`PUT /layout` (per-user sidebar layout, stored under `/var/lib/tmux-api/layout/`) |
| `clipboard-upload/` (Go) | DevVM systemd service | 7683 | Per-session image store (`/var/lib/clipboard-store/<user>/<session>/`): `POST /upload` persists pasted/uploaded/dropped images and returns a path the terminal can paste (non-image drops stay in `/tmp/clipboard-files`), `POST /register` records `show-image` renders (localhost), `GET /list` + `GET /img/…` serve the gallery. Per-user isolation via `X-Authentik-Username` → `/etc/ttyd-user-map`, like tmux-api. See `docs/adr/0005-session-image-store.md` |
| `devvm/tmux-attach.sh` | DevVM, invoked by ttyd | — | Validates `X-authentik-username`, maps to OS user via `/etc/ttyd-user-map`, `sudo -u <user> tmux new-session -A` |
| `devvm/claude-tmux-state` | DevVM, invoked by Claude Code hooks | — | Stamps `@claude_state` (running / awaiting / done) on the enclosing tmux session; wired org-wide via `/etc/claude-code/managed-settings.json` (infra repo, `scripts/workstation/`, self-deploys hourly). No-ops outside tmux. See `docs/adr/0001-claude-state-via-hooks.md` |
| `devvm/tmux-restore-user` | DevVM, invoked by `tmux-api` via sudo (`POST /restore`) | — | "Restore sessions" button helper: validates the user against `/etc/ttyd-user-map`, runs `tmux-persist restore <user>` (recreates that user's saved-but-dead sessions, resuming each Claude conversation). Idempotent — live sessions are left alone. Useful after an OOM kills the tmux server without a reboot (the boot-only restore never fires) |
| `devvm/show-image` | DevVM, `/usr/local/bin/show-image`, run inside sessions | — | Shows an image at the terminal. Inside tmux: temporary split pane running `viu` (sixel; Enter closes) — the reliable path for Claude/agents, whose captured stdout breaks bare `viu` — then fire-and-forgets a localhost `/register` so the image joins the session gallery. Outside tmux: plain `viu`. See "Showing images in sessions" |
| `devvm/ttyd.service`, `ttyd-ro.service`, `ttyd-v2.service`, `tmux-api.service`, `clipboard-upload.service` | DevVM | — | systemd units (`ttyd-v2` = the :7687 second ttyd serving the v2 SPA at terminal-dev) |
| `devvm/clipboard-cleanup.service` + `.timer` + `clipboard-store-clean` | DevVM | — | Daily retention sweep: store dirs live while their session does (live tmux or saved layout) + 30-day `.deleted-at` grace; `_unsorted` 90 d; `/tmp/clipboard-files` 7 d |
| `devvm/ttyd-user-map`, `sudoers.d-ttyd-users` | `/etc/` on DevVM | — | Authentik → OS-user mapping + sudo grant |
| `devvm/start-claude.sh` | Per-user, e.g. `/home/emo/` | — | Optional Claude-Code launcher invoked by tmux `default-command` |

## How a request flows

1. Browser hits `https://terminal.viktorbarzin.me/`.
2. Traefik forward-auth → Authentik → adds `X-authentik-username` header.
3. K8s ingress (in `infra/stacks/terminal/`) routes:
   - `/api/sessions/*` → `tmux-api` (port 7684 on the DevVM)
   - `/clipboard/*` → `clipboard-upload` (port 7683)
   - everything else → `ttyd` (port 7681) which serves `index.html` + WebSocket
4. The browser preflights `/api/sessions/whoami` to discover its OS user, then either renders the lobby or opens a session iframe with `?arg=<name>`.
5. ttyd, on each WS connection, runs `tmux-attach.sh` with `X-authentik-username` in `$TTYD_USER`. The script `sudo`s into the mapped OS user and `exec tmux new-session -A -s <name>`. Each OS user has its own `/tmp/tmux-<uid>/default` socket — kernel-level isolation.
6. `tmux-api` reads the same `X-Authentik-Username` header on every API call and runs tmux under the mapped OS user, so users only see their own sessions.

## Deployment

For now: **manual deploy**, from a workstation that can SSH
`wizard@10.0.10.10`. There are **three** scripts, split by blast radius — each
cross-builds what it owns, SCPs to `/tmp`, installs under `sudo`, runs
`daemon-reload`, and smoke-tests what it just shipped. Nothing is shipped by
two of them:

| Script | Ships | Restarts | Blast radius |
|---|---|---|---|
| `./scripts/deploy.sh` | vanilla `index.html`, PWA assets + webfonts, `tmux-api`, `clipboard-upload`, the patched `ttyd`, the devvm helper scripts + `/etc` config | `ttyd`, `ttyd-ro`, `tmux-api`, `clipboard-upload` | **Shared** — both hosts, every user |
| `./scripts/deploy-v2.sh` | `index-v2.html`, `ttyd-v2.service`, `term.html` | `ttyd-v2` only | terminal-dev only |
| `./scripts/deploy-services.sh` | `session-events` (:7685), `file-api` (:7686) + their units | those two only | terminal-dev only (the vanilla page calls neither) |

```bash
./scripts/deploy.sh                      # full deploy
DEVVM=10.0.10.10 ./scripts/deploy.sh     # explicit host
SKIP_BUILD=1 ./scripts/deploy.sh         # reuse ./out/ binaries
```

`deploy.sh` cross-builds **`tmux-api` and `clipboard-upload`** (not every Go
service in the tree — `session-events` and `file-api` are
`deploy-services.sh`'s), ships the patched `ttyd` only if `out/ttyd` exists,
and smoke-tests `/whoami` + `/health` + the public assets.

### Two frontends (terminal + terminal-dev)

The vanilla page (`frontend/index.html`) and the SolidJS **v2** rewrite
(`frontend-v2/`) run as **two separate ttyd instances over one shared backend**:

| Host | ttyd | `-I` index | Deploy |
|---|---|---|---|
| `terminal.viktorbarzin.me` | `ttyd` :7681 | `index.html` (vanilla) | `./scripts/deploy.sh` |
| `terminal-dev.viktorbarzin.me` | `ttyd-v2` :7687 | `index-v2.html` (v2 SPA) | `./scripts/deploy-v2.sh` |

`deploy-v2.sh` builds `frontend-v2` (vite single-file) into `index-v2.html`,
installs `devvm/ttyd-v2.service`, and **restarts only ttyd-v2** — never ttyd
:7681, ttyd-ro, or any shared backend, so the vanilla page is unaffected. It
also installs **`term.html`**, the terminal-mode page the SPA frames
(`config.TERMINAL_BASE = "/term.html"`, emitted by the `copyTermHtml` plugin in
`frontend-v2/vite.config.ts`): that one file lands in the *shared* asset dir
`/usr/local/share/ttyd/`, where **clipboard-upload** serves it from its
exact-path whitelist — so no service is restarted for it, and only the v2 SPA
ever fetches it (the vanilla page has no reference to `/term.html`).

Both artefacts are stamped independently (`__TL_BUILD__` = git SHA,
`__TL_ASSET__` = a fingerprint of the file's own bytes, ADR-0007) because each
runs the zero-touch self-update healer against its *own* identity. Two skips
keep repeated deploys cheap: `npm ci` is skipped while `package-lock.json`
hashes the same as the last install (stamp at
`frontend-v2/node_modules/.tl-lock-hash`), and the `ttyd-v2` restart is skipped
when the installed artefacts were byte-identical — an unnecessary restart drops
every attached terminal's WebSocket. `enable --now` still runs either way, so a
stopped unit comes back up.

Both frontends attach the SAME per-uid tmux server (like `ttyd` + `ttyd-ro`), so
sessions/clipboard/prefs are shared: opening the same session on both hosts at
once makes tmux clamp to the smaller client's viewport (use different sessions,
or one host at a time).

The k8s routing for `terminal-dev` (its own ingress + per-path routes + PWA
carve-out, all reusing the shared backend Services) lives in
`infra/stacks/terminal/terminal-dev.tf`; the Authentik admin-gate for the host is
in `infra/stacks/authentik/admin-services-restriction.tf` (`ADMIN_ONLY_HOSTS`).

```bash
./scripts/deploy-v2.sh                    # build frontend-v2 + (re)deploy ttyd-v2
SKIP_BUILD=1 ./scripts/deploy-v2.sh       # reuse frontend-v2/dist/{index,term}.html
```

### v2-only backends (session-events + file-api)

`session-events` (:7685, the Text view's SSE transcript stream + `/prompt` +
`/cancel`) and `file-api` (:7686, the file preview/editor) back **only** the v2
SPA — the vanilla page calls neither. They were installed by hand until
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
deliberately does **not** touch `ttyd`, `ttyd-ro`, `tmux-api` or
`clipboard-upload`: those are shared with the stable tier and are `deploy.sh`'s
to release.

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
fastest rollback). The binary backs both :7681 and the read-only :7682.

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

### CI status — TODO

`.woodpecker.yml` is ready and the deploy SSH key is provisioned
(`secret/woodpecker/devvm_ssh_key`), but **Forgejo-side activation is
blocked**:

- Woodpecker user `viktor` (forge_id=2) cannot activate `viktor/terminal-lobby`
  in the current installation — returns HTTP 500 on activation, same
  symptom that blocked `viktor/payslip-ingest` previously.
- Forgejo Actions is not enabled in `app.ini` and there's no
  `forgejo-runner` provisioned in the cluster.

Either of these unblocks CI:
1. **Enable Forgejo Actions**: add `[actions] ENABLED = true` to
   Forgejo `app.ini`, restart, then deploy a `forgejo-runner` Helm
   release in a new Terraform stack. Move `.woodpecker.yml` →
   `.forgejo/workflows/deploy.yml` (similar syntax, native YAML).
2. **Fix Woodpecker ↔ Forgejo activation** (root cause of the
   HTTP 500 unknown — needs server logs).

Until then: `./scripts/deploy.sh` after each push.

## Per-user setup

Adding a new user (`auth_local_name` → `os_user`):

1. Append `auth_local_name=os_user` to `devvm/ttyd-user-map`.
2. Append `wizard ALL=(os_user) NOPASSWD: /usr/bin/tmux` to `devvm/sudoers.d-ttyd-users`.
3. Ensure the OS user exists: `useradd -m os_user`.
4. (Optional) Copy `devvm/start-claude.sh` into the user's home and reference it from their `~/.tmux.conf` via `set -g default-command "$HOME/start-claude.sh"`.

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
routes (`/upload` image field — pastes, uploads and dropped images
alike — plus `/list`, `/img/…`); non-image drops still land
header-free in `/tmp/clipboard-files`. Locally it needs a writable
`/var/lib/clipboard-store` (`sudo install -d -o $USER
/var/lib/clipboard-store`) — without it only the store routes 500.

For the frontend, there's no build step. The whole UI is a single
`index.html` with inline CSS + a single `<script>` IIFE. ttyd serves
it verbatim with `-I`.

For end-to-end frontend work there's a loopback harness:
`python3 scripts/dev-harness.py` reproduces the production routing
(auth header injection, prefix-stripped API routes, WS passthrough)
against an isolated scratch tmux server — see `scripts/dev-harness.md`.
UI changes are verified against the regression battery in
`scripts/devserve/BATTERY.md` (red-line checks + per-feature acceptance).

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
