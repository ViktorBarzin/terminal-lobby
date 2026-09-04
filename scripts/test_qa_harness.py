#!/usr/bin/env python3
"""Tests for the QA harness — the proxy (qa-harness.py) and its driver
(qa_driver.py).

The guard is the only thing standing between a QA fleet and wizard's live
sessions, so it gets tested as logic rather than trusted as prose. Most of this
file is pure — no proxy, no network, no tmux. The last two sections are not:
some of the harness's defects lived in the WIRING rather than in the guard, so
those tests run the real app over fake upstreams, and the driver's browser
launch is verified by launching one. They still touch no live backend and never
reach the dev tier.

    python3 -m pytest scripts/test_qa_harness.py -q
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

_spec = importlib.util.spec_from_file_location(
    "qa_harness", Path(__file__).with_name("qa-harness.py"))
qa = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(qa)


@pytest.fixture
def guard():
    return qa.Guard("/tmp/qa-scratch")


def body(**kw) -> bytes:
    return json.dumps(kw).encode()


# --- the qa- prefix itself ------------------------------------------------

@pytest.mark.parametrize("name", ["qa-timeline", "qa-a", "qa-view_switch", "qa-1"])
def test_qa_names_accepted(name):
    assert qa.is_qa(name)


@pytest.mark.parametrize("name", [
    "main", "", "qa", "qa-", "myqa-x", "QA-x", " qa-x", "qa-x ",
    "wizard", "claude-work", "qa/../main", "qa-" + "x" * 30,
])
def test_non_qa_names_rejected(name):
    assert not qa.is_qa(name)


# --- kill -----------------------------------------------------------------

def test_kill_qa_session_allowed(guard):
    assert guard.check_tmux_api("DELETE", "sessions/qa-timeline", b"") is None


def test_kill_real_session_blocked(guard):
    reason = guard.check_tmux_api("DELETE", "sessions/main", b"")
    assert reason and "refusing to kill" in reason


def test_kill_url_encoded_real_session_blocked(guard):
    # %6D%61%69%6E == "main" — the guard must decode before matching.
    assert guard.check_tmux_api("DELETE", "sessions/%6D%61%69%6E", b"") is not None


def test_get_session_never_blocked(guard):
    assert guard.check_tmux_api("GET", "sessions/main", b"") is None


# --- rename ---------------------------------------------------------------

def test_rename_qa_to_qa_allowed(guard):
    assert guard.check_tmux_api(
        "POST", "sessions/qa-old/rename", body(name="qa-new")) is None


def test_rename_real_session_blocked(guard):
    reason = guard.check_tmux_api(
        "POST", "sessions/main/rename", body(name="qa-new"))
    assert reason and "refusing to rename 'main'" in reason


def test_rename_qa_out_of_the_namespace_blocked(guard):
    """Escaping the prefix would leave an unkillable orphan behind."""
    reason = guard.check_tmux_api(
        "POST", "sessions/qa-old/rename", body(name="main"))
    assert reason and "must stay qa-*" in reason


def test_rename_with_unparseable_body_blocked(guard):
    assert guard.check_tmux_api(
        "POST", "sessions/qa-old/rename", b"not json") is not None


# --- shares ---------------------------------------------------------------

def test_share_reads_allowed(guard):
    assert guard.check_tmux_api("GET", "shares", b"") is None


@pytest.mark.parametrize("method", ["POST", "PUT", "DELETE"])
def test_share_mutations_blocked(guard, method):
    assert guard.check_tmux_api(method, "shares", b"") is not None
    assert guard.check_tmux_api(method, "shares/wizard/main", b"") is not None


# --- projects -------------------------------------------------------------

def test_create_qa_project_allowed(guard):
    assert guard.check_tmux_api("POST", "projects", body(name="qa-fleet")) is None


def test_create_real_project_blocked(guard):
    assert guard.check_tmux_api("POST", "projects", body(name="Work")) is not None


def test_editing_a_project_we_did_not_create_is_blocked(guard):
    assert guard.check_tmux_api("DELETE", "projects/p-real", b"") is not None


def test_editing_a_project_we_created_is_allowed(guard):
    guard.check_tmux_api("POST", "projects", body(name="qa-fleet"))
    guard.record_project(body(name="qa-fleet"), body(id="p-123"))
    assert guard.check_tmux_api("PUT", "projects/p-123", b"") is None
    assert guard.check_tmux_api("DELETE", "projects/p-123", b"") is None


# --- push -----------------------------------------------------------------

def test_push_subscribe_allowed(guard):
    assert guard.check_tmux_api("POST", "push-subscriptions", b"{}") is None


def test_push_unsubscribe_blocked(guard):
    assert guard.check_tmux_api("DELETE", "push-subscriptions", b"") is not None


# --- roamed state passes through (it is snapshot/restored instead) --------

@pytest.mark.parametrize("tail", ["layout", "prefs", "telemetry"])
def test_roamed_and_idempotent_endpoints_allowed(guard, tail):
    assert guard.check_tmux_api("PUT", tail, b"{}") is None
    assert guard.check_tmux_api("POST", tail, b"{}") is None


# --- restore --------------------------------------------------------------
# POST /restore shells `tmux-persist restore <osUser>`, which recreates EVERY
# session in the user's manifest that is not currently live — including the ones
# other agents (and wizard) deliberately killed. It is not blanket-blocked: area
# 7 is chartered to exercise Restore. It is allowed only while the proxy can put
# the collateral back.

def test_restore_blocked_when_the_reaper_is_disarmed(guard):
    reason = guard.check_tmux_api("POST", "restore", b"")
    assert reason and "restore" in reason.lower()


def test_restore_allowed_when_the_reaper_is_armed():
    armed = qa.Guard("/tmp/qa-scratch", can_reap=True)
    assert armed.check_tmux_api("POST", "restore", b"") is None


def test_reading_restore_is_never_blocked(guard):
    assert guard.check_tmux_api("GET", "restore", b"") is None


def test_reap_targets_only_sessions_the_restore_resurrected():
    before = ["main", "rewrite", "qa-seven"]
    after = ["main", "rewrite", "qa-seven", "qa-seven-b", "deploy", "notes"]
    assert qa.sessions_to_reap(before, after) == ["deploy", "notes"]


def test_reap_leaves_a_resurrected_qa_session_alone():
    """Area 7 kills qa-x, clicks Restore, and expects qa-x back."""
    assert qa.sessions_to_reap(["main"], ["main", "qa-x"]) == []


def test_reap_never_touches_a_session_that_was_already_live():
    assert qa.sessions_to_reap(["main", "deploy"], ["main", "deploy"]) == []


def test_reap_leaves_a_resurrected_session_this_run_created_alone():
    """The composer's sessions carry a minted id, not a qa-* name, so the qa-*
    exemption alone would have the reaper kill the fleet's own work."""
    assert qa.sessions_to_reap(["main"], ["main", "k7m2q9x4tp0v"],
                               {"k7m2q9x4tp0v"}) == []
    assert qa.sessions_to_reap(["main"], ["main", "k7m2q9x4tp0v"], set()) == ["k7m2q9x4tp0v"]


