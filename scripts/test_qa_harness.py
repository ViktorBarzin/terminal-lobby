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
#
# `telemetry` was in this list until the origin work ("A session knows who made
# it"): the fleet was allowed to post its usage batch because the events looked
# harmless. They
# are not — they carry no session, so nothing downstream can separate them from
# a person's usage. The refusal and its reasoning are in the telemetry section
# at the foot of this file.

@pytest.mark.parametrize("tail", ["layout", "prefs"])
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
# clipboard-upload's publicAssets table holds twelve paths; the prod ingress
# carve-out holds eleven. The one in the table and not the carve-out (the build
# stamp) is authed in production, so the harness must not serve it from the
# unauthenticated table however public the Go file looks. /term.html is in
# neither now: it is a 302 handler rather than a file (2026-09-05), and it is
# authed like the stamp.

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
    unauthenticated, while /term.html and /build-id answer 302 to Authentik. A
    path added here that production gates would let the fleet load something
    anonymously that a real browser cannot, and the divergence would read as an
    app bug in whichever sweep hit it."""
    assert set(qa.ASSET_PATHS) == PROD_PUBLIC_CARVE_OUT


def test_the_build_stamp_is_authed_not_public():
    """The stamp the self-update healer polls (ADR-0007's 2026-08-28
    amendment). clipboard-upload serves it, which is what makes the mistake
    tempting; production answers it with a 302 to Authentik.

    There were two until 2026-09-05, the second being /term-build-id: the
    framed terminal page had an identity of its own and re-checked itself on
    every reconnect. One document, one stamp."""
    assert qa.STAMP_PATHS == ("/build-id",)
    assert "/build-id" not in qa.ASSET_PATHS, (
        "/build-id is authed in production (302 to Authentik, measured "
        "2026-09-04), so it cannot ride the unauthenticated asset table")


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
    test must never reach either; one that needs an upstream starts its own.

    tmux is stubbed for the same reason: build_app starts the origin stamper,
    and an admitted attach in a proxy-level test queues a name for it, so
    without this the suite would fork `tmux` against whatever server the machine
    running it happens to have. The stamper tests below install their own fake
    over these, after this fixture has run."""
    monkeypatch.setattr(qa, "TMUX_API", "http://127.0.0.1:1")
    monkeypatch.setattr(qa, "CLIPBOARD", "http://127.0.0.1:1")
    monkeypatch.setattr(qa, "tmux_origins", lambda: {})
    monkeypatch.setattr(qa, "tmux_stamp_origin",
                        lambda name, value=qa.ORIGIN_TEST: None)


def harness_args(**over) -> argparse.Namespace:
    # auth_header and proxy_secret are what the services check: the header name
    # became configuration on 2026-08-29 and the proxy secret is checked before
    # identity is read at all. The default here is the module's resolved header
    # so a test that does not care gets whatever the box would send, and the
    # secret is empty because the assertions below are about the identity.
    defaults = dict(port=0, user="qa-tester", ttyd_port=0,
                    scratch="/tmp/qa-scratch", permission_shim=False,
                    stamp_shim=False, no_restore=True, quiet=True,
                    auth_header=qa.AUTH_HEADER, proxy_secret="")
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


# --- telemetry ------------------------------------------------------------
#
# The fleet's page-level events name no session at all — app.loaded,
# theme.changed, the whole diagnostics batch — so a session-keyed exclusion
# cannot see them and they would file against wizard's own usage figures
# (docs/adr/0006-usage-telemetry.md). The proxy refuses the intake instead,
# which is the only place that sees them before they reach Loki.

def test_posting_telemetry_is_refused(guard):
    reason = guard.check_tmux_api("POST", "telemetry", body(events=[]))
    assert reason and "telemetry" in reason


def test_reading_telemetry_is_not_refused(guard):
    """The refusal is about what the fleet WRITES. A GET carries no events."""
    assert guard.check_tmux_api("GET", "telemetry", b"") is None


def test_the_telemetry_refusal_says_qa_harness_guard(guard):
    """Same body shape as every other refusal, so an agent reading a 403 knows
    it hit the guard rather than an intake bug."""
    resp = guard.deny(guard.check_tmux_api("POST", "telemetry", b"{}"),
                      "/api/sessions/telemetry")
    assert resp.status == 403
    assert resp.text.startswith("qa-harness guard:")


# --- @tl_origin: the fleet's sessions say they are the fleet's -------------
#
# The lobby's own create path stamps `@tl_origin user` on everything it makes
# (devvm/tmux-user-attach), including a session a QA agent creates by driving
# /?session=<minted-id>. So the harness has to OVERWRITE that for the sessions
# its run owns, and it can only do so once the session exists — the attach that
# brings it into being is the same request the guard admits.

def test_attaching_a_fresh_minted_id_queues_the_origin_stamp(guard, monkeypatch):
    monkeypatch.setattr(qa, "tmux_session_names", lambda: ["main"])
    assert guard.check_ws(FakeQuery(["k7m2q9x4tp0v"])) is None
    assert "k7m2q9x4tp0v" in guard.pending_origin


def test_attaching_a_qa_session_queues_the_origin_stamp(guard):
    """qa-* needs no ownership record — it is a namespace — but it still needs
    the option, because the option is what the list reads."""
    assert guard.check_ws(FakeQuery(["qa-timeline"])) is None
    assert "qa-timeline" in guard.pending_origin


def test_a_refused_attach_queues_nothing(guard):
    assert guard.check_ws(FakeQuery(["main"])) is not None
    assert guard.pending_origin == set()


