"""CDP touch-gesture helpers for the terminal-lobby battery (Task M.6).

Every multi-touch battery leg (Tasks M.4-M.8) dispatches through raw CDP
``Input.dispatchTouchEvent`` — Playwright's ``page.touchscreen`` is TAP-ONLY
(no holds, no multi-point, no moves), and JS ``dispatchEvent`` clones are
untrusted (the frontend's recognizers see them, but the browser's native
gesture pipeline does not, so claim/consume behavior false-greens).

Ground rules (plan Task M.8, probe-verified):

- **FINE steps only.** A coarse dispatch (few large jumps) false-greens
  recognizer thresholds and never exercises the browser's cancelable-
  touchmove window (~1-3 moves on Chrome). Pinch legs want ≈2.5 px per
  finger per move over ≥35 moves; swipes want ≥10 moves.
- The Playwright context must be created with a touch device (e.g.
  ``p.devices['Pixel 7']`` → ``has_touch=True``, Android UA, coarse
  pointer) or CDP refuses touch dispatch. The Android-gated recognizers
  additionally read ``navigator.userAgent``, so use a real device
  descriptor, not just ``has_touch``.
- Coordinates are MAIN-FRAME viewport CSS pixels. The terminal lives in an
  iframe inside the lobby — compute targets from the OUTER page, e.g.
  ``page.locator('#session-frame').bounding_box()`` plus an inner offset.
- CDP semantics (protocol contract, verified): ``touchPoints`` carries the
  FULL set of active points; ``touchStart``/``touchMove`` need ≥1 point,
  ``touchEnd``/``touchCancel`` carry NONE (all points release). The backend
  diffs against the previous event and synthesizes per-point transitions.

Usage from a battery script (sync Playwright API)::

    from gestures import multi_swipe, pinch, long_press, two_finger_tap
    box = page.locator('#session-frame').bounding_box()
    cx, cy = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
    # Android 3-finger session swipe (leftward = next session):
    multi_swipe(page, [(cx - 40, cy), (cx, cy + 30), (cx + 40, cy + 60)],
                dx=-120, steps=12)
    # 1-finger module-isolation leg (5 px steps):
    multi_swipe(page, [(cx, cy)], dx=0, dy=-60, steps=12)
    two_finger_tap(page, cx, cy)
    long_press(page, cx, cy, hold_ms=600)
    pinch(page, cx, cy, span0=80, span1=255, steps=35)   # ≈2.5 px/finger/move
"""

import time

__all__ = ["multi_swipe", "pinch", "long_press", "two_finger_tap"]

_CDP_ATTR = "_tl_gestures_cdp"


def _cdp(page):
    """One cached CDP session per Playwright page."""
    sess = getattr(page, _CDP_ATTR, None)
    if sess is None:
        sess = page.context.new_cdp_session(page)
        setattr(page, _CDP_ATTR, sess)
    return sess


def _touch(page, type_, points):
    _cdp(page).send(
        "Input.dispatchTouchEvent",
        {
            "type": type_,
            "touchPoints": [
                {"x": float(x), "y": float(y), "id": i}
                for i, (x, y) in enumerate(points)
            ],
        },
    )


def _sleep_ms(ms):
    if ms > 0:
        time.sleep(ms / 1000.0)


def multi_swipe(page, points, dx, dy=0.0, steps=12, step_ms=16,
                hold_ms=0, release=True):
    """N-finger straight swipe: all fingers travel (dx, dy) in fine steps.

    ``points``: list of (x, y) start positions — 1 tuple gives the 1-finger
    module-isolation leg, 3 tuples the Android session swipe. ``steps=12``
    with the default 16 ms cadence covers 3-finger commit thresholds
    (mean |dx| >= 80 px inside 600 ms) while staying fine-grained; a
    12-step 60 px 1-finger swipe moves 5 px per step (the discriminator's
    6 px tap-vs-swipe threshold trips on step 2).

    ``hold_ms``: rest with all fingers down BEFORE moving (>350 ms
    exercises the swipe recognizer's OEM-screenshot-hold abort).
    ``release=False`` leaves the fingers down (caller ends the sequence).
    """
    pts = [(float(x), float(y)) for x, y in points]
    _touch(page, "touchStart", pts)
    _sleep_ms(hold_ms)
    for i in range(1, steps + 1):
        moved = [(x + dx * i / steps, y + dy * i / steps) for x, y in pts]
        _touch(page, "touchMove", moved)
        _sleep_ms(step_ms)
    if release:
        _touch(page, "touchEnd", [])


def pinch(page, cx, cy, span0, span1, steps=35, step_ms=16, angle_deg=0.0):
    """Two-finger pinch around (cx, cy): finger gap span0 → span1 px.

    FINE steps are mandatory (plan M.8): with the defaults, pick spans so
    ``abs(span1 - span0) / (2 * steps)`` ≈ 2.5 px per finger per move
    (e.g. 80 → 255 at 35 steps). ``span1 > span0`` diverges (zoom-in
    shape), ``span1 < span0`` converges. ``angle_deg`` rotates the finger
    axis (0 = horizontal). A span-constant 2-finger PAN is
    ``multi_swipe(page, [p1, p2], dx=..., dy=...)``.
    """
    import math
    ux = math.cos(math.radians(angle_deg)) / 2.0
    uy = math.sin(math.radians(angle_deg)) / 2.0

    def at(span):
        return [(cx - span * ux, cy - span * uy),
                (cx + span * ux, cy + span * uy)]

    _touch(page, "touchStart", at(span0))
    for i in range(1, steps + 1):
        _touch(page, "touchMove", at(span0 + (span1 - span0) * i / steps))
        _sleep_ms(step_ms)
    _touch(page, "touchEnd", [])


def long_press(page, x, y, hold_ms=600, jitter_px=0.0):
    """1-finger press-and-hold (M.4 card/thumb menus: >=600 ms, <10 px).

    ``jitter_px`` > 0 adds one mid-hold move of that size — e.g. 15 to
    exercise the >10 px travel-cancel leg.
    """
    _touch(page, "touchStart", [(x, y)])
    if jitter_px:
        _sleep_ms(min(200, hold_ms // 3))
        _touch(page, "touchMove", [(x + jitter_px, y)])
    _sleep_ms(hold_ms)
    _touch(page, "touchEnd", [])


def two_finger_tap(page, x, y, gap_px=60, hold_ms=80, travel_px=0.0,
                   span_delta_px=0.0):
    """Two fingers down + up, ``gap_px`` apart, horizontally around (x, y).

    Defaults satisfy the M.6 toolbar-toggle gate (<220 ms, <10 px travel,
    <8% span delta). Reject legs: ``travel_px=15`` drags both fingers past
    the travel gate; ``span_delta_px`` moves only the RIGHT finger outward
    (``gap_px=60, span_delta_px=10`` ≈ 17% span growth = pinch start);
    ``hold_ms=300`` overshoots the 220 ms window.
    """
    left = (x - gap_px / 2.0, y)
    right = (x + gap_px / 2.0, y)
    _touch(page, "touchStart", [left, right])
    if travel_px or span_delta_px:
        _sleep_ms(20)
        _touch(page, "touchMove", [
            (left[0] + travel_px, left[1]),
            (right[0] + travel_px + span_delta_px, right[1]),
        ])
    _sleep_ms(hold_ms)
    _touch(page, "touchEnd", [])
