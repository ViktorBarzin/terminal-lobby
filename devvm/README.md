# DevVM artefacts

Files in this directory are deployed to `10.0.10.10`. The Woodpecker
pipeline in `.woodpecker.yml` does it on every push to master; for
manual deploys see the project root `README.md`.

| Source | Destination | Mode |
|---|---|---|
| `tmux-attach.sh` | `/usr/local/bin/tmux-attach.sh` | 0755 |
| `start-claude.sh` | per-user, e.g. `/home/emo/start-claude.sh` | 0755 — **NOT auto-deployed** |
| `ttyd.service` | `/etc/systemd/system/ttyd.service` | 0644 |
| `ttyd-ro.service` | `/etc/systemd/system/ttyd-ro.service` | 0644 |
| `tmux-api.service` | `/etc/systemd/system/tmux-api.service` | 0644 |
| `clipboard-upload.service` | `/etc/systemd/system/clipboard-upload.service` | 0644 |
| `clipboard-cleanup.service` | `/etc/systemd/system/clipboard-cleanup.service` | 0644 |
| `clipboard-cleanup.timer` | `/etc/systemd/system/clipboard-cleanup.timer` | 0644 |
| `ttyd-user-map` | `/etc/ttyd-user-map` | 0644 |
| `sudoers.d-ttyd-users` | `/etc/sudoers.d/ttyd-users` | 0440 root:root |
| `../frontend/index.html` | `/usr/local/share/ttyd/index.html` | 0644 |
| `../tmux-api/` (built) | `/usr/local/bin/tmux-api` | 0755 |
| `../clipboard-upload/` (built) | `/usr/local/bin/clipboard-upload` | 0755 |

`start-claude.sh` is not auto-deployed because it's per-user — copy it
into the home directory of any user who wants Claude Code as their
default tmux command, and reference it from their `~/.tmux.conf`.

ttyd ≥ 1.7 is required for the `-a` flag (URL `?arg=` → argv). DevVM
runs 1.7.7.
