# terminal-lobby

Web tmux sessions, gated by Authentik, isolated per OS user. Lives at
`https://terminal.viktorbarzin.me/`.

A sidebar lists the current user's tmux sessions; the right pane is an
iframe that swaps between sessions on click. Direct-linked sessions
(`?arg=<name>` at the top level) bypass the lobby and render fullscreen
for bookmarks / CLI links.

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

CI/CD via Woodpecker (`.woodpecker.yml`): on push to master, build the
two Go binaries (`linux/amd64`), SSH to `10.0.10.10`, install
binaries + frontend + systemd units + config, daemon-reload, restart
the affected services.

Manual deploy:

```bash
DEVVM=10.0.10.10
( cd tmux-api && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o /tmp/tmux-api . )
( cd clipboard-upload && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o /tmp/clipboard-upload . )

scp /tmp/tmux-api /tmp/clipboard-upload $DEVVM:/tmp/
scp frontend/index.html $DEVVM:/tmp/
scp devvm/tmux-attach.sh devvm/ttyd-user-map devvm/sudoers.d-ttyd-users $DEVVM:/tmp/
scp devvm/*.service devvm/*.timer $DEVVM:/tmp/

ssh $DEVVM '
  sudo install -m 0755 /tmp/tmux-api          /usr/local/bin/tmux-api
  sudo install -m 0755 /tmp/clipboard-upload  /usr/local/bin/clipboard-upload
  sudo install -m 0755 /tmp/tmux-attach.sh    /usr/local/bin/tmux-attach.sh
  sudo install -m 0644 /tmp/index.html        /usr/local/share/ttyd/index.html
  sudo install -m 0644 /tmp/ttyd-user-map     /etc/ttyd-user-map
  sudo install -m 0440 -o root -g root /tmp/sudoers.d-ttyd-users /etc/sudoers.d/ttyd-users
  sudo visudo -cf /etc/sudoers.d/ttyd-users
  for u in ttyd ttyd-ro tmux-api clipboard-upload clipboard-cleanup; do
    sudo install -m 0644 /tmp/$u.service /etc/systemd/system/$u.service 2>/dev/null || true
  done
  sudo install -m 0644 /tmp/clipboard-cleanup.timer /etc/systemd/system/clipboard-cleanup.timer
  sudo systemctl daemon-reload
  sudo systemctl restart ttyd ttyd-ro tmux-api clipboard-upload
  sudo systemctl enable --now clipboard-cleanup.timer
  rm /tmp/{tmux-api,clipboard-upload,tmux-attach.sh,index.html,ttyd-user-map,sudoers.d-ttyd-users}
  rm /tmp/*.service /tmp/*.timer
'
```

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
