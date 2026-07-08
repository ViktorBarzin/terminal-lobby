#!/usr/bin/env python3
"""Local dev harness for terminal-lobby's frontend/index.html.

Makes the REAL page fully functional on loopback without Authentik/nginx:

    browser ──► http://127.0.0.1:7997  (this aiohttp reverse proxy)
                   ├── /api/sessions/*  → http://127.0.0.1:7684/*  (live tmux-api,
                   │                      prefix stripped, X-Authentik-Username added)
                   ├── /clipboard/*     → http://127.0.0.1:7683/*  (clipboard-upload,
                   │                      prefix stripped — paste-upload E2E; run
                   │                      `cd clipboard-upload && go run .` locally)
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

Usage:
    python3 scripts/dev-harness.py [--index PATH] [--session copytest]
        [--proxy-port 7997] [--ttyd-port 7996]
        [--api http://127.0.0.1:7684] [--user vbarzin]
        [--kill-session-on-exit]

Then open:  http://127.0.0.1:7997/?arg=<session>   (terminal mode)
            http://127.0.0.1:7997/                 (lobby mode)

Stop with Ctrl+C / SIGTERM; the ttyd child is killed on exit. Everything
binds to 127.0.0.1 only. Requires: aiohttp, ttyd, tmux.
"""

import argparse
import asyncio
import os
import signal
import socket
import subprocess
import sys

import aiohttp
from aiohttp import WSMsgType, web

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_INDEX = os.path.join(REPO_ROOT, "frontend", "index.html")

# clipboard-upload pins 0.0.0.0:7683 (clipboard-upload/main.go listenAddr),
# so unlike --api there is nothing to configure. It serves /upload + /health.
CLIPBOARD_BASE = "http://127.0.0.1:7683"

# Hop-by-hop headers must not be blindly forwarded.
HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host",
    "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions",
    "sec-websocket-protocol", "accept-encoding", "content-length",
}


def log(msg: str) -> None:
    print(f"[harness] {msg}", file=sys.stderr, flush=True)


def ensure_tmux_session(session: str) -> None:
    """Create the target tmux session if it doesn't exist (detached)."""
    probe = subprocess.run(
        ["tmux", "has-session", "-t", f"={session}"],
        capture_output=True,
    )
    if probe.returncode != 0:
        subprocess.run(
            ["tmux", "new-session", "-d", "-s", session, "-x", "220", "-y", "50"],
            check=True,
        )
        log(f"created tmux session '{session}'")
    else:
        log(f"tmux session '{session}' already exists — reusing")


def start_ttyd(port: int, index: str, session: str) -> subprocess.Popen:
    cmd = [
        "ttyd",
        "--port", str(port),
        "--interface", "127.0.0.1",
        "--writable",                      # ttyd.service: -W
        "-a",                              # ttyd.service: -a (URL ?arg= → argv)
        "-t", "enableClipboard=true",      # ttyd.service: -t enableClipboard=true
        "--index", index,                  # ttyd.service: -I <custom index>
        "tmux", "new", "-As", session,
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    log(f"ttyd started (pid {proc.pid}): {' '.join(cmd)}")
    return proc


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
    api_base = args.api.rstrip("/")

    async def api_proxy(request: web.Request) -> web.StreamResponse:
        """/api/sessions/<tail> → <api_base>/<tail> with the auth header."""
        tail = request.match_info["tail"]
        url = f"{api_base}/{tail}"
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

    async def clipboard_proxy(request: web.Request) -> web.StreamResponse:
        """/clipboard/<tail> → CLIPBOARD_BASE/<tail>, prefix stripped (mirrors
        the prod ingress route to the clipboard-upload service)."""
        tail = request.match_info["tail"]
        url = f"{CLIPBOARD_BASE}/{tail}"
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
                log(f"{request.method} /clipboard/{tail} → {upstream.status}")
                return web.Response(status=upstream.status, body=payload,
                                    headers=resp_headers)
        except aiohttp.ClientError as exc:
            log(f"{request.method} /clipboard/{tail} → 502 ({exc})")
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
    app.router.add_route("*", "/{tail:.*}", ttyd_proxy)
    return app


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--index", default=DEFAULT_INDEX,
                        help=f"index.html for ttyd -I (default: {DEFAULT_INDEX})")
    parser.add_argument("--session", default="copytest",
                        help="tmux session name to create/attach (default: copytest)")
    parser.add_argument("--proxy-port", type=int, default=7997)
    parser.add_argument("--ttyd-port", type=int, default=7996)
    parser.add_argument("--api", default="http://127.0.0.1:7684",
                        help="live tmux-api base URL")
    parser.add_argument("--user", default="vbarzin",
                        help="value for the injected X-Authentik-Username header")
    parser.add_argument("--no-ttyd", action="store_true",
                        help="don't spawn ttyd; assume one is already on --ttyd-port")
    parser.add_argument("--kill-session-on-exit", action="store_true",
                        help="tmux kill-session the --session on shutdown")
    args = parser.parse_args()

    if not os.path.isfile(args.index):
        parser.error(f"index file not found: {args.index}")

    ensure_tmux_session(args.session)

    ttyd_proc = None
    if not args.no_ttyd:
        ttyd_proc = start_ttyd(args.ttyd_port, args.index, args.session)
    wait_for_port(args.ttyd_port)

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    def shutdown(*_sig) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, shutdown)

    app = make_app(args)
    log(f"proxy on http://127.0.0.1:{args.proxy_port}  "
        f"(index={args.index}, session={args.session}, api={args.api}, "
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
        if args.kill_session_on_exit:
            subprocess.run(["tmux", "kill-session", "-t", f"={args.session}"],
                           capture_output=True)
            log(f"tmux session '{args.session}' killed")


if __name__ == "__main__":
    main()
