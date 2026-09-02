/**
 * The font ladder and the two pinch recognizers, lifted out of
 * frontend/term.html ahead of the native xterm component.
 *
 * These tests pin the rules that page's comments record as incidents: the claim
 * that has to happen before the gesture is understood, the release that never
 * resumes, the freeze that outlives the finger that caused it, and the
 * truncation that makes a step feel like a step. Every one of them would still
 * "work" if it were dropped — the gesture would just feel wrong on a phone
 * nobody is holding while the tests run, which is why they are pinned here.
 *
 * Not covered, because no headless browser can answer it: whether
 * preventDefault actually suppresses native pinch-zoom on a real iPad. That
 * stays a device check, as it is for term.html.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FONT_READOUT_HIDE_MS,
  FONT_SIZE_DEFAULT,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  PINCH_CLASSIFY_MOVE,
  PINCH_CLASSIFY_RATIO,
  PINCH_PAGE_SCALE_MAX,
  PINCH_STEP_RATIO,
  canClaimPinch,
  clampFontSize,
  gesturePinchChange,
  gesturePinchEnd,
  gesturePinchStart,
  isCommittedStep,
  isPinch,
  pinchReset,
  pinchSpan,
  sizeForRatio,
  stepFontSize,
  touchPinchEnd,
  touchPinchMove,
  touchPinchStart,
  type FontReadout,
  type GesturePinchState,
  type PinchDecision,
  type PinchGates,
  type PinchTouch,
  type TouchPinchState,
} from "../src/terminal/font";
import {
  CLASSIFY_MOVE,
  CLASSIFY_RATIO,
  STEP_RATIO,
  sizeForRatio as textViewSizeForRatio,
} from "../src/mobile/textzoom";

const GATES: PinchGates = { armed: true, pageScale: 1, onSurface: true };

/** Two fingers, `gap` pixels apart, keeping their identifiers. */
const pair = (gap: number, ids: [number, number] = [1, 2]): PinchTouch[] => [
  { identifier: ids[0], clientX: 0, clientY: 0 },
  { identifier: ids[1], clientX: 0, clientY: gap },
];

/**
 * Drives the Chromium reducer the way a component would: it owns the state, the
 * live font size and the readout, and feeds each back into the next event.
 */
function chromium(start = FONT_SIZE_DEFAULT) {
  let state: TouchPinchState | null = null;
  let size = start;
  const applied: number[] = [];
  const readouts: FontReadout[] = [];
  const consumed: boolean[] = [];
  const feed = (d: PinchDecision<TouchPinchState>) => {
    state = d.state;
    consumed.push(d.consume);
    if (d.size !== null) {
      size = d.size;
      applied.push(d.size);
    }
    if (d.readout !== null) readouts.push(d.readout);
    return d;
  };
  return {
    start: (touches: PinchTouch[], gates: Partial<PinchGates> = {}) =>
      feed(touchPinchStart(state, { ...GATES, ...gates, touches, currentSize: size })),
    move: (touches: PinchTouch[], cancelable = true) =>
      feed(touchPinchMove(state, { touches, cancelable, currentSize: size })),
    end: (fingers: number) =>
      feed(touchPinchEnd(state, { touches: new Array<number>(fingers).fill(0) })),
    applied,
    readouts,
    consumed,
    size: () => size,
    state: () => state,
  };
}

/** The same, for the WebKit front-end. */
function webkit(start = FONT_SIZE_DEFAULT) {
  let state: GesturePinchState | null = null;
  let size = start;
  const applied: number[] = [];
  const readouts: FontReadout[] = [];
  const feed = (d: PinchDecision<GesturePinchState>) => {
    state = d.state;
    if (d.size !== null) {
      size = d.size;
      applied.push(d.size);
    }
    if (d.readout !== null) readouts.push(d.readout);
    return d;
  };
  return {
    start: (gates: Partial<PinchGates> = {}) =>
      feed(gesturePinchStart({ ...GATES, ...gates, currentSize: size })),
    change: (scale: number, fingers = 2) =>
      feed(gesturePinchChange(state, { scale, fingers, currentSize: size })),
    end: () => feed(gesturePinchEnd(state)),
    applied,
    readouts,
    size: () => size,
    state: () => state,
  };
}