def test_reap_ignores_sessions_that_vanished():
    assert qa.sessions_to_reap(["main", "gone"], ["main"]) == []


# --- prompt / cancel ------------------------------------------------------

def test_prompt_qa_session_allowed(guard):
    assert guard.check_events("POST", "/prompt/qa-composer") is None


def test_prompt_real_session_blocked(guard):
    reason = guard.check_events("POST", "/prompt/main")
    assert reason and "live Claude" in reason


def test_cancel_real_session_blocked(guard):
    assert guard.check_events("POST", "/cancel/main") is not None


def test_events_read_never_blocked(guard):
    """Reading any session's stream is allowed — SSE cannot mutate."""
    assert guard.check_events("GET", "/events/main") is None


def test_permission_decisions_allowed(guard):
    """A reqId is not a session name; only qa-* sessions can produce one."""
    assert guard.check_events("POST", "/permission/req-abc123") is None


# --- file writes ----------------------------------------------------------

def test_write_inside_scratch_allowed(guard):
    assert guard.check_files(
        "POST", "/files/write", body(path="/tmp/qa-scratch/a.md")) is None


def test_write_outside_scratch_blocked(guard):
    reason = guard.check_files(
        "POST", "/files/write", body(path="/home/wizard/.bashrc"))
    assert reason and "confined to" in reason


