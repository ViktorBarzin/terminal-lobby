#!/usr/bin/env python3
"""qa-harness.py — ingress-faithful loopback proxy for the DEV TIER, with a
mutation guard.

Companion to dev-harness.py, but a different job. dev-harness.py runs the
VANILLA page against a scratch ttyd + scratch tmux server. This one puts a QA
fleet in front of the **already-deployed** SPA and the **real** backends, on
the devvm itself — so what the agents click is byte-for-byte what
terminal.viktorbarzin.me serves.

    browser ── http://127.0.0.1:7998 (this script)
      ├─ 10 exact PWA paths      → :7683 clipboard-upload, UNSTRIPPED, NO auth
      │  + /assets/*               (mirrors the public auth="none" carve-out;
      │                            /assets/ is the split bundle's hashed chunks)
      ├─ /term.html              → :7683 clipboard-upload, UNSTRIPPED, authed
      ├─ /api/sessions/*         → :7684 tmux-api, prefix STRIPPED, authed
      ├─ /clipboard/*            → :7683 clipboard-upload, prefix stripped, authed
      ├─ /events/*               → :7685 session-events, no strip, authed, STREAMED
      ├─ /prompt/*  /cancel/*    → :7685 session-events, no strip, authed
      ├─ /earlier/* /result/*    → :7685 session-events, no strip, authed
      │  /pane/*    /keys/*         (the rest of the production ingress rule)
      ├─ /permission/*           → :7681 ttyd catch-all, as in production (†)
      ├─ /files/*                → :7686 file-api, no strip, authed
      ├─ /skills, /skills/*      → :7688 skills-api, no strip, authed; READS are
      │                            free, every mutation is refused by default
      └─ everything else + /ws   → :7681 ttyd, the DEPLOYED lobby index.html

(†) /permission has no working destination anywhere, and this proxy cannot
invent one. The production ingress does not route it — the session-events rule
matches /events/, /prompt/, /cancel/, /earlier/, /result/, /pane/ and /keys/,
and nothing else — and session-events has no
/permission handler either: its whole route table is GET /events/{session},
POST /prompt/{session}, POST /cancel/{session}, GET /health and a
localhost-only POST /hooks/session-start. Measured 2026-08-06: POST
/permission/<id> straight at 127.0.0.1:7685 as alice returns
`404 page not found`. So routing /permission to session-events would NOT let
the fleet exercise the panel (an earlier version of this docstring and of
the plan claimed it would); it would only swap the SPA's HTML 404 for
session-events' text/plain 404. The default is therefore production-faithful:
/permission falls through to the ttyd catch-all. --permission-shim routes
it to session-events anyway, for the day a handler lands there.

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
  5. POST /prompt/<s>, /cancel/<s>,
     /keys/<s>, /answer-text/<s>        unless s is qa-*
  6. POST /files/write                  unless the NORMALISED path is under
                                        --scratch (see THE SCRATCH below)
  7. WS upgrade whose first ?arg= is not qa-*   (a ttyd attach is WRITABLE:
     `tmux new-session -A` would both create the session and hand the agent a
     live keyboard into it)
  8. DELETE /push-subscriptions         (would unsubscribe real devices)
  9. POST /restore, but only when the reaper is disarmed — see below

POST /restore is the one mutation that cannot be scoped by name: it shells
`tmux-persist restore <osUser>`, which recreates EVERY session in that user's
manifest that is not currently live, each resuming its Claude conversation. One
agent clicking Restore would resurrect the sessions the rest of the fleet just
killed, and on this box the ones wizard deliberately killed too. Blanket-403 is
wrong (area 7 is chartered to exercise Restore), so instead the proxy snapshots
the live session set, forwards the request, and kills whatever came back that is
new AND not qa-*. If it cannot do that — the injected identity maps to a
different OS user, or `tmux list-sessions` fails — the reaper is disarmed and
/restore gets the 403 instead.

Allowed, but restored on exit: PUT /layout and PUT /prefs rewrite wizard's real
sidebar arrangement and roamed preferences. Both are snapshotted at startup and
written back on shutdown, so a fleet that drag-reorders everything and cycles
all nine themes leaves the sidebar as it found it.

THE SCRATCH
-----------
--scratch defaults to /home/<osUser>/qa-harness-scratch, created at startup.
It has to sit INSIDE file-api's own containment root — file-api confines every
path to /home/<osUser> (file-api/auth.go: homeBase "/home", userHome()) — or
the guard and the server permit disjoint sets and no write can land anywhere.
That is what the original /tmp default did: the guard allowed the write and
file-api answered 400 "invalid path", which the editor renders as "Can't save
this path (not a regular file)." (frontend-v2/src/lib/file-api.ts,
writeErrorMessage); aim at the home instead and the guard's own 403 renders as
"Not authorized to save this file.". Either way the save looks like a product
bug. Because the scratch now shares a root with everything else the
caller owns, the guard matches on the NORMALISED path: one ".." would otherwise
leave the scratch and still land somewhere file-api writes happily.

Usage:
    python3 scripts/qa-harness.py                  # :7998, user alice
    python3 scripts/qa-harness.py --port 7999      # a second, isolated fleet
    python3 scripts/qa-harness.py --no-restore     # keep whatever the fleet did
    python3 scripts/qa-harness.py --scratch DIR    # only if DIR is under /home/<osUser>
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import pwd
import re
import signal
import subprocess
import sys
from typing import Optional
from urllib.parse import unquote

try:
    import aiohttp
    from aiohttp import WSMsgType, web
except ImportError:  # pragma: no cover - operator-facing
    sys.exit("qa-harness.py needs aiohttp: pip install --user aiohttp")

# Upstreams — every one of them is on this box (we run ON the devvm).
# ttyd :7681 serves the lobby SPA. It used to be :7687 (ttyd-v2, the
# terminal-dev canary) until that tier was retired on 2026-08-16 and prod became
# the only place the SPA runs. --ttyd-port still moves it.
TTYD_DEFAULT_PORT = 7681
TMUX_API = "http://127.0.0.1:7684"
CLIPBOARD = "http://127.0.0.1:7683"
SESSION_EVENTS = "http://127.0.0.1:7685"
FILE_API = "http://127.0.0.1:7686"
SKILLS_API = "http://127.0.0.1:7688"

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


def tmux_session_names() -> Optional[list[str]]:
    """Live sessions on THIS OS user's tmux server, or None if unreadable.

    Uncached on purpose: tmux-api caches /sessions for 5 s, and a stale baseline
    would make the reaper mistake a session created moments ago for one the
    restore resurrected — and kill it.
    """
    try:
        r = subprocess.run(["tmux", "list-sessions", "-F", "#{session_name}"],
                           capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0:
        # No server at all is a real, empty answer; anything else is a failure
        # we must not paper over with an empty baseline.
        if "no server running" in (r.stderr or "").lower():
            return []
        return None
    return [line for line in r.stdout.splitlines() if line.strip()]


def tmux_kill_session(name: str) -> bool:
    """`=name` is tmux's exact-match form — no prefix or fnmatch surprises."""
    try:
        r = subprocess.run(["tmux", "kill-session", "-t", f"={name}"],
                           capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return False
    return r.returncode == 0


def proxy_os_user() -> str:
    """The OS user whose tmux server this process can actually reach — read
    from the uid, not from $USER, which a launcher can set to anything."""
    return pwd.getpwuid(os.getuid()).pw_name


# file-api's containment root is /home/<osUser> (file-api/auth.go: homeBase
# "/home", userHome()). Mirrored here rather than read from passwd, because
# file-api joins the literal "/home" with the mapped user name and never
# consults pw_dir — a user whose passwd home is elsewhere would still be
# confined to /home/<name>.
FILE_API_HOME_BASE = "/home"


def default_scratch() -> str:
    """The only tree /files/write may target, by default.

    It has to satisfy BOTH gates or no write can ever land: the guard below,
    and file-api's own /home/<osUser> containment. A /tmp scratch satisfies
    only the guard — file-api answers 400 "invalid path", the editor renders
    that as "Can't save this path (not a regular file).", and the save
    round-trip looks like a product bug to every sweep agent.

    Keyed on the OS user this proxy RUNS as, which is also the user whose home
    it can create the directory in. When --user maps to a different OS user
    (tmux-api /whoami disagrees; arm_reaper logs it), pass --scratch explicitly.
    """
    return os.path.join(FILE_API_HOME_BASE, proxy_os_user(), "qa-harness-scratch")


def sessions_to_reap(before: list[str], after: list[str]) -> list[str]:
    """Sessions a /restore brought back that were not there before it, minus the
    qa-* ones (area 7 restoring a qa-* session it killed is the point)."""
    return sorted(set(after) - set(before) - {n for n in after if is_qa(n)})


class Guard:
    """Decides which mutations are allowed. Pure except for the set of project
    ids this run created, which it tracks so a project the fleet made can also
    be edited and deleted by it."""

    def __init__(self, scratch: str, *, can_reap: bool = False) -> None:
        self.scratch = os.path.normpath(scratch).rstrip("/") + "/"
        self.own_projects: set[str] = set()
        self.blocked: list[str] = []
        # Armed at startup once the proxy has proved it can undo a /restore.
        # Default off: a Guard that has not proved it refuses.
        self.can_reap = can_reap
        self.reaped: list[str] = []

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
            except (ValueError, AttributeError):
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
            except (ValueError, AttributeError):
                return "project body was not JSON, refusing to guess the name"
            if not is_qa(name):
                return f"refusing to create project {name!r} — name must be qa-*"

        m = RE_PROJECT_ID.match(tail)
        if m and method in ("PUT", "PATCH", "DELETE"):
            pid = unquote(m.group(1))
            if pid not in self.own_projects:
                return (f"refusing to {method} project {pid!r} — this run did not "
                        f"create it")

        if tail == "restore" and method == "POST" and not self.can_reap:
            return ("refusing to restore — a restore resurrects every saved "
                    "session of the OS user, and this proxy cannot undo it "
                    "(the reaper is disarmed; see the startup log for why)")

        if tail.startswith("push-subscriptions") and method == "DELETE":
            return "refusing to delete push subscriptions — real devices are subscribed"

        return None

    def check_events(self, method: str, path: str) -> Optional[str]:
        m = re.match(r"^/(prompt|cancel|keys|answer-text)/([^/]+)", path)
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
            except (ValueError, AttributeError):
                return "write body was not JSON, refusing to guess the target path"
            # Compare the NORMALISED path. The scratch lives inside
            # /home/<osUser>, which is file-api's whole containment root, so a
            # single ".." walks out of the scratch onto a path file-api is
            # perfectly happy to write — a raw prefix check would hand the
            # fleet the entire home directory. A relative path normalises to
            # something that cannot match the absolute scratch, so it is
            # refused rather than guessed at.
            if not os.path.normpath(target).startswith(self.scratch):
                return (f"refusing to write {target!r} — writes are confined to "
                        f"{self.scratch}")
        return None

    def check_skills(self, method: str, path: str) -> Optional[str]:
        """Reads are unrestricted; mutations are not.

        Unlike a session, a skill has no qa-* namespace to sandbox into: an
        install, a toggle, a remove or a restart lands in the real account the
        harness is authenticating as. Browsing the panel is what a QA lane needs,
        so reads pass and writes are refused with the curl that would do it for
        real — deliberately, rather than by omission.
        """
        if method in ("GET", "HEAD", "OPTIONS"):
            return None
        # /skills/source/inspect is a POST that installs NOTHING: it reads a repo
        # and reports what it offers. Refusing it would make the install field
        # untestable through the harness while protecting nothing.
        if path == "/skills/source/inspect":
            return None
        return (f"refusing {method} {path} — a skill mutation lands in the real "
                f"account (no qa-* namespace exists for skills). Run it against "
                f"127.0.0.1:7688 directly if that is what you mean.")

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
    restore_lock = asyncio.Lock()
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

    def ttyd_base() -> str:
        """The ttyd serving the SPA. Read through --ttyd-port rather than a
        module constant: the HTTP forwarders used to hardcode it while only the
        WebSocket path honoured the flag, so pointing the harness at another
        ttyd moved the socket and left every page load on the old one."""
        return f"http://127.0.0.1:{args.ttyd_port}"

    async def control_proxy(request: web.Request) -> web.StreamResponse:
        path = request.rel_url.path
        if path.startswith("/permission") and not args.permission_shim:
            # Reproduce production: the ingress has no /permission rule, so the
            # request falls through to the SPA's catch-all and gets HTML back.
            return await forward(
                request, f"{ttyd_base()}{request.rel_url.raw_path}",
                auth=True, label=f"{path} (no shim → ttyd catch-all)")
        body = await request.read()
        reason = guard.check_events(request.method, path)
        if reason:
            return guard.deny(reason, path)
        return await forward(request, f"{SESSION_EVENTS}{request.rel_url.raw_path}",
                             auth=True, label=path, body=body)

    async def restore_proxy(request: web.Request, body: bytes) -> web.StreamResponse:
        """Forward POST /restore, then undo what it resurrected behind us.

        The restore itself must really run — area 7 tests the button, and a
        faked response would test nothing. What is put back is the blast
        radius: every non-qa-* session that was not live a moment ago.
        """
        # Two agents restoring at once would each snapshot, then each try to
        # reap the other's resurrections — same end state, but a confusing log
        # full of "KILL FAILED" for sessions the other one already killed.
        async with restore_lock:
            return await _restore_once(request, body)

    async def _restore_once(request: web.Request, body: bytes) -> web.StreamResponse:
        # tmux is a subprocess: off the event loop, or a hung one freezes every
        # agent sharing this proxy for the whole timeout.
        before = await asyncio.to_thread(tmux_session_names)
        if before is None:
            return guard.deny(
                "refusing to restore — could not list the live sessions first, "
                "so anything it resurrected could not be identified or undone",
                "/api/sessions/restore")
        resp = await forward(request, f"{TMUX_API}/restore", auth=True,
                             label="/api/sessions/restore", body=body)
        after = await asyncio.to_thread(tmux_session_names)
        if after is None:
            log("restore: could NOT re-list sessions — NOTHING was reaped; "
                "check `tmux ls` by hand")
            return resp
        # Log the whole delta, not just the reaped part: when everything it
        # brought back is qa-* the reaper stays silent, and an operator reading
        # the log cannot otherwise tell that apart from a restore that did
        # nothing (or from a re-list that ran too early to see it).
        brought_back = sorted(set(after) - set(before))
        if brought_back:
            log(f"restore brought back {len(brought_back)} session(s): "
                f"{', '.join(brought_back)}")
        for name in sessions_to_reap(before, after):
            killed = await asyncio.to_thread(tmux_kill_session, name)
            guard.reaped.append(name if killed else f"{name} (KILL FAILED)")
            log(f"restore resurrected {name!r} (not qa-*) → "
                f"{'reaped' if killed else 'KILL FAILED, still live'}")
        return resp

    async def api_proxy(request: web.Request) -> web.StreamResponse:
        tail = request.match_info["tail"]
        body = await request.read()
        reason = guard.check_tmux_api(request.method, tail, body)
        if reason:
            return guard.deny(reason, f"/api/sessions/{tail}")
        if tail == "restore" and request.method == "POST":
            return await restore_proxy(request, body)
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

    async def skills_proxy(request: web.Request) -> web.StreamResponse:
        reason = guard.check_skills(request.method, request.rel_url.path)
        if reason:
            return guard.deny(reason, request.rel_url.path)
        # raw_path, not raw_path_qs: forward() already passes the query through
        # as params, so carrying it in the URL too would duplicate every one.
        return await forward(request, f"{SKILLS_API}{request.rel_url.raw_path}",
                             auth=True, label=request.rel_url.path)

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
            # ttyd runs `-H X-authentik-username`, so the UPGRADE is authed
            # exactly like every HTTP leg. Miss this and ttyd drops the dial
            # while the browser socket is already open, which surfaces as
            # "Reconnecting… (attempt N)" in term.html and nothing in the log
            # except this handler's failure line.
            ws_up = await request.app["client"].ws_connect(
                url, protocols=offered or ("tty",),
                headers={"X-Authentik-Username": args.user})
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
        return await forward(request, f"{ttyd_base()}{request.rel_url.raw_path}",
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

    async def arm_reaper(app: web.Application) -> None:
        """A /restore may only be forwarded if we can reap its collateral, and
        we can only reap in OUR OWN tmux server. tmux-api resolves the injected
        identity through /etc/ttyd-user-map, so ask it which OS user that is
        rather than assuming the mapping is the identity."""
        try:
            async with app["client"].get(
                f"{TMUX_API}/whoami",
                headers={"X-Authentik-Username": args.user},
            ) as r:
                os_user = (await r.json()).get("osUser") if r.status == 200 else None
        except (aiohttp.ClientError, ValueError) as exc:
            log(f"reaper DISARMED — tmux-api /whoami failed ({exc}); "
                f"POST /restore will be refused")
            return
        me = proxy_os_user()
        if os_user != me:
            log(f"reaper DISARMED — {args.user!r} maps to OS user "
                f"{os_user!r}, but this proxy runs as {me!r} and could not "
                f"reap in that tmux server; POST /restore will be refused")
            return
        guard.can_reap = True
        log(f"reaper armed for OS user {me!r} — POST /restore is forwarded, "
            f"then non-qa-* resurrections are killed")

    async def on_startup(app: web.Application) -> None:
        app["client"] = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=None, sock_connect=10))
        await arm_reaper(app)
        await snapshot(app)

    async def on_cleanup(app: web.Application) -> None:
        await restore(app)
        if guard.reaped:
            log(f"reaped {len(guard.reaped)} session(s) a /restore "
                f"resurrected: {', '.join(guard.reaped)}")
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
    # The bundle is no longer one file: 5f370fc splits it into hashed chunks
    # under /assets/, served by clipboard-upload the way the PWA assets are
    # (immutable, no auth). Without this route the harness answered every chunk
    # with the SPA's own HTML 404 and the page rendered blank — the fleet could
    # not open the lobby at all.
    app.router.add_route("*", "/assets/{tail:.*}", asset_proxy)
    app.router.add_route("*", "/term.html", term_html_proxy)
    app.router.add_route("*", "/api/sessions/{tail:.*}", api_proxy)
    app.router.add_route("*", "/clipboard/{tail:.*}", clipboard_proxy)
    app.router.add_route("*", "/events/{tail:.*}", events_proxy)
    # Everything the PRODUCTION ingress routes to session-events, verbatim:
    # infra/stacks/terminal/main.tf matches (/events/ || /prompt/ || /cancel/ ||
    # /earlier/ || /result/ || /pane/ || /keys/). The last four arrived after
    # this table was written, so a fleet reaching for history, a full tool
    # result, the pane, or an answer got the SPA's HTML 404 and no way to tell
    # that apart from a real one. /permission keeps its own handling below —
    # production has no rule for it, and reproducing that is the point.
    for prefix in ("prompt", "cancel", "earlier", "result", "pane", "keys", "permission"):
        app.router.add_route("*", f"/{prefix}/{{tail:.*}}", control_proxy)
    app.router.add_route("*", "/files/{tail:.*}", files_proxy)
    # Both forms: the inventory is GET /skills exactly, the rest are /skills/<verb>.
    app.router.add_route("*", "/skills", skills_proxy)
    app.router.add_route("*", "/skills/{tail:.*}", skills_proxy)
    app.router.add_route("*", "/{tail:.*}", ttyd_proxy)
    return app


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--port", type=int, default=7998, help="proxy listen port")
    p.add_argument("--user", default="alice",
                   help="value injected as X-Authentik-Username")
    p.add_argument("--ttyd-port", type=int, default=TTYD_DEFAULT_PORT,
                   help=f"ttyd serving the SPA (default {TTYD_DEFAULT_PORT} = "
                        "the deployed lobby on terminal.viktorbarzin.me)")
    p.add_argument("--scratch", default=default_scratch(),
                   help="the only tree /files/write may target (default: "
                        "%(default)s). Must live inside file-api's containment "
                        "root /home/<osUser>, or file-api answers 400 'invalid "
                        "path' and no write can land however the guard is set")
    # Default OFF = what production does. The shim cannot make the permission
    # panel work — session-events has no /permission handler — so leaving it on
    # bought nothing but a divergence from the tier under test.
    p.add_argument("--permission-shim", dest="permission_shim",
                   action="store_true", default=False,
                   help="route /permission to session-events instead of the "
                        "ttyd catch-all. Off by default: session-events has "
                        "no /permission handler, so this only changes which 404 "
                        "comes back (finding B)")
    p.add_argument("--no-permission-shim", dest="permission_shim",
                   action="store_false",
                   help="accepted for compatibility — this is now the default")
    p.add_argument("--no-restore", action="store_true",
                   help="do not snapshot/restore /layout and /prefs")
    p.add_argument("--quiet", action="store_true")
    return p


def main() -> None:
    args = build_parser().parse_args()

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
