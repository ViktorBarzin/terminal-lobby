import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  NO_KEYBOARD_RESERVE,
  hostHeightStyle,
  keyboardReserve,
  reduce,
  type ViewportAction,
  type ViewportEvent,
  type ViewportFacts,
  type ViewportState,
} from "../src/terminal/viewport";
import { keyboardOffset } from "../src/mobile/viewport";

/**
 * The soft-keyboard reserve, as term.html:8416-8420 and :8427-8469 pay for it.
 *
 * THE FAILURE BEHIND ALL OF IT. iOS Safari does not shrink the LAYOUT viewport
 * when the soft keyboard rises, only `window.visualViewport`, so a terminal
 * sized to 100% of a layout-anchored container renders its bottom rows, the
 * prompt among them, behind the keyboard. Two parties can know how much is
 * covered: the terminal's own visualViewport reading, and a height the shell
 * measured and forwarded. They describe the SAME keyboard, so the reserve
 * is the larger of the two and never their sum (term.html:8413-8414).
 *
 * Most of `syncViewport` is already in this app: the shell publishes
 * `--kb-offset`, the toolbar comes out of the container in CSS, and both of the
 * page's gates are in TerminalNative. What is NOT is a terminal that reads the
 * viewport for itself, which is what "the terminal reading the viewport for
 * itself" below is about.
 */

const IPHONE_LAYOUT = 812;
const IPHONE_KEYBOARD = 376;
/** The visual viewport an iPhone reports with the keyboard up, in Safari. */
const IPHONE_VISUAL = IPHONE_LAYOUT - IPHONE_KEYBOARD;
/** What iOS pans the visual viewport by to bring a focused field into view. */
const PANNED_TOP = 100;

/** A coarse-pointer phone with a visualViewport, which is every case that decides anything. */
const phone = (visualHeight: number | null, offsetTop = 0): ViewportFacts => ({
  layoutHeight: IPHONE_LAYOUT,
  visualHeight,
  offsetTop,
  coarsePointer: true,
});

/** The same geometry on a desktop mouse, where term.html writes no height at all (:8441). */
const desktop = (visualHeight: number | null, offsetTop = 0): ViewportFacts => ({
  ...phone(visualHeight, offsetTop),
  coarsePointer: false,
});

const observed = (facts: ViewportFacts) => ({ type: "observed" as const, facts });
const forwarded = (px: number, facts: ViewportFacts) => ({
  type: "forwarded" as const,
  px,
  facts,
});

/**
 * The shrink an action carries, or null for the two answers that carry none.
 * Keeps the assertions to one line. Where the difference between those two
 * matters, and it does for the fit, the tests read `action.kind` instead.
 */
const shrinkOf = (action: ViewportAction): number | null =>
  action.kind === "host-height" ? action.shrinkPx : null;

describe("the two readings of one keyboard", () => {
  /**
   * The whole function as a table, because it is one. `own` is the terminal's
   * own reading, `forwarded` is what the shell measured, `offset` is what comes
   * off the host. The last two rows are the ones term.html can never see.
   */
  const RESERVE: ReadonlyArray<
    readonly [string, number, number, number, number, number]
  > = [
    // name, layoutHeight, visualHeight, offsetTop, forwardedPx, expected offset
    ["no keyboard, nothing forwarded", 812, 812, 0, 0, 0],
    ["iOS Safari with the keyboard up", 812, 436, 0, 0, 376],
    ["a panned visual viewport takes offsetTop off the covered part", 812, 436, 100, 0, 276],
    ["framed: the frame is blind and the lobby forwards the height", 812, 812, 0, 376, 376],
    ["a layout viewport that shrank for the keyboard itself", 436, 436, 0, 0, 0],
    ["the visual viewport reported taller than the layout never goes negative", 812, 850, 0, 0, 0],
    ["a negative forwarded height is refused", 812, 812, 0, -50, 0],
    // The row this module exists for. Natively there is no iframe, so the
    // terminal's own reading and the shell's forwarded one are the same
    // keyboard measured twice: 752 would be a keyboard too far.
    ["native: both readings see the same keyboard", 812, 436, 0, 376, 376],
    ["the shell measured more than the terminal did", 812, 436, 0, 400, 400],
    ["the terminal measured more than the shell did", 812, 412, 0, 376, 400],
  ];

  it.each(RESERVE)("%s", (_name, layout, visual, top, fwd, offset) => {
    expect(keyboardReserve(layout, visual, top, fwd).offset).toBe(offset);
  });

  /** Both readings survive on the result, so a caller can tell which one won. */
  it("reports the two readings separately", () => {
    const r = keyboardReserve(812, 436, 0, 400);
    expect(r.own).toBe(376);
    expect(r.forwarded).toBe(400);
    expect(r.offset).toBe(400);
  });

  /**
   * `Math.max(0, forwarded || 0)` is term.html's expression verbatim (:8418),
   * and `|| 0` is what neutralises a NaN there. Worth pinning: the two callers
   * that reach this in the app both check `Number.isFinite` first
   * (term.html:9418, TerminalNative:1134), so this is the belt to that.
   */
  it("treats a NaN forwarded height as nothing forwarded", () => {
    expect(keyboardReserve(812, 812, 0, Number.NaN).offset).toBe(0);
  });

  /**
   * A pure function can be called with anything. term.html cannot hit this,
   * since its inputs are `window.innerHeight` and two visualViewport reads, so
   * the check is a divergence, and it is NOT the safe direction: `own` 0 where
   * the host already carries a reserve hands the rows back under the keyboard,
   * which is the harm the module exists to prevent. The two tests below are
   * what it does buy, and they are the reason the check is there.
   *
   * All THREE inputs to `own` get it, `offsetTop` included, because a
   * non-finite `offsetTop` poisons `layout - visual - offsetTop` exactly as a
   * non-finite height does. A caller cannot reach it with `undefined` under
   * `strict: true`, since `window.visualViewport?.offsetTop` is
   * `number | undefined` against a `number` field, which is why the owes list
   * spells the fallback out as `?? 0`.
   */
  const FINITE_GUARD: ReadonlyArray<
    readonly [string, number, number, number, number, number, number]
  > = [
    // name, layoutHeight, visualHeight, offsetTop, forwardedPx, expected own, expected offset
    ["a NaN layout height", Number.NaN, 436, 0, 376, 0, 376],
    ["an infinite visual height", 812, Number.POSITIVE_INFINITY, 0, 0, 0, 0],
    ["a NaN offsetTop on its own", 812, 436, Number.NaN, 0, 0, 0],
    ["a NaN offsetTop with a good forwarded height", 812, 436, Number.NaN, 376, 0, 376],
  ];

  it.each(FINITE_GUARD)(
    "falls back to no own reading for %s",
    (_name, layout, visual, top, fwd, own, offset) => {
      const r = keyboardReserve(layout, visual, top, fwd);
      expect(r.own).toBe(own);
      expect(r.offset).toBe(offset);
    },
  );

  /**
   * WHAT THE CHECK ACTUALLY BUYS, first half: a junk own reading cannot poison
   * a GOOD forwarded height. Without it `own` would be NaN, `Math.max(NaN,
   * fwd)` is NaN, and the shell's perfectly good number would go out with the
   * bad geometry.
   */
  it("keeps a good forwarded height when the own reading is junk", () => {
    expect(Math.max(Number.NaN, IPHONE_KEYBOARD)).toBeNaN();
    expect(keyboardReserve(812, 436, Number.NaN, IPHONE_KEYBOARD).offset).toBe(IPHONE_KEYBOARD);
  });

  /**
   * Second half, and the one a caller would not see coming: NaN must not reach
   * `appliedShrink`. `NaN === NaN` is false, so the dedupe would answer
   * `host-height` on every later event however settled the keyboard was, and
   * the state would stop being a claim about what is on the host. The bad
   * number would not even be visible on screen: `hostHeightStyle(NaN)` is "",
   * exactly as 0 is, because `NaN > 0` is false. So a NaN reserve reads as "no
   * keyboard", not as a fault, which is why this is checked rather than left to
   * be noticed.
   */
  it("keeps NaN out of the applied reserve, where it would not have shown", () => {
    expect(hostHeightStyle(Number.NaN)).toBe("");
    const junk = reduce(NO_KEYBOARD_RESERVE, observed(phone(436, Number.NaN)));
    expect(junk.state.appliedShrink).toBe(0);
  });
});

