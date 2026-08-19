"""Generate SVG mockups of the Skills group, using terminal-lobby's real Slate tokens."""
import html, pathlib

OUT = pathlib.Path(__file__).parent

# --- theme-slate tokens, copied from frontend-v2/src/theme/theme.css -----------
BG_PAGE, BG_CARD, BG_HOVER = "#0d1117", "#161b22", "#1c2128"
FG, MUTED = "#e6e8eb", "#7d8590"
BORDER, BORDER_STRONG = "#1f242d", "#30363d"
ACCENT, DANGER, SUCCESS = "#4493f8", "#f47067", "#56d364"
RUNNING, AWAITING, DONE = "#4493f8", "#a371f7", "#56d364"
UI = "'DM Sans','Inter',system-ui,-apple-system,sans-serif"
MONO = "'JetBrains Mono','SFMono-Regular',ui-monospace,monospace"
R, RCARD = 10, 18

W = 420          # .tl-settings width
PAD = 18         # panel horizontal padding


def e(s):
    return html.escape(str(s), quote=True)


class Svg:
    def __init__(self, w, h, title):
        self.w, self.h, self.title = w, h, title
        self.p = []

    def rect(self, x, y, w, h, fill="none", stroke=None, rx=0, sw=1, dash=None, op=None):
        a = f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}"'
        if stroke:
            a += f' stroke="{stroke}" stroke-width="{sw}"'
        if dash:
            a += f' stroke-dasharray="{dash}"'
        if op is not None:
            a += f' opacity="{op}"'
        self.p.append(a + "/>")

    def text(self, x, y, s, size=13, fill=FG, font=UI, weight=None, anchor="start", ls=None, op=None):
        a = f'<text x="{x}" y="{y}" font-family="{font}" font-size="{size}" fill="{fill}"'
        if weight:
            a += f' font-weight="{weight}"'
        if anchor != "start":
            a += f' text-anchor="{anchor}"'
        if ls:
            a += f' letter-spacing="{ls}"'
        if op is not None:
            a += f' opacity="{op}"'
        self.p.append(a + f">{e(s)}</text>")

    def line(self, x1, y1, x2, y2, stroke=BORDER, sw=1, dash=None):
        a = f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{stroke}" stroke-width="{sw}"'
        if dash:
            a += f' stroke-dasharray="{dash}"'
        self.p.append(a + "/>")

    def path(self, d, stroke=None, fill="none", sw=2, cap="round"):
        a = f'<path d="{d}" fill="{fill}"'
        if stroke:
            a += f' stroke="{stroke}" stroke-width="{sw}" stroke-linecap="{cap}" stroke-linejoin="round"'
        self.p.append(a + "/>")

    def circle(self, cx, cy, r, fill, stroke=None, sw=1):
        a = f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{fill}"'
        if stroke:
            a += f' stroke="{stroke}" stroke-width="{sw}"'
        self.p.append(a + "/>")

    # --- composites -----------------------------------------------------------
    def panel(self, y=0, h=None):
        """The .tl-settings dialog card."""
        self.rect(1, y + 1, self.w - 2, (h or self.h) - 2 - y, fill=BG_CARD,
                  stroke=BORDER_STRONG, rx=RCARD)

    def group_label(self, y, s, right=None):
        self.text(PAD, y, s.upper(), size=11, fill=MUTED, ls="0.9")
        if right:
            self.text(self.w - PAD, y, right, size=11, fill=MUTED, anchor="end")

    def divider(self, y):
        self.line(PAD, y, self.w - PAD, y, stroke=BORDER)

    def check(self, x, y, on=True, color=ACCENT):
        """13px checkbox, centred on y."""
        s = 13
        self.rect(x, y - s / 2, s, s, fill=color if on else "none",
                  stroke=color if on else BORDER_STRONG, rx=3)
        if on:
            self.path(f"M{x+3},{y} l2.6,2.6 L{x+10},{y-3.4}", stroke=BG_PAGE, sw=1.9)

    def btn(self, x, y, label, w=None, kind="normal", size=12):
        """.tl-settings-btn — returns its width."""
        w = w or (len(label) * 6.7 + 20)
        h = 24
        fill, stroke, fg = BG_PAGE, BORDER, FG
        if kind == "accent":
            fill, stroke, fg = "#132b4d", ACCENT, "#cfe3ff"
        elif kind == "danger":
            stroke, fg = DANGER, DANGER
        elif kind == "ghost":
            fg = MUTED
        self.rect(x, y - h / 2, w, h, fill=fill, stroke=stroke, rx=R)
        self.text(x + w / 2, y + 4, label, size=size, fill=fg, anchor="middle")
        return w

    def dot(self, cx, cy, color, hollow=False):
        if hollow:
            self.circle(cx, cy, 4, "none", stroke=color, sw=1.6)
        else:
            self.circle(cx, cy, 4.2, color)

    def out(self, name):
        body = "\n  ".join(self.p)
        svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.w} {self.h}" '
               f'style="max-width:{self.w}px;width:100%;height:auto;display:block" '
               f'role="img" aria-label="{e(self.title)}">\n'
               f'  <title>{e(self.title)}</title>\n  {body}\n</svg>\n')
        (OUT / name).write_text(svg)
        return svg


