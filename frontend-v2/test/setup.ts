import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

// @solidjs/testing-library needs a DOM. The DOM-free integration test runs under
// `@vitest-environment node`, where importing/using its cleanup would throw — so
// only wire it up when a document exists.
if (typeof document !== "undefined") {
  afterEach(async () => {
    const { cleanup } = await import("@solidjs/testing-library");
    cleanup();
  });
}

/**
 * A no-op EventSource for jsdom, which ships none.
 *
 * It became load-bearing on 2026-08-16: text is now the default view on a
 * coarse pointer, so mounting a SessionView under a touch-screen matchMedia
 * opens the transcript stream — and every such test threw "EventSource is not
 * available in this environment" from code that was doing exactly the right
 * thing. Tests that assert ON the stream install their own richer fake over
 * this one (see SessionView.lazysse.test.tsx); this only keeps a mount from
 * failing for a stream it does not care about.
 */
if (typeof document !== "undefined" && typeof EventSource === "undefined") {
  (globalThis as unknown as { EventSource: unknown }).EventSource = class {
    onopen: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    constructor(public url: string) {}
    close(): void {}
    // The server marks the end of the opening window with a named `ready`
    // event; the store holds its first paint until it arrives. These fakes have
    // no replay to finish, so the window is complete the moment it is asked
    // for.
    addEventListener(type: string, fn: (ev: { data: string }) => void): void {
      if (type === "ready") fn({ data: "0" });
    }
    removeEventListener(): void {}
  };
}

/**
 * jsdom ships no PointerEvent, and its fallback drops `pointerType` — which is
 * the field the composer's touch-focus fix branches on (it acts on touch/pen
 * and leaves the mouse alone). Without this, a "touch" fired from a test
 * arrives with no pointer type and the code correctly declines to handle it,
 * so the test would be asserting against the shim rather than the behaviour.
 */
if (typeof window !== "undefined" && typeof (window as { PointerEvent?: unknown }).PointerEvent === "undefined") {
  class PointerEventShim extends MouseEvent {
    pointerType: string;
    pointerId: number;
    constructor(type: string, init: MouseEventInit & { pointerType?: string; pointerId?: number } = {}) {
      super(type, init);
      this.pointerType = init.pointerType ?? "";
      this.pointerId = init.pointerId ?? 0;
    }
  }
  (window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventShim;
  (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventShim;
}

/**
 * Three DOM methods the drag library reaches for that jsdom does not implement.
 *
 * `dnd/sidebar.ts` registers @formkit/drag-and-drop on every group list, so
 * these are touched by any test that mounts a sidebar, not only the ones about
 * dragging: `elementFromPoint` is how it decides what a drag is over, and the
 * popover pair is how a synthetic drag puts its cloned row in the top layer.
 * Each throws rather than returning nothing in jsdom, which failed mounts that
 * had no interest in a drag at all.
 */
if (typeof document !== "undefined") {
  const doc = document as unknown as { elementFromPoint?: unknown };
  if (typeof doc.elementFromPoint !== "function") doc.elementFromPoint = () => null;
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  if (typeof proto.showPopover !== "function") proto.showPopover = () => {};
  if (typeof proto.hidePopover !== "function") proto.hidePopover = () => {};
}

/**
 * A no-op Web Animations API, which jsdom does not implement.
 *
 * The drag library's animations plugin slides a row out of the way with
 * `Element.animate`, so any test that drags a session in jsdom would throw
 * there. Nothing asserts on the animation; the order the rows end up in is what
 * matters, and that is decided before the slide starts.
 */
if (typeof Element !== "undefined") {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  if (typeof proto.animate !== "function") {
    proto.animate = () => ({
      finished: Promise.resolve(),
      cancel() {},
      finish() {},
      addEventListener() {},
      removeEventListener() {},
    });
  }
}
