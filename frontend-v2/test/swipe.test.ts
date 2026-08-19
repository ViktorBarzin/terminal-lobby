import { describe, it, expect } from "vitest";
import { swipeDirection, SWIPE_MIN_PX, SWIPE_MAX_MS } from "../src/mobile/swipe";
import { defaultMode } from "../src/store/viewmode";

describe("swipeDirection", () => {
  it("reads a leftward flick as moving forward", () => {
    expect(swipeDirection({ dx: -120, dy: 8, ms: 200 })).toBe("next");
    expect(swipeDirection({ dx: 120, dy: 8, ms: 200 })).toBe("prev");
  });

  // A vertical scroll through a long transcript must never change session.
  it("ignores a drag that is mostly vertical", () => {
    expect(swipeDirection({ dx: 80, dy: 200, ms: 200 })).toBeNull();
    expect(swipeDirection({ dx: 80, dy: 60, ms: 200 })).toBeNull();
  });

  it("ignores a drag too short to be deliberate", () => {
    expect(swipeDirection({ dx: SWIPE_MIN_PX - 1, dy: 0, ms: 100 })).toBeNull();
  });

  // A slow drag is someone selecting text or scrolling, not flicking.
  it("ignores a drag that took too long", () => {
    expect(swipeDirection({ dx: -200, dy: 0, ms: SWIPE_MAX_MS + 1 })).toBeNull();
  });
});

describe("the device's default view", () => {
  /**
   * Terminal, on every device (Viktor, 2026-08-19). A phone used to open in the
   * text view on the reasoning that a 390px screen cannot render an 80-column
   * pty; in daily use the terminal is still what a session is opened to do, and
   * the text view is one tap away. The switch is what makes that true, which is
   * why the bar has to keep it reachable (test/header.fit.test.ts).
   */
  it("is terminal, whatever the pointer", () => {
    expect(defaultMode()).toBe("terminal");
  });
});