describe("the A− / A+ ladder", () => {
  it("moves one pixel of size per press", () => {
    expect(stepFontSize(15, +1)).toBe(16);
    expect(stepFontSize(15, -1)).toBe(14);
  });

  it("stops at the floor and the ceiling instead of wrapping", () => {
    expect(stepFontSize(FONT_SIZE_MAX, +1)).toBe(FONT_SIZE_MAX);
    expect(stepFontSize(FONT_SIZE_MIN, -1)).toBe(FONT_SIZE_MIN);
  });

  /**
   * The haptic and the readout ride committed steps only. Without this rule,
   * holding A− at the floor buzzes forever against a size that cannot move.
   */
  it("reports nothing committed when a press hits a wall", () => {
    expect(isCommittedStep(15, stepFontSize(15, +1))).toBe(true);
    expect(isCommittedStep(FONT_SIZE_MAX, stepFontSize(FONT_SIZE_MAX, +1))).toBe(false);
    expect(isCommittedStep(FONT_SIZE_MIN, stepFontSize(FONT_SIZE_MIN, -1))).toBe(false);
  });

  /**
   * The floor was 10 until 2026-07-13 ("support font sizes smaller than 10px").
   * A tiny size is a deliberate zoom-out — roughly 7px is what reaches 80
   * columns in portrait on a 390px phone — so raising this floor back would
   * take away a size people chose on purpose.
   */
  it("still reaches 6, the size a phone needs for 80 columns in portrait", () => {
    expect(FONT_SIZE_MIN).toBe(6);
    expect(FONT_SIZE_MAX).toBe(22);
    expect(clampFontSize(7)).toBe(7);
  });

  it("keeps garbage out of the pref rather than crashing on it", () => {
    expect(clampFontSize(Number.NaN)).toBe(FONT_SIZE_DEFAULT);
    expect(clampFontSize("nonsense")).toBe(FONT_SIZE_DEFAULT);
    expect(clampFontSize(15.6)).toBe(16);
  });
});

