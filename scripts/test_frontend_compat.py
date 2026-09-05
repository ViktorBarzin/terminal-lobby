#!/usr/bin/env python3
"""Guards the oldest browser engine we serve against the shipped frontend.

A syntax error in a shipped chunk is fatal for the whole script it sits in, and
that is not theoretical: xterm.js 6.0.0 (vendored 2026-07-13) shipped ES2022
class static blocks, Safari parses those only from 16.4, and on iPadOS 15.8 — a
Safari 15.6-era WebKit, which every browser on that OS uses — the bundle failed
to parse. window.Terminal was never defined, so the terminal pane came up empty
while the rest of the lobby kept working, and no WebSocket was ever attempted.

WHAT THIS FILE CHECKS, since it has been aimed at three different things now.
The subject is THE BUILT SPA: its page, every assets/*.js chunk beside it, and
every stylesheet it ships. It reads the built artifact rather than the source,
because the source is TypeScript and says nothing about what vite will emit.

There was a second arm until 2026-09-05, aimed at `frontend/term.html` — a
hand-written page that mounted xterm itself, with a hand-vendored copy of the
library spliced between BEGIN/END VENDOR markers by scripts/vendor-xterm.py.
Five test functions and 15 cases read that page, and all five had an SPA
counterpart in this same file already, so they went with it rather than being
re-pointed at bytes another test already audits. Two had no counterpart and
needed none: they asserted that the hand-written block existed and defined
Terminal, FitAddon and WebglAddon, and there is no hand-written block any more
— TerminalNative does `import("@xterm/xterm")`, a bare specifier vite resolves
from the committed package-lock.json.

The question those two DID answer has not gone away, and it has its own test
now (`test_the_spa_loads_no_script_from_a_cdn`): xterm was on a CDN for a while,
which would have handed bob's iPad the same blank terminal the vendoring existed
to fix. The routine path back to that is closed by construction, but an
`<script src="https://cdn…">` hand-added to frontend-v2/index.html was invisible
to every check here, because the SPA fixture collects script BODIES and an
src-only tag has none.
"""
from __future__ import annotations

import glob
import os
import re
import shlex
import shutil
import subprocess
from typing import Literal, NamedTuple

import pytest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The floor is set by the oldest engine in use: bob's iPad, which cannot be
# upgraded past iPadOS 15.8. Keep this in sync with `build.target` in
# frontend-v2/vite.config.ts, which is what decides the shipped syntax.
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


def _esbuild() -> list[str] | None:
    local = os.path.join(REPO, "frontend-v2", "node_modules", ".bin", "esbuild")
    if os.path.isfile(local):
        return [local]
    return [shutil.which("esbuild")] if shutil.which("esbuild") else None


# ---------------------------------------------------------------------------
# The BUILT SPA (frontend-v2).
#
# The lobby stopped being frontend/index.html on 2026-08-16, when the SolidJS
# SPA was promoted to /usr/local/share/ttyd/index.html. The guards that existed
# then only ever read the vanilla pages, so the promotion quietly moved the
# shipped bytes out from under the check that existed for exactly this failure:
# vite's build.target decides what syntax survives, it was "es2022", and
# viteSingleFile inlined the whole bundle into ONE script — so one ES2022
# construct anywhere in it took the entire lobby down on the baseline engine.
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
def spa() -> tuple[str, list[tuple[str, str]]]:
    """The shipped SPA: its page AND the chunks the page loads.

    The bundle stopped being inline on 2026-08-28, when viteSingleFile was
    dropped so first paint no longer waits for 1.2 MB. That moved the shipped
    JavaScript out of index.html and into assets/*.js — out from under this
    guard, which is precisely how the check went blind the LAST time the lobby
    moved (see the comment above). So the fixture follows the bytes: the page
    plus every chunk beside it, concatenated, because what matters is whether a
    fatal construct ships at all rather than which file carries it.
    """
    for path in _spa_candidates():
        if not os.path.isfile(path):
            continue
        with open(path, encoding="utf-8") as f:
            html = f.read()
        # Every piece of JavaScript that ships, each kept SEPARATE: this page's
        # inline scripts, then every chunk beside it. Not concatenated — the
        # chunks are ES modules, and joining them into one script is invalid by
        # construction (top-level imports, repeated declarations), which reads as
        # a parse failure that has nothing to do with the baseline engine. They
        # also load independently in the browser, so auditing them independently
        # is the honest shape.
        pieces: list[tuple[str, str]] = [
            (f"{os.path.basename(path)} inline #{i}", code)
            for i, code in enumerate(re.findall(r"<script[^>]*>(.*?)</script>", html, re.S))
            if code.strip()
        ]
        for chunk in sorted(glob.glob(os.path.join(os.path.dirname(path), "assets", "*.js"))):
            with open(chunk, encoding="utf-8") as f:
                pieces.append((os.path.basename(chunk), f.read()))
        if not pieces:
            pytest.fail(
                f"{path} carries no inline script and no assets/*.js beside it — "
                "nothing was audited, which is how this check went blind before"
            )
        return path, pieces
    pytest.skip(
        "no built SPA found — run `npm run build` in frontend-v2, or point "
        "TL_SPA at the page to audit"
    )


