/**
 * Pinch sizes the text view the way it sizes the terminal.
 *
 * Viktor, 2026-08-29: "we can make the pinch gesture also adjust font size in
 * text mode the same way it ties for terminal."
 *
 * The arithmetic and the guards are ported from frontend/term.html so the two
 * views answer the same gesture the same way. These tests pin the numbers, and
 * the two-front-end wiring; the real-device suppression of native pinch-zoom is
 * not testable headless and stays a manual check, as it is for the terminal.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CLASSIFY_MOVE,
  CLASSIFY_RATIO,
  STEP_RATIO,
  clampTextSize,
  installTextZoom,
  isPinch,
  scaleFor,
  sizeForRatio,
  span,
} from "../src/mobile/textzoom";
import { FONT_SIZE_DEFAULT, FONT_SIZE_MAX, FONT_SIZE_MIN } from "../src/store/prefs";

describe("the step arithmetic matches the terminal's", () => {
  it("moves one step per 7% of span", () => {
    expect(STEP_RATIO).toBe(0.07);
    expect(sizeForRatio(15, 1.08)).toBe(16);
    expect(sizeForRatio(15, 1.15)).toBe(17);
    expect(sizeForRatio(15, 1.22)).toBe(18);
    expect(sizeForRatio(15, 0.92)).toBe(14);
    expect(sizeForRatio(15, 0.85)).toBe(13);
  });

  it("truncates on the boundary, exactly as the terminal does", () => {
    // (1.14 - 1) is 0.14000000000000012 in binary floating point, and dividing
    // by 0.07 gives 1.9999999999999984 — so a spread of precisely two steps
    // truncates to one. The subtraction is where the error enters, not the
    // division: 0.14 / 0.07 is exactly 2. The terminal's recognizer carries the
    // same expression and the same edge, and matching it is the point, so this
    // records the behaviour rather than correcting it in one view only.
    expect(sizeForRatio(15, 1.14)).toBe(16);
    expect((1.14 - 1) / STEP_RATIO).toBeLessThan(2);
    expect(0.14 / 0.07).toBe(2);
  });

  it("does nothing inside the deadzone", () => {
    expect(CLASSIFY_RATIO).toBe(0.05);
    expect(isPinch(1.04)).toBe(false);
    expect(isPinch(0.96)).toBe(false);
    expect(isPinch(1.06)).toBe(true);
    expect(CLASSIFY_MOVE).toBe(3);
  });

  it("clamps to the range the terminal uses", () => {
    expect(clampTextSize(FONT_SIZE_MIN - 5)).toBe(FONT_SIZE_MIN);
    expect(clampTextSize(FONT_SIZE_MAX + 5)).toBe(FONT_SIZE_MAX);
    expect(sizeForRatio(FONT_SIZE_MAX, 3)).toBe(FONT_SIZE_MAX);
    expect(sizeForRatio(FONT_SIZE_MIN, 0.1)).toBe(FONT_SIZE_MIN);
  });

  it("survives nonsense", () => {
    expect(sizeForRatio(15, 0)).toBe(15);
    expect(sizeForRatio(15, NaN)).toBe(15);
    expect(clampTextSize(NaN)).toBe(FONT_SIZE_DEFAULT);
  });

  it("publishes a scale the default renders as 1", () => {
    expect(scaleFor(FONT_SIZE_DEFAULT)).toBe(1);
    expect(scaleFor(30)).toBeCloseTo(FONT_SIZE_MAX / FONT_SIZE_DEFAULT);
  });

  it("measures a span between two points", () => {
    expect(span({ clientX: 0, clientY: 0 }, { clientX: 3, clientY: 4 })).toBe(5);
    expect(span({ clientX: 1, clientY: 1 }, { clientX: 1, clientY: 1 })).toBe(1);
  });
});

/** jsdom has no TouchEvent; the recognizer only reads `touches` and `cancelable`. */
function touch(type: string, pts: Array<[number, number]>, target: EventTarget, cancelable = true) {
  const e = new Event(type, { bubbles: true, cancelable });
  Object.defineProperty(e, "touches", {
    value: pts.map(([x, y]) => ({ clientX: x, clientY: y, target })),
  });
  Object.defineProperty(e, "target", { value: target });
  return e;
}

function rig() {
  const surface = document.createElement("div");
  document.body.appendChild(surface);
  let size = FONT_SIZE_DEFAULT;
  const set = vi.fn((n: number) => (size = n));
  const stop = installTextZoom({
    surface: () => surface,
    get: () => size,
    set,
    onReadout: vi.fn(),
  });
  return { surface, set, stop, size: () => size };
}