def test_write_with_scratch_prefix_but_sibling_dir_blocked(guard):
    """/tmp/qa-scratch-evil must not pass as /tmp/qa-scratch/."""
    assert guard.check_files(
        "POST", "/files/write", body(path="/tmp/qa-scratch-evil/x")) is not None


def test_reads_and_lists_allowed_anywhere(guard):
    assert guard.check_files("GET", "/files/read", b"") is None
    assert guard.check_files("GET", "/files/list", b"") is None


# --- the scratch root must be somewhere file-api will actually write -------
# file-api confines every path to /home/<osUser> (auth.go: homeBase="/home",
# userHome()). A scratch outside that root makes the two allowed sets DISJOINT:
# the guard permits the write, file-api rejects it 400 "invalid path", and the
# editor surfaces that as "Can't save this path (not a regular file)." — which
# reads exactly like a product bug. The default has to satisfy both.

FILE_API_HOME_BASE = "/home"  # file-api/auth.go:28


def test_the_shipped_default_scratch_is_inside_file_api_containment():
    """The default a fleet gets with no flags must be writable end to end."""
    default = qa.build_parser().parse_args([]).scratch
    root = os.path.join(FILE_API_HOME_BASE, qa.proxy_os_user())
    assert os.path.normpath(default).startswith(root + os.sep), (
        f"--scratch defaults to {default!r}, which is outside file-api's "
        f"containment root {root!r} — every POST /files/write through the "
        f"harness would 400 'invalid path' no matter what the app does")


def test_the_shipped_default_scratch_passes_its_own_guard():
    """The other half: a path inside the default must survive the guard."""
    default = qa.build_parser().parse_args([]).scratch
    g = qa.Guard(default)
    assert g.check_files(
        "POST", "/files/write", body(path=f"{default}/probe.txt")) is None


def test_write_traversing_out_of_scratch_blocked():
    """A `..` must not walk out of the scratch.

    This is load-bearing now that the scratch lives inside /home/<osUser>: a
    single `..` lands somewhere file-api is perfectly happy to write, so a
    string-prefix check alone would hand the fleet the whole home directory.
    """
    g = qa.Guard("/home/wizard/qa-harness-scratch")
    reason = g.check_files(
        "POST", "/files/write",
        body(path="/home/wizard/qa-harness-scratch/../.bashrc"))
    assert reason and "confined to" in reason


def test_deep_traversal_out_of_scratch_blocked():
    g = qa.Guard("/tmp/qa-scratch")
    assert g.check_files(
        "POST", "/files/write",
        body(path="/tmp/qa-scratch/../../home/wizard/.ssh/authorized_keys")
    ) is not None


def test_noise_inside_the_scratch_is_still_allowed():
    """Normalising must not reject a legitimate path that merely looks messy."""
    g = qa.Guard("/tmp/qa-scratch")
    assert g.check_files(
        "POST", "/files/write", body(path="/tmp/qa-scratch/./sub//a.md")) is None


def test_relative_paths_blocked():
    """file-api resolves a relative path against the home; the guard cannot
    tell where it lands, so it refuses rather than guesses."""
    g = qa.Guard("/tmp/qa-scratch")
    assert g.check_files(
        "POST", "/files/write", body(path="qa-scratch/a.md")) is not None


def test_writing_the_scratch_directory_itself_blocked():
    g = qa.Guard("/tmp/qa-scratch")
    assert g.check_files(
        "POST", "/files/write", body(path="/tmp/qa-scratch")) is not None


