#!/usr/bin/env python3
"""End-to-end guards for Watch mode's arg5, across the boundary it can die at.

Watch mode rides the ttyd positional `?arg=` contract, whose failure mode is
established rather than hypothetical: arg4 (the shared-attach owner) once died
at the iframe boundary and the attach silently fell back to the caller's own
server (memory #9926). arg5 sits one position deeper and fails worse — an arg5
that goes missing means a client that asked to WATCH attaches read-WRITE, takes
the grid, and reflows the session it was trying not to disturb. arg6/arg7 (the
launch model and effort) were added later and sit deeper still, so the layout
now has two slots BELOW the one that must not move.

Two legs, each exercising real shipped code rather than a description of it:

  1. BROWSER — `frontend-v2/src/lib/terminal-url.ts` is transpiled by the
     repo's own esbuild and its `terminalFrameArgs` is CALLED in node. That is
     the function every attach in the SPA builds its args from (SessionView and
     Dock are its only callers), so it is the hop where an arg is dropped.

     This leg read `frontend/term.html` until 2026-09-06, lifting the page's
     `argSuffix` block out by string anchors and running the fragment. The page
     was deleted on 2026-09-05 (the SPA draws the terminal in its own document
     now) and the leg failed with FileNotFoundError for five releases, because
     this file is in none of the gate commands (see THE GATE below). The
     questions did not change with the page, so it was re-pointed rather than
     retired: the owner still has to land on arg4 and the read-only flag on
     arg5, without disturbing the dir and command slots above them.

  2. DEVVM — devvm/tmux-attach.sh is executed with curl/tmux/sudo/logger shimmed,
     and the exact argv it would exec is asserted. `-r` must come from the
     SERVER's answer and never from the client's argument, so the cases below
     pin both directions: asking to watch produces `-r`, and a server that says
     rw produces no `-r` however the client asked.

The last test joins them: the arg vector leg 1 builds is handed to leg 2
verbatim, so the two halves are checked against each other rather than against
two hand-written lists that could drift apart.

THE GATE. This file is in none of the four gate commands. Leg 2 needs a
readable /etc/ttyd-user-map naming the current user, which exists on the devvm
and on no CI runner, so 16 of its cases skip there and only leg 1 would run.
That is why it was written as a devvm-local suite. It is worth adding anyway,
next to the compat suite in packaging/build-deb.sh, and the runtime is in this
file's report rather than assumed.

Run: pytest scripts/test_watch_mode_e2e.py
"""
from __future__ import annotations

import atexit
import functools
import json
import os
import shutil
import subprocess
import tempfile

import pytest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TERMINAL_URL_TS = os.environ.get("TL_TERMINAL_URL_TS") or os.path.join(
    REPO, "frontend-v2", "src", "lib", "terminal-url.ts"
)
ATTACH_SH = os.path.join(REPO, "devvm", "tmux-attach.sh")
USER_MAP = "/etc/ttyd-user-map"


# --------------------------------------------------------------------------
# Leg 1 — the browser hop: terminal-url.ts's builder, executed as shipped
# --------------------------------------------------------------------------

def _esbuild() -> str:
    """The repo's own esbuild, which vite already depends on."""
    local = os.path.join(REPO, "frontend-v2", "node_modules", ".bin", "esbuild")
    return local if os.access(local, os.X_OK) else (shutil.which("esbuild") or "")


@functools.lru_cache(maxsize=1)
def _builder_module() -> str:
    """Transpile terminal-url.ts to CJS and return the path node should require.

    NOT a bundle and not a copy of the logic: esbuild strips the types and
    rewrites the one import, and every line of the builder runs verbatim. The
    import is `./config`, whose ACT_AS is read at module scope and would drag in
    the whole runtime-config module (and its window reads), so a two-line stub
    stands in for it beside the output. `terminalFrameArgs` treats ACT_AS as a
    DEFAULT for the owner slot, and these cases pass an owner or none.
    """
    if not os.path.exists(TERMINAL_URL_TS):
        pytest.fail(
            f"the builder this leg tests is not at {TERMINAL_URL_TS}. "
            "It moved rather than went: set TL_TERMINAL_URL_TS, or re-point this file."
        )
    esbuild = _esbuild()
    if not esbuild:
        pytest.skip("esbuild not available (frontend-v2/node_modules not installed?)")
    out = tempfile.mkdtemp(prefix="tl-watch-e2e-")
    atexit.register(shutil.rmtree, out, True)
    mod = os.path.join(out, "terminal-url.js")
    r = subprocess.run(
        [esbuild, TERMINAL_URL_TS, "--format=cjs", f"--outfile={mod}"],
        capture_output=True, text=True,
    )
    assert r.returncode == 0, f"esbuild failed: {r.stderr}"
    with open(os.path.join(out, "config.js"), "w", encoding="utf-8") as f:
        f.write('exports.ACT_AS = "";\n')
    return mod


