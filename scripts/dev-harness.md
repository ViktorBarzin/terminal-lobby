# dev-harness.py — local loopback harness for frontend/index.html

Runs the REAL `frontend/index.html` fully functional on `127.0.0.1`, no
Authentik/nginx needed. Used to validate the native copy/paste redesign
(synthetic-modifier selection hijack) against a live tmux pane.

## Topology

```
browser ── http://127.0.0.1:7997 (aiohttp reverse proxy, this script)
             ├─ /api/sessions/*  → http://127.0.0.1:7684/*   live tmux-api;
             │                     prefix stripped, X-Authentik-Username: alice added
             │                     (without it the page hard-stops on Access denied)
             ├─ /clipboard/*     → http://127.0.0.1:7683/*   clipboard-upload; prefix
             │                     stripped (paste-upload E2E — `cd clipboard-upload && go run .`)
             └─ everything else  → http://127.0.0.1:7996     local ttyd child
                                   (incl. /ws WebSocket, subprotocol 'tty', binary frames)
```

The ttyd child mirrors `devvm/ttyd.service` client-relevant flags: `--writable`
(`-W`), `-a` (URL `?arg=` → argv), `-t enableClipboard=true`, custom `--index`,
no base path, default `TERM=xterm-256color`. Differences from prod, both
deliberate: `-H X-authentik-username` is not passed (no Authentik hop locally;
it would only add a 401 failure mode), and the command is a fixed
`tmux new -As <session>` instead of `tmux-attach.sh` (no user mapping/sudo).
The tmux session is **pre-created** at startup so ttyd's `-a` can never turn
the URL arg into a `new-session` shell command.

## Start / stop

```sh
# defaults: index=frontend/index.html (this worktree), session=copytest,
#           proxy 7997, ttyd 7996, tmux-api http://127.0.0.1:7684, user alice
python3 scripts/dev-harness.py

# frozen-copy run (recommended while index.html is being edited by others):
cp frontend/index.html /tmp/proto-index.html
python3 scripts/dev-harness.py --index /tmp/proto-index.html

# stop: Ctrl+C (or SIGTERM the pid). The ttyd child is killed automatically.
# add --kill-session-on-exit to also tmux kill-session the test session.
```

Open `http://127.0.0.1:7997/?arg=copytest` (terminal) or `/` (lobby).
Requires: `aiohttp`, `ttyd`, `tmux` on PATH; the live tmux-api on :7684.

## Options

| flag | default | purpose |
|---|---|---|
| `--index` | `<repo>/frontend/index.html` | file served by ttyd `-I` |
| `--session` | `copytest` | tmux session created/attached |
| `--proxy-port` / `--ttyd-port` | 7997 / 7996 | loopback ports |
| `--api` | `http://127.0.0.1:7684` | tmux-api base |
| `--user` | `alice` | injected `X-Authentik-Username` value |
| `--no-ttyd` | off | reuse an already-running ttyd on `--ttyd-port` |
| `--kill-session-on-exit` | off | remove the tmux session on shutdown |

## Test recipes (used by the feasibility suite)

- **Grab the page's closed-over `term`**: `page.add_init_script` a
  `window.Terminal` property setter that wraps the class in a `Proxy` whose
  `construct` trap stores the instance as `window.__term` (xterm.min.js UMD
  assigns the Terminal class to `globalThis.Terminal` — a plain assignment,
  so the setter fires).
- **Mouse-report leak sensor**: make the pane echo every mouse report the app
  receives as visible text:
  `tmux send-keys -t copytest "clear; echo 'MARKER'; stty -icanon -echo -isig min 1 time 0; printf '\x1b[?1002h\x1b[?1006h'; exec cat -v" Enter`
  then count `^[[<` occurrences in `tmux capture-pane -p -J -S -400 -t copytest`.
  (`-isig` keeps Ctrl+C from killing `cat` and makes a leaked `^C` visible.)
- Playwright: `context.grant_permissions(['clipboard-read','clipboard-write'])`;
  trusted key chords via CDP `Input.dispatchKeyEvent`; Mac emulation via CDP
  `Emulation.setUserAgentOverride` with `platform: 'MacIntel'` **before** goto
  (xterm computes `Browser.isMac` from `navigator.platform` at script load).
