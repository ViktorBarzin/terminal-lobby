#!/usr/bin/env python3
"""Guards the oldest browser engine we serve against the shipped frontend.

The vanilla frontend is a single self-contained file, so a syntax error
anywhere in it is fatal for the whole script block it sits in. That is not
theoretical: xterm.js 6.0.0 (vendored 2026-07-13) ships ES2022 class static
blocks, Safari parses those only from 16.4, and on iPadOS 15.8 — a Safari
15.6-era WebKit, which every browser on that OS uses — the bundle failed to
parse. window.Terminal was never defined, so the terminal pane came up empty
while the rest of the lobby kept working, and no WebSocket was ever attempted.

scripts/vendor-xterm.py refuses to emit static blocks, so these tests exist for
the other path in: a hand-edit, or a vendor bump done without the script.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess

import pytest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# TL_INDEX aims the same guards at a candidate file — out/index.html before a
# deploy, or an already-installed page you want to audit.
INDEX = os.environ.get("TL_INDEX") or os.path.join(REPO, "frontend", "index.html")

# The floor is set by the oldest engine in use: emo's iPad, which cannot be
# upgraded past iPadOS 15.8. Keep this in sync with vendor-xterm.py's BASELINE.
BASELINE = "safari15"

# Constructs that are a PARSE-time SyntaxError on the baseline engine, so they
# take out the entire enclosing script rather than just their own feature.
FATAL_SYNTAX = {
    "class static block": re.compile(r"\bstatic\s*\{"),        # ES2022, Safari 16.4
    "regexp lookbehind": re.compile(r"\(\?<[=!]"),             # Safari 16.4
    "regexp v flag": re.compile(r"/[gimsuy]*v[gimsuy]*;"),     # Safari 17
}


@pytest.fixture(scope="module")
def index() -> str:
    with open(INDEX, encoding="utf-8") as f:
        return f.read()


@pytest.mark.parametrize("name", sorted(FATAL_SYNTAX))
def test_no_syntax_fatal_on_baseline_engine(index: str, name: str) -> None:
    hits = FATAL_SYNTAX[name].findall(index)
    assert not hits, (
        f"frontend/index.html contains {len(hits)} instance(s) of {name}, which "
        f"is a parse-time SyntaxError on {BASELINE} (iPadOS 15.8). The enclosing "
        f"script will not run at all there. If this came from a vendor bump, "
        f"re-run scripts/vendor-xterm.py instead of editing the page by hand."
    )


def test_xterm_is_vendored_not_cdn(index: str) -> None:
    """Self-hosted, so no third party can change what an old engine must parse."""
    assert "cdn.jsdelivr.net/npm/@xterm" not in index.replace("/* https://cdn.jsdelivr.net", "/* x"), (
        "index.html loads xterm from a CDN again; vendor it with "
        "scripts/vendor-xterm.py so the bytes are transpiled and pinned."
    )
    for marker in ("BEGIN VENDOR CSS", "END VENDOR CSS", "BEGIN VENDOR JS", "END VENDOR JS"):
        assert marker in index, f"missing {marker} marker — vendor-xterm.py cannot splice"


def test_terminal_global_is_defined_by_the_vendored_block(index: str) -> None:
    """The empty-terminal symptom was window.Terminal missing; assert its source."""
    start = index.index("BEGIN VENDOR JS")
    end = index.index("END VENDOR JS")
    block = index[start:end]
    for expected in ("Terminal", "FitAddon", "WebglAddon"):
        assert expected in block, f"vendored block does not define {expected}"


def _esbuild() -> list[str] | None:
    local = os.path.join(REPO, "frontend-v2", "node_modules", ".bin", "esbuild")
    if os.path.isfile(local):
        return [local]
    return [shutil.which("esbuild")] if shutil.which("esbuild") else None


def test_esbuild_agrees_nothing_needs_lowering(tmp_path) -> None:
    """Catches post-baseline syntax the regexes above do not enumerate.

    `esbuild --target=safari15` on its own is NOT a compatibility check -- it
    silently LOWERS what the target cannot run and says nothing. So compare its
    baseline output against its esnext output: any difference means the source
    contained syntax newer than the baseline.
    """
    esb = _esbuild()
    if not esb:
        pytest.skip("esbuild not available (frontend-v2/node_modules or PATH)")

    # Only the vendored block is machine-generated third-party code; the app's
    # own inline script is hand-written against the baseline and is covered by
    # the regex tests above.
    with open(INDEX, encoding="utf-8") as f:
        html = f.read()
    assert "BEGIN VENDOR JS" in html and "END VENDOR JS" in html, (
        "no vendored block to check — xterm is not vendored into this page "
        "(run scripts/vendor-xterm.py)"
    )
    block = html[html.index("BEGIN VENDOR JS"):html.index("END VENDOR JS")]
    code = "\n".join(re.findall(r"<script>(.*?)</script>", block, re.S))
    assert code.strip(), "no vendored script content found"

    src = tmp_path / "vendored.js"
    src.write_text(code, encoding="utf-8")
    outs = {}
    for target in (BASELINE, "esnext"):
        r = subprocess.run(
            esb + [str(src), f"--target={target}", "--log-level=silent"],
            capture_output=True, check=True,
        )
        outs[target] = r.stdout

    assert outs[BASELINE] == outs["esnext"], (
        f"the vendored block still contains syntax newer than {BASELINE} — "
        f"esbuild had to lower it, so the real {BASELINE} engine cannot parse it"
    )