describe("pinch scale to font size", () => {
  it("moves one step per 7% of span, both ways", () => {
    expect(PINCH_STEP_RATIO).toBe(0.07);
    expect(sizeForRatio(15, 1.08)).toBe(16);
    expect(sizeForRatio(15, 1.15)).toBe(17);
    expect(sizeForRatio(15, 1.22)).toBe(18);
    expect(sizeForRatio(15, 0.92)).toBe(14);
    expect(sizeForRatio(15, 0.85)).toBe(13);
  });

  /**
   * Truncation toward zero, not rounding: the size changes only after the
   * fingers have travelled a whole step. Rounding would flip it at half a step
   * and the gesture would feel twitchy. The float error rides along — 1.14 is
   * two steps of intent but (1.14 − 1) / 0.07 is 1.9999999999999984, and 0.93
   * is one step of intent but truncates to none. term.html carries the same
   * expression, so this records the edge rather than correcting it here alone.
   */
  it("truncates on the boundary, exactly as the terminal page does", () => {
    expect(sizeForRatio(15, 1.14)).toBe(16);
    expect(sizeForRatio(15, 1.07)).toBe(16);
    expect(sizeForRatio(15, 0.93)).toBe(15);
    expect(sizeForRatio(15, 0.86)).toBe(13);
  });

  it("clamps, so no spread walks the size past the ends of the range", () => {
    expect(sizeForRatio(FONT_SIZE_MAX, 3)).toBe(FONT_SIZE_MAX);
    expect(sizeForRatio(FONT_SIZE_MIN, 0.1)).toBe(FONT_SIZE_MIN);
    expect(sizeForRatio(15, 2)).toBe(FONT_SIZE_MAX);
  });

  /**
   * A nonsense ratio is NOT "no movement at all", however much it reads like it
   * should be. term.html guards nothing here, so 0 is −14 steps and lands on the
   * floor, and NaN reaches clampFontSize's non-finite branch and comes back as
   * the default — which moves a base of 10 UP. This pins the expression rather
   * than a guard, because a `ratio <= 0` guard here diverged by the whole range
   * (6 on the page against 15 in the port) on a primitive that is exported for
   * anyone to call.
   */
  it("runs a degenerate ratio through the expression, not around it", () => {
    const asThePageDoes = (base: number, ratio: number) =>
      clampFontSize(base + Math.trunc((ratio - 1) / PINCH_STEP_RATIO));
    const degenerate: Array<[number, number]> = [
      [15, 0],
      [15, -1],
      [10, 0],
      [22, -0.5],
      [15, Number.NaN],
      [10, Number.NaN],
      [10, Number.POSITIVE_INFINITY],
      [10, Number.NEGATIVE_INFINITY],
    ];
    for (const [base, ratio] of degenerate) {
      expect(sizeForRatio(base, ratio), `base ${base}, ratio ${ratio}`).toBe(
        asThePageDoes(base, ratio),
      );
    }
    expect(sizeForRatio(15, 0)).toBe(FONT_SIZE_MIN);
    expect(sizeForRatio(15, -1)).toBe(FONT_SIZE_MIN);
    expect(sizeForRatio(10, Number.NaN)).toBe(FONT_SIZE_DEFAULT);
    expect(sizeForRatio(10, Number.POSITIVE_INFINITY)).toBe(FONT_SIZE_DEFAULT);
  });

  it("calls anything under 5% of span a pan, not a pinch", () => {
    expect(PINCH_CLASSIFY_RATIO).toBe(0.05);
    expect(isPinch(1.04)).toBe(false);
    expect(isPinch(0.96)).toBe(false);
    expect(isPinch(1.05)).toBe(true);
    expect(isPinch(0.95)).toBe(true);
  });

  /**
   * NaN is not "not a pinch". term.html classifies with
   * `Math.abs(ratio - 1) < PINCH_CLASSIFY_RATIO`, which is false for a
   * non-finite ratio, so the page falls through and claims. Answering false here
   * — which a `Number.isFinite(ratio) &&` guard does — is the negation dropped,
   * and it sends the recognizer down the opposite branch.
   */
  it("answers a non-finite ratio the way the page's comparison does", () => {
    const asThePageDoes = (ratio: number) =>
      !(Math.abs(ratio - 1) < PINCH_CLASSIFY_RATIO);
    for (const ratio of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1,
      1.04,
      1.05,
      0.95,
      3,
    ]) {
      expect(isPinch(ratio), `ratio ${ratio}`).toBe(asThePageDoes(ratio));
    }
    expect(isPinch(Number.NaN)).toBe(true);
  });

  /**
   * The opening span divides every later one. Two touches reported at the same
   * point would otherwise make the first ratio Infinity and slam the size to a
   * bound on move one.
   */
  it("never measures a span of zero", () => {
    expect(pinchSpan({ clientX: 0, clientY: 0 }, { clientX: 3, clientY: 4 })).toBe(5);
    expect(pinchSpan({ clientX: 7, clientY: 7 }, { clientX: 7, clientY: 7 })).toBe(1);
  });
});

describe("the gates both front-ends share", () => {
  /**
   * The standing regression guard. On an already-zoomed page, native pinch is
   * the only way back out — claiming it there traps the reader at that zoom.
   */
  it("stands down on a page that is already zoomed", () => {
    expect(canClaimPinch({ ...GATES, pageScale: 1.5 })).toBe(false);
    expect(canClaimPinch({ ...GATES, pageScale: PINCH_PAGE_SCALE_MAX })).toBe(true);
  });

  it("claims when the viewport cannot say what the zoom is", () => {
    // A missing or cross-origin visualViewport reads as NaN. Reading that as
    // "zoomed" would disable the gesture wherever the measurement is unavailable.
    expect(canClaimPinch({ ...GATES, pageScale: Number.NaN })).toBe(true);
  });

  it("claims only over the terminal, and only while the flag is on", () => {
    expect(canClaimPinch({ ...GATES, onSurface: false })).toBe(false);
    expect(canClaimPinch({ ...GATES, armed: false })).toBe(false);
    expect(canClaimPinch(GATES)).toBe(true);
  });
});

