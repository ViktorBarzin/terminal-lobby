#!/usr/bin/env python3
"""Local dev harness for terminal-lobby's frontend/index.html.

Makes the REAL page fully functional on loopback without Authentik/nginx:

    browser ──► http://127.0.0.1:7997  (this aiohttp reverse proxy)
                   ├── /api/sessions/*  → http://127.0.0.1:7684/*  (live tmux-api,
                   │                      prefix stripped, X-Authentik-Username added)
                   ├── /events|/prompt|/pane|/keys|/commands/* → :7685
                   │                      (session-events, verbatim — text mode)
                   ├── /clipboard/*     → http://127.0.0.1:7683/*  (clipboard-upload,
                   │                      prefix stripped, X-Authentik-Username added
                   │                      — paste-upload + session-gallery E2E; run
                   │                      `cd clipboard-upload && go run .` locally)
                   ├── PWA/font assets  → http://127.0.0.1:7683    (clipboard-upload,
                   │                      the 10 EXACT paths in ASSET_PATHS, kept
                   │                      UNSTRIPPED and with NO auth header —
                   │                      mirrors the public auth="none" ingress
                   │                      carve-out, plan Tasks 3.1/3.2)
                   └── everything else  → http://127.0.0.1:7996    (local ttyd child,
                                          including the /ws WebSocket, subprotocol 'tty')

The ttyd child mirrors devvm/ttyd.service flags that affect the client
(`-W`/writable, `-a`/url-arg, `-t enableClipboard=true`, custom `--index`,
no base path, default TERM=xterm-256color). `-H X-authentik-username` is NOT
mirrored: locally there is no Authentik hop, and the harness command is a
fixed `tmux new -As <session>` instead of tmux-attach.sh, so the header would
only add a 401 failure mode. The tmux session is pre-created so that ttyd's
`-a` (which appends `?arg=<x>` to the command line) can never turn the URL
arg into a new-session shell command.

By default the ttyd child attaches an ISOLATED scratch tmux server
(`tmux -L tl-dev`, session `main`) that is torn down on exit, so harness
and battery runs never touch the user's real tmux sessions (`--no-scratch`
restores the old attach-the-default-server behavior). The served page is a
build of --index with the deploy.sh stamp seds applied (`__TL_BUILD__` ->
`DEV-<git short sha>` and `__TL_ASSET__` -> the source fingerprint, written to
out/index.html) so the console prints a recognizable
`terminal-lobby build: DEV-...` line and the self-update path is live.

Usage:
    python3 scripts/dev-harness.py [--index PATH] [--session NAME]
        [--scratch | --no-scratch]
        [--proxy-port 7997] [--ttyd-port 7996]
        [--tmux-api-port 7684] [--clipboard-port 7683]
        [--api URL] [--user vbarzin] [--ttyd-bin PATH]
        [--delay /PATH=SECS] [--kill-session-on-exit]

Then open:  http://127.0.0.1:7997/?arg=<session>   (terminal mode)
            http://127.0.0.1:7997/                 (lobby mode)

Stop with Ctrl+C / SIGTERM; the ttyd child is killed on exit (and in
scratch mode the tl-dev tmux server with it). Everything binds to
127.0.0.1 only. Requires: aiohttp, ttyd, tmux.
"""

import argparse
import asyncio
import hashlib
import os
import signal
import socket
import subprocess
import sys

import aiohttp
from aiohttp import WSMsgType, web

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_INDEX = os.path.join(REPO_ROOT, "frontend", "index.html")
STAMPED_INDEX = os.path.join(REPO_ROOT, "out", "index.html")

# Scratch tmux server socket name (tmux -L). `-L` only changes the socket —
# the user's ~/.tmux.conf still loads, matching prod behavior.
SCRATCH_SOCKET = "tl-dev"

# Hop-by-hop headers must not be blindly forwarded.
HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host",
    "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions",
    "sec-websocket-protocol", "accept-encoding", "content-length",
}

