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
    addEventListener(): void {}
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
