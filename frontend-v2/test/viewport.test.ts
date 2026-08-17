import { describe, it, expect } from "vitest";
import { installViewportSync, keyboardOffset, keyboardReserve } from "../src/mobile/viewport";

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

/**
 * How much the shell must still give up for the keyboard.
 *
 * BUG (reported 2026-08-17, iPhone installed PWA): in Text mode the composer
 * ended up near the TOP of the screen with a large dead gap above the keyboard.
 * Reproduced at 390x844: the composer landed at 9% of the screen with 368px of
 * nothing below it.
 *
 * Cause: the keyboard's height was reserved TWICE — once by whatever shortened
 * the shell (its height tracks window.innerHeight) and again by .tl-views
 * subtracting --kb-offset. Which platforms shorten the shell varies (iOS Safari
 * does not, Chromium does via interactive-widget=resizes-content, and the iOS
 * standalone PWA is its own case), so the reservation is MEASURED rather than
 * modelled: where the shell actually ends, minus where the keyboard actually
 * starts. A shell that already clears the keyboard reserves nothing.
 */
describe("viewport — the reservation is measured, not assumed", () => {
  it("reserves the overlap when the shell runs under the keyboard", () => {
    // iOS Safari: the layout viewport ignores the keyboard, so the shell still
    // spans the whole screen and the bottom 336px are covered.
    expect(keyboardReserve(844, 508, 0)).toBe(336);
  });

  it("reserves NOTHING when the shell already ends above the keyboard", () => {
    // Chromium with interactive-widget=resizes-content: the layout viewport
    // shrank, so the shell stops at 508 and the keyboard starts at 508.
    // Subtracting again is what put the composer at 9% of the screen.
    expect(keyboardReserve(508, 508, 0)).toBe(0);
  });

  it("reserves nothing when the shell stops short of the keyboard", () => {
    expect(keyboardReserve(400, 508, 0)).toBe(0);
  });

  it("accounts for a scrolled visual viewport", () => {
    // visibleBottom is offsetTop + height, so a scrolled viewport moves the
    // keyboard's top edge down in the shell's own coordinates.
    expect(keyboardReserve(844, 500, 50)).toBe(294);
  });

  it("is 0 with no keyboard at all", () => {
    expect(keyboardReserve(844, 844, 0)).toBe(0);
  });

  it("never goes negative", () => {
    expect(keyboardReserve(844, 900, 0)).toBe(0);
  });
});