describe("the value that lands on the host", () => {
  /**
   * The one place that knows the host's height is relative. term.html writes an
   * absolute `vv.height - ...` because its terminal fills a whole iframe; here
   * `.tl-views.tl-kb-inline` has already taken the toolbar and the safe area
   * out of the container and deliberately left the keyboard IN
   * (app.css:2370-2372), so the number that belongs on the host is how much of
   * THAT box the keyboard covers.
   */
  it("shrinks the container by the reserve", () => {
    expect(hostHeightStyle(376)).toBe("calc(100% - 376px)");
  });

  /** Zero hands the box back to the stylesheet's `height: 100%` rather than writing `calc(100% - 0px)`. */
  it("is empty when nothing is reserved", () => {
    expect(hostHeightStyle(0)).toBe("");
    expect(hostHeightStyle(-5)).toBe("");
  });

  /**
   * A RELATIVE value, and that is load-bearing rather than a style choice.
   * term.html rewrote an absolute pixel height on every call, so its box
   * tracked `window.innerHeight` by being recomputed constantly; this module
   * writes once per distinct reserve, so the box has to keep tracking
   * `innerHeight` on its own between writes. It does, because the container
   * chain resolves to `#root { height: var(--app-vh) }` and `--app-vh` IS
   * `window.innerHeight` (app.css:30-34, mobile/viewport.ts:276). An absolute
   * `hostHeightStyle` would silently stop tracking the window while the
   * reserve sat still, which is the reason the dedupe below is safe here and
   * was not there.
   */
  it("is relative to the container, never an absolute pixel height", () => {
    expect(hostHeightStyle(376)).toContain("100%");
    expect(hostHeightStyle(376)).not.toMatch(/^\d+(\.\d+)?px$/);
  });

  /**
   * A fractional reserve is written as measured. iOS reports fractional
   * visualViewport heights and term.html writes its arithmetic straight into
   * the style string too (:8466-8467), so rounding here would be an invention.
   */
  it("keeps a fractional reserve", () => {
    expect(hostHeightStyle(376.5)).toBe("calc(100% - 376.5px)");
  });

  /**
   * A reserve taller than the container. term.html clamps its pixel height with
   * `Math.max(0, ...)` (:8467); a `calc()` that resolves negative is clamped to
   * 0 for `height` by CSS, so the rendered box is 0 either way and no clamp is
   * needed here. Said out loud because what xterm's fit then measures is a
   * zero-height box, and a reader looking for the missing `Math.max` should
   * find the reason rather than the gap.
   */
  it("does not clamp a reserve larger than the container", () => {
    expect(hostHeightStyle(900)).toBe("calc(100% - 900px)");
  });
});