class FakeTmuxOrigins:
    """A tmux server that lists `@tl_origin` per session and takes writes.

    `origins` maps a LIVE session name to its option value, "" being live but
    unstamped. A name that is absent is a session that does not exist — the
    distinction the stamper waits on. `listing` may be set to None to play an
    unreadable tmux.
    """

    def __init__(self, origins: dict):
        self.origins = dict(origins)
        self.writes: list = []
        self.readable = True

    def list(self):
        return None if not self.readable else dict(self.origins)

    def write(self, name: str, value: str = qa.ORIGIN_TEST):
        if name not in self.origins:
            return None
        self.origins[name] = value
        self.writes.append((name, value))
        return value


@pytest.fixture
def stamper(guard, monkeypatch):
    def make(origins: dict, **kw):
        fake = FakeTmuxOrigins(origins)
        monkeypatch.setattr(qa, "tmux_origins", fake.list)
        monkeypatch.setattr(qa, "tmux_stamp_origin", fake.write)
        return fake, qa.OriginStamper(guard, **kw)
    return make


@pytest.mark.asyncio
async def test_the_stamper_overwrites_the_lobbys_user_stamp(guard, stamper):
    guard.pending_origin.add("k7m2q9x4tp0v")
    fake, st = stamper({"k7m2q9x4tp0v": "user"})
    await st.step()
    assert fake.writes == [("k7m2q9x4tp0v", "test")]


@pytest.mark.asyncio
async def test_the_stamper_confirms_on_a_later_read_than_the_write(guard, stamper):
    """One pass cannot prove the stamp stuck: the create's own `set-option user`
    may still be in the tmux command queue behind our read. So a name leaves the
    queue only when a READ taken after the write says test."""
    guard.pending_origin.add("qa-x")
    fake, st = stamper({"qa-x": "user"})
    await st.step()
    assert guard.pending_origin == {"qa-x"}, "one pass is not proof"
    await st.step()
    assert guard.pending_origin == set()
    assert guard.stamped == ["qa-x"]
    assert fake.writes == [("qa-x", "test")]


@pytest.mark.asyncio
async def test_the_stamper_restamps_when_the_create_path_wins_the_race(guard, stamper):
    guard.pending_origin.add("qa-x")
    fake, st = stamper({"qa-x": ""})
    await st.step()
    fake.origins["qa-x"] = "user"  # the lobby's set-option landed after ours
    await st.step()
    assert guard.pending_origin == {"qa-x"}
    await st.step()
    assert guard.pending_origin == set()
    assert fake.writes == [("qa-x", "test"), ("qa-x", "test")]


@pytest.mark.asyncio
async def test_the_stamper_waits_for_the_session_to_exist(guard, stamper):
    """The attach is what creates the session, so the queue runs ahead of it."""
    guard.pending_origin.add("qa-late")
    fake, st = stamper({})
    await st.step()
    assert fake.writes == []
    assert guard.pending_origin == {"qa-late"}
    fake.origins["qa-late"] = "user"
    await st.step()
    await st.step()
    assert guard.pending_origin == set()


@pytest.mark.asyncio
async def test_the_stamper_gives_up_on_a_session_that_never_appears(guard, stamper):
    """An agent that navigates away before the terminal attaches leaves a name
    nothing will ever create. Retrying it forever would fork tmux twice a second
    for the length of the run."""
    guard.pending_origin.add("qa-ghost")
    fake, st = stamper({}, window=0.0)
    await st.step()
    assert guard.pending_origin == set()
    assert guard.stamped == []
    assert fake.writes == []


@pytest.mark.asyncio
async def test_a_session_that_appears_late_still_gets_its_confirming_pass(guard, stamper):
    """The window is how long the queue waits for a session to EXIST. A session
    that shows up in its last second has been stamped correctly and must not be
    dropped one pass later and reported as never stamped."""
    guard.pending_origin.add("qa-slow")
    fake, st = stamper({"qa-slow": "user"}, window=0.0)
    await st.step()
    assert guard.pending_origin == {"qa-slow"}, "written, so it gets its confirm"
    await st.step()
    assert guard.stamped == ["qa-slow"]


@pytest.mark.asyncio
async def test_an_unreadable_tmux_gives_up_on_nothing(guard, stamper):
    """A tmux that cannot be listed says nothing about any name, so a pass that
    cannot read must not drop a session the fleet really owns — the give-up is
    for names that are proved absent, not for passes that proved nothing."""
    guard.pending_origin.add("qa-x")
    fake, st = stamper({"qa-x": "user"}, window=0.0)
    fake.readable = False
    await st.step()
    assert guard.pending_origin == {"qa-x"}
    assert fake.writes == []
    fake.readable = True
    await st.step()
    await st.step()
    assert guard.stamped == ["qa-x"]


@pytest.mark.asyncio
async def test_the_telemetry_intake_is_never_reached(monkeypatch):
    """Wire-level, because the browser reaches the intake through the normal
    /api/sessions/* leg and a refusal that only lives in the guard's return
    value would still have to be plumbed into that handler."""
    intake: list = []

    async def telemetry_handler(request):
        intake.append(await request.read())
        return web.json_response({"accepted": 1})

    app = web.Application()
    app.router.add_route("POST", "/telemetry", telemetry_handler)
    api = TestServer(app)
    await api.start_server()
    monkeypatch.setattr(qa, "TMUX_API", f"http://127.0.0.1:{api.port}")
    try:
        async with TestClient(TestServer(qa.build_app(harness_args()))) as client:
            resp = await client.post("/api/sessions/telemetry",
                                     json={"events": [{"name": "app.loaded"}]})
            assert resp.status == 403
            assert (await resp.text()).startswith("qa-harness guard:")
    finally:
        await api.close()
    assert intake == [], "a fleet's page events must not reach the intake"