def _run_builder(**kw) -> str:
    """Call the shipped `terminalFrameArgs` with the given options."""
    node = shutil.which("node") or shutil.which("nodejs")
    if not node:
        pytest.skip("node not available")
    opts = {k: kw[k] for k in ("cmd", "dir", "owner", "watch", "model", "effort") if k in kw}
    script = (
        f"const m = require({json.dumps(_builder_module())});\n"
        # A rename or a signature change has to be loud rather than a TypeError
        # from a hundred lines away, because this is the whole entry point.
        'if (typeof m.terminalFrameArgs !== "function")'
        '  throw new Error("terminal-url.ts no longer exports terminalFrameArgs");\n'
        f"process.stdout.write(m.terminalFrameArgs({json.dumps(kw.get('arg', 'sess'))},"
        f" {json.dumps(opts)}));"
    )
    out = subprocess.run([node, "-e", script], capture_output=True, text=True)
    assert out.returncode == 0, f"builder failed: {out.stderr}"
    return out.stdout


def _args(suffix: str) -> list[str]:
    from urllib.parse import parse_qsl
    # The SPA returns a bare `arg=…&arg=…` list: there is no page URL in front
    # of it any more, because the terminal is drawn in this document. The lstrip
    # keeps a leading "?" from being read as part of arg1 if one ever returns.
    return [v for k, v in parse_qsl(suffix.lstrip("?"), keep_blank_values=True) if k == "arg"]


def test_watch_reaches_arg5_on_the_websocket_url():
    """The whole point: 'ro' lands on $5, with every earlier slot filled."""
    args = _args(_run_builder(arg="main", watch=True))
    assert len(args) == 5, f"expected 5 args, got {args}"
    assert args[0] == "main"
    assert args[4] == "ro", f"watch request did not reach arg5: {args}"


def test_own_session_watch_leaves_the_owner_slot_empty():
    """arg4 must be EMPTY for your own session.

    tmux-attach.sh reads a blank arg4 as "mine". A placeholder like 'default'
    would instead name an OS user that does not exist, and the attach would be
    refused rather than watched.
    """
    args = _args(_run_builder(arg="main", watch=True))
    assert args[3] == "", f"own-session watch put {args[3]!r} in the owner slot"


def test_foreign_watch_keeps_owner_at_arg4_and_ro_at_arg5():
    args = _args(_run_builder(arg="main", owner="bob", watch=True))
    assert args[3] == "bob", f"owner left arg4: {args}"
    assert args[4] == "ro", f"watch left arg5: {args}"


def test_watch_does_not_disturb_the_dir_or_command_slots():
    args = _args(_run_builder(arg="main", cmd="claude", dir="/srv/p", watch=True))
    assert args == ["main", "claude", "/srv/p", "", "ro"], args


def test_without_watch_the_url_shape_is_unchanged():
    """Watch mode must be inert for every client that does not ask for it."""
    assert _args(_run_builder(arg="main")) == ["main"]
    assert _args(_run_builder(arg="main", cmd="claude")) == ["main", "claude"]
    assert _args(_run_builder(arg="main", owner="bob")) == [
        "main", "default", "default", "bob",
    ]
    assert _args(_run_builder(arg="main", cmd="c", dir="/d")) == ["main", "c", "/d"]


def test_a_launch_model_cannot_push_the_watch_flag_off_arg5():
    """The two slots BELOW arg5, which did not exist when this file was written.

    A create can now carry a model at arg6 and an effort at arg7, and the
    builder takes a separate branch to reach them. Watching a session you are
    creating therefore has to fill six or seven slots and still leave "ro" on
    the fifth. An off-by-one in that branch is exactly the arg5 loss this file
    exists for, and it would only show up on a create-and-watch.
    """
    args = _args(_run_builder(arg="main", watch=True, model="opus", effort="max"))
    assert args == ["main", "default", "default", "", "ro", "opus", "max"], args
    # Model without effort stops at arg6 rather than padding arg7.
    assert _args(_run_builder(arg="main", watch=True, model="opus")) == [
        "main", "default", "default", "", "ro", "opus",
    ]
    # And the same branch without a watch request leaves arg5 EMPTY rather than
    # writing something MODE_RE would refuse: only ro/rw are a request at all.
    assert _args(_run_builder(arg="main", model="opus", effort="max")) == [
        "main", "default", "default", "", "", "opus", "max",
    ]


