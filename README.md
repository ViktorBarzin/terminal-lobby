# terminal-lobby

Web tmux sessions, gated by Authentik, isolated per OS user. Lives at
`https://terminal.viktorbarzin.me/`.

A sidebar lists the current user's tmux sessions; the right pane is an
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

## Components

| Piece | Where it runs | Port | Purpose |
|---|---|---|---|
| `frontend/index.html` | Served by ttyd on the DevVM | 7681 | Lobby UI + xterm.js terminal |
| `tmux-api/` (Go) | DevVM systemd service | 7684 | `GET /sessions`, `DELETE /sessions/<n>`, `POST /sessions/<n>/rename`, `GET /whoami` |
| `clipboard-upload/` (Go) | DevVM systemd service | 7683 | Receives pasted/uploaded images, returns a path the terminal can paste |
| `devvm/tmux-attach.sh` | DevVM, invoked by ttyd | — | Validates `X-authentik-username`, maps to OS user via `/etc/ttyd-user-map`, `sudo -u <user> tmux new-session -A` |
| `devvm/ttyd.service`, `ttyd-ro.service`, `tmux-api.service`, `clipboard-upload.service` | DevVM | — | systemd units |
| `devvm/clipboard-cleanup.service` + `.timer` | DevVM | — | Daily `find /tmp/clipboard-images -mtime +7 -delete` |
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

For now: **manual deploy via `./scripts/deploy.sh`** from a workstation
that can SSH `wizard@10.0.10.10`. The script cross-builds the Go
binaries, SCPs all artefacts, installs them under `sudo`, runs
`daemon-reload`, restarts services, and smoke-tests `/whoami` +
`/health`.

```bash
./scripts/deploy.sh                      # full deploy
DEVVM=10.0.10.10 ./scripts/deploy.sh     # explicit host
SKIP_BUILD=1 ./scripts/deploy.sh         # reuse ./out/ binaries
```

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

`clipboard-upload` is even simpler — it just accepts multipart POSTs at
`/upload` and saves to `/tmp/clipboard-images`.

For the frontend, there's no build step. The whole UI is a single
`index.html` with inline CSS + a single `<script>` IIFE. ttyd serves
it verbatim with `-I`.

## Theme

Four themes shipped as CSS variables on `body.theme-{slate,carbon,mono,ink}`.
Slate is the default. Picker lives at the bottom of the sidebar; choice
persists in `localStorage` (`tmux-theme`). The iframe re-mounts on
theme change so the inner xterm re-reads CSS vars.