# --- terminal attach ------------------------------------------------------

class FakeQuery:
    def __init__(self, args):
        self._args = args

    def getall(self, key, default=None):
        return self._args if key == "arg" else (default or [])


def test_attach_qa_session_allowed(guard):
    assert guard.check_ws(FakeQuery(["qa-terminal"])) is None


def test_attach_real_session_blocked(guard):
    reason = guard.check_ws(FakeQuery(["main"]))
    assert reason and "writable" in reason


def test_attach_checks_the_first_arg_only(guard):
    """argv is (session, command, dir, owner) — the session is arg[0]."""
    assert guard.check_ws(FakeQuery(["qa-x", "default", "/home/wizard"])) is None
    assert guard.check_ws(FakeQuery(["main", "default", "/home/wizard"])) is not None


def test_attach_with_no_arg_allowed(guard):
    """No ?arg= means ttyd's unit default, which is not a targeted attach."""
    assert guard.check_ws(FakeQuery([])) is None


# --- minted ids: the only names the new-session composer can produce -------
# Naming left the create path entirely (ADR-0019): the browser mints a
# 12-character id and navigates the iframe to ?arg=<id>, so a QA agent driving
# the primary new-session flow cannot produce a qa-* name at all. The guard
# admits an id that is not already a live session — attaching is what brings it
# into being — and remembers it, so the same run may drive and kill it.

@pytest.mark.parametrize("name", ["k7m2q9x4tp0v", "00000000000a", "zzzzzzzzzzzz"])
def test_minted_ids_recognised(name):
    assert qa.is_minted(name)


@pytest.mark.parametrize("name", [
    "k7m2q9x4tp0", "k7m2q9x4tp0vv", "K7M2Q9X4TP0V", "k7m2q9x4tpiv",
    "k7m2q9x4tplv", "k7m2q9x4tpov", "k7m2q9x4tpuv", "authentik", "qa-timeline", "",
])
def test_non_minted_names_rejected(name):
    assert not qa.is_minted(name)


def test_attach_to_a_fresh_minted_id_allowed(guard, monkeypatch):
    monkeypatch.setattr(qa, "tmux_session_names", lambda: ["main", "authentik"])
    assert guard.check_ws(FakeQuery(["k7m2q9x4tp0v"])) is None
    assert "k7m2q9x4tp0v" in guard.own_sessions


def test_attach_to_a_minted_id_someone_else_is_using_blocked(guard, monkeypatch):
    monkeypatch.setattr(qa, "tmux_session_names", lambda: ["k7m2q9x4tp0v"])
    reason = guard.check_ws(FakeQuery(["k7m2q9x4tp0v"]))
    assert reason and "already a live session" in reason
    assert guard.own_sessions == set()


def test_attach_to_a_minted_id_blocked_when_tmux_is_unreadable(guard, monkeypatch):
    monkeypatch.setattr(qa, "tmux_session_names", lambda: None)
    reason = guard.check_ws(FakeQuery(["k7m2q9x4tp0v"]))
    assert reason and "cannot read" in reason


def test_reattaching_to_our_own_session_allowed(guard, monkeypatch):
    monkeypatch.setattr(qa, "tmux_session_names", lambda: [])
    assert guard.check_ws(FakeQuery(["k7m2q9x4tp0v"])) is None
    # It is live now, and reconnecting must still work.
    monkeypatch.setattr(qa, "tmux_session_names", lambda: ["k7m2q9x4tp0v"])
    assert guard.check_ws(FakeQuery(["k7m2q9x4tp0v"])) is None


def test_our_own_session_may_be_prompted_titled_and_killed(guard, monkeypatch):
    monkeypatch.setattr(qa, "tmux_session_names", lambda: [])
    guard.check_ws(FakeQuery(["k7m2q9x4tp0v"]))
    assert guard.check_events("POST", "/prompt/k7m2q9x4tp0v") is None
    assert guard.check_tmux_api("POST", "sessions/k7m2q9x4tp0v/title",
                                body(title="Fix the deploy")) is None
    assert guard.check_tmux_api("DELETE", "sessions/k7m2q9x4tp0v", b"") is None


