import { describe, it, expect } from "vitest";
import { installSwipe, swipeDirection, SWIPE_MIN_PX, SWIPE_MAX_MS } from "../src/mobile/swipe";
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

describe("installSwipe", () => {
  const flick = (el: Element, x0: number, x1: number) => {
    for (const [type, x] of [
      ["pointerdown", x0],
      ["pointerup", x1],
    ] as const) {
      el.dispatchEvent(
        new PointerEvent(type, { bubbles: true, clientX: x, clientY: 100, pointerType: "touch" }),
      );
    }
  };

  // A queued ghost swiped away is cancelled (QueuedGhost), and that swipe
  // must not also move to the next session.
  it("leaves a swipe that started inside [data-own-swipe] to that element", () => {
    const root = document.createElement("div");
    const own = document.createElement("div");
    own.setAttribute("data-own-swipe", "");
    const inner = document.createElement("span");
    own.append(inner);
    root.append(own);
    document.body.append(root);
    const seen: string[] = [];
    const off = installSwipe(root, { onSwipe: (d) => seen.push(d) });
    flick(inner, 300, 150);
    expect(seen).toEqual([]);
    flick(root, 300, 150);
    expect(seen).toEqual(["next"]);
    off();
    root.remove();
  });
});

describe("the device's default view", () => {
  /**
   * Text, on every device (Viktor, 2026-10-03). It was the terminal from
   * 2026-08-19, and before that text on a phone only. The terminal is one tap
   * away, which is why the bar has to keep the switch reachable
   * (test/header.fit.test.ts).
   */
  it("is text, whatever the pointer", () => {
    expect(defaultMode()).toBe("text");
  });
});
