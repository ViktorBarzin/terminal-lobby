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
  // A phone cannot usefully render an 80-column pty; a desktop keeps booting
  // into the terminal it has always booted into.
  it("is text on a touch screen and terminal on a desktop", () => {
    expect(defaultMode(true)).toBe("text");
    expect(defaultMode(false)).toBe("terminal");
  });
});
