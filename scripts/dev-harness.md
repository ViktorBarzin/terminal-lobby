# dev-harness.py — local loopback harness for frontend/index.html

Runs the REAL `frontend/index.html` fully functional on `127.0.0.1`, no
Authentik/nginx needed. Used to validate the native copy/paste redesign
(synthetic-modifier selection hijack) against a live tmux pane.

## Topology

```
browser ── http://127.0.0.1:7997 (aiohttp reverse proxy, this script)
             ├─ /api/sessions/*  → http://127.0.0.1:7684/*   live tmux-api;
             │                     prefix stripped, X-Authentik-Username: vbarzin added
             │                     (without it the page hard-stops on Access denied)
             ├─ /clipboard/*     → http://127.0.0.1:7683/*   clipboard-upload; prefix
             │                     stripped, X-Authentik-Username: vbarzin added — the
             │                     store/list/img routes resolve the caller from that
             │                     header like tmux-api does (paste-upload + session-
             │                     gallery E2E — `cd clipboard-upload && go run .`)
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
# defaults: index=frontend/index.html (this worktree), SCRATCH tmux server
#           (-L tl-dev, session main, torn down on exit), proxy 7997,
#           ttyd 7996, tmux-api :7684, clipboard-upload :7683, user vbarzin
python3 scripts/dev-harness.py

# attach the REAL default tmux server instead (pre-battery behavior,
# session copytest):
python3 scripts/dev-harness.py --no-scratch

# frozen-copy run (recommended while index.html is being edited by others):
cp frontend/index.html /tmp/proto-index.html
python3 scripts/dev-harness.py --index /tmp/proto-index.html

# stop: Ctrl+C (or SIGTERM the pid). The ttyd child is killed automatically;
# in scratch mode the tl-dev tmux server is killed with it.
# add --kill-session-on-exit to also kill the session in --no-scratch mode.
```

The served page is a stamped copy of `--index` (`__TL_BUILD__` →
`DEV-<git short sha>`, written to `out/index.html`, mirroring deploy.sh), so
the browser console prints `terminal-lobby build: DEV-…`.

Open `http://127.0.0.1:7997/#main` (lobby, auto-attached — how battery runs
enter) or `/?arg=main` (bare terminal mode). Regression battery:
`scripts/devserve/BATTERY.md`.
Requires: `aiohttp`, `ttyd`, `tmux` on PATH; the live tmux-api on :7684.
For the paste/gallery flows a local `clipboard-upload` additionally
wants `/etc/ttyd-user-map` to map `--user` and a writable
`/var/lib/clipboard-store` (`sudo install -d -o $USER /var/lib/clipboard-store`).

## Options

| flag | default | purpose |
|---|---|---|
| `--index` | `<repo>/frontend/index.html` | source for ttyd `-I` (stamped copy → `out/index.html`) |
| `--scratch` / `--no-scratch` | scratch ON | isolated `tmux -L tl-dev` server vs the REAL default server |
| `--session` | `main` (scratch) / `copytest` | tmux session created/attached |
| `--proxy-port` / `--ttyd-port` | 7997 / 7996 | loopback ports |
| `--tmux-api-port` | 7684 | tmux-api port (point at a scratch build to test server changes — the binary honors `TMUX_API_ADDR=127.0.0.1:<port>` since Task 2.5, production's fixed :7684 can't be double-bound) |
| `--clipboard-port` | 7683 | clipboard-upload port (same idea) |
| `--api` | derived from `--tmux-api-port` | full tmux-api base URL override |
| `--user` | `vbarzin` | injected `X-Authentik-Username` value |
| `--delay /PATH=SECS` | none | debug: sleep before proxying matching requests (repeatable; slow-toast battery) |
| `--no-ttyd` | off | reuse an already-running ttyd on `--ttyd-port` |
| `--kill-session-on-exit` | off | remove the tmux session on shutdown (`--no-scratch` runs; scratch kills its server anyway) |

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