# Public PWA/webfont asset carve-out — MUST mirror the ingress_path list of
# infra Task 3.2 (stacks/terminal `module "ingress_assets"`, auth = "none")
# and clipboard-upload's exact-path whitelist (main.go publicAssets). These
# paths reach clipboard-upload UNSTRIPPED with NO auth header injected, so
# battery curls without credentials exercise the real Go handlers and the
# page's same-origin /fonts/ @font-face sources resolve locally.
ASSET_PATHS = (
    "/manifest.webmanifest",
    "/icon-192.png",
    "/icon-512.png",
    "/icon-512-maskable.png",
    "/fonts/JetBrainsMono-Regular.woff2",
    "/fonts/JetBrainsMono-Bold.woff2",
    "/fonts/JetBrainsMono-Italic.woff2",
    "/fonts/JetBrainsMono-BoldItalic.woff2",
    "/fonts/dm-sans-latin-wght-normal.woff2",
    "/sw.js",
)


def log(msg: str) -> None:
    print(f"[harness] {msg}", file=sys.stderr, flush=True)


def tmux_base(socket_name: str | None) -> list:
    """tmux argv prefix — scratch servers get their own -L socket."""
    return ["tmux", "-L", socket_name] if socket_name else ["tmux"]


def ensure_tmux_session(session: str, socket_name: str | None = None) -> None:
    """Create the target tmux session if it doesn't exist (detached)."""
    where = f" on scratch server '-L {socket_name}'" if socket_name else ""
    probe = subprocess.run(
        [*tmux_base(socket_name), "has-session", "-t", f"={session}"],
        capture_output=True,
    )
    if probe.returncode != 0:
        subprocess.run(
            [*tmux_base(socket_name), "new-session", "-d", "-s", session,
             "-x", "220", "-y", "50"],
            check=True,
        )
        log(f"created tmux session '{session}'{where}")
    else:
        log(f"tmux session '{session}'{where} already exists — reusing")