describe("the gates", () => {
  /**
   * `if (!window.visualViewport) return;` (term.html:8428). Nothing is
   * measured and nothing is written, rather than a height decided from a
   * fallback the page never uses.
   */
  it("decides nothing without a visualViewport", () => {
    const r = reduce(NO_KEYBOARD_RESERVE, observed(phone(null)));
    expect(r.action.kind).toBe("nothing");
    expect(r.state).toBe(NO_KEYBOARD_RESERVE);
  });

  /**
   * The height write lives inside `if (isCoarsePointer)` (term.html:8441). A
   * fine pointer has no soft keyboard to make room for, and taking rows off a
   * desktop terminal because the browser moved its visual viewport is a
   * regression rather than a reservation.
   */
  it("writes no height for a fine pointer", () => {
    const r = reduce(NO_KEYBOARD_RESERVE, observed(desktop(IPHONE_VISUAL)));
    expect(r.action.kind).toBe("nothing");
    expect(r.state).toBe(NO_KEYBOARD_RESERVE);
  });

  /**
   * A forwarded height behind a refusing gate changes NOTHING, where term.html
   * stores `framedKb` first and keeps it (:9419-9420). The page needs that
   * memory because its own reading is blind for the whole life of a framed
   * page, so the forwarded number is the only one it will ever have; here both
   * refusals are permanent for the mount and neither can be followed by a
   * decision that could use the number.
   *   no visualViewport: the API does not appear mid-session, so gate 1 refuses
   *     every later event too.
   *   a fine pointer: `coarsePointer` is read once per mount
   *     (TerminalNative:528, term.html:6350), so gate 2 refuses every later
   *     event too.
   * A number remembered here could therefore never be spent, and the state
   * that held it would be a claim about `framedKb` that does not apply.
   */
  it.each([
    ["no visualViewport", phone(null)],
    ["a fine pointer", desktop(IPHONE_VISUAL)],
  ])("keeps no state behind %s", (_name, facts) => {
    const r = reduce(NO_KEYBOARD_RESERVE, forwarded(IPHONE_KEYBOARD, facts));
    expect(r.action.kind).toBe("nothing");
    expect(r.state).toBe(NO_KEYBOARD_RESERVE);
  });
});

describe("the terminal reading the viewport for itself", () => {
  /**
   * THE GAP THIS MODULE EXISTS FOR. `installViewportSync` is installed once at
   * the SHELL and stays installed for the whole app, the list screen and a
   * session alike (App.tsx:181-196, which records that the install moved there
   * BECAUSE a per-session one did not run until a session was opened). What is
   * missing is not the install, it is the message: `onKeyboard` fires only when
   * the height the shell measured DIFFERS from the last one it sent
   * (mobile/viewport.ts:259-262). A terminal that mounts while the keyboard is
   * already up is never told, because nothing changed: a session opened with
   * the keyboard up, a switch back to the terminal view, `?native=1` on a tab
   * that started on the list. Its host keeps the stylesheet's `height: 100%`
   * and the prompt sits behind the keyboard until the keyboard next moves.
   *
   * THE SHIPPED PAGE HAS THE SAME GAP, which this file used to deny. term.html
   * does seed, by calling `syncViewport()` at boot (:8490) off a live read, and
   * standalone that reserves the keyboard. Framed, the only configuration
   * shipped, it reserves nothing, because both readings are 0 at boot: the
   * frame's own visualViewport never saw the keyboard (:8402-8404) and
   * `framedKb` starts at 0 (:8425). The parity block below pins both halves and
   * that nothing else seeds the frame.
   *
   * So the reserve here comes out of the facts, with nothing forwarded at all.
   */
  it("reserves the keyboard from its own reading, with nothing forwarded", () => {
    const r = reduce(NO_KEYBOARD_RESERVE, observed(phone(IPHONE_VISUAL)));
    expect(shrinkOf(r.action)).toBe(IPHONE_KEYBOARD);
  });

  /** A mount with no keyboard up asks for nothing: the host already has its stylesheet height. */
  it("asks for nothing when the viewport is whole", () => {
    const r = reduce(NO_KEYBOARD_RESERVE, observed(phone(IPHONE_LAYOUT)));
    expect(r.action.kind).toBe("nothing");
    expect(r.state).toBe(NO_KEYBOARD_RESERVE);
  });

  /**
   * A platform that shrinks the LAYOUT viewport for the keyboard (Chromium's
   * `interactive-widget=resizes-content`, and the iOS standalone PWA once the
   * keyboard settles) reports a whole visual viewport inside a short layout
   * one. Nothing is covered, because the container itself already ends above
   * the keyboard. Measured on the in-cluster Android emulator, innerHeight 471
   * against an unobstructed 783 with the covered reading at 0
   * (mobile/viewport.ts:53-55).
   */
  it("reserves nothing when the layout viewport shrank for the keyboard itself", () => {
    const facts: ViewportFacts = {
      layoutHeight: 471,
      visualHeight: 471,
      offsetTop: 0,
      coarsePointer: true,
    };
    expect(reduce(NO_KEYBOARD_RESERVE, observed(facts)).action.kind).toBe("nothing");
  });
});