def test_a_minted_id_this_run_did_not_create_is_still_off_limits(guard):
    assert guard.check_events("POST", "/prompt/q4m8vwx2rt5n") is not None
    assert guard.check_tmux_api("DELETE", "sessions/q4m8vwx2rt5n", b"") is not None


def test_retitling_a_real_session_blocked(guard):
    reason = guard.check_tmux_api("POST", "sessions/authentik/title", body(title="mine now"))
    assert reason and "not ours" in reason


def test_retitling_a_qa_session_allowed(guard):
    assert guard.check_tmux_api("POST", "sessions/qa-timeline/title",
                                body(title="Timeline sweep")) is None


# --- bookkeeping ----------------------------------------------------------

def test_denials_are_recorded(guard):
    guard.deny("nope", "/api/sessions/sessions/main")
    guard.deny("also nope", "/prompt/main")
    assert len(guard.blocked) == 2
    assert "/prompt/main" in guard.blocked[1]


def test_deny_response_is_identifiable(guard):
    resp = guard.deny("because", "/x")
    assert resp.status == 403
    assert resp.text.startswith("qa-harness guard:")


# --- which paths are public, and which only look it -----------------------
#
# clipboard-upload's publicAssets table holds thirteen paths; the prod ingress
# carve-out holds ten. The three in the table and not the carve-out (term.html
# and the two build stamps) are authed in production, so the harness must not
# serve them from the unauthenticated table however public the Go file looks.

# module.ingress_assets in infra/stacks/terminal/main.tf, auth = "none". The
# same eleven are live: `kubectl get ingress terminal-assets -n terminal`.
PROD_PUBLIC_CARVE_OUT = frozenset({
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
    # Added to the carve-out 2026-09-04, infra 0b70bd82. Verified against the
    # live host after the apply: GET /fonts/tl-symbols.woff2 answers 200 with
    # 16,924 bytes unauthenticated, the same as its five siblings, where before
    # it answered 302 to Authentik. This test is what noticed the harness had
    # stopped mirroring production, which is the job it was written for.
    "/fonts/tl-symbols.woff2",
})


def test_public_assets_are_exactly_the_prod_carve_out():
    """Measured against the live site 2026-09-04: GET /sw.js answers 200
    unauthenticated, while /term.html, /build-id and /term-build-id answer 302
    to Authentik. A path added here that production gates would let the fleet
    load something anonymously that a real browser cannot, and the divergence
    would read as an app bug in whichever sweep hit it."""
    assert set(qa.ASSET_PATHS) == PROD_PUBLIC_CARVE_OUT


@pytest.mark.parametrize("path", ["/build-id", "/term-build-id"])
def test_the_build_stamps_are_authed_not_public(path):
    """The two stamps the self-update healer polls (ADR-0007's 2026-08-28
    amendment). clipboard-upload serves both, which is what makes the mistake
    tempting; production answers both with a 302 to Authentik."""
    assert path in qa.STAMP_PATHS
    assert path not in qa.ASSET_PATHS, (
        f"{path} is authed in production (302 to Authentik, measured "
        f"2026-09-04), so it cannot ride the unauthenticated asset table")


# ==========================================================================
# Proxy-level tests.
#
# Everything above is pure guard logic. These two defects live in the WIRING
# instead — the identity header the WS leg forwards, and what happens around a
# forwarded /restore — so they are tested by running the real app over fake
# upstreams. No live backend is touched: TMUX_API is pointed at a dead port for
# the whole module and each test supplies its own upstream.
# ==========================================================================

@pytest.fixture(autouse=True)
def _never_touch_the_live_backends(monkeypatch):
    """:7684 and :7683 are wizard's real tmux-api and clipboard-upload. A unit
    test must never reach either; one that needs an upstream starts its own."""
    monkeypatch.setattr(qa, "TMUX_API", "http://127.0.0.1:1")
    monkeypatch.setattr(qa, "CLIPBOARD", "http://127.0.0.1:1")


