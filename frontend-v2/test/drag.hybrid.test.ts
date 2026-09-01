import { describe, it, expect, afterEach } from "vitest";
import { hasFinePointer } from "../src/mobile/pointer";

/**
 * Which devices get native drag-and-drop.
 *
 * The sidebar has two reorder paths: HTML5 drag for a pointer that can be
 * precise, and a hold-and-lift gesture for touch. They were split on
 * `(pointer: coarse)`, which describes only the PRIMARY input — so a touchscreen
 * laptop, a 2-in-1 or a Chromebook reported coarse while the person used a
 * mouse. HTML5 drag was not armed, and the touch path returns early on
 * `pointerType === "mouse"`, so NEITHER ran and dragging did nothing.
 *
 * Reproduced 2026-09-01 in a desktop-sized window advertising a touchscreen:
 * draggable=false, no drop indicator, no PUT /layout.
 */
const real = globalThis.matchMedia;
afterEach(() => {
  if (real) globalThis.matchMedia = real;
  else Reflect.deleteProperty(globalThis as object, "matchMedia");
});

/** Answer the two queries the way a given class of device would. */
function device(opts: { anyFine: boolean }) {
  globalThis.matchMedia = ((q: string) =>
    ({ matches: q.includes("any-pointer: fine") ? opts.anyFine : !opts.anyFine }) as MediaQueryList) as typeof matchMedia;
}

describe("hasFinePointer — who gets native drag", () => {
  it("a plain desktop with a mouse", () => {
    device({ anyFine: true });
    expect(hasFinePointer()).toBe(true);
  });

  it("THE BUG: a touchscreen laptop being driven with a mouse", () => {
    // Primary pointer coarse, but a mouse is attached. This machine could not
    // reorder at all before: no native drag, and the touch path ignores a mouse.
    globalThis.matchMedia = ((q: string) =>
      ({ matches: q.includes("any-pointer: fine") || q.includes("pointer: coarse") }) as MediaQueryList) as typeof matchMedia;
    expect(hasFinePointer()).toBe(true);
  });

  it("a phone keeps the touch path", () => {
    device({ anyFine: false });
    expect(hasFinePointer()).toBe(false);
  });

  it("assumes a desktop when the browser cannot answer", () => {
    Reflect.deleteProperty(globalThis as object, "matchMedia");
    // Being wrong here costs an unused draggable attribute; being wrong the
    // other way costs a drag that silently does nothing.
    expect(hasFinePointer()).toBe(true);
  });
});