describe("a height forwarded by the shell", () => {
  /**
   * THE SECOND GAP. term.html's `shrink` is the forwarded height ALONE
   * (:8419), and that is safe there because the two readings are never both
   * non-zero in that page: framed, the iframe's own visualViewport does not
   * move (:8402-8404) so its reading is 0; standalone, nothing forwards
   * (:8423-8424) so the forwarded one is 0. Natively there is no iframe, the
   * terminal sits in the top window, and the shell measures that same window,
   * so both are the same keyboard and both are non-zero. Subtracting both
   * would leave a 60px terminal on an iPhone.
   */
  it("does not count the same keyboard twice", () => {
    const r = reduce(NO_KEYBOARD_RESERVE, forwarded(IPHONE_KEYBOARD, phone(IPHONE_VISUAL)));
    expect(shrinkOf(r.action)).toBe(IPHONE_KEYBOARD);
    expect(shrinkOf(r.action)).not.toBe(IPHONE_KEYBOARD * 2);
  });

  /**
   * The max still earns its place on the event that carries both readings: the
   * shell measures a frame or two before the terminal is asked, so mid-animation
   * the two numbers differ, and the larger keeps the prompt clear
   * (term.html:8413-8414). It is the PERSISTENCE that is gone, not the max.
   */
  it("takes the shell's number when it is the larger of the two", () => {
    const r = reduce(NO_KEYBOARD_RESERVE, forwarded(400, phone(IPHONE_VISUAL)));
    expect(shrinkOf(r.action)).toBe(400);
  });

  /**
   * A HEIGHT THE SHELL FORWARDED DOES NOT OUTLIVE ITS MESSAGE, which is the
   * one place the reserve deliberately leaves term.html's `framedKb` behind.
   *
   * The two readings are not two sources natively, they are one measurement
   * taken twice: the shell computes
   * `keyboardOffset(window.innerHeight, vv.height, vv.offsetTop)`
   * (mobile/viewport.ts:27-33, :242-244) on the same window this terminal
   * reads, and that is the module's own `own` character for character. So a
   * forwarded number can never legitimately exceed a fresh own reading, and any
   * excess is age. Keeping it in state and taking `max(own, remembered)` pins
   * the reserve at the STALE maximum, and a live reading of 0 cannot give the
   * rows back.
   *
   * That is not a one-frame lag either. `__tlKeyboardOffset` is a global
   * claimed via `ownWhile` (TerminalNative:1105) and every visited session
   * stays mounted, so a terminal that hands the bridge over never receives the
   * close, and one missed zero-forward would hold it short for the rest of the
   * mount.
   */
  it("gives the rows back on its own reading, with no close forwarded", () => {
    const up = reduce(NO_KEYBOARD_RESERVE, forwarded(IPHONE_KEYBOARD, phone(IPHONE_VISUAL)));
    expect(shrinkOf(up.action)).toBe(IPHONE_KEYBOARD);

    const down = reduce(up.state, observed(phone(IPHONE_LAYOUT)));
    expect(shrinkOf(down.action)).toBe(0);
    expect(down.state.appliedShrink).toBe(0);
  });

  /**
   * The same measurement, both ways round, so the port cannot drift into the
   * two-sources reading again: whatever the shell would forward for a geometry
   * is what the terminal reads for itself from the same geometry.
   */
  it.each([
    ["the keyboard up", IPHONE_VISUAL, 0],
    ["a panned visual viewport", IPHONE_VISUAL, PANNED_TOP],
    ["the keyboard down", IPHONE_LAYOUT, 0],
  ])("reads what the shell would forward, for %s", (_name, visual, top) => {
    const shellWouldForward = keyboardOffset(IPHONE_LAYOUT, visual, top);
    const own = keyboardReserve(IPHONE_LAYOUT, visual, top, 0).own;
    expect(own).toBe(shellWouldForward);
    // And therefore the two events answer with the same shrink.
    const facts = phone(visual, top);
    expect(shrinkOf(reduce(NO_KEYBOARD_RESERVE, observed(facts)).action)).toBe(
      shrinkOf(reduce(NO_KEYBOARD_RESERVE, forwarded(shellWouldForward, facts)).action),
    );
  });

  /** The shell saying the keyboard closed gives the rows back. */
  it("hands the height back when the shell forwards zero", () => {
    const told = reduce(NO_KEYBOARD_RESERVE, forwarded(IPHONE_KEYBOARD, phone(IPHONE_VISUAL)));
    const closed = reduce(told.state, forwarded(0, phone(IPHONE_LAYOUT)));
    expect(shrinkOf(closed.action)).toBe(0);
    expect(closed.state.appliedShrink).toBe(0);
  });

  /**
   * A NON-FINITE FORWARDED HEIGHT DISCARDS THE WHOLE MESSAGE, and it is the one
   * answer that is `ignored` rather than `nothing`. term.html gates the entire
   * `tl-kb` arm on `Number.isFinite(e.data.px)` (:9418), so a junk message
   * moves no `framedKb`, calls no `syncViewport` (no `--kb-offset` write and no
   * height write) and reaches no `refit()` either, because that call is inside
   * the same gate (:9421); TerminalNative returns at :1134, before both the
   * host write and its refit at :1160. Recomputing from the live facts here
   * instead would let a message both callers ignore write a height.
   *
   * `nothing` could not carry that. It means "write no height, fit anyway", and
   * a component handed it for a junk message would emit a tmux resize neither
   * the page nor pass 1 does, which is why the action set has a third answer.
   *
   * The facts are deliberately NOT the ones already applied, which is what an
   * earlier pass got wrong: with a reserve that already matched the facts, the
   * dedupe answered `nothing` and hid the divergence.
   */
  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("ignores the whole message when the shell forwards %s", (_name, px) => {
    const applied: ViewportState = { appliedShrink: IPHONE_KEYBOARD };
    // A geometry that WOULD move the reserve, so a fall-through shows up.
    const moved = phone(200);
    expect(shrinkOf(reduce(applied, observed(moved)).action)).toBe(612);

    const junk = reduce(applied, forwarded(px, moved));
    expect(junk.action.kind).toBe("ignored");
    expect(junk.state).toBe(applied);
  });

  /**
   * AND `ignored` IS THE ONLY ANSWER THAT MEANS NO FIT, so nothing else may
   * reach for it. A refusing gate is a `nothing`: term.html's fit is outside
   * both gates (:8482-8486 against :8428 and :8441), so a fine-pointer desktop
   * whose window resized still refits even though no height is written. Pinned
   * as a table because a wiring reads `kind` and does exactly what it says.
   */
  const NO_HEIGHT: ReadonlyArray<
    readonly [string, ViewportAction["kind"], ViewportEvent]
  > = [
    ["no visualViewport", "nothing", observed(phone(null))],
    ["a fine pointer", "nothing", observed(desktop(IPHONE_VISUAL))],
    [
      "a forwarded height behind a refusing gate",
      "nothing",
      forwarded(IPHONE_KEYBOARD, phone(null)),
    ],
    ["a reserve that has not moved", "nothing", observed(phone(IPHONE_LAYOUT))],
    ["a junk forwarded height", "ignored", forwarded(Number.NaN, phone(IPHONE_VISUAL))],
  ];

  it.each(NO_HEIGHT)("answers %s with %s", (_name, kind, event) => {
    expect(reduce(NO_KEYBOARD_RESERVE, event).action.kind).toBe(kind);
  });
});

