#!/usr/bin/env python3
"""qa-harness.py — ingress-faithful loopback proxy for the DEV TIER, with a
mutation guard.

Companion to dev-harness.py, but a different job. dev-harness.py runs the
VANILLA page against a scratch ttyd + scratch tmux server. This one puts a QA
fleet in front of the **already-deployed** v2 SPA and the **real** backends, on
the devvm itself — so what the agents click is byte-for-byte what
terminal-dev.viktorbarzin.me serves.

    browser ── http://127.0.0.1:7998 (this script)
      ├─ 10 exact PWA paths      → :7683 clipboard-upload, UNSTRIPPED, NO auth
      │                            (mirrors the public auth="none" carve-out)
      ├─ /term.html              → :7683 clipboard-upload, UNSTRIPPED, authed
      ├─ /api/sessions/*         → :7684 tmux-api, prefix STRIPPED, authed
      ├─ /clipboard/*            → :7683 clipboard-upload, prefix stripped, authed
      ├─ /events/*               → :7685 session-events, no strip, authed, STREAMED
      ├─ /prompt/*  /cancel/*    → :7685 session-events, no strip, authed
      ├─ /permission/*           → :7685 session-events, no strip, authed  (†)
      ├─ /files/*                → :7686 file-api, no strip, authed
      └─ everything else + /ws   → :7687 ttyd-v2, the DEPLOYED index-v2.html

(†) The production ingress does NOT route /permission — its session-events rule
matches only /events/, /prompt/, /cancel/. That gap is finding B of
docs/plans/2026-08-06-dev-tier-qa-fix-loop.md. Routing it here lets the fleet
exercise the panel while the ingress fix is in flight; --no-permission-shim
turns the shim off to reproduce production behaviour exactly.

THE GUARD
---------
Agents share this box with wizard's live work and with bob/carol. The guard
is here, in the proxy, rather than in an agent's brief, so it holds regardless of
how any brief is read. Reads are unrestricted; mutations must name a `qa-*`
session. Blocked requests get 403 + a body starting "qa-harness guard:" so an
agent can tell a guard rejection from an application bug.

Blocked (403):
  1. DELETE /sessions/<name>            unless name is qa-*
  2. POST   /sessions/<name>/rename     unless BOTH old and new are qa-*
  3. any mutation of /shares, /shares/* (grants other OS users real access)
  4. POST /projects with a non-qa name; PUT/DELETE of a project this run
     did not create
  5. POST /prompt/<s>, /cancel/<s>      unless s is qa-*
  6. POST /files/write                  unless the path is under --scratch
  7. WS upgrade whose first ?arg= is not qa-*   (a ttyd attach is WRITABLE:
     `tmux new-session -A` would both create the session and hand the agent a
     live keyboard into it)
  8. DELETE /push-subscriptions         (would unsubscribe real devices)

Allowed, but restored on exit: PUT /layout and PUT /prefs rewrite wizard's real
sidebar arrangement and roamed preferences. Both are snapshotted at startup and
written back on shutdown, so a fleet that drag-reorders everything and cycles
all nine themes leaves the sidebar as it found it.

Usage:
    python3 scripts/qa-harness.py                  # :7998, user alice
    python3 scripts/qa-harness.py --port 7999      # a second, isolated fleet
    python3 scripts/qa-harness.py --no-restore     # keep whatever the fleet did
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import signal
import sys
from typing import Optional
from urllib.parse import unquote

try:
    import aiohttp
    from aiohttp import WSMsgType, web
except ImportError:  # pragma: no cover - operator-facing
    sys.exit("qa-harness.py needs aiohttp: pip install --user aiohttp")

# Upstreams — every one of them is on this box (we run ON the devvm).
TTYD_V2 = "http://127.0.0.1:7687"
TMUX_API = "http://127.0.0.1:7684"
CLIPBOARD = "http://127.0.0.1:7683"
SESSION_EVENTS = "http://127.0.0.1:7685"
FILE_API = "http://127.0.0.1:7686"

HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host",
    "content-length", "content-encoding",
}

# The exact public-asset paths the prod ingress carves out of Authentik. Kept
# in lockstep with clipboard-upload's publicAssets whitelist and dev-harness's
# ASSET_PATHS; term.html is deliberately NOT here (it is authed).
ASSET_PATHS = (
    "/manifest.webmanifest",
    "/icon-192.png",
    "/icon-512.png",
    "/icon-512-maskable.png",
    "/sw.js",
    "/fonts/JetBrainsMono-Regular.woff2",
    "/fonts/JetBrainsMono-Bold.woff2",
    "/fonts/JetBrainsMono-Italic.woff2",
    "/fonts/JetBrainsMono-BoldItalic.woff2",
    "/fonts/dm-sans-latin-wght-normal.woff2",
)

# tmux-api's own sessionNameRe is ^[a-zA-Z0-9_-]{1,32}$, so a qa- prefix with
# hyphens is a legal session name. Anchored both ends: "qa" alone, "myqa-x" and
# "qa-" with nothing after it are all non-qa.
QA_NAME = re.compile(r"^qa-[A-Za-z0-9_-]{1,29}$")

RE_SESSION = re.compile(r"^sessions/([^/]+)$")
RE_RENAME = re.compile(r"^sessions/([^/]+)/rename$")
RE_PROJECT_ID = re.compile(r"^projects/([^/]+)")


def is_qa(name: str) -> bool:
    return bool(QA_NAME.match(name or ""))


class Guard:
    """Decides which mutations are allowed. Pure except for the set of project
    ids this run created, which it tracks so a project the fleet made can also
    be edited and deleted by it."""

    def __init__(self, scratch: str) -> None:
        self.scratch = scratch.rstrip("/") + "/"
        self.own_projects: set[str] = set()
        self.blocked: list[str] = []

    def record_project(self, body: bytes, response: bytes) -> None:
        """After a permitted POST /projects, remember the new id."""
        try:
            pid = json.loads(response).get("id")
        except (ValueError, AttributeError):
            return
        if pid:
            self.own_projects.add(str(pid))

    def check_tmux_api(self, method: str, tail: str, body: bytes) -> Optional[str]:
        """`tail` is the path AFTER the stripped /api/sessions/ prefix."""
        m = RE_SESSION.match(tail)
        if m and method == "DELETE":
            name = unquote(m.group(1))
            if not is_qa(name):
                return f"refusing to kill {name!r} — only qa-* sessions may be killed"

        m = RE_RENAME.match(tail)
        if m and method == "POST":
            old = unquote(m.group(1))
            if not is_qa(old):
                return f"refusing to rename {old!r} — only qa-* sessions may be renamed"
            new = ""
            try:
                new = str(json.loads(body or b"{}").get("name", "")).strip()
            except ValueError:
                return "rename body was not JSON, refusing to guess the target name"
            if not is_qa(new):
                return (f"refusing to rename {old!r} to {new!r} — the new name must "
                        f"stay qa-*")

        if tail.startswith("shares") and method != "GET":
            return ("refusing to mutate shares — a share grants another OS user "
                    "access to a real session")

        if tail == "projects" and method == "POST":
            try:
                name = str(json.loads(body or b"{}").get("name", "")).strip()
            except ValueError:
                return "project body was not JSON, refusing to guess the name"
            if not is_qa(name):
                return f"refusing to create project {name!r} — name must be qa-*"

        m = RE_PROJECT_ID.match(tail)
        if m and method in ("PUT", "PATCH", "DELETE"):
            pid = unquote(m.group(1))
            if pid not in self.own_projects:
                return (f"refusing to {method} project {pid!r} — this run did not "
                        f"create it")

        if tail.startswith("push-subscriptions") and method == "DELETE":
            return "refusing to delete push subscriptions — real devices are subscribed"

        return None

    def check_events(self, method: str, path: str) -> Optional[str]:
        m = re.match(r"^/(prompt|cancel)/([^/]+)", path)
        if m and method == "POST":
            verb, session = m.group(1), unquote(m.group(2))
            if not is_qa(session):
                return (f"refusing to {verb} session {session!r} — that would type "
                        f"into a live Claude; only qa-* sessions accept input")
        return None

    def check_files(self, method: str, path: str, body: bytes) -> Optional[str]:
        if path == "/files/write" and method == "POST":
            try:
                target = str(json.loads(body or b"{}").get("path", ""))
            except ValueError:
                return "write body was not JSON, refusing to guess the target path"
            if not target.startswith(self.scratch):
                return (f"refusing to write {target!r} — writes are confined to "
                        f"{self.scratch}")
        return None

    def check_ws(self, query) -> Optional[str]:
        args = query.getall("arg", [])
        if not args:
            return None  # no session named; ttyd falls back to its unit default
        session = args[0]
        if not is_qa(session):
            return (f"refusing a terminal attach to {session!r} — a ttyd attach is "
                    f"writable and would create-or-drive a real session; only qa-* "
                    f"sessions may be attached")
        return None

    def deny(self, reason: str, where: str) -> web.Response:
        self.blocked.append(f"{where}: {reason}")
        return web.Response(status=403, text=f"qa-harness guard: {reason}\n")


def build_app(args: argparse.Namespace) -> web.Application:
    guard = Guard(args.scratch)
    app = web.Application()
    app["guard"] = guard

    def log(msg: str) -> None:
        if not args.quiet:
            print(f"[qa-harness] {msg}", flush=True)

    def fwd_headers(request: web.Request, auth: bool) -> dict:
        headers = {k: v for k, v in request.headers.items()
                   if k.lower() not in HOP_BY_HOP}
        if auth:
            headers["X-Authentik-Username"] = args.user
        else:
            headers.pop("X-Authentik-Username", None)
        return headers

    async def forward(request: web.Request, url: str, *, auth: bool,
                      label: str, body: Optional[bytes] = None) -> web.StreamResponse:
        payload = request_body = body if body is not None else await request.read()
        try:
            async with request.app["client"].request(
                request.method, url, params=request.rel_url.query,
                headers=fwd_headers(request, auth),
                data=request_body if request_body else None,
                allow_redirects=False,
            ) as upstream:
                payload = await upstream.read()
                resp_headers = {k: v for k, v in upstream.headers.items()
                                if k.lower() not in HOP_BY_HOP}
                log(f"{request.method} {label} → {upstream.status}")
                return web.Response(status=upstream.status, body=payload,
                                    headers=resp_headers)
        except aiohttp.ClientError as exc:
            log(f"{request.method} {label} → 502 ({exc})")
            return web.Response(status=502, text=f"upstream error: {exc}")

    # ---- /events/* : SSE, so it must STREAM ---------------------------------
    # Buffering here would hold the whole event stream open in memory and never
    # deliver a byte — the Text view would look permanently empty, which is
    # exactly the class of bug the fleet is hunting. Chunks are relayed as they
    # arrive.
    async def events_proxy(request: web.Request) -> web.StreamResponse:
        url = f"{SESSION_EVENTS}{request.rel_url.raw_path}"
        try:
            async with request.app["client"].request(
                request.method, url, params=request.rel_url.query,
                headers=fwd_headers(request, auth=True),
                allow_redirects=False,
            ) as upstream:
                resp_headers = {k: v for k, v in upstream.headers.items()
                                if k.lower() not in HOP_BY_HOP}
                resp_headers.setdefault("Cache-Control", "no-cache")
                resp_headers.setdefault("X-Accel-Buffering", "no")
                downstream = web.StreamResponse(status=upstream.status,
                                                headers=resp_headers)
                await downstream.prepare(request)
                log(f"SSE open {request.rel_url.raw_path} → {upstream.status}")
                try:
                    async for chunk in upstream.content.iter_any():
                        await downstream.write(chunk)
                except (asyncio.CancelledError, ConnectionResetError):
                    pass
                finally:
                    log(f"SSE close {request.rel_url.raw_path}")
                await downstream.write_eof()
                return downstream
        except aiohttp.ClientError as exc:
            log(f"SSE {request.rel_url.raw_path} → 502 ({exc})")
            return web.Response(status=502, text=f"session-events error: {exc}")

    async def control_proxy(request: web.Request) -> web.StreamResponse:
        path = request.rel_url.path
        if path.startswith("/permission") and not args.permission_shim:
            # Reproduce production: the ingress has no /permission rule, so the
            # request falls through to the SPA's catch-all and gets HTML back.
            return await forward(request, f"{TTYD_V2}{request.rel_url.raw_path}",
                                 auth=True, label=f"{path} (no shim → ttyd-v2)")
        body = await request.read()
        reason = guard.check_events(request.method, path)
        if reason:
            return guard.deny(reason, path)
        return await forward(request, f"{SESSION_EVENTS}{request.rel_url.raw_path}",
                             auth=True, label=path, body=body)

    async def api_proxy(request: web.Request) -> web.StreamResponse:
        tail = request.match_info["tail"]
        body = await request.read()
        reason = guard.check_tmux_api(request.method, tail, body)
        if reason:
            return guard.deny(reason, f"/api/sessions/{tail}")
        resp = await forward(request, f"{TMUX_API}/{tail}", auth=True,
                             label=f"/api/sessions/{tail}", body=body)
        if tail == "projects" and request.method == "POST" and resp.status < 300:
            guard.record_project(body, resp.body or b"")
        return resp

    async def files_proxy(request: web.Request) -> web.StreamResponse:
        body = await request.read()
        reason = guard.check_files(request.method, request.rel_url.path, body)
        if reason:
            return guard.deny(reason, request.rel_url.path)
        return await forward(request, f"{FILE_API}{request.rel_url.raw_path}",
                             auth=True, label=request.rel_url.path, body=body)

    async def clipboard_proxy(request: web.Request) -> web.StreamResponse:
        tail = request.match_info["tail"]
        return await forward(request, f"{CLIPBOARD}/{tail}", auth=True,
                             label=f"/clipboard/{tail}")

    async def asset_proxy(request: web.Request) -> web.StreamResponse:
        return await forward(request, f"{CLIPBOARD}{request.rel_url.raw_path}",
                             auth=False,
                             label=f"{request.rel_url.raw_path} (public asset)")

    async def term_html_proxy(request: web.Request) -> web.StreamResponse:
        return await forward(request, f"{CLIPBOARD}/term.html", auth=True,
                             label="/term.html")

    async def ws_proxy(request: web.Request) -> web.StreamResponse:
        reason = guard.check_ws(request.rel_url.query)
        if reason:
            return guard.deny(reason, request.rel_url.path)

        offered = [p.strip() for p
                   in request.headers.get("Sec-WebSocket-Protocol", "").split(",")
                   if p.strip()]
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
        log(f"WS open {request.rel_url}")

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
        if (request.headers.get("Upgrade", "").lower() == "websocket"
                and "upgrade" in request.headers.get("Connection", "").lower()):
            return await ws_proxy(request)
        return await forward(request, f"{TTYD_V2}{request.rel_url.raw_path}",
                             auth=True, label=request.rel_url.raw_path)

    # ---- roamed state we borrow and give back ------------------------------
    async def snapshot(app: web.Application) -> None:
        app["snapshots"] = {}
        if args.no_restore:
            return
        for name in ("layout", "prefs"):
            try:
                async with app["client"].get(
                    f"{TMUX_API}/{name}",
                    headers={"X-Authentik-Username": args.user},
                ) as r:
                    if r.status == 200:
                        app["snapshots"][name] = await r.read()
                        log(f"snapshotted /{name} ({len(app['snapshots'][name])} bytes)")
                    else:
                        log(f"could NOT snapshot /{name} (HTTP {r.status}) — "
                            f"it will not be restored")
            except aiohttp.ClientError as exc:
                log(f"could NOT snapshot /{name} ({exc}) — it will not be restored")

    async def restore(app: web.Application) -> None:
        for name, blob in (app.get("snapshots") or {}).items():
            try:
                async with app["client"].put(
                    f"{TMUX_API}/{name}", data=blob,
                    headers={"X-Authentik-Username": args.user,
                             "Content-Type": "application/json"},
                ) as r:
                    log(f"restored /{name} → HTTP {r.status}")
            except aiohttp.ClientError as exc:
                log(f"FAILED to restore /{name}: {exc}")

    async def on_startup(app: web.Application) -> None:
        app["client"] = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=None, sock_connect=10))
        await snapshot(app)

    async def on_cleanup(app: web.Application) -> None:
        await restore(app)
        if guard.blocked:
            log(f"guard blocked {len(guard.blocked)} request(s):")
            for entry in guard.blocked:
                log(f"  · {entry}")
        await app["client"].close()

    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)

    # Order matters: aiohttp matches resources in registration order.
    for path in ASSET_PATHS:
        app.router.add_route("*", path, asset_proxy)
    app.router.add_route("*", "/term.html", term_html_proxy)
    app.router.add_route("*", "/api/sessions/{tail:.*}", api_proxy)
    app.router.add_route("*", "/clipboard/{tail:.*}", clipboard_proxy)
    app.router.add_route("*", "/events/{tail:.*}", events_proxy)
    for prefix in ("prompt", "cancel", "permission"):
        app.router.add_route("*", f"/{prefix}/{{tail:.*}}", control_proxy)
    app.router.add_route("*", "/files/{tail:.*}", files_proxy)
    app.router.add_route("*", "/{tail:.*}", ttyd_proxy)
    return app


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--port", type=int, default=7998, help="proxy listen port")
    p.add_argument("--user", default="alice",
                   help="value injected as X-Authentik-Username")
    p.add_argument("--ttyd-port", type=int, default=7687,
                   help="ttyd serving the SPA (7687 = the deployed v2 tier)")
    p.add_argument("--scratch", default="/tmp/qa-harness-scratch",
                   help="the only tree /files/write may target")
    p.add_argument("--no-permission-shim", dest="permission_shim",
                   action="store_false",
                   help="do NOT route /permission to session-events, reproducing "
                        "the production ingress gap (finding B)")
    p.add_argument("--no-restore", action="store_true",
                   help="do not snapshot/restore /layout and /prefs")
    p.add_argument("--quiet", action="store_true")
    args = p.parse_args()

    import os
    os.makedirs(args.scratch, exist_ok=True)

    app = build_app(args)
    print(f"[qa-harness] http://127.0.0.1:{args.port}  user={args.user}  "
          f"spa=:{args.ttyd_port}  scratch={args.scratch}", flush=True)
    print(f"[qa-harness] mutations restricted to qa-* sessions; "
          f"permission shim {'ON' if args.permission_shim else 'OFF'}", flush=True)

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    runner = web.AppRunner(app)
    loop.run_until_complete(runner.setup())
    site = web.TCPSite(runner, "127.0.0.1", args.port)
    loop.run_until_complete(site.start())

    stop = loop.create_future()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, lambda: stop.done() or stop.set_result(None))
        except NotImplementedError:  # pragma: no cover
            pass
    try:
        loop.run_until_complete(stop)
    finally:
        loop.run_until_complete(runner.cleanup())
        loop.close()


if __name__ == "__main__":
    main()