describe("the Chromium front-end", () => {
  /**
   * Chrome's cancelable-touchmove window is only one to three moves wide, so a
   * recognizer that waits until it is sure before claiming has already missed
   * its chance. Consuming from move 1 is what makes the claim land at all —
   * both naive orderings were falsified on the production surface, 2026-07-11.
   */
  it("consumes the first two-finger moves before it knows what the gesture is", () => {
    const c = chromium();
    c.start(pair(100));
    const first = c.move(pair(114));
    expect(first.consume).toBe(true);
    expect(first.size).toBeNull();
    expect(c.applied).toEqual([]);
  });

  it("classifies on the third move and steps from there", () => {
    const c = chromium();
    c.start(pair(100));
    for (let i = 0; i < PINCH_CLASSIFY_MOVE; i++) c.move(pair(114));
    expect(c.applied).toEqual([sizeForRatio(FONT_SIZE_DEFAULT, 1.14)]);
    expect(c.readouts).toEqual([16]);
  });

  /**
   * A two-finger pan holds its span while both fingers travel. The recognizer
   * has consumed three moves by then and gives the stream back; the page scrolls
   * from wherever the fingers now are, having lost that travel. That cost is the
   * reason classification is at move 3 and not later.
   */
  it("gives a two-finger pan back to the page after three moves", () => {
    const c = chromium();
    c.start(pair(100));
    for (let i = 0; i < PINCH_CLASSIFY_MOVE; i++) c.move(pair(100));
    expect(c.applied).toEqual([]);
    expect(c.consumed).toEqual([false, true, true, true]);
    const after = c.move(pair(100));
    expect(after.consume).toBe(false);
  });

  it("never resumes stepping after it has released", () => {
    const c = chromium();
    c.start(pair(100));
    for (let i = 0; i < PINCH_CLASSIFY_MOVE; i++) c.move(pair(100));
    for (let i = 0; i < 5; i++) c.move(pair(160)); // now a huge, obvious spread
    expect(c.applied).toEqual([]);
  });

  /**
   * A finger joining a scroll already in flight arrives non-cancelable: the
   * browser owns that stream. preventDefault there does nothing except log an
   * intervention warning, so panic-zooming mid-scroll stays native. Declared
   * leak, not an oversight.
   */
  it("never fights a stream the browser already owns", () => {
    const c = chromium();
    c.start(pair(100));
    const uncancelable = c.move(pair(130), false);
    expect(uncancelable.consume).toBe(false);
    for (let i = 0; i < PINCH_CLASSIFY_MOVE; i++) c.move(pair(130));
    expect(c.applied).toEqual([]);
  });

  it("aborts on a third finger and stays aborted when it lifts", () => {
    const c = chromium();
    c.start(pair(100));
    c.start([...pair(100), { identifier: 3, clientX: 50, clientY: 50 }]);
    for (let i = 0; i < PINCH_CLASSIFY_MOVE; i++) c.move(pair(130));
    expect(c.applied).toEqual([]);
    c.end(2); // the third finger lifts, two remain
    for (let i = 0; i < PINCH_CLASSIFY_MOVE; i++) c.move(pair(160));
    expect(c.applied).toEqual([]);
  });

  it("drops the gesture when a finger is swapped for another", () => {
    const c = chromium();
    c.start(pair(100));
    c.move(pair(110));
    const swapped = c.move(pair(120, [1, 9]));
    expect(swapped.state?.dead).toBe(true);
    for (let i = 0; i < PINCH_CLASSIFY_MOVE; i++) c.move(pair(130, [1, 9]));
    expect(c.applied).toEqual([]);
  });

  it("does not arm off the terminal, or on a zoomed page", () => {
    for (const gates of [{ onSurface: false }, { pageScale: 1.5 }, { armed: false }]) {
      const c = chromium();
      c.start(pair(100), gates);
      for (let i = 0; i < PINCH_CLASSIFY_MOVE; i++) c.move(pair(130));
      expect(c.applied, JSON.stringify(gates)).toEqual([]);
      expect(c.consumed.every((x) => x === false)).toBe(true);
    }
  });

  it("follows the fingers back down as well as up", () => {
    const c = chromium();
    c.start(pair(100));
    for (let i = 0; i < PINCH_CLASSIFY_MOVE; i++) c.move(pair(122));
    expect(c.size()).toBe(18);
    c.move(pair(85));
    expect(c.size()).toBe(13);
  });

  /**
   * Every step re-rasterizes the whole grid at new cell sizes and flashes the
   * repaint mask. A target the terminal is already showing must not be applied
   * again — the readout still updates, so the reader sees the number.
   */
  it("does not re-apply a size the terminal already shows", () => {
    const armed: TouchPinchState = {
      ids: [1, 2],
      span0: 100,
      moves: PINCH_CLASSIFY_MOVE - 1,
      claimed: false,
      dead: false,
      baseFont: 15,
      lastTarget: null,
    };
    const d = touchPinchMove(armed, { touches: pair(114), cancelable: true, currentSize: 16 });
    expect(d.readout).toBe(16);
    expect(d.size).toBeNull();
    expect(d.state?.lastTarget).toBe(16);
  });

  it("holds a settled size without re-applying it every frame", () => {
    const c = chromium();
    c.start(pair(100));
    for (let i = 0; i < PINCH_CLASSIFY_MOVE + 4; i++) c.move(pair(115));
    expect(c.applied).toEqual([17]);
  });

  it("keeps the readout up until the second finger lifts", () => {
    const c = chromium();
    c.start(pair(100));
    for (let i = 0; i < PINCH_CLASSIFY_MOVE; i++) c.move(pair(115));
    const stillTwo = c.end(2);
    expect(stillTwo.readout).toBeNull();
    expect(stillTwo.state).not.toBeNull();
    const lifted = c.end(1);
    expect(lifted.readout).toBe("hide");
    expect(lifted.state).toBeNull();
  });

  it("clears everything when the recognizer is torn down", () => {
    const reset = pinchReset<TouchPinchState>();
    expect(reset.state).toBeNull();
    expect(reset.readout).toBe("hide");
    expect(reset.consume).toBe(false);
  });

  /**
   * touchcancel is an end, not a reset. term.html hands touchend and touchcancel
   * to the same handler and that handler calls end(), so a cancel arriving with
   * both fingers still down changes nothing and the pinch keeps stepping. Sent
   * to pinchReset instead — which the wiring note used to prescribe — the state
   * goes and the readout fades out from under a gesture still in progress.
   */
  it("survives a cancel that leaves both fingers down, and keeps stepping", () => {
    const c = chromium();
    c.start(pair(100));
    for (let i = 0; i < PINCH_CLASSIFY_MOVE; i++) c.move(pair(115));
    expect(c.applied).toEqual([17]);

    const cancelled = c.end(2);
    expect(cancelled.state).not.toBeNull();
    expect(cancelled.readout).toBeNull();

    c.move(pair(130));
    expect(c.applied).toEqual([17, 19]);
  });

  /**
   * A span that cannot be measured — a NaN coordinate; no real digitizer sends
   * one, and the recognizer has no way to reject it — must be CLAIMED, because
   * `|NaN − 1| < 5%` is false on the page and the page claims what fails that
   * test. The finiteness guard that used to sit in isPinch flipped this into the
   * release branch: the gesture went dead mid-pinch and the rest of the stream
   * went to native scrolling.
   */
  it("claims a gesture whose span cannot be measured, as the page does", () => {
    const unmeasurable: PinchTouch[] = [
      { identifier: 1, clientX: 0, clientY: 0 },
      { identifier: 2, clientX: Number.NaN, clientY: 0 },
    ];
    const c = chromium();
    c.start(pair(100));
    for (let i = 0; i < PINCH_CLASSIFY_MOVE; i++) c.move(unmeasurable);
    expect(c.state()?.claimed).toBe(true);
    expect(c.state()?.dead).toBe(false);
    expect(c.readouts).toEqual([FONT_SIZE_DEFAULT]);

    const later = c.move(unmeasurable);
    expect(later.consume).toBe(true);
    // Every move consumed; consumed[0] is the touchstart, which never does.
    expect(c.consumed.slice(1).every(Boolean)).toBe(true);
    expect(c.state()?.dead).toBe(false);
  });
});