def harness_args(**over) -> argparse.Namespace:
    defaults = dict(port=0, user="qa-tester", ttyd_port=0,
                    scratch="/tmp/qa-scratch", permission_shim=False,
                    stamp_shim=False, no_restore=True, quiet=True)
    defaults.update(over)
    return argparse.Namespace(**defaults)


async def start_fake_ttyd():
    """Stands in for `ttyd -W -a -H X-authentik-username`: no identity header,
    no upgrade. Returns the server and the list of identities it saw."""
    seen: list = []

    async def ws_handler(request):
        user = request.headers.get("X-Authentik-Username")
        seen.append(user)
        if not user:
            return web.Response(status=401, text="unauthorized")
        resp = web.WebSocketResponse(protocols=("tty",))
        await resp.prepare(request)
        await resp.send_str(f"attached:{user}")
        await resp.close()
        return resp

    app = web.Application()
    app.router.add_route("GET", "/ws", ws_handler)
    server = TestServer(app)
    await server.start_server()
    return server, seen


# --- the /ws leg ----------------------------------------------------------

@pytest.mark.asyncio
async def test_ws_upgrade_carries_the_identity_header():
    """Every HTTP leg injects X-Authentik-Username; the WS upgrade must too,
    or ttyd refuses it and no terminal in the fleet ever attaches."""
    ttyd, seen = await start_fake_ttyd()
    try:
        async with TestClient(TestServer(
                qa.build_app(harness_args(ttyd_port=ttyd.port)))) as client:
            ws = await client.ws_connect("/ws?arg=qa-ws-probe")
            msg = await ws.receive(timeout=5)
            assert msg.type == aiohttp.WSMsgType.TEXT, (
                f"upstream refused the upgrade (got {msg.type}) — the browser "
                f"socket opens first, so this is what 'Reconnecting…' looks like")
            assert msg.data == "attached:qa-tester"
            await ws.close()
    finally:
        await ttyd.close()
    assert seen == ["qa-tester"]


@pytest.mark.asyncio
async def test_ws_attach_to_a_real_session_is_still_refused():
    """The guard runs before the dial — injecting identity must not weaken it."""
    ttyd, seen = await start_fake_ttyd()
    try:
        async with TestClient(TestServer(
                qa.build_app(harness_args(ttyd_port=ttyd.port)))) as client:
            with pytest.raises(aiohttp.WSServerHandshakeError) as err:
                await client.ws_connect("/ws?arg=main")
            assert err.value.status == 403
    finally:
        await ttyd.close()
    assert seen == []


# --- POST /restore --------------------------------------------------------

async def start_fake_tmux_api(os_user: str):
    """tmux-api with just the two endpoints the restore path uses."""
    forwarded: list = []

    async def restore_handler(request):
        forwarded.append(request.headers.get("X-Authentik-Username"))
        return web.json_response({"status": "ok"})

    async def whoami(request):
        return web.json_response({
            "authentik": request.headers.get("X-Authentik-Username"),
            "osUser": os_user,
        })

    app = web.Application()
    app.router.add_route("POST", "/restore", restore_handler)
    app.router.add_route("GET", "/whoami", whoami)
    server = TestServer(app)
    await server.start_server()
    return server, forwarded


@pytest.mark.asyncio
async def test_restore_is_forwarded_and_its_collateral_reaped(monkeypatch):
    """Area 7 may click Restore; the sessions it resurrects behind the fleet's
    back must not survive it."""
    api, forwarded = await start_fake_tmux_api(qa.proxy_os_user())
    monkeypatch.setattr(qa, "TMUX_API", f"http://127.0.0.1:{api.port}")
    snapshots = [["main", "qa-seven"],
                 ["main", "qa-seven", "qa-back", "rewrite"]]
    monkeypatch.setattr(qa, "tmux_session_names", lambda: snapshots.pop(0))
    killed: list = []
    monkeypatch.setattr(qa, "tmux_kill_session",
                        lambda name: bool(killed.append(name)) or True)
    try:
        app = qa.build_app(harness_args())
        async with TestClient(TestServer(app)) as client:
            resp = await client.post("/api/sessions/restore")
            assert resp.status == 200
        assert forwarded == ["qa-tester"], "the restore itself must still run"
        assert killed == ["rewrite"], "only the non-qa resurrection is reaped"
        assert app["guard"].reaped == ["rewrite"]
    finally:
        await api.close()


