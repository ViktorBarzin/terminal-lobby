import { describe, it, expect, vi } from "vitest";
import { installViewportSync, keyboardOffset } from "../src/mobile/viewport";

describe("viewport — keyboardOffset", () => {
  it("is 0 when the visual viewport fills the layout viewport (no keyboard)", () => {
    expect(keyboardOffset(800, 800, 0)).toBe(0);
  });

  it("equals the covered height when the keyboard shrinks the visual viewport", () => {
    // iOS Safari: innerHeight stays 800, visualViewport shrinks to 500.
    expect(keyboardOffset(800, 500, 0)).toBe(300);
  });

  it("accounts for a scrolled visual viewport (offsetTop)", () => {
    expect(keyboardOffset(800, 500, 50)).toBe(250);
  });

  it("never goes negative (visual viewport reported taller than layout)", () => {
    expect(keyboardOffset(800, 850, 0)).toBe(0);
  });
});

describe("viewport — teardown", () => {
// A frame scheduled just before teardown must not run after it: it would
// measure a surface that no longer exists and publish 0px over a live value.
// This is also what made the suite order-dependent — a stray frame from one
// file's unmounted view overwrote what another file's test had just asserted.
it("cancels its pending frame on cleanup", () => {
  const frames: Array<() => void> = [];
  const realRaf = globalThis.requestAnimationFrame;
  const realCancel = globalThis.cancelAnimationFrame;
  let cancelled: number[] = [];
  globalThis.requestAnimationFrame = ((cb: () => void) => {
    frames.push(cb);
    return frames.length;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((h: number) => cancelled.push(h)) as typeof cancelAnimationFrame;
  try {
    document.documentElement.style.removeProperty("--sk-h");
    const stop = installViewportSync();
    window.dispatchEvent(new Event("resize"));
    stop();
    expect(cancelled.length).toBeGreaterThan(0);
  } finally {
    globalThis.requestAnimationFrame = realRaf;
    globalThis.cancelAnimationFrame = realCancel;
  }
});
});

/**
 * Forwarding the keyboard height across the frame boundary.
 *
 * The terminal lives in an iframe, and an iframe's visualViewport does not move
 * when the soft keyboard opens — only the top window's does. The lobby used to
 * reserve the space by shrinking the iframe's CONTAINER, which pulled the frame
 * out from under the tap that had just opened the keyboard: the delayed compat
 * mousedown then landed on a non-focusable shell element and blurred the field,
 * so the keyboard flashed shut for taps below ~54% of the screen (2026-08-17).
 * The height is forwarded into the frame instead, so the frame never moves.
 */

describe("viewport — the keyboard height is published to the frame", () => {
  function withFakeViewport(height: number, run: () => void): void {
    const real = Object.getOwnPropertyDescriptor(window, "visualViewport");
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: { height, offsetTop: 0, addEventListener() {}, removeEventListener() {} },
    });
    try {
      run();
    } finally {
      if (real) Object.defineProperty(window, "visualViewport", real);
      else delete (window as unknown as Record<string, unknown>).visualViewport;
    }
  }

  it("reports the covered height when the keyboard opens", () => {
    const seen: number[] = [];
    withFakeViewport(window.innerHeight - 336, () => {
      const stop = installViewportSync({ onKeyboard: (px) => seen.push(px) });
      stop();
    });
    expect(seen.at(-1)).toBe(336);
  });

  it("reports 0 when there is no keyboard", () => {
    const seen: number[] = [];
    withFakeViewport(window.innerHeight, () => {
      const stop = installViewportSync({ onKeyboard: (px) => seen.push(px) });
      stop();
    });
    expect(seen.at(-1)).toBe(0);
  });

  it("publishes only on a CHANGE — the keyboard fires a burst of events", () => {
    // The keyboard animates over ~250ms and fires resize/scroll throughout.
    // Posting into the frame on every one of them would have the terminal
    // re-fit (and tmux resize) repeatedly for one keyboard.
    const seen: number[] = [];
    withFakeViewport(window.innerHeight - 300, () => {
      const stop = installViewportSync({ onKeyboard: (px) => seen.push(px) });
      window.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("resize"));
      stop();
    });
    expect(seen).toEqual([300]);
  });
});

