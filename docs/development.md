# Local development

Running and testing the lobby without deploying it.

The Go services are small and self-contained. To run locally:

```bash
# tmux-api needs a /etc/ttyd-user-map (read-only) and an Authentik header.
cd tmux-api && go run .

# Then:
curl -H "X-Forwarded-User: $(whoami)" http://localhost:7684/whoami
curl -H "X-Forwarded-User: $(whoami)" http://localhost:7684/sessions
```

`clipboard-upload` reads the same user map and header for its store
routes (`/upload` — pastes, uploads and dropped files alike — plus
`/list`, `/img/…` and `/file/…`). Identity is now required on both
upload fields, since a document joins the same per-user store; only a
document over the 25MB cap still lands in `/run/clipboard-files`. Locally
it needs both of those directories, and it can create neither for itself,
since `/var/lib` and `/run` are root-owned:

```bash
sudo install -d -o $USER /var/lib/clipboard-store   # missing: the store routes 500
sudo install -d -o $USER /run/clipboard-files       # missing: the service exits at startup
```

A missing transfer directory is fatal because on the devvm systemd creates it
as the unit's `RuntimeDirectory` before `ExecStart` (TL-7), so a service that
starts without it is a broken unit, not a dev box missing a directory. `/run` is
a tmpfs, so a local box needs that second command again after a reboot. The
container image installs both at build time (`Dockerfile`), since it has no
systemd to create either.

For end-to-end frontend work there's a loopback harness:
`python3 scripts/qa-harness.py` puts the production routing (auth header
injection, prefix-stripped API routes, WS passthrough, the split bundle's
`/assets/` chunks) in front of the DEPLOYED page and the REAL backends, with a
mutation guard that confines writes to `qa-*` sessions.

That guard has a trap on the other side of it. `qa-` is also the prefix
`tmux-api` stamps `@tl_origin=test` on, and the lobby HIDES test-origin
sessions, so a scratch session created under that name is attachable and never
appears in the sidebar to be clicked. The harness stamps its own sessions
test-origin regardless of name, so a scratch session cannot be driven through
the UI at all. To drive a real one, name it explicitly with `--allow-session`.

The harness reads `TL_AUTH_HEADER` itself, from `/etc/terminal-lobby.conf` and
the `/etc/terminal-lobby.local.conf` that wins over it, so the header name is no
longer yours to pass. `--auth-header` overrides it where you need to.

Two things about running it against a deployed box cost an hour on 2026-09-12
and are worth knowing before you start.

**The proxy secret is not optional.** With `TL_PROXY_SECRET` set,
`authuser/resolve.go` checks it BEFORE it reads identity at all, so without it
every proxied call is 401 whatever header you send, and the lobby renders
"Access denied (HTTP 401)" with an empty sidebar. It lives in
`/etc/terminal-lobby.local.conf`, which is root-owned, so pass it in:

```sh
TL_PROXY_SECRET="$(sudo grep -h ^TL_PROXY_SECRET= /etc/terminal-lobby.local.conf | cut -d= -f2-)" \
  python3 scripts/qa-harness.py --user <authentik-user>
```

**`--user` is the Authentik name, not the OS user.** `/etc/ttyd-user-map` maps
one to the other, and passing the OS user gets a 403 reading "no terminal
account for that identity".

The harness has no lever for pointing it at a LOCAL build: its catch-all goes
to ttyd, which serves the installed bundle, and `/assets/*` goes to
clipboard-upload, whose only override is `CLIPBOARD_UPLOAD_ASSET_DIR` on a
shared systemd service. To drive a build from the working tree, `vite preview`
carries the same proxy table — `vite.config.ts` exports it for both `server`
and `preview`, so the whole ingress is reproduced, WS identity header included:

```sh
cd frontend-v2 && npm run build
TL_DEV_AUTH=<authentik-user> TL_AUTH_HEADER=X-Authentik-Username \
  npx vite preview --host 127.0.0.1 --port 7912
```

Reaching it from the Android emulator wants `adb reverse tcp:7912 tcp:7912`,
which also keeps the origin on `127.0.0.1` so `isSecureContext` stays true and
the clipboard API works. One caveat: the SPA registers a service worker, so drop
it and its caches before trusting that a tab is on the new bundle.
