#!/usr/bin/env python3
"""Guard tests for qa-harness.py.

The guard is the only thing standing between a QA fleet and wizard's live
sessions, so it gets tested as logic rather than trusted as prose. Everything
here is pure — no proxy, no network, no tmux.

    python3 -m pytest scripts/test_qa_harness.py -q
"""
import importlib.util
import json
from pathlib import Path

import pytest

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

@pytest.mark.parametrize("tail", ["layout", "prefs", "restore", "telemetry"])
def test_roamed_and_idempotent_endpoints_allowed(guard, tail):
    assert guard.check_tmux_api("PUT", tail, b"{}") is None
    assert guard.check_tmux_api("POST", tail, b"{}") is None


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