# --------------------------------------------------------------------------
# Leg 2 — the devvm hop: tmux-attach.sh's branch choice and exact argv
# --------------------------------------------------------------------------

@pytest.fixture
def attach(tmp_path):
    """Run tmux-attach.sh with its external commands shimmed.

    Only the ABSOLUTE binary paths are rewritten (they cannot be shadowed by
    PATH); every line of decision logic runs verbatim. The shims record the argv
    they were called with, which is what these tests assert on — the exact-argv
    discipline is the security boundary, so the assertion has to be on the argv
    itself and not on a summary of it.
    """
    if not os.access(USER_MAP, os.R_OK):
        pytest.skip("no readable /etc/ttyd-user-map on this host")
    mapping = [
        line.split("=", 1)
        for line in open(USER_MAP, encoding="utf-8").read().splitlines()
        if line.strip() and not line.startswith("#") and "=" in line
    ]
    me = subprocess.run(["id", "-un"], capture_output=True, text=True).stdout.strip()
    auth = next((a for a, o in mapping if o.split(":")[0] == me), None)
    if not auth:
        pytest.skip(f"current user {me} is not in {USER_MAP}")

    shim = tmp_path / "bin"
    shim.mkdir()
    log = tmp_path / "argv.log"

    def write_shim(name, body):
        p = shim / name
        p.write_text(body)
        p.chmod(0o755)

    for name in ("tmux", "sudo", "tmux-user-attach"):
        write_shim(name, f'#!/bin/sh\nprintf "{name} %s\\n" "$*" >> {log}\nexit 0\n')
    write_shim("logger", "#!/bin/sh\nexit 0\n")
    write_shim("tty", "#!/bin/sh\necho /dev/pts/9\n")
    # curl echoes the canned response body plus the -w status line the script
    # appends, mirroring `curl -w $'\n%{http_code}'`.
    write_shim("curl", (
        "#!/bin/sh\n"
        f'for a in "$@"; do case "$a" in \'{{"owner"\'*) echo "$a" > {tmp_path}/post.json;; esac; done\n'
        f'cat {tmp_path}/resp.body\n'
        f'cat {tmp_path}/resp.code\n'
    ))

    src = open(ATTACH_SH, encoding="utf-8").read()
    src = src.replace("/usr/bin/tmux", str(shim / "tmux"))
    src = src.replace("/usr/local/bin/tmux-user-attach", str(shim / "tmux-user-attach"))
    script = tmp_path / "tmux-attach.sh"
    script.write_text(src)
    script.chmod(0o755)

    def run(args, mode="ro", code="200", spaced=False):
        # Compact by default, mirroring Go's json.NewEncoder — the exact bytes
        # tmux-api puts on the wire. `spaced` covers the other spelling, which
        # the script also accepts (an unparsed mode fails silently and in two
        # different directions, so the parse is deliberately not brittle).
        sep = (", ", ": ") if spaced else (",", ":")
        (tmp_path / "resp.body").write_text(json.dumps({"mode": mode}, separators=sep) + "\n")
        (tmp_path / "resp.code").write_text(code + "\n")
        if log.exists():
            log.unlink()
        env = dict(os.environ)
        env["TTYD_USER"] = auth
        env["PATH"] = f"{shim}:{env['PATH']}"
        proc = subprocess.run(["bash", str(script), *args], capture_output=True,
                              text=True, env=env, timeout=30)
        post = tmp_path / "post.json"
        return {
            "rc": proc.returncode,
            "stdout": proc.stdout,
            "argv": log.read_text().strip().splitlines() if log.exists() else [],
            "post": json.loads(post.read_text()) if post.exists() else None,
            "me": me,
        }

    yield run


def test_no_watch_request_keeps_the_create_path(attach):
    """A client that does not ask to watch never even consults the server."""
    r = attach(["main"])
    assert r["post"] is None, "an ordinary attach called the internal endpoint"
    assert any("tmux-user-attach main" in line for line in r["argv"]), r["argv"]
    assert not any(" -r " in line for line in r["argv"]), r["argv"]


