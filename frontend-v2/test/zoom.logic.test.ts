import { describe, it, expect } from "vitest";
import {
  DOUBLE_TAP_MS,
  DOUBLE_TAP_SLOP,
  TAP_MS,
  TAP_SLOP,
  createTapTracker,
} from "../src/components/zoom.logic";

/**
 * What a press on a zoomable picture meant.
 *
 * The picture owns every pointer on its stage, so it has to tell a tap (close
 * the lightbox) from a double tap (zoom to that point) from a drag or a pinch
 * (neither). Pure, so the timing and the slop are tested without a browser.
 */

/** One finger down and up at (x, y), `ms` apart, starting at `t`. */
function press(
  tr: ReturnType<typeof createTapTracker>,
  t: number,
  x = 100,
  y = 100,
  ms = 50,
  id = 1,
) {
  tr.down(id, x, y, t);
  return tr.up(id, x, y, t + ms);
}

describe("createTapTracker", () => {
  it("reads a quick, still press as a tap", () => {
    const tr = createTapTracker();
    expect(press(tr, 0)).toBe("tap");
  });

  it("reads a second tap close in time and place as a double tap", () => {
    const tr = createTapTracker();
    expect(press(tr, 0)).toBe("tap");
    expect(press(tr, 50 + DOUBLE_TAP_MS - 10, 110, 105)).toBe("double");
  });

  it("starts over after a double tap, so a third tap is a tap again", () => {
    const tr = createTapTracker();
    press(tr, 0);
    press(tr, 150);
    expect(press(tr, 300)).toBe("tap");
  });

  it.each([
    ["too late", DOUBLE_TAP_MS + 60, 100],
    ["too far away", 150, 100 + DOUBLE_TAP_SLOP + 20],
  ])("keeps two taps apart when the second is %s", (_label, t, x) => {
    const tr = createTapTracker();
    press(tr, 0);
    expect(press(tr, t, x)).toBe("tap");
  });

  it("ignores a press that moved past the slop: that was a drag", () => {
    const tr = createTapTracker();
    tr.down(1, 100, 100, 0);
    expect(tr.up(1, 100 + TAP_SLOP + 1, 100, 80)).toBeNull();
  });

  it("ignores a press held longer than a tap", () => {
    const tr = createTapTracker();
    expect(press(tr, 0, 100, 100, TAP_MS + 1)).toBeNull();
  });

  it("ignores every finger of a pinch, including the last one up", () => {
    const tr = createTapTracker();
    tr.down(1, 100, 100, 0);
    tr.down(2, 200, 200, 10);
    expect(tr.up(2, 200, 200, 60)).toBeNull();
    expect(tr.up(1, 100, 100, 70)).toBeNull();
    // ...and the next clean press is a tap, not the second half of a double.
    expect(press(tr, 100)).toBe("tap");
  });

  it("drops a cancelled press", () => {
    const tr = createTapTracker();
    tr.down(1, 100, 100, 0);
    tr.cancel(1);
    expect(tr.up(1, 100, 100, 40)).toBeNull();
  });

  it("a drag between two taps breaks the double", () => {
    const tr = createTapTracker();
    press(tr, 0);
    tr.down(1, 100, 100, 60);
    tr.up(1, 160, 100, 120);
    expect(press(tr, 180)).toBe("tap");
  });
});