@pytest.mark.asyncio
async def test_restore_refused_when_the_identity_is_not_this_os_user(monkeypatch):
    """--user someone-else restores a tmux server this proxy cannot reap in."""
    api, forwarded = await start_fake_tmux_api("someone-else")
    monkeypatch.setattr(qa, "TMUX_API", f"http://127.0.0.1:{api.port}")
    try:
        async with TestClient(TestServer(qa.build_app(harness_args()))) as client:
            resp = await client.post("/api/sessions/restore")
            assert resp.status == 403
            assert (await resp.text()).startswith("qa-harness guard:")
        assert forwarded == []
    finally:
        await api.close()


@pytest.mark.asyncio
async def test_restore_refused_when_the_live_set_cannot_be_read(monkeypatch):
    """No baseline means no way to tell a resurrection from a real session."""
    api, forwarded = await start_fake_tmux_api(qa.proxy_os_user())
    monkeypatch.setattr(qa, "TMUX_API", f"http://127.0.0.1:{api.port}")
    monkeypatch.setattr(qa, "tmux_session_names", lambda: None)
    try:
        async with TestClient(TestServer(qa.build_app(harness_args()))) as client:
            resp = await client.post("/api/sessions/restore")
            assert resp.status == 403
        assert forwarded == []
    finally:
        await api.close()


# --- the build stamps, on the wire ----------------------------------------

async def start_fake_origin(label: str):
    """Answers any path with its own label, so a test can tell WHICH upstream a
    path reached, and records the identity it arrived with."""
    seen: list[tuple[str, str | None]] = []

    async def any_path(request):
        seen.append((request.path, request.headers.get("X-Authentik-Username")))
        return web.Response(status=200, text=f"{label}:{request.path}")

    app = web.Application()
    app.router.add_route("*", "/{tail:.*}", any_path)
    server = TestServer(app)
    await server.start_server()
    return server, seen


@pytest.mark.asyncio
async def test_the_stamps_reach_ttyd_by_default():
    """Faithful to the ingress, which routes neither stamp to clipboard-upload:
    both land on the catch-all and 404 from ttyd, in production and here. Authed
    on the way, because the catch-all carries authentik-forward-auth."""
    ttyd, seen = await start_fake_origin("ttyd")
    try:
        async with TestClient(TestServer(
                qa.build_app(harness_args(ttyd_port=ttyd.port)))) as client:
            for path in qa.STAMP_PATHS:
                resp = await client.get(path)
                assert await resp.text() == f"ttyd:{path}"
    finally:
        await ttyd.close()
    assert seen == [(p, "qa-tester") for p in qa.STAMP_PATHS]


@pytest.mark.asyncio
async def test_stamp_shim_serves_them_from_clipboard_upload(monkeypatch):
    """--stamp-shim is the only way to exercise the healer's STAMP path here,
    since the origin under test answers the real stamp nowhere else."""
    ttyd, ttyd_seen = await start_fake_origin("ttyd")
    clip, clip_seen = await start_fake_origin("clipboard")
    monkeypatch.setattr(qa, "CLIPBOARD", f"http://127.0.0.1:{clip.port}")
    try:
        async with TestClient(TestServer(qa.build_app(
                harness_args(ttyd_port=ttyd.port, stamp_shim=True)))) as client:
            for path in qa.STAMP_PATHS:
                resp = await client.get(path)
                assert await resp.text() == f"clipboard:{path}"
    finally:
        await clip.close()
        await ttyd.close()
    assert ttyd_seen == []
    assert clip_seen == [(p, "qa-tester") for p in qa.STAMP_PATHS]