def build_stamped_index(src: str) -> str:
    """Mirror deploy.sh's stamps: __TL_BUILD__ and __TL_ASSET__.

    Written to out/index.html (gitignored, same spot deploy.sh uses and
    unconditionally regenerates). Lets the page log a recognizable
    `terminal-lobby build: DEV-…` so battery runs can assert which build
    the browser actually loaded.

    Both stamps matter (ADR-0007): TL_BUILD is provenance, TL_ASSET is the
    UPDATE IDENTITY, fingerprinted from the unstamped source exactly as
    deploy.sh does it. Leaving __TL_ASSET__ unsubstituted would ship a page
    with no identity — detection reads that as "no information" and the
    self-update path is dead for the whole harness run, which is precisely
    the behaviour a battery run needs to exercise.
    """
    try:
        rev = subprocess.run(
            ["git", "-C", REPO_ROOT, "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
    except (subprocess.CalledProcessError, OSError):
        rev = "local"
    stamp = f"DEV-{rev}"
    with open(src, encoding="utf-8") as f:
        html = f.read()
    asset = hashlib.sha256(html.encode("utf-8")).hexdigest()[:12]
    os.makedirs(os.path.dirname(STAMPED_INDEX), exist_ok=True)
    with open(STAMPED_INDEX, "w", encoding="utf-8") as f:
        f.write(html.replace("__TL_BUILD__", stamp).replace("__TL_ASSET__", asset))
    log(f"stamped {src} → {STAMPED_INDEX} (build {stamp}, asset {asset})")
    return STAMPED_INDEX


def start_ttyd(port: int, index: str, session: str,
               socket_name: str | None = None,
               ttyd_bin: str = "ttyd") -> subprocess.Popen:
    if socket_name:
        tmux_cmd = ["tmux", "-L", socket_name, "new-session", "-A", "-s", session]
    else:
        tmux_cmd = ["tmux", "new", "-As", session]
    cmd = [
        ttyd_bin,
        "--port", str(port),
        "--interface", "127.0.0.1",
        "--writable",                      # ttyd.service: -W
        "-a",                              # ttyd.service: -a (URL ?arg= → argv)
        "-t", "enableClipboard=true",      # ttyd.service: -t enableClipboard=true
        "--index", index,                  # ttyd.service: -I <custom index>
        *tmux_cmd,
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    log(f"ttyd started (pid {proc.pid}): {' '.join(cmd)}")
    return proc


def parse_delays(specs) -> list:
    """--delay '/sessions=20' (or '20s') → [('/sessions', 20.0), …]."""
    rules = []
    for spec in specs or []:
        path, eq, secs = spec.rpartition("=")
        if not eq or not path.startswith("/"):
            raise SystemExit(f"--delay expects /PATH=SECONDS, got {spec!r}")
        try:
            rules.append((path, float(secs.rstrip("sS"))))
        except ValueError:
            raise SystemExit(f"--delay: bad seconds value in {spec!r}")
    return rules


def wait_for_port(port: int, timeout: float = 8.0) -> None:
    import time
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with socket.socket() as s:
            s.settimeout(0.3)
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.15)
    raise RuntimeError(f"port {port} did not come up within {timeout}s")


def make_app(args: argparse.Namespace) -> web.Application:
    ttyd_base = f"http://127.0.0.1:{args.ttyd_port}"
    api_base = args.api_base
    clipboard_base = args.clipboard_base
    session_events_base = args.session_events_base

    async def maybe_delay(*paths) -> None:
        """--delay debug hook: sleep before proxying a matching request.

        Matches by prefix against every candidate spelling of the request
        path (browser-facing and upstream-stripped), so both
        `--delay /sessions=20` and `--delay /api/sessions=20` work.
        """
        for prefix, secs in args.delays:
            for p in paths:
                if p.startswith(prefix):
                    log(f"delay {secs:g}s ({prefix} matched {p})")
                    await asyncio.sleep(secs)
                    return

    async def api_proxy(request: web.Request) -> web.StreamResponse:
        """/api/sessions/<tail> → <api_base>/<tail> with the auth header."""
        tail = request.match_info["tail"]
        url = f"{api_base}/{tail}"
        await maybe_delay(f"/{tail}", request.rel_url.path)
        headers = {
            k: v for k, v in request.headers.items()
            if k.lower() not in HOP_BY_HOP
        }
        headers["X-Authentik-Username"] = args.user
        body = await request.read()
        try:
            async with request.app["client"].request(
                request.method, url, params=request.rel_url.query,
                headers=headers, data=body if body else None,
                allow_redirects=False,
            ) as upstream:
                payload = await upstream.read()
                resp_headers = {
                    k: v for k, v in upstream.headers.items()
                    if k.lower() not in HOP_BY_HOP
                }
                log(f"{request.method} /api/sessions/{tail} → {upstream.status}")
                return web.Response(status=upstream.status, body=payload,
                                    headers=resp_headers)
        except aiohttp.ClientError as exc:
            log(f"{request.method} /api/sessions/{tail} → 502 ({exc})")
            return web.Response(status=502, text=f"tmux-api upstream error: {exc}")

    # The session-events root paths, VERBATIM — the prod ingress routes these
    # to :7685 with no strip, so the harness has to as well or text mode is
    # inert here: no transcript, no pane, no `/` catalogue. Without it the one
    # place this app can be driven with a real soft keyboard cannot exercise
    # the half of it that lives in text mode.
    SE_PREFIXES = ("events", "prompt", "cancel", "earlier", "result", "pane",
                   "keys", "commands")

    async def session_events_proxy(request: web.Request) -> web.StreamResponse:
        path = request.rel_url.raw_path
        url = f"{session_events_base}{path}"
        headers = {
            k: v for k, v in request.headers.items()
            if k.lower() not in HOP_BY_HOP
        }
        headers["X-Authentik-Username"] = args.user
        body = await request.read()
        try:
            async with request.app["client"].request(
                request.method, url, params=request.rel_url.query,
                headers=headers, data=body if body else None,
                allow_redirects=False,
            ) as upstream:
                # /events is an SSE stream: relay it as one rather than waiting
                # for a body that never ends.
                if "text/event-stream" in upstream.headers.get("Content-Type", ""):
                    resp = web.StreamResponse(
                        status=upstream.status,
                        headers={"Content-Type": "text/event-stream",
                                 "Cache-Control": "no-cache"},
                    )
                    await resp.prepare(request)
                    try:
                        async for chunk in upstream.content.iter_any():
                            await resp.write(chunk)
                    except (ConnectionResetError, aiohttp.ClientError):
                        pass  # the page navigated away mid-stream; ordinary
                    return resp
                payload = await upstream.read()
                resp_headers = {
                    k: v for k, v in upstream.headers.items()
                    if k.lower() not in HOP_BY_HOP
                }
                log(f"{request.method} {path} → {upstream.status}")
                return web.Response(status=upstream.status, body=payload,
                                    headers=resp_headers)
        except aiohttp.ClientError as exc:
            log(f"{request.method} {path} → 502 ({exc})")
            return web.Response(status=502, text=f"session-events upstream error: {exc}")

    async def clipboard_proxy(request: web.Request) -> web.StreamResponse:
        """/clipboard/<tail> → CLIPBOARD_BASE/<tail>, prefix stripped, auth
        header injected (mirrors the prod ingress route + forward-auth to the
        clipboard-upload service — its store/list/img routes resolve the
        caller's OS user from the header exactly like tmux-api does)."""
        tail = request.match_info["tail"]
        url = f"{clipboard_base}/{tail}"
        await maybe_delay(f"/{tail}", request.rel_url.path)
        headers = {
            k: v for k, v in request.headers.items()
            if k.lower() not in HOP_BY_HOP
        }
        headers["X-Authentik-Username"] = args.user
        body = await request.read()
        try:
            async with request.app["client"].request(
                request.method, url, params=request.rel_url.query,
                headers=headers, data=body if body else None,
                allow_redirects=False,
            ) as upstream:
                payload = await upstream.read()
                resp_headers = {
                    k: v for k, v in upstream.headers.items()
                    if k.lower() not in HOP_BY_HOP
                }
                log(f"{request.method} /clipboard/{tail} → {upstream.status}")
                return web.Response(status=upstream.status, body=payload,
                                    headers=resp_headers)
        except aiohttp.ClientError as exc:
            log(f"{request.method} /clipboard/{tail} → 502 ({exc})")
            return web.Response(status=502,
                                text=f"clipboard-upload upstream error: {exc}")

    async def asset_proxy(request: web.Request) -> web.StreamResponse:
        """One of ASSET_PATHS → clipboard-upload, path UNSTRIPPED and NO
        X-Authentik-Username injected (the prod carve-out routes these
        outside Authentik; the Go asset handlers never read the header)."""
        url = f"{clipboard_base}{request.rel_url.raw_path}"
        await maybe_delay(request.rel_url.raw_path)
        headers = {
            k: v for k, v in request.headers.items()
            if k.lower() not in HOP_BY_HOP
        }
        body = await request.read()
        try:
            async with request.app["client"].request(
                request.method, url, params=request.rel_url.query,
                headers=headers, data=body if body else None,
                allow_redirects=False,
            ) as upstream:
                payload = await upstream.read()
                resp_headers = {
                    k: v for k, v in upstream.headers.items()
                    if k.lower() not in HOP_BY_HOP
                }
                log(f"{request.method} {request.rel_url.raw_path} → "
                    f"{upstream.status} (public asset)")
                return web.Response(status=upstream.status, body=payload,
                                    headers=resp_headers)
        except aiohttp.ClientError as exc:
            log(f"{request.method} {request.rel_url.raw_path} → 502 ({exc})")
            return web.Response(status=502,
                                text=f"clipboard-upload upstream error: {exc}")

    async def ws_proxy(request: web.Request) -> web.StreamResponse:
        """Bidirectional WebSocket pump browser ⇄ ttyd (subprotocol 'tty')."""
        offered = [
            p.strip()
            for p in request.headers.get("Sec-WebSocket-Protocol", "").split(",")
            if p.strip()
        ]
        ws_client = web.WebSocketResponse(protocols=offered or ("tty",))
        await ws_client.prepare(request)

        url = f"ws://127.0.0.1:{args.ttyd_port}{request.rel_url.raw_path}"
        if request.rel_url.query_string:
            url += "?" + request.rel_url.query_string
        try:
            ws_up = await request.app["client"].ws_connect(
                url, protocols=offered or ("tty",))
        except aiohttp.ClientError as exc:
            log(f"WS {request.rel_url} → upstream connect failed: {exc}")
            await ws_client.close()
            return ws_client
        log(f"WS open {request.rel_url} (subprotocol={ws_client.ws_protocol!r})")

        async def pump(src, dst):
            async for msg in src:
                if msg.type == WSMsgType.BINARY:
                    await dst.send_bytes(msg.data)
                elif msg.type == WSMsgType.TEXT:
                    await dst.send_str(msg.data)
                elif msg.type in (WSMsgType.CLOSE, WSMsgType.CLOSING,
                                  WSMsgType.CLOSED, WSMsgType.ERROR):
                    break

        t1 = asyncio.create_task(pump(ws_client, ws_up))
        t2 = asyncio.create_task(pump(ws_up, ws_client))
        try:
            await asyncio.wait({t1, t2}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for t in (t1, t2):
                t.cancel()
            await asyncio.gather(t1, t2, return_exceptions=True)
            if not ws_up.closed:
                await ws_up.close()
            if not ws_client.closed:
                await ws_client.close()
        log(f"WS closed {request.rel_url}")
        return ws_client

    async def ttyd_proxy(request: web.Request) -> web.StreamResponse:
        """Everything that isn't /api/sessions/*: plain HTTP or WS to ttyd."""
        if (request.headers.get("Upgrade", "").lower() == "websocket"
                and "upgrade" in request.headers.get("Connection", "").lower()):
            return await ws_proxy(request)

        await maybe_delay(request.rel_url.raw_path)
        url = f"{ttyd_base}{request.rel_url.raw_path}"
        headers = {
            k: v for k, v in request.headers.items()
            if k.lower() not in HOP_BY_HOP
        }
        body = await request.read()
        try:
            async with request.app["client"].request(
                request.method, url, params=request.rel_url.query,
                headers=headers, data=body if body else None,
                allow_redirects=False,
            ) as upstream:
                payload = await upstream.read()
                resp_headers = {
                    k: v for k, v in upstream.headers.items()
                    if k.lower() not in HOP_BY_HOP
                }
                log(f"{request.method} {request.rel_url.raw_path} → {upstream.status}")
                return web.Response(status=upstream.status, body=payload,
                                    headers=resp_headers)
        except aiohttp.ClientError as exc:
            log(f"{request.method} {request.rel_url.raw_path} → 502 ({exc})")
            return web.Response(status=502, text=f"ttyd upstream error: {exc}")

    async def on_startup(app: web.Application) -> None:
        app["client"] = aiohttp.ClientSession(auto_decompress=False)

    async def on_cleanup(app: web.Application) -> None:
        await app["client"].close()

    app = web.Application()
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    app.router.add_route("*", "/api/sessions/{tail:.*}", api_proxy)
    app.router.add_route("*", "/clipboard/{tail:.*}", clipboard_proxy)
    for pfx in SE_PREFIXES:
        app.router.add_route("*", f"/{pfx}/{{tail:.*}}", session_events_proxy)
    for asset_path in ASSET_PATHS:  # exact paths, before the catch-all
        app.router.add_route("*", asset_path, asset_proxy)
    app.router.add_route("*", "/{tail:.*}", ttyd_proxy)
    return app


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--index", default=DEFAULT_INDEX,
                        help=f"index.html source for ttyd -I; the build stamp is "
                             f"applied to a copy (default: {DEFAULT_INDEX})")
    parser.add_argument("--session", default=None,
                        help="tmux session name to create/attach "
                             "(default: main in scratch mode, copytest with --no-scratch)")
    parser.add_argument("--scratch", action=argparse.BooleanOptionalAction,
                        default=True,
                        help="run the ttyd child against an isolated scratch tmux "
                             f"server (tmux -L {SCRATCH_SOCKET}), killed on exit; "
                             "--no-scratch attaches the REAL default tmux server "
                             "(pre-battery behavior)")
    parser.add_argument("--proxy-port", type=int, default=7997)
    parser.add_argument("--ttyd-port", type=int, default=7996)
    parser.add_argument("--session-events-base", default="http://127.0.0.1:7685",
                        help="session-events base (default the live one on :7685) — "
                             "text mode's transcript, pane and / catalogue")
    parser.add_argument("--tmux-api-port", type=int, default=7684,
                        help="tmux-api port on 127.0.0.1 (default 7684 = the live "
                             "service; point at a scratch `go run .` build to test "
                             "server changes)")
    parser.add_argument("--clipboard-port", type=int, default=7683,
                        help="clipboard-upload port on 127.0.0.1 (default 7683 = "
                             "the live service)")
    parser.add_argument("--api", default=None,
                        help="full tmux-api base URL (overrides --tmux-api-port)")
    parser.add_argument("--user", default="vbarzin",
                        help="value for the injected X-Authentik-Username header")
    parser.add_argument("--delay", action="append", metavar="/PATH=SECS",
                        help="debug: sleep SECS before proxying requests whose "
                             "path starts with /PATH (repeatable), e.g. "
                             "--delay /sessions=20")
    parser.add_argument("--ttyd-bin", default="ttyd",
                        help="ttyd binary for the child (default: ttyd from "
                             "PATH; point at out/ttyd to exercise a fresh "
                             "scripts/build-ttyd.sh build, e.g. for the "
                             "flow-control battery — plan Task 3.4)")
    parser.add_argument("--no-ttyd", action="store_true",
                        help="don't spawn ttyd; assume one is already on --ttyd-port")
    parser.add_argument("--kill-session-on-exit", action="store_true",
                        help="tmux kill-session the --session on shutdown "
                             "(scratch mode already kills its whole server)")
    args = parser.parse_args()

    if not os.path.isfile(args.index):
        parser.error(f"index file not found: {args.index}")

    args.delays = parse_delays(args.delay)
    args.api_base = (args.api or f"http://127.0.0.1:{args.tmux_api_port}").rstrip("/")
    args.clipboard_base = f"http://127.0.0.1:{args.clipboard_port}"
    socket_name = SCRATCH_SOCKET if args.scratch else None
    if args.session is None:
        args.session = "main" if args.scratch else "copytest"

    ensure_tmux_session(args.session, socket_name)

    ttyd_proc = None
    if not args.no_ttyd:
        index_for_ttyd = build_stamped_index(args.index)
        ttyd_proc = start_ttyd(args.ttyd_port, index_for_ttyd, args.session,
                               socket_name, ttyd_bin=args.ttyd_bin)
    wait_for_port(args.ttyd_port)

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    def shutdown(*_sig) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, shutdown)

    app = make_app(args)
    log(f"proxy on http://127.0.0.1:{args.proxy_port}  "
        f"(index={args.index}, session={args.session}"
        f"{f' [scratch -L {SCRATCH_SOCKET}]' if args.scratch else ''}, "
        f"api={args.api_base}, clipboard={args.clipboard_base}, "
        f"user={args.user})")
    try:
        web.run_app(app, host="127.0.0.1", port=args.proxy_port,
                    print=None, handle_signals=False, loop=loop)
    except KeyboardInterrupt:
        pass
    finally:
        if ttyd_proc is not None:
            ttyd_proc.terminate()
            try:
                ttyd_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                ttyd_proc.kill()
            log("ttyd child stopped")
        if args.scratch and ttyd_proc is not None:
            # Scratch teardown: the whole tl-dev server goes away. Only when
            # this harness spawned the ttyd child — with --no-ttyd the scratch
            # server may belong to someone else's run.
            subprocess.run([*tmux_base(SCRATCH_SOCKET), "kill-server"],
                           capture_output=True)
            log(f"scratch tmux server '-L {SCRATCH_SOCKET}' killed")
        elif args.kill_session_on_exit:
            subprocess.run([*tmux_base(socket_name), "kill-session",
                            "-t", f"={args.session}"],
                           capture_output=True)
            log(f"tmux session '{args.session}' killed")


if __name__ == "__main__":
    main()