# =============================================================================
# M1 — the Skills group inside the Settings overlay
# =============================================================================
def m1():
    """The shipped surface: its own overlay, tabs, filter."""
    s = Svg(560, 660, "The Skills panel: its own overlay beside Settings")
    s.panel()
    s.text(PAD, 34, "Skills", size=15, weight="600")
    s.text(s.w - PAD - 28, 35, "\u27f3", size=14, fill=MUTED, anchor="end")
    s.text(s.w - PAD - 4, 35, "\u2715", size=15, fill=MUTED, anchor="end")

    # tab strip: this account first, then each other account, then the rest
    y, x = 56, PAD
    for label, count, active in (("Mine", "38", True), ("bob", "17", False),
                                 ("Plugins", "7", False), ("Sessions", "13", False)):
        # room for both halves plus the gap between them; a tighter metric
        # ran "Mine" into its own count.
        w = len(label) * 7.0 + len(count) * 7.0 + 34
        s.rect(x, y, w, 26, fill="#132b4d" if active else BG_PAGE,
               stroke=ACCENT if active else BORDER, rx=R)
        s.text(x + 11, y + 17, label, size=12, fill=FG if active else MUTED)
        s.text(x + w - 11, y + 17, count, size=11, fill=FG if active else MUTED,
               anchor="end")
        x += w + 5
    y += 34
    s.line(PAD, y, s.w - PAD, y, stroke=BORDER)

    # the filter, which is what makes 38 rows usable
    y += 12
    s.rect(PAD, y, s.w - PAD * 2, 30, fill=BG_PAGE, stroke=BORDER, rx=R)
    s.text(PAD + 11, y + 20, "Filter by name or description", size=12, fill=MUTED)
    y += 46

    def row(y, name, meta, *, on=True, metafill=MUTED):
        s.check(PAD, y, on)
        s.text(PAD + 22, y + 4, name, size=13, font=MONO,
               fill=FG if on else MUTED, op=None if on else 0.75)
        s.text(s.w - PAD, y + 4, meta, size=11, fill=metafill, anchor="end")

    for name, meta, on, fill in (
        ("grilling", "own", True, MUTED),
        ("publish-page", "own", True, MUTED),
        ("cluster-health", "from bob \u00b7 \u27f3 update", True, ACCENT),
        ("caveman", "from bob", False, MUTED),
        ("email", "own", True, MUTED),
        ("spotify", "own", True, MUTED),
        ("tripit-cli", "own", True, MUTED),
    ):
        row(y, name, meta, on=on, metafill=fill)
        y += 27
    s.text(PAD + 22, y + 4, "\u2026  31 more, scrolling under the tabs", size=11,
           fill=MUTED, font=UI)

    y += 28
    s.line(PAD, y, s.w - PAD, y, stroke=BORDER)
    y += 20
    s.text(PAD, y, "Everyone here can see everyone's skills. Installing copies it into",
           size=11, fill=MUTED)
    s.text(PAD, y + 15, "your account; the owner's copy is untouched.", size=11, fill=MUTED)
    s.h = y + 34
    return s


