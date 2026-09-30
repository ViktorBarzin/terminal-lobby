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
  TL_PROXY_SECRET=<the box's TL_PROXY_SECRET> \
  npx vite preview --host 127.0.0.1 --port 7912
```

`TL_PROXY_SECRET` only matters on a box that sets one, and there it is not
optional: `authuser` checks the shared secret before it reads the identity
header, so without it every call is a 401 — the sidebar reads "Access denied
(HTTP 401)" and the terminal cannot attach. The dev proxy forwards it as
`X-TL-Proxy-Secret` on both the request and the WebSocket upgrade. The value
lives in `/etc/terminal-lobby.local.conf`, which is root-readable.

Reaching it from the Android emulator wants `adb reverse tcp:7912 tcp:7912`,
which also keeps the origin on `127.0.0.1` so `isSecureContext` stays true and
the clipboard API works. One caveat: the SPA registers a service worker, so drop
it and its caches before trusting that a tab is on the new bundle.

## The Stop replay

`session-events/stopreplay_test.go` presses Stop at every moment from 0 to
3 s after a send, in 200 ms steps, for five messages: a plain one, a long one
that goes as several pastes, one with a picture, one with two pictures, and a
batch of three queued behind a running turn. No real Claude is involved. It
drives the real `POST /prompt` and `POST /cancel` routes and the real
`sessionio.Injector` against `sessionio/testdata/fakeinput.py`, which stands in
for Claude Code's input box with its turn modelled (`FAKEINPUT_TURN_MS`: a
Stop before the reply puts the prompt back on the input line, one after it
leaves the prompt in the conversation) and its delayed picture attach
(`FAKEINPUT_IMAGE_MS`). The Stop it sends is the one the Text view sends before
the transcript has caught up: the first message as `returnPrompt`, the rest as
`restoreQueue`.

Every run checks that each message reached Claude exactly once or came back
whole to the field, that Claude's input box is left empty, and that a message
the server handed back is out of the conversation and named by the rewound
stamp. It fails on the regressions the T3 pass's review rounds found by hand:
a prompt left on the input line, a queued prompt both run and handed back, a
picture attached after the Enter.

It runs in CI in the `test (go)` step of `.github/workflows/release.yml`, with
the rest of `go test -race ./...` in `session-events`, and takes about 45 s. It
needs `tmux` and `python3`. On a developer's box without them it skips; under
CI (`CI` set) it fails instead, so a missing tool cannot let a Stop regression
through. To run it alone:

```sh
cd session-events && go test -race -run TestStopReplay -v .
```

`-short` takes 600 ms steps instead of 200 ms.