describe("the WebKit front-end", () => {
  /**
   * preventDefault at gesturestart is the whole claim on iOS: it is what stops
   * the page zooming for the rest of the gesture. There is no classification
   * step because a two-finger pan never fires a GestureEvent at all.
   */
  it("claims at gesturestart, which is what suppresses native zoom", () => {
    const w = webkit();
    expect(w.start().consume).toBe(true);
    expect(w.state()).not.toBeNull();
  });

  it("does not claim when a gate says no", () => {
    for (const gates of [{ onSurface: false }, { pageScale: 1.5 }, { armed: false }]) {
      const w = webkit();
      const d = w.start(gates);
      expect(d.consume, JSON.stringify(gates)).toBe(false);
      expect(d.state).toBeNull();
    }
  });

  it("steps from the cumulative scale WebKit reports", () => {
    const w = webkit();
    w.start();
    w.change(1.14);
    expect(w.size()).toBe(sizeForRatio(FONT_SIZE_DEFAULT, 1.14));
    w.change(1.22);
    expect(w.size()).toBe(18);
  });

  it("holds the deadzone before the first step", () => {
    const w = webkit();
    w.start();
    const d = w.change(1.03);
    expect(d.size).toBeNull();
    expect(d.readout).toBeNull();
    expect(d.consume).toBe(true);
  });

  /**
   * The deadzone gates the FIRST step only. After one has landed, a scale back
   * inside 5% must still step, or a pinch out and back would stick at the larger
   * size with the fingers already home.
   */
  it("follows the scale back through the deadzone once a step has landed", () => {
    const w = webkit();
    w.start();
    w.change(1.15);
    expect(w.size()).toBe(17);
    w.change(1.02);
    expect(w.size()).toBe(15);
  });

  /**
   * A claimed WebKit gesture cannot be handed back mid-flight without the page
   * popping into native zoom, so a third finger freezes stepping through
   * gestureend rather than half-releasing the way Chromium does.
   */
  it("freezes on a third finger and stays frozen after it lifts", () => {
    const w = webkit();
    w.start();
    w.change(1.15, 3);
    expect(w.applied).toEqual([]);
    w.change(1.4, 2);
    expect(w.applied).toEqual([]);
    expect(w.state()?.frozen).toBe(true);
  });

  it("holds the claim even while frozen", () => {
    const w = webkit();
    w.start();
    expect(w.change(1.15, 3).consume).toBe(true);
    expect(w.change(1.4, 2).consume).toBe(true);
  });

  /**
   * Consuming a gesture nobody claimed would suppress native pinch-zoom
   * everywhere — including the surfaces the gates deliberately left alone.
   */
  it("ignores a change with no gesture in flight", () => {
    const d = gesturePinchChange(null, { scale: 1.4, fingers: 2, currentSize: 15 });
    expect(d).toEqual({ state: null, consume: false, size: null, readout: null });
    expect(gesturePinchEnd(null).consume).toBe(false);
  });

  it("reads a nonsense scale as no movement", () => {
    const w = webkit();
    w.start();
    w.change(0);
    w.change(-2);
    expect(w.applied).toEqual([]);
  });

  it("hides the readout and forgets the gesture at gestureend", () => {
    const w = webkit();
    w.start();
    w.change(1.15);
    const end = w.end();
    expect(end.state).toBeNull();
    expect(end.readout).toBe("hide");
    expect(end.consume).toBe(true);
    expect(FONT_READOUT_HIDE_MS).toBe(220);
  });

  it("does not re-apply a size the terminal already shows", () => {
    const state: GesturePinchState = { baseFont: 15, lastTarget: null, frozen: false };
    const d = gesturePinchChange(state, { scale: 1.14, fingers: 2, currentSize: 16 });
    expect(d.readout).toBe(16);
    expect(d.size).toBeNull();
  });
});

