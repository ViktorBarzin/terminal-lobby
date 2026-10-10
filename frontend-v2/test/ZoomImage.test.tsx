import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";
import { ZoomImage } from "../src/components/ZoomImage";
import { DOUBLE_TAP_MS } from "../src/components/zoom.logic";

/**
 * The full-size picture zooms on its own instead of handing the pinch to the
 * browser, which zoomed the whole page, transcript and composer included
 * (Viktor, 2026-10-10: "zooming should only zoom the photo not the entire chat
 * and form size").
 *
 * jsdom has no layout and no real gestures, so these cover the contract the
 * lightboxes depend on: the stage claims touch, a tap dismisses only once the
 * double-tap window has passed, a double tap zooms instead, and no click
 * escapes to the lightbox behind.
 */

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

let clock = 1000;
function pointer(type: string, target: EventTarget, id = 1, x = 100, y = 100): void {
  clock += 40;
  const e = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: id,
    clientX: x,
    clientY: y,
  });
  // The tracker times presses by the event's own stamp, which jsdom fixes at
  // creation; a steady clock keeps the taps' spacing exact.
  Object.defineProperty(e, "timeStamp", { value: clock });
  target.dispatchEvent(e);
}

function tap(target: EventTarget, id = 1): void {
  pointer("pointerdown", target, id);
  pointer("pointerup", target, id);
}

function mount(onDismiss = vi.fn()) {
  const r = render(() => <ZoomImage src="/x.png" alt="x.png" onDismiss={onDismiss} />);
  const stage = r.container.querySelector<HTMLElement>(".tl-zoom")!;
  return { ...r, stage, img: stage.querySelector("img")!, onDismiss };
}

describe("<ZoomImage>", () => {
  it("claims touch on the whole stage, so a pinch never reaches the page", () => {
    const { stage, img } = mount();
    expect(stage.style.touchAction).toBe("none");
    expect(img.getAttribute("alt")).toBe("x.png");
  });

  /**
   * Panzoom measures a pinch from the stage's top-left and assumes the element
   * it transforms starts there. The photo is centred, so transforming it
   * directly zoomed about a fixed point instead of the fingers (measured: the
   * spot under the pinch moved 279px up wherever the pinch landed). The
   * transform goes on a layer that fills the stage, and the photo sits inside.
   */
  it("transforms a layer that fills the stage, never the photo itself", () => {
    vi.useFakeTimers();
    const { stage, img } = mount();
    const layer = stage.querySelector<HTMLElement>(":scope > .tl-zoom-layer");
    expect(layer).not.toBeNull();
    expect(img.parentElement).toBe(layer);
    tap(img);
    tap(img);
    // Panzoom writes the transform on the next animation frame.
    vi.advanceTimersByTime(50);
    expect(layer!.style.transform).toMatch(/scale\(2\.5\)/);
    expect(img.style.transform).toBe("");
  });

  it("dismisses on a tap, once the double-tap window has passed", () => {
    vi.useFakeTimers();
    const { img, onDismiss } = mount();
    tap(img);
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DOUBLE_TAP_MS + 1);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("zooms on a double tap instead of dismissing, and a tap while zoomed stays put", () => {
    vi.useFakeTimers();
    const { stage, img, onDismiss } = mount();
    tap(img);
    tap(img);
    vi.advanceTimersByTime(DOUBLE_TAP_MS + 1);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(stage.getAttribute("data-zoomed")).toBe("on");

    vi.advanceTimersByTime(1000);
    tap(img);
    vi.advanceTimersByTime(DOUBLE_TAP_MS + 1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("does not dismiss on a two-finger press", () => {
    vi.useFakeTimers();
    const { stage, onDismiss } = mount();
    pointer("pointerdown", stage, 1);
    pointer("pointerdown", stage, 2, 200, 200);
    pointer("pointerup", stage, 2, 200, 200);
    pointer("pointerup", stage, 1);
    vi.advanceTimersByTime(DOUBLE_TAP_MS + 1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("keeps its click from reaching the lightbox behind", () => {
    const behind = vi.fn();
    const { container, img } = mount();
    container.addEventListener("click", behind);
    img.click();
    expect(behind).not.toHaveBeenCalled();
  });
});