describe("writing only what changed", () => {
  /**
   * term.html re-writes `terminalEl.style.height` on every call, and a
   * visualViewport `scroll` fires a burst of them. The rendered result is
   * identical either way, so this is a deliberate divergence: the module
   * answers `nothing` when the number it would write is the number already on
   * the host, which is what lets a caller skip the WRITE. It never lets a
   * caller skip the fit, which the owes list says in the module and the
   * contract block below pins.
   */
  it("says nothing when the reserve has not moved", () => {
    const first = reduce(NO_KEYBOARD_RESERVE, observed(phone(IPHONE_VISUAL)));
    expect(shrinkOf(first.action)).toBe(IPHONE_KEYBOARD);

    const second = reduce(first.state, observed(phone(IPHONE_VISUAL)));
    expect(second.action.kind).toBe("nothing");
    // Identity, so a caller can compare by reference the way fit.ts allows.
    expect(second.state).toBe(first.state);
  });

  it("writes again as soon as it moves", () => {
    const first = reduce(NO_KEYBOARD_RESERVE, observed(phone(IPHONE_VISUAL)));
    const taller = reduce(first.state, observed(phone(IPHONE_VISUAL - 24)));
    expect(shrinkOf(taller.action)).toBe(IPHONE_KEYBOARD + 24);
  });

  it("hands the box back when the keyboard closes", () => {
    const open = reduce(NO_KEYBOARD_RESERVE, observed(phone(IPHONE_VISUAL)));
    const shut = reduce(open.state, observed(phone(IPHONE_LAYOUT)));
    expect(shrinkOf(shut.action)).toBe(0);
    expect(shut.state.appliedShrink).toBe(0);
  });

  /**
   * A keyboard animating over ~250ms fires resize and scroll throughout, and
   * every frame of it is a different geometry. One write per distinct height,
   * and the mount at the front of it is the seed the shell would not have sent.
   */
  it("writes once per distinct height across a keyboard opening", () => {
    let state: ViewportState = NO_KEYBOARD_RESERVE;
    const heights = [812, 700, 560, 436, 436, 436, 812];
    const shrinks: Array<number | null> = [];
    for (const h of heights) {
      const r = reduce(state, observed(phone(h)));
      state = r.state;
      shrinks.push(shrinkOf(r.action));
    }
    expect(shrinks).toEqual([null, 112, 252, 376, null, null, 0]);
    expect(state.appliedShrink).toBe(0);
  });

  /**
   * WHAT THE DEDUPE IS WORTH ON THE PLATFORM IT WAS WRITTEN FOR: almost
   * nothing. iOS reports fractional visualViewport heights, and three readings
   * a tenth of a pixel apart are three distinct reserves, so three writes. The
   * dedupe earns its keep on the settled bursts (the run above, and a
   * visualViewport `scroll` that moves nothing), not on the animation.
   * Recorded rather than left as an implied saving.
   */
  it("writes for every fractional reading, since each one is a distinct reserve", () => {
    let state: ViewportState = NO_KEYBOARD_RESERVE;
    const shrinks: Array<number | null> = [];
    for (const h of [435.5, 435.9, 435.5]) {
      const r = reduce(state, observed(phone(h)));
      state = r.state;
      shrinks.push(shrinkOf(r.action));
    }
    expect(shrinks).toEqual([376.5, 376.1, 376.5]);
  });
});

describe("a panned visual viewport", () => {
  /**
   * When iOS pans the visual viewport to reveal a focused field, the visible
   * band is layout `[offsetTop, offsetTop + visualHeight]` and the keyboard is
   * below it, so the covered part of a layout-anchored box is
   * `layoutHeight - offsetTop - visualHeight`. `offsetTop` therefore belongs in
   * the reserve rather than being dropped from it: at 812/436/100 the keyboard
   * covers 276 of the container, not 376.
   */
  it("takes the pan off the covered height", () => {
    const r = reduce(NO_KEYBOARD_RESERVE, observed(phone(IPHONE_VISUAL, PANNED_TOP)));
    expect(shrinkOf(r.action)).toBe(276);
  });

  /**
   * AND THIS IS THE CHECK THAT SETTLES IT, because the header used to argue the
   * number from a derivation that does not hold when `offsetTop > 0`: at
   * 812/436/100 term.html standalone would write `vv.height` = 436 onto a
   * layout-anchored 812 box, an implied shrink of 376, where this module
   * reserves 276. The two disagree by exactly `offsetTop`, and 276 is the
   * number that composes with THIS app's layout.
   *
   * The arithmetic, from the CSS pinned in the parity block below:
   *   the container's bottom edge is `layout - --sk-h - --safe-b`
   *     (app.css:2370-2372, and `#root` is `height: var(--app-vh)` =
   *     `window.innerHeight`, app.css:30-34);
   *   the toolbar's top edge is `layout - --kb-offset - --safe-b - --sk-h`
   *     (app.css:2224, `bottom: calc(var(--kb-offset) + var(--safe-b))`);
   *   `--kb-offset` is the shell's `keyboardOffset(...)` (mobile/viewport.ts:244),
   *     which carries `offsetTop` the same way `own` does.
   * So a shrink of `own` puts the host's bottom edge exactly on the toolbar's
   * top edge, whatever the pan. A shrink of `own + offsetTop`, which is what
   * term.html's formula implies off a layout-anchored box, would leave a
   * 100px gap above the toolbar here.
   */
  it.each([
    ["the keyboard up, no pan", IPHONE_VISUAL, 0],
    ["the keyboard up and a 100px pan", IPHONE_VISUAL, PANNED_TOP],
    ["no keyboard and a 100px pan", IPHONE_LAYOUT - PANNED_TOP, PANNED_TOP],
    ["no keyboard at all", IPHONE_LAYOUT, 0],
  ])("puts the host's bottom edge on the toolbar's top edge, with %s", (_name, visual, top) => {
    const SK_H = 50;
    const SAFE_B = 34;
    const facts = phone(visual, top);
    const shrink = shrinkOf(reduce(NO_KEYBOARD_RESERVE, observed(facts)).action) ?? 0;

    const containerBottom = IPHONE_LAYOUT - SK_H - SAFE_B;
    const hostBottom = containerBottom - shrink;
    const kbOffset = keyboardOffset(IPHONE_LAYOUT, visual, top);
    const toolbarTop = IPHONE_LAYOUT - kbOffset - SAFE_B - SK_H;

    expect(hostBottom).toBe(toolbarTop);
  });
});