/**
 * Three copies of this arithmetic exist while the iframe is still shipping:
 * term.html, the text view's port, and this module. They are meant to answer a
 * pinch identically, so drift between them is a bug nobody would notice by hand.
 */
describe("parity with the page and the sibling port", () => {
  const page = readFileSync(resolve(process.cwd(), "../frontend/term.html"), "utf8");
  const source = readFileSync(resolve(process.cwd(), "src/terminal/font.ts"), "utf8");

  /**
   * The wiring note is the only place this survives extraction, and it pointed
   * the wrong way: term.html gives touchend and touchcancel to one handler that
   * calls end(), and reaches reset() only through resetAll() on pagehide. A note
   * telling a component to send touchcancel to pinchReset would drop a gesture
   * the page keeps. Asserted against the page, so it fails if either side moves.
   */
  it("says where touchcancel goes, and says what term.html actually does", () => {
    expect(page).toContain(
      "document.addEventListener('touchcancel', onDocTouchEndOrCancel",
    );
    expect(page).toMatch(/function onDocTouchEndOrCancel\(e\)[^]*?r\.end\(e\)/);
    expect(page).toMatch(/function resetAll\(\)[^]*?r\.reset\(\)/);
    expect(page).toContain("window.addEventListener('pagehide', resetAll);");

    const note = /\/\*\*([^]*?)\*\/\s*export function pinchReset/.exec(source)?.[1];
    expect(note, "pinchReset has no doc comment").toBeTruthy();
    expect(note).toContain("pagehide");
    expect(note).toContain("touchPinchEnd");
    const cancelEnd = /\/\*\*([^]*?)\*\/\s*export function touchPinchEnd/.exec(source)?.[1];
    expect(cancelEnd).toContain("touchcancel");
  });

  it("carries the same numbers term.html does", () => {
    expect(page).toMatch(
      new RegExp(`const PINCH_CLASSIFY_MOVE = ${PINCH_CLASSIFY_MOVE};`),
    );
    expect(page).toMatch(
      new RegExp(`const PINCH_CLASSIFY_RATIO = ${PINCH_CLASSIFY_RATIO};`),
    );
    expect(page).toMatch(new RegExp(`const PINCH_STEP_RATIO = ${PINCH_STEP_RATIO};`));
    expect(page).toContain(
      `const FONT_SIZE_MIN = ${FONT_SIZE_MIN}, FONT_SIZE_MAX = ${FONT_SIZE_MAX}, FONT_SIZE_DEFAULT = ${FONT_SIZE_DEFAULT};`,
    );
  });

  it("stands down at the same page zoom term.html does", () => {
    expect(page).toContain(`pageScale() > ${PINCH_PAGE_SCALE_MAX}`);
  });

  it("agrees with the text view on every step of a pinch", () => {
    expect([PINCH_CLASSIFY_MOVE, PINCH_CLASSIFY_RATIO, PINCH_STEP_RATIO]).toEqual([
      CLASSIFY_MOVE,
      CLASSIFY_RATIO,
      STEP_RATIO,
    ]);
    for (let ratio = 0.3; ratio <= 2.5; ratio += 0.01) {
      expect(sizeForRatio(15, ratio), `ratio ${ratio}`).toBe(textViewSizeForRatio(15, ratio));
    }
  });
});