# A THIRD PARTY MUST NOT DECIDE WHAT THE FLOOR HAS TO PARSE.
#
# This is the question the two deleted vendored-block tests existed to answer,
# in the shape the SPA needs. xterm was loaded from a CDN for a while, and the
# CDN's CJS build carried 18 class static blocks, which is exactly the blank
# terminal the hand-vendoring was introduced to fix. Every check in this file
# reads bytes that are IN the payload, so a script fetched at runtime from
# somewhere else is audited by nothing at all.
#
# The routine path back is closed by construction: TerminalNative does
# `import("@xterm/xterm")`, a bare specifier vite resolves from node_modules
# against a committed package-lock.json at build time, and vite emits it as a
# content-hashed chunk this file already audits. What is NOT closed, and what
# this test covers, are the two ways a remote script can still ship:
#
#   1. `<script src="https://cdn…">` hand-added to frontend-v2/index.html. The
#      SPA fixture above collects script BODIES (`<script…>(.*?)</script>`) and
#      skips empty ones, so an src-only tag contributes no piece and is
#      invisible to every other assertion here.
#   2. a dynamic `import()` of a URL, which lands the host inside a chunk with
#      nothing asserting its absence.
#
# Same-origin sources are fine and expected: the page loads its own
# /assets/*.js, and those ARE audited.
CDN_HOSTS = (
    "cdn.jsdelivr.net",
    "unpkg.com",
    "cdnjs.cloudflare.com",
    "esm.sh",
    "cdn.skypack.dev",
    "ga.jspm.io",
    "code.jquery.com",
)