def test_watching_your_own_session_attaches_read_only(attach):
    r = attach(["main", "default", "default", "", "ro"], mode="ro")
    assert r["argv"] == [f"tmux attach-session -r -t main"], r["argv"]


def test_the_watch_request_is_forwarded_to_the_server(attach):
    r = attach(["main", "default", "default", "", "ro"], mode="ro")
    assert r["post"]["requested"] == "ro", r["post"]
    assert r["post"]["owner"] == r["me"], r["post"]
    assert r["post"]["guest"] == r["me"], r["post"]


def test_a_session_that_does_not_exist_falls_back_to_creating_it(attach):
    """The server answers rw when there is nothing to watch; the script must
    then take the ordinary create path rather than attaching to a ghost."""
    r = attach(["main", "default", "default", "", "ro"], mode="rw")
    assert any("tmux-user-attach main" in line for line in r["argv"]), r["argv"]
    assert not any("attach-session" in line for line in r["argv"]), r["argv"]


def test_read_only_comes_from_the_server_not_the_client(attach):
    """The security direction that matters: a client asking to watch gets `-r`
    only because the SERVER said ro. When the server says rw, no `-r` appears
    however the client asked — the flag is never sourced from the argument."""
    r = attach(["main", "default", "default", "other", "ro"], mode="rw")
    assert any("attach-session -t main" in line for line in r["argv"]), r["argv"]
    assert not any("-r" in line for line in r["argv"]), r["argv"]


def test_a_foreign_attach_still_runs_as_the_owner_under_sudo(attach):
    r = attach(["main", "default", "default", "other", "ro"], mode="ro")
    assert len(r["argv"]) == 1, r["argv"]
    line = r["argv"][0]
    assert line.startswith("sudo -n -H -u other "), line
    assert line.endswith("attach-session -r -t main"), line


def test_the_mode_is_read_whichever_way_the_json_is_spaced(attach):
    """An unparsed mode is not a loud failure — it falls safe to `-r` on a
    foreign attach but falls through to CREATING the session on a self attach.
    So the parse accepts both spellings rather than depending on the encoder's
    current formatting."""
    r = attach(["main", "default", "default", "", "ro"], mode="ro", spaced=True)
    assert r["argv"] == ["tmux attach-session -r -t main"], r["argv"]


def test_a_denied_attach_execs_no_tmux_at_all(attach):
    r = attach(["main", "default", "default", "other", "ro"], code="403")
    assert r["rc"] != 0
    assert r["argv"] == [], f"a denied attach still ran: {r['argv']}"
    assert "Access denied" in r["stdout"]


@pytest.mark.parametrize("bad", ["", "RO", "ro ", "rw;id", "../../etc", "readonly", "1"])
def test_a_malformed_watch_argument_is_ignored(attach, bad):
    """arg5 is validated against ^(ro|rw)$ before it is used. Anything else is
    no request at all, so the attach keeps today's behaviour — it must never be
    guessed at, and never reach a command line."""
    r = attach(["main", "default", "default", "", bad])
    assert any("tmux-user-attach main" in line for line in r["argv"]), (bad, r["argv"])
    assert r["post"] is None, (bad, r["post"])


def test_the_session_name_is_still_the_only_client_shaped_value_in_the_argv(attach):
    """The exact-argv discipline: whatever the client sends, the tmux command
    line is fixed apart from the NAME_RE-validated session name."""
    r = attach(["main;id", "default", "default", "", "ro"], mode="ro")
    for line in r["argv"]:
        assert ";" not in line, f"an unvalidated value reached the argv: {line}"


# --------------------------------------------------------------------------
# The two legs, joined
# --------------------------------------------------------------------------

def test_the_vector_the_browser_builds_is_the_one_the_devvm_reads(attach):
    """Leg 1's output, handed to leg 2 verbatim.

    Every case above this line feeds leg 2 a hand-written list. Those lists and
    the builder can drift apart without either leg noticing, which is how an
    arg dies at a boundary that both sides test in isolation (memory #9926 was
    exactly that). So this one asks the SPA for the args, splits them the way
    ttyd's `-a` does, and runs the attach script on the result.
    """
    args = _args(_run_builder(arg="main", watch=True))
    r = attach(args, mode="ro")
    assert r["argv"] == ["tmux attach-session -r -t main"], (args, r["argv"])
    assert r["post"]["requested"] == "ro", (args, r["post"])
