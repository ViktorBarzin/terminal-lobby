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
document over the 25MB cap still lands in `/tmp/clipboard-files`. Locally it needs a writable
`/var/lib/clipboard-store` (`sudo install -d -o $USER
/var/lib/clipboard-store`) — without it only the store routes 500.

For end-to-end frontend work there's a loopback harness:
`python3 scripts/qa-harness.py` puts the production routing (auth header
injection, prefix-stripped API routes, WS passthrough, the split bundle's
`/assets/` chunks) in front of the DEPLOYED page and the REAL backends, with a
mutation guard that confines writes to `qa-*` sessions.

The header name is `TL_AUTH_HEADER`, which defaults to `X-Forwarded-User`.
A box configured for a different proxy sets it in `/etc/terminal-lobby.conf`,
so use whatever that file names when running against a deployed service.

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