describe("viewport — a re-measure after the viewport settles", () => {
  function withFakeViewport(height: number, run: (setH: (h: number) => void) => void): void {
    let h = height;
    const real = Object.getOwnPropertyDescriptor(window, "visualViewport");
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: {
        get height() {
          return h;
        },
        offsetTop: 0,
        addEventListener() {},
        removeEventListener() {},
      },
    });
    try {
      run((next) => {
        h = next;
      });
    } finally {
      if (real) Object.defineProperty(window, "visualViewport", real);
      else delete (window as unknown as Record<string, unknown>).visualViewport;
    }
  }

  it("re-measures once the events stop, so a mid-animation reading cannot stick", () => {
    vi.useFakeTimers();
    try {
      withFakeViewport(window.innerHeight, (setH) => {
        const seen: number[] = [];
        const stop = installViewportSync({ onKeyboard: (px) => seen.push(px) });
        // Mid-animation: the viewport is briefly much shorter than it ends up.
        setH(window.innerHeight - 500);
        window.dispatchEvent(new Event("resize"));
        vi.advanceTimersByTime(20);
        // The animation finishes — but nothing dispatches another event.
        setH(window.innerHeight - 300);
        vi.advanceTimersByTime(1000);
        stop();
        // The LAST value published must be the settled one, not the transient.
        expect(seen.at(-1)).toBe(300);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire the settle pass when nothing moved", () => {
    vi.useFakeTimers();
    try {
      withFakeViewport(window.innerHeight, () => {
        const seen: number[] = [];
        const stop = installViewportSync({ onKeyboard: (px) => seen.push(px) });
        vi.advanceTimersByTime(1000);
        stop();
        // One seeding report, and nothing more — onKeyboard is change-only.
        expect(seen).toEqual([0]);
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The document must never hold a scroll offset.
 *
 * Measured on an iPhone-26 installed PWA (85 records, 2026-08-17). Focusing the
 * Text composer made iOS do two things at once: collapse window.innerHeight to
 * the visual viewport (812 -> 436) AND scroll the document by 376px to bring
 * the field "into view". The shell follows innerHeight, so it collapsed too,
 * and the 376px scroll carried it off the top — the composer measured at
 * -90,-25, above the screen. iOS then unwound both over FOURTEEN SECONDS
 * (innerH 436->454->501->…->812, docScroll 376->0), which is the whole of the
 * "everything scrolls" experience.
 *
 * The layout is invariant if that scroll is simply never held: across the same
 * 85 samples, `innerH + vvTop` is a constant 812 and `vvH` a constant 436, so
 * with the offset at 0 the reservation lands the composer at the same place in
 * every frame of the animation.
 *
 * The page has no scrollable overflow of its own (html/body overflow:hidden,
 * #root a fixed height) — any offset here is the platform's doing, not a
 * reader's, so resetting it can never throw away a scroll position someone
 * chose.
 */
describe("viewport — the document never holds a scroll offset", () => {
  const scroller = (): HTMLElement =>
    (document.scrollingElement as HTMLElement | null) ?? document.documentElement;

  it("resets a scroll the platform imposed", () => {
    const stop = installViewportSync();
    scroller().scrollTop = 376;
    window.dispatchEvent(new Event("scroll"));
    stop();
    expect(scroller().scrollTop).toBe(0);
  });

  it("resets on a viewport resize too — the keyboard fires both", () => {
    const stop = installViewportSync();
    scroller().scrollTop = 200;
    window.dispatchEvent(new Event("resize"));
    stop();
    expect(scroller().scrollTop).toBe(0);
  });

  it("leaves an already-zero offset alone", () => {
    const stop = installViewportSync();
    scroller().scrollTop = 0;
    window.dispatchEvent(new Event("resize"));
    stop();
    expect(scroller().scrollTop).toBe(0);
  });
});

/**
 * The field data itself, as a regression test.
 *
 * These are real (innerHeight, visualViewport.height) pairs sampled from an
 * iPhone-26 installed PWA while iOS animated the keyboard open — the sequence
 * that put the Text composer above the top of the screen for fourteen seconds.
 * `innerHeight` crawls from the visual viewport back to the full layout
 * viewport; the visual viewport itself never moves.
 *
 * With the platform's scroll offset removed, the surface that has to clear the
 * keyboard lands in the SAME place in every frame. If a future change makes
 * that untrue, the keyboard animation becomes visible movement again.
 */
describe("viewport — the iPhone keyboard animation, replayed", () => {
  // Sampled 2026-08-17; vvHeight held 436 across all of them.
  const FRAMES = [436, 454, 501, 564, 625, 686, 743, 766, 793, 809, 812];
  const VV_H = 436;
  const CHROME = 51 + 34; // --sk-h + the measured safe-area inset

  it("puts the composer in one place across the whole animation", () => {
    const bottoms = FRAMES.map((innerH) => {
      const kb = keyboardOffset(innerH, VV_H, 0);
      return innerH - (CHROME + kb); // where .tl-views ends
    });
    expect(new Set(bottoms).size).toBe(1);
    expect(bottoms[0]).toBe(VV_H - CHROME); // 351, as measured on the device
  });

  it("would NOT be stable if the platform's offset were left in", () => {
    // The same frames with the offset iOS actually imposed (innerH + top = 812
    // throughout) move the surface by hundreds of pixels — the reported bug.
    const bottoms = FRAMES.map((innerH) => {
      const top = 812 - innerH;
      return innerH - (CHROME + keyboardOffset(innerH, VV_H, top)) - top;
    });
    expect(new Set(bottoms).size).toBeGreaterThan(1);
    expect(Math.min(...bottoms)).toBeLessThan(0); // off the top of the screen
  });
});