# ==========================================================================
# qa_driver's browser launch.
#
# The driver grants the notifications permission up front so the prompt cannot
# eat a click. Under Playwright's DEFAULT headless build that grant is a no-op
# at the `Notification` API: permissions.query() reports "granted" while
# Notification.permission still reads "denied", because the headless shell ships
# no notification presenter. The app's notification code returns early on
# `Notification.permission !== "granted"`, so the entire feature reads as dead to
# a sweep agent — a blindfold that manufactures app bugs that do not exist.
# (BATTERY.md line 2619 hit the same wall in 2026-07 and stubbed `Notification`
# with addInitScript; a real browser build is better than a stub.)
#
# Launching a browser is slow but hermetic: a throwaway local HTTP server stands
# in for the dev tier, so this reaches no backend and needs no harness running.
# ==========================================================================

def serve_blank_page():
    """A one-page HTTP origin. `Notification` needs a real origin — the grant is
    origin-scoped and about:/data: URLs cannot carry one."""
    import http.server
    import threading

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b"<!doctype html><title>qa</title>ok")

        def log_message(self, *a):  # keep pytest output clean
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


@pytest.fixture
def driver(monkeypatch, tmp_path):
    """qa_driver with its browser-slot lockfiles and artifacts redirected, so a
    test never contends with a live fleet for one of the six slots."""
    qa_driver = pytest.importorskip("qa_driver")
    monkeypatch.setattr(qa_driver, "_SLOT_DIR", tmp_path / "slots")
    monkeypatch.setattr(qa_driver, "ARTIFACTS", tmp_path / "artifacts")
    return qa_driver


def test_a_fresh_agent_can_actually_use_notifications(driver):
    """The acceptance for the blindfold: a stock QaAgent must see a permission
    the page's own code will accept, not one only permissions.query() believes."""
    srv, origin = serve_blank_page()
    try:
        with driver.QaAgent("selftest-notifications", harness=origin) as agent:
            agent.goto("/")
            assert agent.page.evaluate("Notification.permission") == "granted", (
                "Notification.permission is not 'granted' after "
                "grant_permissions(['notifications']) — the app's notification "
                "code returns early on exactly this check, so every sweep of "
                "area 11 runs blindfolded")
            assert agent.page.evaluate(
                "navigator.permissions.query({name:'notifications'})"
                ".then(s => s.state)") == "granted"
            # The API must be usable, not merely reported as permitted.
            assert agent.page.evaluate(
                "(() => { try { new Notification('qa'); return 'ok'; } "
                "catch (e) { return String(e); } })()") == "ok"
            agent.findings.clear()  # nothing here is an app finding
    finally:
        srv.shutdown()


# --- valid JSON that is not an object -------------------------------------
# `json.loads("[]").get(...)` raises AttributeError, not ValueError, so a body
# like `[]` or `"x"` or `null` escaped the except clause and surfaced as a 500
# from the proxy — which an agent would reasonably mis-file as "save returns
# 500" against file-api. A guard must refuse it, not crash on it.

@pytest.mark.parametrize("payload", [b"[]", b'"x"', b"null", b"3", b"true"])
def test_rename_with_non_object_json_is_refused_not_crashed(guard, payload):
    reason = guard.check_tmux_api("POST", "sessions/qa-old/rename", payload)
    assert reason, f"{payload!r} must be refused"


@pytest.mark.parametrize("payload", [b"[]", b'"x"', b"null"])
def test_project_create_with_non_object_json_is_refused(guard, payload):
    assert guard.check_tmux_api("POST", "projects", payload) is not None


@pytest.mark.parametrize("payload", [b"[]", b'"x"', b"null"])
def test_write_with_non_object_json_is_refused(guard, payload):
    assert guard.check_files("POST", "/files/write", payload) is not None


def test_record_project_survives_non_object_response(guard):
    guard.record_project(b"{}", b"[]")
    assert guard.own_projects == set()
