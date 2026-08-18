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
# deploy, or an already-installed page you want to audit. With it unset, EVERY
# page that mounts xterm is checked: the vanilla lobby and term.html, the
# terminal the v2 SPA frames. term.html was left on a CDN xterm for a while
# after the vanilla page was vendored, which would have handed bob's iPad the
# same blank terminal the vendoring existed to fix — so the guard covers both
# rather than trusting whoever bumps a version to remember the second page.
PAGES = (
    [os.environ["TL_INDEX"]]
    if os.environ.get("TL_INDEX")
    else [
        os.path.join(REPO, "frontend", "index.html"),
        os.path.join(REPO, "frontend", "term.html"),
    ]
)

# The floor is set by the oldest engine in use: bob's iPad, which cannot be
# upgraded past iPadOS 15.8. Keep this in sync with vendor-xterm.py's BASELINE.
BASELINE = "safari15"

# Constructs that are a PARSE-time SyntaxError on the baseline engine, so they
# take out the entire enclosing script rather than just their own feature.
FATAL_SYNTAX = {
    "class static block": re.compile(r"\bstatic\s*\{"),        # ES2022, Safari 16.4
    "regexp lookbehind": re.compile(r"\(\?<[=!]"),             # Safari 16.4
    # NO "regexp v flag" entry. The v flag (Safari 17) genuinely is fatal here,
    # but it cannot be spotted by regex on this input without crying wolf: telling
    # a literal from division needs a parser, and both attempts produced false
    # positives on real bytes — flags-before-semicolon matched mermaid's
    # arithmetic (`w=b/O,T=b/v;`), and requiring a plausible body matched
    # URL-encoded SVG data URIs in the vanilla pages (`/%3E%3C/svg`). The esbuild
    # differential below is a real parser and covers the v flag wherever it is
    # applied, so the cheap layer keeps only what it can judge honestly.
}


@pytest.fixture(scope="module", params=PAGES, ids=lambda p: os.path.basename(p))
def page_path(request: pytest.FixtureRequest) -> str:
    return request.param


@pytest.fixture(scope="module")
def index(page_path: str) -> str:
    with open(page_path, encoding="utf-8") as f:
        return f.read()


@pytest.mark.parametrize("name", sorted(FATAL_SYNTAX))
def test_no_syntax_fatal_on_baseline_engine(index: str, page_path: str, name: str) -> None:
    hits = FATAL_SYNTAX[name].findall(index)
    assert not hits, (
        f"{os.path.basename(page_path)} contains {len(hits)} instance(s) of {name}, which "
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


def test_esbuild_agrees_nothing_needs_lowering(tmp_path, page_path: str) -> None:
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
    with open(page_path, encoding="utf-8") as f:
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


# ---------------------------------------------------------------------------
# The BUILT SPA (frontend-v2).
#
# The lobby stopped being frontend/index.html on 2026-08-16, when the SolidJS
# SPA was promoted to /usr/local/share/ttyd/index.html. The guards above only
# ever read the vanilla pages, so the promotion quietly moved the shipped bytes
# out from under the check that existed for exactly this failure: vite's
# build.target decides what syntax survives, it was "es2022", and viteSingleFile
# inlines the whole bundle into ONE script — so one ES2022 construct anywhere in
# it takes the entire lobby down on the baseline engine.
#
# It did. On 2026-08-18 the shipped bundle held 270 class static blocks, and
# bob's iPad (iPadOS 15.8) rendered a blank page: the tab title arrived, nothing
# else ran, and the device sent no telemetry at all — silence being the
# signature, since a page that cannot parse cannot report that it could not.
#
# These read the BUILT artifact rather than the source: the source is TypeScript
# and says nothing about what vite will emit.
# ---------------------------------------------------------------------------

def _spa_candidates() -> list[str]:
    if os.environ.get("TL_SPA"):
        return [os.environ["TL_SPA"]]
    return [
        os.path.join(REPO, "out", "index.html"),                 # stamped, about to ship
        os.path.join(REPO, "frontend-v2", "dist", "index.html"),  # a fresh local build
    ]


@pytest.fixture(scope="module")
def spa() -> tuple[str, str]:
    for path in _spa_candidates():
        if os.path.isfile(path):
            with open(path, encoding="utf-8") as f:
                return path, f.read()
    pytest.skip(
        "no built SPA found — run `npm run build` in frontend-v2, or point "
        "TL_SPA at the page to audit"
    )


# Only the static block is regex-checked on the SPA. The other two patterns
# cannot gate a MINIFIED bundle without false positives, measured on the
# 2026-08-18 build: every "v flag" hit was inline SVG path data inside a string
# (`<svg><circle cx=9 ...</svg>`), and two of the three "lookbehind" hits were a
# lookbehind inside a STRING — marked's `new RegExp("(?<=1)(?<!1)")` capability
# probe, which is wrapped in try/catch precisely so an engine without lookbehind
# takes the fallback branch. Telling a literal from division, or from a string,
# needs a parser; that is what the esbuild differential below is for. The static
# block stays because it is the construct that has now broken this page twice
# and `static {` does not plausibly occur in minified string data.
def test_spa_no_class_static_blocks(spa: tuple[str, str]) -> None:
    path, html = spa
    hits = FATAL_SYNTAX["class static block"].findall(html)
    assert not hits, (
        f"the built SPA ({os.path.basename(path)}) contains {len(hits)} class static "
        f"block(s), a parse-time SyntaxError on {BASELINE} (iPadOS 15.8). "
        f"viteSingleFile ships the bundle as ONE script, so the whole lobby fails to "
        f"start there — a blank page, not a degraded one. Set build.target to "
        f"'{BASELINE}' in frontend-v2/vite.config.ts."
    )


def test_spa_esbuild_agrees_nothing_needs_lowering(tmp_path, spa: tuple[str, str]) -> None:
    """The authoritative check: a real parser, not the regexes above.

    Same differential the vendored block gets — `--target=safari15` on its own
    only tells you esbuild COULD lower the input, silently. Comparing it against
    `--target=esnext` is what reveals that lowering was necessary at all.
    """
    esb = _esbuild()
    if not esb:
        pytest.skip("esbuild not available (frontend-v2/node_modules or PATH)")

    path, html = spa
    code = "\n".join(re.findall(r"<script[^>]*>(.*?)</script>", html, re.S))
    assert code.strip(), f"no inline script found in {path}"

    src = tmp_path / "spa.js"
    src.write_text(code, encoding="utf-8")
    outs = {}
    for target in (BASELINE, "esnext"):
        r = subprocess.run(
            esb + [str(src), f"--target={target}", "--log-level=silent"],
            capture_output=True, check=True,
        )
        outs[target] = r.stdout

    assert outs[BASELINE] == outs["esnext"], (
        f"the built SPA contains syntax newer than {BASELINE}, so esbuild had to "
        f"lower it — meaning the real engine on bob's iPad cannot parse the bundle "
        f"and the lobby comes up blank. Set build.target to '{BASELINE}' in "
        f"frontend-v2/vite.config.ts and rebuild."
    )
