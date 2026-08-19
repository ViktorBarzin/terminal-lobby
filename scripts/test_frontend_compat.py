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
    # ES2022, Safari 16.4. The lookbehind is what keeps this off CSS: the bundle
    # is one file with the stylesheet inlined, and a minified selector like
    # `.tl-skill-static{` used to match on \b. A real static block is only ever
    # preceded by `{`, `}`, `;` or whitespace — never by an identifier character,
    # a dash, a dot or a hash, which is what a selector puts there.
    "class static block": re.compile(r"(?<![\w$.#-])static\s*\{"),
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
# block stays because it is the construct that has now broken this page twice.
# It is regex-checkable because a real one can only follow `{`, `}`, `;` or
# whitespace — the lookbehind above encodes that, after a CSS class named
# `tl-skill-static` matched the older \b form and blocked a deploy (2026-08-19).
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


# ---------------------------------------------------------------------------
# Runtime APIs, which the syntax guards above cannot see.
#
# build.target only governs SYNTAX. A METHOD the baseline engine never shipped
# parses fine and throws where it is called, so the failure lands wherever that
# happens to be — which on 2026-08-19 was every lobby request: `AbortSignal.timeout`
# (Safari 16) is read on the way into each one, so the TypeError landed before
# fetch. No request left the iPad, none reached the ingress, and the sidebar
# read "Failed to load" over an empty session list. With no session to select
# there was no terminal, which is how it was reported.
#
# The rule is not "never mention these" — it is "if the bundle can reach one,
# something must fill it in first". src/lib/baseline-polyfills.ts is that
# something, and it stamps data-tl-polyfills so a device with no developer
# tools can still answer whether it ran.
#
# The SPA only. frontend/term.html names AbortSignal.timeout in a COMMENT saying
# it deliberately uses a controller and a timer instead, and a grep cannot tell
# that apart from a call.
# ---------------------------------------------------------------------------

# Substring → the Safari version that first shipped it. Matched literally.
POST_BASELINE_APIS = {
    "AbortSignal.timeout": "Safari 16.0",
    "AbortSignal.any": "Safari 17.4",
    "URL.canParse": "Safari 17.0",
    "Object.groupBy": "Safari 17.4",
    "Map.groupBy": "Safari 17.4",
    "Array.fromAsync": "Safari 16.4",
    ".toSorted(": "Safari 16.4",
    ".toReversed(": "Safari 16.4",
    ".toSpliced(": "Safari 16.4",
    ".isWellFormed(": "Safari 17.0",
    ".checkVisibility(": "Safari 17.4",
}

# The ones baseline-polyfills.ts fills in. Anything else on the list above has
# no safety net, so its presence fails.
POLYFILLED = {"AbortSignal.timeout", "URL.canParse"}

# The stamp installBaselinePolyfills() writes. Minifiers rename identifiers but
# not this string, because it becomes a DOM attribute name.
POLYFILL_MARKER = "tlPolyfills"


def test_spa_post_baseline_apis_are_all_polyfilled(spa: tuple[str, str]) -> None:
    path, html = spa
    reachable = [api for api in POST_BASELINE_APIS if api in html]
    unguarded = sorted(api for api in reachable if api not in POLYFILLED)
    assert not unguarded, (
        "the built SPA can reach "
        + ", ".join(f"{api} ({POST_BASELINE_APIS[api]})" for api in unguarded)
        + f", which {BASELINE} (iPadOS 15.8) does not have. A missing method parses "
        f"fine and throws at the call, so this does not show up as a broken build — "
        f"it shows up as one feature dying on one device. Either add it to "
        f"frontend-v2/src/lib/baseline-polyfills.ts and to POLYFILLED here, or use "
        f"something the baseline has. ({os.path.basename(path)})"
    )
    if reachable:
        assert POLYFILL_MARKER in html, (
            f"{os.path.basename(path)} reaches {', '.join(reachable)} but does not "
            f"carry the polyfill install — baseline-polyfills.ts was dropped from the "
            f"bundle, or index.tsx stopped importing it first."
        )


# The pattern is load-bearing in both directions: it has to keep catching the
# construct that blanked bob's iPad, and it must not block a deploy over a CSS
# selector that merely ends in "static" (which it did, on 2026-08-19).
def test_class_static_block_pattern_tells_js_from_css() -> None:
    pattern = FATAL_SYNTAX["class static block"]
    fatal = [
        "class A{static{x()}}",           # minified, straight after the brace
        "class A { static { x() } }",     # spaced
        "};static{y()}",                  # after a statement end
        "class A{f(){};static {z()}}",
    ]
    for src in fatal:
        assert pattern.search(src), f"must still catch a real static block: {src}"

    benign = [
        ".tl-skill-static{cursor:default}",       # the selector that blocked a deploy
        ".static{color:red}",                     # a class called exactly that
        "#static{color:red}",                     # an id
        "a.x-static{b:1}.y{c:2}",                 # minified, no space anywhere
        "el.classList.add('is-static');",         # a string, not a block
    ]
    for src in benign:
        assert not pattern.search(src), f"must not flag CSS or strings: {src}"
