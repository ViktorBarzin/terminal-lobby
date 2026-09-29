/**
 * The phone's Back closes the overlay on top (lib/back-closes.ts).
 *
 * Deployed reviews, 2026-09-28: Android's Back with the picture lightbox or the
 * model sheet up left the overlay on screen and moved the browser's history.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { closeOnBack } from "../src/lib/back-closes";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A popstate landing on an entry `depth` overlays deep (0: the page). */
const back = (depth = 0) =>
  window.dispatchEvent(new PopStateEvent("popstate", { state: depth ? { tlOverlay: depth } : null }));

function overlay() {
  const [open, setOpen] = createSignal(false);
  render(() => {
    closeOnBack(open, () => setOpen(false));
    return null;
  });
  return { open, setOpen };
}

describe("closeOnBack", () => {
  it("pushes one entry while open, and Back closes it", () => {
    const push = vi.spyOn(window.history, "pushState");
    const o = overlay();
    o.setOpen(true);
    expect(push).toHaveBeenCalledTimes(1);
    back();
    expect(o.open()).toBe(false);
  });

  it("takes its entry back when it closes some other way, and that is no Back", () => {
    const goBack = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const a = overlay();
    const b = overlay();
    a.setOpen(true);
    b.setOpen(true);
    b.setOpen(false);
    expect(goBack).toHaveBeenCalledTimes(1);
    // The popstate that history.back() causes lands on a's entry.
    back(1);
    expect(a.open()).toBe(true);
    // A real Back now closes the one still open.
    back();
    expect(a.open()).toBe(false);
  });

  it("closes the newest overlay only", () => {
    vi.spyOn(window.history, "back").mockImplementation(() => {});
    const a = overlay();
    const b = overlay();
    a.setOpen(true);
    b.setOpen(true);
    back(1);
    expect(b.open()).toBe(false);
    expect(a.open()).toBe(true);
  });

  it("does nothing on Back with nothing open", () => {
    const o = overlay();
    back();
    expect(o.open()).toBe(false);
  });
});