# =============================================================================
# M2 — an expanded row
# =============================================================================
def m2():
    s = Svg(W, 300, "An expanded skill row with its actions")
    s.panel()
    y = 34
    s.group_label(y, "Skills", right="⟳ refresh")
    y += 24
    s.check(PAD, y, True)
    s.text(PAD + 22, y + 4, "diagnose", size=13, font=MONO)
    s.text(W - PAD, y + 4, "from bob · ⟳ update", size=11, fill=ACCENT, anchor="end")

    # expanded body
    y += 16
    s.rect(PAD + 22, y, W - PAD * 2 - 22, 118, fill=BG_PAGE, stroke=BORDER, rx=R)
    s.text(PAD + 34, y + 22, "Diagnosis loop for hard bugs and performance", size=11, fill=MUTED)
    s.text(PAD + 34, y + 37, "regressions. Use when the user says \"diagnose\".", size=11, fill=MUTED)
    s.text(PAD + 34, y + 60, "4 files · 2 executable · 6.1 KB", size=11, fill=MUTED, font=MONO)
    s.text(PAD + 34, y + 76, "bob changed SKILL.md 3 days ago", size=11, fill=ACCENT, font=MONO)
    bx = PAD + 34
    for label, kind in (("View", "normal"), ("Update", "accent"),
                        ("Disable", "normal"), ("Remove", "danger")):
        bx += s.btn(bx, y + 100, label, kind=kind) + 7

    y += 134
    s.text(PAD, y + 4, "Remove backs the directory up first, it never just deletes.",
           size=11, fill=MUTED)
    s.h = y + 24
    return s


# =============================================================================
# M3 — the collision path
# =============================================================================
def m3():
    s = Svg(W, 330, "Installing a skill whose name you already use")
    s.panel()
    y = 34
    s.group_label(y, "From bob — not installed")
    y += 26
    s.text(PAD, y + 4, "tdd", size=13, font=MONO)
    bx = PAD + 34
    s.rect(bx, y - 7, 58, 15, fill="#2a1f16", stroke=DANGER, rx=7)
    s.text(bx + 29, y + 4, "differs", size=10, fill=DANGER, anchor="middle")
    s.text(W - PAD, y + 4, "you have your own", size=11, fill=MUTED, anchor="end")

    # diff box
    y += 18
    s.rect(PAD, y, W - PAD * 2, 96, fill=BG_PAGE, stroke=BORDER, rx=R)
    s.text(PAD + 12, y + 20, "SKILL.md", size=11, fill=MUTED, font=MONO)
    s.line(PAD + 12, y + 28, W - PAD - 12, y + 28, stroke=BORDER)
    rows = [("-", "red-green-refactor, property-based tests", DANGER),
            ("+", "red-green-refactor; integration first", SUCCESS),
            (" ", "…3 more changed lines", MUTED)]
    ry = y + 46
    for sign, txt, col in rows:
        s.text(PAD + 12, ry, sign, size=11, fill=col, font=MONO)
        s.text(PAD + 26, ry, txt, size=11, fill=col, font=MONO,
               op=0.85 if col is MUTED else None)
        ry += 17

    y += 112
    bx = PAD
    bx += s.btn(bx, y, "View full diff") + 8
    s.btn(bx, y, "Replace (backs up mine)", kind="accent")
    y += 26
    s.text(PAD, y + 4, "Your copy moves to .backup/tdd-20260819T0912Z/ before", size=11, fill=MUTED)
    s.text(PAD, y + 19, "bob's is written. Identical skills show \"= same as yours\"", size=11, fill=MUTED)
    s.text(PAD, y + 34, "and offer nothing to do.", size=11, fill=MUTED)
    s.h = y + 52
    return s