describe("the Chromium front-end", () => {
  it("steps the size once a real pinch is classified", () => {
    const r = rig();
    r.surface.dispatchEvent(touch("touchstart", [[0, 0], [0, 100]], r.surface));
    // Three moves before it decides, then a 14% spread = two steps.
    for (let i = 0; i < CLASSIFY_MOVE; i++) {
      r.surface.dispatchEvent(touch("touchmove", [[0, 0], [0, 114]], r.surface));
    }
    expect(r.set).toHaveBeenCalled();
    expect(r.size()).toBe(sizeForRatio(FONT_SIZE_DEFAULT, 1.14));
    r.stop();
  });

  it("lets a two-finger pan go", () => {
    const r = rig();
    r.surface.dispatchEvent(touch("touchstart", [[0, 0], [0, 100]], r.surface));
    // Span held constant while both fingers travel: a pan, not a pinch.
    for (let i = 0; i < CLASSIFY_MOVE + 2; i++) {
      r.surface.dispatchEvent(touch("touchmove", [[0, i * 10], [0, 100 + i * 10]], r.surface));
    }
    expect(r.set).not.toHaveBeenCalled();
    r.stop();
  });

  it("ignores a pinch that is not over the surface", () => {
    const r = rig();
    const elsewhere = document.createElement("div");
    document.body.appendChild(elsewhere);
    elsewhere.dispatchEvent(touch("touchstart", [[0, 0], [0, 100]], elsewhere));
    for (let i = 0; i < CLASSIFY_MOVE; i++) {
      elsewhere.dispatchEvent(touch("touchmove", [[0, 0], [0, 130]], elsewhere));
    }
    expect(r.set).not.toHaveBeenCalled();
    r.stop();
  });

  it("never fights a stream the browser already owns", () => {
    const r = rig();
    r.surface.dispatchEvent(touch("touchstart", [[0, 0], [0, 100]], r.surface));
    r.surface.dispatchEvent(touch("touchmove", [[0, 0], [0, 130]], r.surface, false));
    for (let i = 0; i < CLASSIFY_MOVE; i++) {
      r.surface.dispatchEvent(touch("touchmove", [[0, 0], [0, 130]], r.surface));
    }
    expect(r.set).not.toHaveBeenCalled();
    r.stop();
  });

  it("aborts on a third finger and does not resume", () => {
    const r = rig();
    r.surface.dispatchEvent(touch("touchstart", [[0, 0], [0, 100]], r.surface));
    r.surface.dispatchEvent(touch("touchstart", [[0, 0], [0, 100], [50, 50]], r.surface));
    for (let i = 0; i < CLASSIFY_MOVE; i++) {
      r.surface.dispatchEvent(touch("touchmove", [[0, 0], [0, 130]], r.surface));
    }
    expect(r.set).not.toHaveBeenCalled();
    r.stop();
  });

  it("stops listening on cleanup", () => {
    const r = rig();
    r.stop();
    r.surface.dispatchEvent(touch("touchstart", [[0, 0], [0, 100]], r.surface));
    for (let i = 0; i < CLASSIFY_MOVE; i++) {
      r.surface.dispatchEvent(touch("touchmove", [[0, 0], [0, 130]], r.surface));
    }
    expect(r.set).not.toHaveBeenCalled();
  });
});

describe("the WebKit front-end", () => {
  const gesture = (type: string, scale: number, target: EventTarget) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, "scale", { value: scale });
    Object.defineProperty(e, "target", { value: target });
    return e;
  };

  it("steps from GestureEvent's cumulative scale", () => {
    const r = rig();
    r.surface.dispatchEvent(gesture("gesturestart", 1, r.surface));
    r.surface.dispatchEvent(gesture("gesturechange", 1.14, r.surface));
    expect(r.size()).toBe(sizeForRatio(FONT_SIZE_DEFAULT, 1.14));
    r.stop();
  });

  it("holds the deadzone before the first step", () => {
    const r = rig();
    r.surface.dispatchEvent(gesture("gesturestart", 1, r.surface));
    r.surface.dispatchEvent(gesture("gesturechange", 1.03, r.surface));
    expect(r.set).not.toHaveBeenCalled();
    r.stop();
  });

  it("claims the gesture at gesturestart, which is what suppresses native zoom", () => {
    const r = rig();
    const e = gesture("gesturestart", 1, r.surface);
    r.surface.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    r.stop();
  });
});

/**
 * The scale drives FONT SIZES, not a zoom.
 *
 * The first cut zoomed `.tl-timeline`. Viktor: "I don't like the zoom in. I
 * want font increase. now the zoom experience is weird especially as it doesn't
 * work well with the prompt input field." Two things were wrong with it: `zoom`
 * scales padding, borders and gaps along with the type, so the transcript grew
 * rather than its text; and it applied to the timeline alone, so the composer
 * stayed at native size and the two visibly disagreed.
 *
 * Now every font-size in app.css is `calc(<px> * var(--tl-text-scale, 1))`. The
 * variable is set on `.tl-textview`, so everything in the text view — transcript,
 * answer card, composer — scales together, and everything outside it inherits
 * the default of 1 and is untouched. Referencing the root variable rather than
 * an inherited font-size is what stops nested rules compounding.
 */
describe("the scale is a font-size scale", () => {
  const css = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8");

  it("does not zoom the timeline", () => {
    expect(css).not.toMatch(/zoom:\s*var\(--tl-text-scale/);
  });

  it("scales every px font-size in the stylesheet", () => {
    // A bare `font-size: 13px` would not follow the pinch, and the mismatch is
    // exactly what made the first attempt feel wrong.
    const bare = [...css.matchAll(/font-size:\s*[\d.]+px\s*;/g)].map((m) => m[0]);
    expect(bare, "unscaled px font-sizes").toEqual([]);
  });

  it("never lets the compose field fall below the iOS zoom floor", () => {
    // Under 16px iOS zooms the page on focus and leaves it zoomed.
    expect(css).toMatch(
      /\.tl-composer-input\s*\{\s*font-size:\s*max\(16px,\s*calc\(16px \* var\(--tl-text-scale, 1\)\)\)/,
    );
  });
});