def test_the_spa_loads_no_script_from_a_cdn(spa: tuple[str, list[tuple[str, str]]]) -> None:
    path, pieces = spa
    with open(path, encoding="utf-8") as f:
        html = f.read()

    # An external script tag, whatever the host: the page must load only its own
    # origin, so this needs no host list and catches a CDN nobody enumerated.
    external = [
        m.group(1)
        for m in re.finditer(r"""<script[^>]*\bsrc\s*=\s*["']([^"']+)["']""", html, re.I)
        if re.match(r"(?i)(?:https?:)?//", m.group(1))
    ]
    assert not external, (
        f"{os.path.basename(path)} loads {external} from another origin. Nothing in "
        f"this file audits a script fetched at runtime, so its syntax reaches "
        f"bob's iPad unchecked — which is how a CDN xterm handed that device a "
        f"blank terminal. Add the dependency to package.json and import it, so "
        f"vite emits it as a chunk beside the page."
    )

    # And a URL import inside the shipped JavaScript, which would fetch at run
    # time from a chunk this file otherwise reads as clean.
    for label, code in pieces:
        for host in CDN_HOSTS:
            assert host not in code, (
                f"{label} references {host}. A module fetched from there at run "
                f"time is parsed by the browser and audited by nothing here."
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
def test_spa_no_class_static_blocks(spa: tuple[str, list[tuple[str, str]]]) -> None:
    path, pieces = spa
    hits = [
        (label, len(FATAL_SYNTAX["class static block"].findall(code)))
        for label, code in pieces
        if FATAL_SYNTAX["class static block"].search(code)
    ]
    assert not hits, (
        f"the built SPA ({os.path.basename(path)}) ships class static blocks in "
        f"{hits} — a parse-time SyntaxError on {BASELINE} (iPadOS 15.8). The entry "
        f"chunk failing to parse is a blank page rather than a degraded one; a lazy "
        f"chunk failing takes the feature that imports it. Set build.target to "
        f"'{BASELINE}' in frontend-v2/vite.config.ts."
    )


def test_spa_esbuild_agrees_nothing_needs_lowering(
    tmp_path, spa: tuple[str, list[tuple[str, str]]]
) -> None:
    """The authoritative check: a real parser, not the regexes above.

    `--target=safari15` on its own only tells you esbuild COULD lower the input,
    silently. Comparing it against `--target=esnext` is what reveals that
    lowering was necessary at all.
    """
    esb = _esbuild()
    if not esb:
        pytest.skip("esbuild not available (frontend-v2/node_modules or PATH)")

    path, pieces = spa
    assert pieces, f"nothing to audit in {path}"

    # One piece at a time: each chunk is its own ES module and loads on its own,
    # so each is parsed on its own. A lowering difference names the file, which is
    # what makes the failure actionable.
    lowered = []
    for label, code in pieces:
        src = tmp_path / "piece.js"
        src.write_text(code, encoding="utf-8")
        outs = {}
        for target in (BASELINE, "esnext"):
            r = subprocess.run(
                esb + [str(src), f"--target={target}", "--log-level=silent"],
                capture_output=True, check=True,
            )
            outs[target] = r.stdout
        if outs[BASELINE] != outs["esnext"]:
            lowered.append(label)

    assert not lowered, (
        f"the built SPA ships syntax newer than {BASELINE} in {lowered}, so esbuild "
        f"had to lower it — meaning the real engine on bob's iPad cannot parse those "
        f"files. The entry chunk is a blank lobby; a lazy chunk is the feature that "
        f"imports it. Set build.target to '{BASELINE}' in frontend-v2/vite.config.ts "
        f"and rebuild."
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


def _reach(pieces: list[tuple[str, str]], needle: str) -> list[str]:
    """Which pieces contain `needle`, by label — empty when none do."""
    return [label for label, code in pieces if needle in code]


def test_spa_post_baseline_apis_are_all_polyfilled(
    spa: tuple[str, list[tuple[str, str]]],
) -> None:
    path, pieces = spa
    # `pieces` is a LIST OF (label, code). It has to be searched piece by piece.
    # Writing `api in pieces` asks whether the list CONTAINS that string as an
    # element, which no list of tuples ever does — so the guard passed
    # unconditionally from the day the fixture started returning chunks
    # (2026-08-28, when viteSingleFile was dropped) until 2026-09-02, while the
    # bundle really did reach AbortSignal.timeout and URL.canParse. This is the
    # guard that exists BECAUSE AbortSignal.timeout blanked the iPad's session
    # list, so a vacuous version of it is worse than none: it reads as coverage.
    # test_the_api_guard_can_actually_fire below is what keeps it honest.
    reachable = {api: _reach(pieces, api) for api in POST_BASELINE_APIS}
    reachable = {api: where for api, where in reachable.items() if where}
    unguarded = sorted(api for api in reachable if api not in POLYFILLED)
    assert not unguarded, (
        "the built SPA can reach "
        + ", ".join(
            f"{api} ({POST_BASELINE_APIS[api]}, in {', '.join(reachable[api][:3])})"
            for api in unguarded
        )
        + f", which {BASELINE} (iPadOS 15.8) does not have. A missing method parses "
        f"fine and throws at the call, so this does not show up as a broken build — "
        f"it shows up as one feature dying on one device. Either add it to "
        f"frontend-v2/src/lib/baseline-polyfills.ts and to POLYFILLED here, or use "
        f"something the baseline has. ({os.path.basename(path)})"
    )
    if reachable:
        assert _reach(pieces, POLYFILL_MARKER), (
            f"{os.path.basename(path)} reaches {', '.join(sorted(reachable))} but "
            f"does not carry the polyfill install — baseline-polyfills.ts was dropped "
            f"from the bundle, or index.tsx stopped importing it first."
        )


def test_the_api_guard_can_actually_fire() -> None:
    """The guard above must be able to FAIL, which for five days it could not.

    A guard that cannot fail is indistinguishable from a passing one, and this
    particular guard is the only automated thing standing between a
    post-baseline method call and a device nobody here can test.
    """
    pieces = [("fake-chunk.js", "const x = await Object.groupBy(rows, f);")]
    assert _reach(pieces, "Object.groupBy") == ["fake-chunk.js"]
    assert _reach(pieces, "AbortSignal.timeout") == []
    # And the shape that broke it: searching the list itself finds nothing.
    assert "Object.groupBy" not in pieces


def test_the_shipped_bundle_really_does_reach_a_polyfilled_api(
    spa: tuple[str, list[tuple[str, str]]],
) -> None:
    """Proves the guard is looking at real bytes, not an empty haystack.

    The lobby reads AbortSignal.timeout on the way into every request, so if a
    search over the shipped pieces cannot find it, the search is broken again
    rather than the bundle being clean.
    """
    _, pieces = spa
    assert _reach(pieces, "AbortSignal.timeout"), (
        "no piece of the shipped SPA mentions AbortSignal.timeout, which every "
        "lobby request goes through — the fixture is not returning the bundle"
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


# ---------------------------------------------------------------------------
# CSS, which every guard above is blind to.
#
# The stylesheet ships in the same payload as the chunks (101,590 bytes against
# the entry chunk's 553,689 on the 2026-09-04 build), and nothing checked it
# against the floor until now.
#
# build.target is barely any help here, which is the reason this section is
# regexes rather than a differential like the two above. Run through the
# installed esbuild at --target=safari15 (checked 2026-09-04), `color-mix()`,
# `light-dark()` and `50cqw` come out byte-identical to their input, so nothing
# would show up in a baseline-versus-esnext comparison. Only CSS nesting and
# `@media` range syntax get rewritten.
#
# CSS does not fail the way JavaScript does. There is no SyntaxError and no
# console entry: the engine's error recovery throws away what it cannot parse
# and carries on, so the only symptom is a surface that looks wrong. HOW MUCH
# gets thrown away decides whether that matters, and it is not uniform:
#
#   unknown at-rule    the whole block goes, so every rule inside
#                      `@container (min-width:600px){...}` is lost together
#   bad declaration    only that declaration goes; the rest of the rule applies
#
# Each entry below carries which of the two it is. Block-level ones fail
# outright. Declaration-level ones fail unless named in
# CSS_DROPS_ONE_DECLARATION. That is a closed list the way POLYFILLED is, and
# the resemblance stops at the shape. A POLYFILLED api is RESTORED on the floor,
# and test_spa_post_baseline_apis_are_all_polyfilled proves the filler shipped
# by looking for POLYFILL_MARKER in the bundle. Nothing restores a dropped CSS
# declaration, and nothing here looks for a fallback: naming a construct in
# CSS_DROPS_ONE_DECLARATION records only that someone read what breaks and wrote
# down why the loss is survivable. It is a waiver, not a safety net.
#
# Versions are MDN browser-compat-data, read 2026-09-04, on the `safari` key
# that iOS mirrors. The floor is iPadOS 15.8, a Safari 15.6-era WebKit, so
# anything that shipped by 15.6 is BELOW the floor and has no business here.
# Checked and deliberately left out, with the version that puts each under the
# floor: `:has()` 15.4, `@layer` 15.4, `accent-color` 15.4 (this stylesheet
# uses it twice), `:is()` 14, `inset-block`/`inset-inline` 14.1,
# `oklch()`/`oklab()` 15.4, `lab()`/`lch()` 15, `dvh`/`svh`/`lvh` 15.4.
# docs/plans/2026-09-04-native-terminal-de-iframe-design.md says the floor has
# no `:has()`; BCD puts it in Safari 15.4, and the stylesheet uses neither
# `:has()` nor container queries, so the guard follows BCD. Firing on a feature
# the floor HAS costs a deploy: a class name merely ending in "static" cost one
# on 2026-08-19, which is the scar the lookbehind in FATAL_SYNTAX carries.
# ---------------------------------------------------------------------------


class CssFeature(NamedTuple):
    """A post-floor CSS construct: how to spot it, and what losing it costs."""

    pattern: re.Pattern[str]
    safari: str
    #: "block" when the engine discards more than the construct itself.
    blast: Literal["block", "declaration"]


POST_BASELINE_CSS: dict[str, CssFeature] = {
    # At-rules. An engine that does not know the name skips to the matching
    # brace, so everything styled inside one of these is styled by nothing.
    "@container": CssFeature(re.compile(r"@container[\s({]"), "Safari 16.0", "block"),
    "@property": CssFeature(re.compile(r"@property\s+--"), "Safari 16.4", "block"),
    "@scope": CssFeature(re.compile(r"@scope[\s({]"), "Safari 17.4", "block"),
    "@starting-style": CssFeature(
        re.compile(r"@starting-style[\s{]"), "Safari 17.5", "block"
    ),
    # `@media (width >= 600px)` rather than `(min-width:600px)`. A prelude the
    # engine cannot parse evaluates false, so the block never applies. `[^{]*`
    # cannot run past the prelude because `{` opens the block, which is what
    # keeps this off a `<` inside a url() elsewhere in the file.
    #
    # esbuild rewrites this to `(min-width:900px)` at build.target=safari15, so
    # the entry stands for the reason the esbuild differential stands for the
    # scripts: build.target is one config line, and it has been changed before
    # (it was "es2022" when 270 class static blocks shipped).
    "@media range syntax": CssFeature(
        re.compile(r"@media[^{]*[<>]=?"), "Safari 16.4", "block"
    ),
    # A nested rule sits where a declaration is expected, and recovery from a
    # bad declaration runs to the next `;`, taking whatever is between with it.
    # Only the `&` form is checkable here: telling a bare nested selector
    # (`.a{.b{...}}`) from a declaration needs a parser. esbuild flattens the
    # `&` form at build.target=safari15, so this entry is the same second layer
    # the range-syntax one is. Requiring a `{` before any `;` is what keeps it
    # off an `&` inside a string or a data URI.
    "CSS nesting": CssFeature(
        re.compile(r"[{;]\s*&[\w.#:\[\]>+~,\s-]*\{"), "Safari 17.2", "block"
    ),
    # Values. Each loses its own declaration and nothing else.
    "color-mix()": CssFeature(re.compile(r"color-mix\("), "Safari 16.2", "declaration"),
    "light-dark()": CssFeature(
        re.compile(r"light-dark\("), "Safari 17.5", "declaration"
    ),
    # Relative color syntax, `rgb(from var(--x) r g b / .5)`. The plain colour
    # functions themselves are all pre-floor (`lab()`/`lch()` 15,
    # `oklab()`/`oklch()` 15.4); it is the `from` keyword that is not.
    "relative color syntax": CssFeature(
        re.compile(r"\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(\s*from\b"),
        "Safari 16.4",
        "declaration",
    ),
    # Container query units. The lookbehind is the trick FATAL_SYNTAX uses: a
    # class named `.x1cqw` puts an identifier character before the digits, so
    # excluding those keeps the pattern off a selector. `-` has to be excluded
    # with them, because an atomic class name puts one there too (`.w-50cqw`).
    # A negative length puts one there as well, though, so `-?` matches the sign
    # explicitly rather than leaving the lookbehind to swallow `margin:-2cqw`.
    "container query units": CssFeature(
        re.compile(r"(?<![\w-])-?[\d.]+cq(?:w|h|i|b|min|max)\b"),
        "Safari 16.0",
        "declaration",
    ),
}

# The declaration-level entries that really do ship, and the reason each is
# tolerated. Closed like POLYFILLED, so anything not named here fails. Unlike
# POLYFILLED, being named buys no replacement: the declaration is simply gone on
# the floor, and no test in this file checks that a fallback was written.
#
# color-mix() is in the stylesheet 38 times on the 2026-09-04 build, every one a
# paint value: 24 `background`, 7 `border-color`, 3 `box-shadow`, 2
# `border-bottom`, 1 `border`, 1 `outline`. Not one has a preceding
# same-property fallback declaration, so on the floor each of those surfaces
# paints unstyled instead of tinted while the rest of its rule still applies.
# A cosmetic loss on one device rather than a blank page is the whole of the
# case for tolerating it. The fix is a fallback ahead of each one
# (`background:rgba(...)` then `background:color-mix(...)`), after which this
# entry comes off the set.
CSS_DROPS_ONE_DECLARATION = {"color-mix()"}


def _css_hits(sheets: list[tuple[str, str]], feature: CssFeature) -> list[tuple[str, int]]:
    """(label, count) for every sheet the feature appears in. Empty when none do."""
    counted = [(label, len(feature.pattern.findall(css))) for label, css in sheets]
    return [(label, n) for label, n in counted if n]


@pytest.fixture(scope="module")
def spa_css() -> tuple[str, list[tuple[str, str]]]:
    """The shipped stylesheet: assets/*.css beside the page, plus its <style> blocks.

    The BUILT CSS, not frontend-v2/src/app.css. vite runs the source through
    esbuild at build.target, so the source says what was written and the asset
    says what an engine is handed. Both halves are collected for the same reason
    the `spa` fixture collects both halves of the JavaScript: the shipped bytes
    have moved out from under this file's guards twice, and a glob that finds
    nothing reads as a pass.
    """
    for path in _spa_candidates():
        if not os.path.isfile(path):
            continue
        with open(path, encoding="utf-8") as f:
            html = f.read()
        sheets: list[tuple[str, str]] = [
            (f"{os.path.basename(path)} <style> #{i}", css)
            for i, css in enumerate(re.findall(r"<style[^>]*>(.*?)</style>", html, re.S))
            if css.strip()
        ]
        for sheet in sorted(glob.glob(os.path.join(os.path.dirname(path), "assets", "*.css"))):
            with open(sheet, encoding="utf-8") as f:
                sheets.append((os.path.basename(sheet), f.read()))
        if not sheets:
            pytest.fail(
                f"{path} carries no <style> block and no assets/*.css beside it -- "
                "nothing was audited, which is how this check went blind before"
            )
        return path, sheets
    pytest.skip(
        "no built SPA found -- run `npm run build` in frontend-v2, or point "
        "TL_SPA at the page to audit"
    )


def _assert_css_within_floor(
    path: str, sheets: list[tuple[str, str]], name: str
) -> None:
    """Fail unless `name` is absent from `sheets`, or tolerated for shipping.

    A helper rather than an inline body because it had two callers, one per
    surface, and judging them by one set of rules is what stopped them drifting
    — the drift being the bug: the audit landed on the SPA stylesheet alone
    while a second page was the one rendering the terminal on the floor. One
    caller now, and the shape is kept for the next surface rather than inlined.
    """
    feature = POST_BASELINE_CSS[name]
    hits = _css_hits(sheets, feature)
    tolerated = feature.blast == "declaration" and name in CSS_DROPS_ONE_DECLARATION
    cost = (
        # True of both block-level shapes: an unknown at-rule loses everything
        # between its braces, and a nested rule loses the declarations that
        # follow it while the engine hunts for the next `;`.
        "the engine throws away more than the construct itself, so rules with "
        "nothing to do with it go too"
        if feature.blast == "block"
        else "the declaration is dropped, so that surface renders unstyled"
    )
    fix = (
        "use a construct the floor has (a media query rather than a container "
        "query, a flat rule rather than a nested one)"
        if feature.blast == "block"
        else "put a fallback declaration for the same property ahead of it, then "
        f"name {name} in CSS_DROPS_ONE_DECLARATION with the reason"
    )
    assert tolerated or not hits, (
        f"the shipped CSS uses {name} ({feature.safari}), which {BASELINE} "
        f"(iPadOS 15.8) does not have: "
        + ", ".join(f"{label} x{n}" for label, n in hits)
        + f". CSS fails silently there rather than loudly -- {cost}, and no console "
        f"entry says so. Either {fix}. ({os.path.basename(path)})"
    )


@pytest.mark.parametrize("name", sorted(POST_BASELINE_CSS))
def test_spa_css_has_no_post_baseline_syntax(
    spa_css: tuple[str, list[tuple[str, str]]], name: str
) -> None:
    path, sheets = spa_css
    _assert_css_within_floor(path, sheets, name)


# The CSS section was aimed at the SPA stylesheet alone until 2026-09-04, when a
# second arm was added for `frontend/term.html` — the page then actually serving
# the floor, which the SPA-only guard left unchecked. That page was deleted on
# 2026-09-05 and the arm went with it: ten parameterized cases over a `page_css`
# fixture that read every <style> block in it.
#
# Worth recording, since it was measured rather than assumed: nine of the ten
# patterns found nothing in that page, and color-mix() found 18, all in its own
# <style> block — 11 `background`, 3 `border-color`, 3 `box-shadow`, 1 `border`.
# That was the same cosmetic, one-declaration loss CSS_DROPS_ONE_DECLARATION
# still tolerates for the SPA, and a real floor crossing that had shipped for
# months before the guard existed. A 19th was assigned from JavaScript
# (term.html:9258, `Object.assign(dropOverlay.style, {...})` on the
# drag-and-drop overlay), which no regex here could have found without matching
# CSS inside string literals.


# One planted stylesheet per entry, plus one near-miss that must NOT fire. Kept
# as its own table rather than generated from the patterns. A sample derived
# from the thing it checks proves nothing, which is ADR-0017's point about a
# module and the tests its own author wrote for it.
CSS_GUARD_SAMPLES: dict[str, tuple[str, str]] = {
    "@container": (
        "@container (min-width:600px){.tl-row{display:grid}}",
        "@media (min-width:600px){.tl-container{display:grid}}",
    ),
    "@property": (
        '@property --tl-accent{syntax:"<color>";inherits:true}',
        "[data-property=accent]{color:red}",
    ),
    "@scope": (
        "@scope (.tl-card){img{border:0}}",
        ".tl-scope{overflow:hidden}",
    ),
    "@starting-style": (
        "@starting-style{.tl-toast{opacity:0}}",
        "[data-starting-style=fade]{opacity:1}",
    ),
    "@media range syntax": (
        "@media (width >= 600px){.tl-row{display:grid}}",
        # The `<` sits inside a url() in the BLOCK, past the `{` that ends the
        # prelude. Minified stylesheets really do carry inline SVG like this,
        # and it is what the `[^{]*` bound exists for.
        "@media (min-width:600px){.tl-row{background:url('data:image/svg+xml,<svg/>')}}",
    ),
    "CSS nesting": (
        ".tl-row{color:red;&:hover{color:blue}}",
        # `;&` inside a string, which is what the trailing `{` requirement is for.
        '.tl-row{content:"a;&amp;b";color:red}',
    ),
    "color-mix()": (
        ".tl-row{background:color-mix(in srgb,var(--accent) 12%,transparent)}",
        ".tl-color-mixer{display:flex}",
    ),
    "light-dark()": (
        ".tl-row{color:light-dark(#000,#fff)}",
        ".tl-light-dark-toggle{display:flex}",
    ),
    "relative color syntax": (
        ".tl-row{color:rgb(from var(--accent) r g b/.5)}",
        ".tl-row{color:rgb(0 0 0/.5);font-family:from-mono}",
    ),
    "container query units": (
        ".tl-row{width:50cqw}",
        # A class name ending in the unit: the CSS-versus-JS trap that cost a
        # deploy on 2026-08-19 in its other form.
        ".x1cqw{width:50px}",
    ),
}


@pytest.mark.parametrize("name", sorted(CSS_GUARD_SAMPLES))
def test_the_css_guard_can_actually_fire(name: str) -> None:
    """Every entry must fire on a real use and stay off its near-miss.

    The guard this one mirrors checked nothing for five days
    (test_the_api_guard_can_actually_fire says how), so a CSS guard arriving
    with no proof it can fail would be the same mistake with a new list.
    """
    fatal, benign = CSS_GUARD_SAMPLES[name]
    feature = POST_BASELINE_CSS[name]
    assert _css_hits([("planted.css", fatal)], feature) == [("planted.css", 1)], (
        f"{name} ({feature.safari}) does not fire on {fatal!r}"
    )
    assert _css_hits([("planted.css", benign)], feature) == [], (
        f"{name} fires on {benign!r}, which the {BASELINE} floor parses fine"
    )


def test_the_container_query_unit_pattern_reads_the_sign() -> None:
    """A negative container-query length is a real length, and `-` is excluded.

    `(?<![\\w-])` has to keep `-` in its exclusion class or an atomic class name
    that carries one (`.w-50cqw`) fires, which is the false positive a class
    named `tl-skill-static` already cost a deploy for on 2026-08-19. That means
    the lookbehind alone cannot see `margin:-2cqw`, so the sign is matched
    explicitly instead of being read as an identifier character.
    """
    feature = POST_BASELINE_CSS["container query units"]
    fatal = [
        ".tl-row{width:50cqw}",              # the plain case
        ".tl-row{margin:-2cqw}",             # sign straight after the colon
        ".tl-row{translate:-10cqi 0}",       # sign, then a second value
        ".tl-row{inset:calc(100% - 5cqh)}",  # after a space, inside calc()
        ".tl-row{--tl-pull:-4cqmin}",        # a custom property, longest unit
    ]
    for css in fatal:
        assert _css_hits([("planted.css", css)], feature), (
            f"a real container-query length goes unseen: {css}"
        )

    benign = [
        ".x1cqw{width:50px}",            # a class name ending in the unit
        ".w-50cqw{width:50px}",          # the same, with a dash before the digits
        ".tl-a{font-family:foo50cqw}",   # the unit inside a longer identifier
    ]
    for css in benign:
        assert not _css_hits([("planted.css", css)], feature), (
            f"fires on an identifier the floor parses fine: {css}"
        )


def test_the_shipped_stylesheet_is_a_non_empty_haystack(
    spa_css: tuple[str, list[tuple[str, str]]],
) -> None:
    """Proves the fixture found real CSS rather than an empty glob.

    This file's guards have gone quiet twice by searching the wrong bytes, once
    when the SPA promotion left them reading the vanilla pages (2026-08-16) and
    once when the chunk split moved the JavaScript out of index.html
    (2026-08-28). The app names its own classes `tl-` and reads every colour
    through a custom property, so CSS carrying neither is not this app's.
    """
    path, sheets = spa_css
    body = "\n".join(css for _, css in sheets)
    assert ".tl-" in body and "var(--" in body, (
        f"the CSS collected from {os.path.basename(path)} has no `.tl-` class and "
        f"no `var(--` lookup, so it is not the lobby's -- the fixture is reading "
        f"the wrong files ({len(body)} bytes over {len(sheets)} sheet(s))"
    )
    # TerminalNative.tsx imports @xterm/xterm/css/xterm.css, and ADR-0017 records
    # that the terminal renders a column of overlapping glyphs without it. That
    # puts third-party CSS inside the floor, so its absence here means either a
    # partial build or that the native terminal stopped shipping its stylesheet.
    assert ".xterm" in body, (
        "the collected CSS carries none of xterm's own rules, which the native "
        "terminal needs to lay out at all -- the fixture has a partial build"
    )


def test_the_css_guard_tables_agree() -> None:
    """The tables must cover each other, and the escape hatch must stay narrow.

    An entry with no planted sample is one nobody has watched fire; a sample
    with no entry is a feature nobody checks. Both read as coverage.
    """
    assert sorted(POST_BASELINE_CSS) == sorted(CSS_GUARD_SAMPLES), (
        "POST_BASELINE_CSS and CSS_GUARD_SAMPLES have drifted: unsampled="
        f"{sorted(set(POST_BASELINE_CSS) - set(CSS_GUARD_SAMPLES))}, unguarded="
        f"{sorted(set(CSS_GUARD_SAMPLES) - set(POST_BASELINE_CSS))}"
    )
    assert CSS_DROPS_ONE_DECLARATION <= set(POST_BASELINE_CSS), (
        f"{sorted(CSS_DROPS_ONE_DECLARATION - set(POST_BASELINE_CSS))} is tolerated "
        "but not on the list, so nothing is looking for it in the first place"
    )
    # Nothing block-level may hide in the escape hatch. Its only justification
    # is that the engine drops one declaration and keeps the rest of the rule,
    # and an at-rule loses its entire block, so that reasoning does not reach it.
    wrong = sorted(
        name for name in CSS_DROPS_ONE_DECLARATION
        if POST_BASELINE_CSS[name].blast != "declaration"
    )
    assert not wrong, (
        f"{wrong} sit in CSS_DROPS_ONE_DECLARATION but lose more than their own "
        "declaration on the floor, so being tolerated there is not justified"
    )


# ---------------------------------------------------------------------------
# How this file is INVOKED, which decides how much of it runs.
#
# packaging/build-deb.sh is the only automated run of this file: no workflow
# under .github/ invokes it, and release.yml's own pytest step (line 81) runs
# scripts/test_qa_harness.py instead. A selector on that one line therefore does
# not narrow a run, it deletes coverage outright.
# ---------------------------------------------------------------------------

GATE_SCRIPT = os.path.join(REPO, "packaging", "build-deb.sh")
#: pytest flags that stop collected tests from running. Compared against
#: pytest's OWN argv, not searched for in the line: the invocation is
#: `python3 -m pytest`, so a plain substring search for "-m" matches the
#: interpreter flag and reads as a marker selector. `--co` is deliberately
#: absent because `--color=no` starts with it, and a guard that fires on a
#: harmless flag is the 2026-08-19 false positive again.
# Compared as WHOLE tokens, split on "=", never by prefix. A prefix test cannot
# have both halves: "--co" is what pytest accepts as the abbreviation of
# --collect-only, and it is also the start of "--color=no", which is harmless.
# Measured 2026-09-04: `pytest scripts/test_frontend_compat.py --co -q` collects
# 45 and executes none, exit 0, so the abbreviation is the total-bypass form and
# the one most worth naming.
DESELECTING_FLAGS = frozenset({
    "-k", "-m", "--deselect", "--ignore", "--last-failed", "--lf",
    "--collect-only", "--co",
})


def test_the_release_gate_runs_this_whole_file() -> None:
    """No selector on the gate's pytest line, because it is the only run there is.

    `-k spa` kept four test functions, 13 parameterized cases, and dropped the
    rest: 13 selected against 32 deselected of the 45 this file holds today.
    Among the dropped was test_the_shipped_stylesheet_is_a_non_empty_haystack,
    which is the one check that proves the CSS guard found real bytes rather
    than falling back to the small inline #tl-shell block. Two further checks on
    the guard went with it, and those two audit planted samples and the tables
    themselves rather than the SPA.
    Demonstrated 2026-09-04: a gate directory staged the way build-deb.sh does
    it but with the 88 assets/*.js copied and no assets/*.css passed `-k spa`
    13 of 13, because the fixture had fallen back to the 1,236 bytes of
    #tl-shell CSS that vite inlines into index.html and audited that. The same
    payload under the whole file failed on this check, 1 of the 33 tests the
    file held that day.

    A name-based selector needs every future test to remember a convention, and
    two of the three checks it dropped here could not honestly adopt it:
    test_the_css_guard_can_actually_fire and test_the_css_guard_tables_agree
    audit planted samples and the tables themselves, not the SPA, so calling
    either one test_spa_* would put a false claim in its name.
    """
    with open(GATE_SCRIPT, encoding="utf-8") as f:
        gate = f.read()
    me = os.path.basename(__file__)
    lines = [ln.strip() for ln in gate.splitlines() if "pytest" in ln and me in ln]
    assert lines, (
        f"packaging/build-deb.sh no longer runs {me}, so nothing in CI checks the "
        f"shipped frontend against the {BASELINE} (iPadOS 15.8) floor at all"
    )
    for line in lines:
        argv = shlex.split(line)
        args = argv[argv.index("pytest") + 1:]
        narrowing = [a for a in args if a.split("=", 1)[0] in DESELECTING_FLAGS or "::" in a]
        assert not narrowing, (
            f"the release gate narrows this file with {narrowing}: {line!r}. Every "
            f"test the selector drops runs NOWHERE, which is how the CSS guard "
            f"shipped with its honesty checks deselected. Run the "
            f"file whole; it costs 5.5s against 4.7s, measured 2026-09-04."
        )
        # A selector can arrive without touching the command line. pytest reads
        # PYTEST_ADDOPTS from the environment and prepends it to argv, so
        # `PYTEST_ADDOPTS="-k spa" python3 -m pytest <this file>` narrows the run
        # while the line above looks clean.
        assert "PYTEST_ADDOPTS" not in line, (
            f"the gate line sets PYTEST_ADDOPTS: {line!r}. pytest prepends it to "
            f"argv, so it narrows this file just as a flag would, and the "
            f"argv check above cannot see it."
        )