# =============================================================================
# M4 — what happens after an install
# =============================================================================
def m4():
    s = Svg(W, 270, "After an install: which sessions can pick it up")
    s.panel()
    y = 36
    s.circle(PAD + 7, y - 4, 8, "none", stroke=SUCCESS, sw=1.6)
    s.path(f"M{PAD+3.5},{y-4.5} l2.6,2.6 L{PAD+11},{y-8}", stroke=SUCCESS, sw=1.8)
    s.text(PAD + 24, y, "installed diagnose from bob", size=13)
    y += 24
    s.text(PAD, y, "Loads in new sessions. 3 of yours are running now:", size=11, fill=MUTED)

    y += 14
    s.rect(PAD, y, W - PAD * 2, 108, fill=BG_PAGE, stroke=BORDER, rx=R)
    ry = y + 26
    sessions = [("infra-work", "running", RUNNING, False, "picks it up on next start"),
                ("notes", "idle", DONE, True, None),
                ("tripit", "awaiting", AWAITING, True, None)]
    for name, state, col, restartable, note in sessions:
        s.dot(PAD + 20, ry - 4, col, hollow=state != "running")
        s.text(PAD + 34, ry, name, size=12, font=MONO)
        s.text(PAD + 140, ry, state, size=11, fill=col)
        if restartable:
            s.btn(W - PAD - 90, ry - 4, "Restart", w=78)
        else:
            s.text(W - PAD - 12, ry, note, size=10, fill=MUTED, anchor="end")
        ry += 32

    y += 124
    s.text(PAD, y, "Restart respawns the pane with claude --continue, so the", size=11, fill=MUTED)
    s.text(PAD, y + 15, "conversation survives. A session mid-turn is never offered one.",
           size=11, fill=MUTED)
    s.h = y + 32
    return s


for name, fn in (("m1-skills-panel.svg", m1), ("m2-row-expanded.svg", m2),
                 ("m3-collision.svg", m3), ("m4-after-install.svg", m4)):
    s = fn()
    # re-emit the panel at the final height
    s.p = [p for p in s.p if not (p.startswith('<rect x="1"'))]
    # s.w, not W: the panel mockup is wider than the row ones, and a hardcoded
    # width here drew a 420px card inside a 560px viewBox.
    s.p.insert(0, f'<rect x="1" y="1" width="{s.w-2}" height="{s.h-2}" rx="{RCARD}" '
                  f'fill="{BG_CARD}" stroke="{BORDER_STRONG}" stroke-width="1"/>')
    s.out(name)
    print(f"{name}  {s.w}x{s.h}")

CAPTIONS = {
    "m1-skills-panel.svg": (
        "<strong>1 — the group in place.</strong> Every user's skills are visible with no "
        "publish step. <em>Mine</em> carries provenance and an update marker, <em>Plugins</em> "
        "brings the marketplace ones into the same inventory, and <em>From bob</em> is what "
        "is there to take — an identical skill says so and offers nothing to do."),
    "m2-row-expanded.svg": (
        "<strong>2 — a row opened.</strong> The description, the file count, and how many of "
        "those files are executable, because installing a skill puts its scripts in your "
        "sessions. Update appears only when the owner's copy has moved on."),
    "m3-collision.svg": (
        "<strong>3 — a name you already use.</strong> 13 of bob's 22 names already exist in "
        "wizard's account and 9 of those differ, so this is ordinary traffic: the diff comes "
        "first, and Install becomes Replace, which backs your copy up before writing."),
    "m4-after-install.svg": (
        "<strong>4 — after an install.</strong> A skill only loads in a new session, so the "
        "panel names the ones already running and offers Restart on those that are idle. A "
        "session mid-turn is never offered one."),
}

# A <figure> wrapper is load-bearing: Python-Markdown treats <svg> as span-level and
# wraps its children in <p>, and a <p> inside <svg> ends SVG parsing in the browser —
# the panel renders empty and every label spills out as page prose. <figure> is
# block-level to md_in_html, so the block passes through untouched.
frag = ["## Mockups\n",
        "Slate theme, at the panel's real width of 420 px. Generated by",
        "`assets/skill-manager/gen.py`, which takes its palette from",
        "`frontend-v2/src/theme/theme.css` and its geometry from the `.tl-settings-*`",
        "rules in `frontend-v2/src/app.css`, so these are the panel's own tokens rather",
        "than approximations.\n"]
for name, cap in CAPTIONS.items():
    frag.append('<figure style="margin:1.4rem 0">')
    frag.append((OUT / name).read_text().strip())
    frag.append(f'<figcaption style="font-size:0.86em;line-height:1.55;'
                 f'opacity:0.78;margin-top:0.6rem">{cap}</figcaption>')
    frag.append("</figure>\n")
(OUT / "fragment.md").write_text("\n".join(frag))
print("fragment.md", len((OUT / "fragment.md").read_text()), "chars")
