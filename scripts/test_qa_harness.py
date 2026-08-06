#!/usr/bin/env python3
"""Tests for qa-harness.py.

The guard is the only thing standing between a QA fleet and wizard's live
sessions, so it gets tested as logic rather than trusted as prose. Most of this
file is pure — no proxy, no network, no tmux. The last section is not: two of
the harness's defects lived in the WIRING rather than in the guard, so those
tests run the real app over fake upstreams. They still touch no live backend.

    python3 -m pytest scripts/test_qa_harness.py -q
"""
import argparse
import importlib.util
import json
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
def _never_touch_the_live_tmux_api(monkeypatch):
    """:7684 is wizard's real tmux-api. A unit test must never reach it."""
    monkeypatch.setattr(qa, "TMUX_API", "http://127.0.0.1:1")


def harness_args(**over) -> argparse.Namespace:
    defaults = dict(port=0, user="qa-tester", ttyd_port=0,
                    scratch="/tmp/qa-scratch", permission_shim=False,
                    no_restore=True, quiet=True)
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
