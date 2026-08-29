/**
 * The focused field must be revealed AFTER the keyboard settles, not only at
 * focus time — see src/mobile/reveal.ts for why the browser's own scroll is not
 * enough. These tests pin the trigger points; the geometry itself is asserted
 * in the browser (jsdom has no layout).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { installFocusReveal } from "../src/mobile/reveal";

/** A stand-in for window.visualViewport, which jsdom does not implement. */
function fakeViewport() {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    vv: {
      addEventListener: (t: string, fn: () => void) => {
        (listeners[t] ||= []).push(fn);
      },
      removeEventListener: (t: string, fn: () => void) => {
        listeners[t] = (listeners[t] || []).filter((f) => f !== fn);
      },
    } as unknown as VisualViewport,
    emit: (t: string) => (listeners[t] || []).forEach((f) => f()),
    count: (t: string) => (listeners[t] || []).length,
  };
}

function typableInput(type = "text"): HTMLInputElement {
  const el = document.createElement("input");
  el.type = type;
  el.scrollIntoView = vi.fn();
  document.body.appendChild(el);
  return el;
}

let stop: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
});

describe("focus reveal", () => {
  it("reveals the field when it takes focus", () => {
    const vp = fakeViewport();
    stop = installFocusReveal({ visualViewport: vp.vv });
    const el = typableInput();
    el.focus();
    expect(el.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
  });

  it("reveals it again on every viewport change while it holds focus", () => {
    // The keyboard rises over ~250ms; the geometry at focus time is not the
    // geometry the reader ends up looking at.
    const vp = fakeViewport();
    stop = installFocusReveal({ visualViewport: vp.vv });
    const el = typableInput();
    el.focus();
    (el.scrollIntoView as ReturnType<typeof vi.fn>).mockClear();
    vp.emit("resize");
    vp.emit("scroll");
    expect(el.scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it("takes one more reading once the events stop", () => {
    // The last event of the burst routinely arrives while the keyboard is still
    // moving, and nothing fires afterwards to correct it.
    const vp = fakeViewport();
    stop = installFocusReveal({ visualViewport: vp.vv, settleMs: 350 });
    const el = typableInput();
    el.focus();
    (el.scrollIntoView as ReturnType<typeof vi.fn>).mockClear();
    vp.emit("resize");
    expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(350);
    expect(el.scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it("coalesces a burst into a single settled reading", () => {
    const vp = fakeViewport();
    stop = installFocusReveal({ visualViewport: vp.vv, settleMs: 350 });
    const el = typableInput();
    el.focus();
    (el.scrollIntoView as ReturnType<typeof vi.fn>).mockClear();
    for (let i = 0; i < 6; i++) {
      vp.emit("resize");
      vi.advanceTimersByTime(40);
    }
    expect(el.scrollIntoView).toHaveBeenCalledTimes(6); // one per event
    vi.advanceTimersByTime(350);
    expect(el.scrollIntoView).toHaveBeenCalledTimes(7); // plus ONE settled
  });

  it("ignores focus on a control that raises no keyboard", () => {
    // Scrolling the list under a tapped checkbox would be noise, not help.
    const vp = fakeViewport();
    stop = installFocusReveal({ visualViewport: vp.vv });
    const box = typableInput("checkbox");
    box.focus();
    expect(box.scrollIntoView).not.toHaveBeenCalled();
  });

  it("reveals a textarea (the composer) as well as an input", () => {
    const vp = fakeViewport();
    stop = installFocusReveal({ visualViewport: vp.vv });
    const ta = document.createElement("textarea");
    ta.scrollIntoView = vi.fn();
    document.body.appendChild(ta);
    ta.focus();
    expect(ta.scrollIntoView).toHaveBeenCalled();
  });

  it("does not reveal a field that was unmounted before the settle fired", () => {
    // Committing a rename removes the box while the keyboard is still closing.
    const vp = fakeViewport();
    stop = installFocusReveal({ visualViewport: vp.vv, settleMs: 350 });
    const el = typableInput();
    el.focus();
    vp.emit("resize");
    (el.scrollIntoView as ReturnType<typeof vi.fn>).mockClear();
    el.remove();
    vi.advanceTimersByTime(350);
    expect(el.scrollIntoView).not.toHaveBeenCalled();
  });

  it("removes every listener on cleanup", () => {
    const vp = fakeViewport();
    const dispose = installFocusReveal({ visualViewport: vp.vv });
    expect(vp.count("resize")).toBe(1);
    dispose();
    expect(vp.count("resize")).toBe(0);
    const el = typableInput();
    el.focus();
    expect(el.scrollIntoView).not.toHaveBeenCalled();
  });
});