describe("parity with the page it came from", () => {
  const root = resolve(__dirname, "../..");
  const html = (): string => readFileSync(resolve(root, "frontend/term.html"), "utf8");

  /** term.html's keyboardReserve, code only, read out of the page by its markers. */
  const reserveBlock = (): string => {
    const src = html();
    const start = src.indexOf(">>> tl-kb-reserve");
    const end = src.indexOf("<<< tl-kb-reserve", start);
    expect(start, "the tl-kb-reserve marker in term.html").toBeGreaterThan(-1);
    expect(end, "the end of the reserve block").toBeGreaterThan(start);
    return src.slice(start, end);
  };

  /**
   * The max-not-sum rule, in the page's own code. If this ever became a sum
   * there, the reserve here would be wrong by a keyboard.
   */
  it("still takes the larger of the two readings, never the sum", () => {
    const body = reserveBlock();
    expect(body).toContain("Math.max(own, fwd)");
    expect(body).toContain("Math.max(0, innerH - vvH - vvTop)");
    expect(body).toContain("Math.max(0, forwarded || 0)");
  });

  /** Both of the gates this module reproduces, still where the header says they are. */
  it("still gates on visualViewport and on the pointer type", () => {
    const src = html();
    const sync = src.indexOf("function syncViewport()");
    expect(sync).toBeGreaterThan(-1);
    const body = src.slice(sync, src.indexOf("let kbRafScheduled", sync));
    expect(body).toContain("if (!window.visualViewport) return;");
    expect(body).toContain("if (isCoarsePointer) {");
    // The height write is INSIDE the coarse gate, which is the half that
    // decides whether a desktop terminal loses rows.
    expect(body.indexOf("terminalEl.style.height")).toBeGreaterThan(
      body.indexOf("if (isCoarsePointer) {"),
    );
  });

  /**
   * `isCoarsePointer` is read once, as a `const`, so a pointer type that
   * changes mid-session moves nothing in that page. TerminalNative reads it
   * once too (:528), so treating it as a fact per event rather than a live
   * query is parity, not a shortcut. Both gate refusals being permanent for a
   * mount is also why nothing needs remembering behind one.
   */
  it("still reads the pointer type once for the life of the page", () => {
    expect(html()).toContain("const isCoarsePointer = matchMedia('(pointer: coarse)').matches;");
  });

  /**
   * THE WHOLE `tl-kb` ARM IS INSIDE THE FINITE GATE, THE REFIT INCLUDED, which
   * is why a non-finite px is `ignored` rather than `nothing`. The regex is the
   * arm's three statements in order between the gate's braces, so the refit
   * moving OUT of the gate would fail it. An earlier version of this test read
   * the same code as "the refit after it is unconditional", which is what the
   * module's owes list then told a wiring to do.
   */
  it("still discards a whole tl-kb message that is not a number, the refit too", () => {
    const src = html();
    const arm = src.indexOf("e.data.type === 'tl-kb'");
    expect(arm).toBeGreaterThan(-1);
    const body = src.slice(arm, arm + 1200);
    expect(body).toMatch(
      /Number\.isFinite\(e\.data\.px\)\) \{\s*\n\s*framedKb = Math\.max\(0, e\.data\.px\);\s*\n\s*syncViewport\(\);\s*\n\s*refit\(\);\s*\n\s*\}/,
    );
  });

  /**
   * AND WHAT *IS* UNGATED IN THAT PAGE: the four viewport listeners, which call
   * `refit()` with no condition on them at all (:8482-8486). That is the fit
   * being outside `syncViewport`'s two GATES, which is a different statement
   * from the `tl-kb` arm above, and it is why `nothing` still owes a fit. A
   * fine-pointer desktop whose window resized writes no height and refits.
   */
  it("still refits on every viewport event with nothing gating it", () => {
    const src = html();
    const listeners = src.slice(
      src.indexOf("let kbRafScheduled"),
      src.indexOf("// Seed offset + height"),
    );
    expect(listeners).toContain("window.addEventListener('resize', refit);");
    expect(listeners).toContain("window.addEventListener('orientationchange', refit);");
    expect(listeners).toContain("window.visualViewport.addEventListener('resize', refit);");
    expect(listeners).toContain("window.visualViewport.addEventListener('scroll', refit);");
    // The only `if` between the fit and those events is the feature test for
    // visualViewport itself, not a gate on the pointer or on the geometry.
    expect(listeners).toContain("if (window.visualViewport) {");
    expect(listeners).not.toContain("isCoarsePointer");
  });

  /**
   * THE CLAIMS THIS MODULE'S HEADER MAKES ABOUT THE REST OF THE APP. Each one
   * is load-bearing for "most of syncViewport is already done", or for the
   * shrink being `own` rather than `own + offsetTop`, so each one is pinned
   * rather than asserted in a comment.
   */
  describe("the chain this module deliberately does not duplicate", () => {
    const read = (rel: string): string => readFileSync(resolve(root, rel), "utf8");

    /** The shell owns `--kb-offset`; the contract tests below pin that this module writes none. */
    it("leaves --kb-offset to the shell", () => {
      expect(read("frontend-v2/src/mobile/viewport.ts")).toContain(
        'root.setProperty("--kb-offset", kb + "px")',
      );
    });

    it("leaves the toolbar height to the container's margin", () => {
      const css = read("frontend-v2/src/app.css");
      expect(css).toContain("body.has-soft-keys .tl-views.tl-kb-inline {");
      // The terminal view's container reserves the toolbar and the safe area
      // and leaves the keyboard IN, which is exactly why the host needs a
      // shrink of its own.
      expect(css).toContain("margin-bottom: calc(var(--sk-h, 50px) + var(--safe-b, 0px));");
      expect(read("frontend-v2/src/mobile/viewport.ts")).toContain('root.setProperty("--sk-h"');
    });

    /**
     * The two edges the panned-viewport arithmetic above measures between, and
     * the innerHeight-anchored container the relative height depends on.
     */
    it("parks the toolbar on --kb-offset and anchors the app to innerHeight", () => {
      const css = read("frontend-v2/src/app.css");
      expect(css).toContain("bottom: calc(var(--kb-offset, 0px) + var(--safe-b, 0px));");
      expect(css).toContain("height: var(--app-vh, 100%);");
      expect(read("frontend-v2/src/mobile/viewport.ts")).toContain(
        'root.setProperty("--app-vh", window.innerHeight + "px")',
      );
    });

    /**
     * The shell forwards `keyboardOffset(...)`, the same formula as `own`, and
     * NOT `coveredAtBottom` (mobile/viewport.ts:57-63), which is the other
     * number that file computes. That distinction is load-bearing for the max:
     * `coveredAtBottom` counts a shrunken LAYOUT viewport as coverage, so
     * forwarding it would take 312px off an Android container that had already
     * shrunk itself.
     */
    it("forwards the same measurement the terminal reads, on change only", () => {
      const shell = read("frontend-v2/src/mobile/viewport.ts");
      expect(shell).toContain("const kb = keyboardOffset(window.innerHeight, h, top);");
      expect(shell).toMatch(/if \(kb !== lastKb\) \{\s*\n\s*lastKb = kb;\s*\n\s*opts\.onKeyboard\?\.\(kb\);/);
    });

    /** The install is at the shell and stays there; only the message is conditional. */
    it("installs the shell's sync once for the whole app", () => {
      const app = read("frontend-v2/src/components/App.tsx");
      expect(app).toContain("onKeyboard: (px) => window.__tlKeyboardOffset?.(px),");
      expect(app).toContain("// At the SHELL, not per session.");
    });

    /**
     * THE FRAMED BOOT SEED RESERVES NOTHING, so the shipped page has the same
     * hole the module's `observed` closes. Both of the page's readings are 0 at
     * boot: `framedKb` starts at 0, and an iframe's own visualViewport never
     * saw the keyboard, so `innerHeight - vv.height - vv.offsetTop` is 0 there
     * whatever the keyboard is doing. The seed is `syncViewport()` with no
     * argument (:8490), so there is nowhere for a real height to come from.
     */
    it("seeds a framed page with no reserve at all", () => {
      const src = html();
      expect(src).toContain("let framedKb = 0;");
      expect(src).toMatch(/\/\/ Seed offset \+ height[\s\S]{0,200}\n\s*syncViewport\(\);/);
      // The framed geometry, as arithmetic: layout and visual are the same
      // number, so both readings are 0 and so is the reserve.
      expect(keyboardReserve(IPHONE_LAYOUT, IPHONE_LAYOUT, 0, 0).offset).toBe(0);
    });

    /**
     * AND NOTHING ELSE SEEDS THE FRAME. `keyboardToFrame` is never called
     * directly; it is reachable only as the `__tlKeyboardOffset` global, whose
     * one caller is App.tsx's `onKeyboard` above, which fires on CHANGE only.
     * The frame's own `onLoad` seeds the Alt state and nothing else. So on an
     * iPad with the keyboard already up, the shipped page's prompt sits behind
     * it until the keyboard next moves, exactly as the native path's does.
     */
    it("has no second seed for the framed page either", () => {
      const view = read("frontend-v2/src/components/TerminalView.tsx");
      expect(view).toContain('postToFrame({ type: "tl-kb", px });');
      expect(view).toContain('ownWhile(ownsBridges, "__tlKeyboardOffset", keyboardToFrame);');
      // Referenced, never invoked: no `keyboardToFrame(...)` anywhere.
      expect(view).not.toMatch(/keyboardToFrame\s*\(/);
      expect(view).toContain("onLoad={() => props.onFrameAlt?.(false)}");
      // One mention in the shell, and it is the on-change forward.
      const app = read("frontend-v2/src/components/App.tsx");
      expect(app.match(/__tlKeyboardOffset/g)).toHaveLength(1);
    });

    /**
     * THE CONTAINER THE SHRINK COMES OFF, which is why the answer is a shrink
     * and not an absolute `vv.height`. `.tl-view` is `inset: 0` inside
     * `.tl-views`, and `.tl-views` is the flex remainder BELOW
     * `.tl-session-bar`. The bar's height is one of the two terms the module's
     * header was missing when it called the difference "exactly --sk-h +
     * --safe-b".
     */
    it("puts the host's container below the session bar", () => {
      expect(read("frontend-v2/src/app.css")).toContain(
        ".tl-view {\n  position: absolute;\n  inset: 0;",
      );
      const sidebar = read("frontend-v2/src/sidebar.css");
      expect(sidebar).toMatch(/\n\.tl-session-view \{[^}]*flex-direction: column;/);
      expect(sidebar).toMatch(/\n\.tl-session-bar \{[^}]*flex: 0 0 auto;/);
      // The bar comes first in that column, so the views start below it.
      const view = read("frontend-v2/src/components/SessionView.tsx");
      const bar = view.indexOf('<div class="tl-session-bar">');
      const views = view.indexOf('<main class="tl-views"');
      expect(bar).toBeGreaterThan(-1);
      expect(views).toBeGreaterThan(bar);
    });

    it("has no compose bar over the terminal to subtract", () => {
      // term.html's `cbH` term is its own fixed mobile input surface. In this
      // app the composer belongs to the TEXT view, so nothing sits over the
      // terminal's box and there is no analogue to port.
      expect(html()).toContain("getElementById('compose-bar')");
      expect(read("frontend-v2/src/app.css")).not.toContain("--cb-h");
    });

    /**
     * The measured bug that put the reserve on the terminal instead of the
     * container, still recorded next to the rule it explains. The header owes
     * the reader the native version of it: natively the shrunken box is the tap
     * target's own ancestor, so the seed this module adds moves the host's
     * bottom edge out from under wherever the finger is. Same shape as the
     * shipped page, and a unit test cannot settle it.
     */
    it("still records why the keyboard is left inside the terminal's container", () => {
      expect(read("frontend-v2/src/app.css")).toContain("the keyboard flashed shut for any tap");
    });
  });
});

describe("the contract handed to the component", () => {
  const source = readFileSync(resolve(__dirname, "../src/terminal/viewport.ts"), "utf8");
  /** The module with its comments stripped, so a prose mention is not read as a call. */
  const code = (): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  const owes = (): string => {
    const start = source.indexOf("WHAT THE COMPONENT STILL OWES");
    const end = source.indexOf("*/", start);
    expect(start, "the owes list").toBeGreaterThan(-1);
    expect(end, "the end of the owes list").toBeGreaterThan(start);
    return source.slice(start, end);
  };

  /**
   * A pure module decides; the component performs. Two halves of `host-height`
   * live nowhere else: the style write, and the fit that has to follow it.
   */
  it("names the style write and the fit the component owes", () => {
    const body = owes();
    expect(body).toContain("hostHeightStyle");
    expect(body).toContain("host.style.height");
    expect(body).toContain("fit");
  });

  /**
   * THE RULE A LITERAL WIRING WOULD HAVE GOT WRONG, in the version that is
   * true of the page. `nothing` means "write no height", never "do nothing":
   * TerminalNative's ResizeObserver (:1054) exists for exactly one call,
   * `refit("fit-wanted")`, and a container that changed WIDTH with the reserve
   * unmoved still has a new column count, so a wiring that skipped the fit
   * there would silence every non-keyboard resize: a view switch, a window
   * resize, the sidebar, an orientation change with the keyboard down.
   * `ignored` is the opposite of that and the reason the set has three answers.
   * term.html keeps the `tl-kb` refit INSIDE its finite gate (:9418, :9421) and
   * pass 1 returns at TerminalNative:1134 before its own at :1160, so a wiring
   * told to fit on every trigger regardless would emit a tmux resize neither of
   * them does.
   *
   * Pinned by its words because the owes list is what a fixer implements.
   */
  it("says which of the three answers must not be followed by a fit", () => {
    const body = owes();
    expect(body).toContain("host-height:");
    expect(body).toContain("nothing:");
    expect(body).toContain("ignored:");
    // `nothing` still owes the fit, and `ignored` is the one that does not.
    expect(body).toContain("then fit anyway");
    expect(body).toContain("the fit included");
    // And the list carries the gate the difference comes from, not a paraphrase.
    expect(body).toContain("Number.isFinite(e.data.px)");
  });

  /**
   * THE FACTS, WITH THE FALLBACKS THAT MAKE THEM NUMBERS. An earlier draft
   * asked for `window.visualViewport?.offsetTop` with no `?? 0`. Passed
   * through, `Number.isFinite(undefined)` is false, `own` is 0 on every event,
   * and the seed this module exists for reserves nothing. `strict: true` makes
   * the literal expression a compile error, which is the only reason that draft
   * was a nuisance rather than a shipped bug, so the list spells it out.
   */
  it("names the facts with the fallbacks that keep them numbers", () => {
    const body = owes();
    expect(body).toContain("window.visualViewport?.height ?? null");
    expect(body).toContain("window.visualViewport?.offsetTop ?? 0");
  });

  /**
   * And the cost of the dedupe, named where the invariant is. term.html's
   * unconditional rewrite is self-healing: a write that did not land is
   * repaired by the next event. Deduping gives that up, so `appliedShrink` is a
   * claim about one element's inline style and a caller that swaps hosts owes
   * the reset.
   */
  it("says what the dedupe gives up", () => {
    const body = owes();
    expect(body).toContain("self-heal");
    expect(body).toContain("NO_KEYBOARD_RESERVE");
  });

  /**
   * The purity ADR-0017 asks of every module under src/terminal. The header
   * names `window.innerHeight`, `matchMedia` and the rest in prose, which is
   * why the comments come off before the search: what must not appear is a
   * CALL.
   */
  it.each([
    ["the DOM", /\bdocument\s*\./],
    ["the window", /\bwindow\s*\./],
    ["a media query", /matchMedia\s*\(/],
    ["a timer", /set(?:Timeout|Interval)\s*\(/],
    ["a frame", /requestAnimationFrame\s*\(/],
    ["a socket", /WebSocket|postMessage/],
    ["a clock", /Date\.now|performance\.now/],
  ])("reaches for %s nowhere in its code", (_name, forbidden) => {
    expect(code()).not.toMatch(forbidden);
  });

  /** Pure means no CSS property write either: `--kb-offset` belongs to the shell. */
  it("writes no CSS custom property", () => {
    expect(code()).not.toContain("setProperty");
  });
});
