/**
 * The geometry of a finger-dragged row, away from the DOM.
 *
 * Which half of a row the finger is in decides whether the dragged row lands
 * above or below it, and how close the finger is to the edge of the list
 * decides how fast the list scrolls itself. Both are arithmetic, and neither is
 * observable in jsdom (no layout, no elementFromPoint), so they are tested
 * here and the DOM walk that feeds them is tested in SessionCard.reorder.
 */
import { describe, it, expect } from "vitest";
import { dropSide, edgeScroll } from "../src/mobile/reorder";

describe("dropSide — which half of the row the finger is in", () => {
  const top = 100;
  const height = 40;

  it("is above in the top half, below in the bottom half", () => {
    expect(dropSide(105, top, height)).toBe("above");
    expect(dropSide(135, top, height)).toBe("below");
  });

  it("puts the exact middle below, so one rule covers the whole row", () => {
    expect(dropSide(120, top, height)).toBe("below");
  });
});

describe("edgeScroll — the list scrolls itself while the finger sits at its edge", () => {
  const top = 200;
  const bottom = 800;

  it("does nothing in the middle, which is most of the list", () => {
    expect(edgeScroll(500, top, bottom)).toBe(0);
    expect(edgeScroll(300, top, bottom)).toBe(0);
  });

  it("scrolls up near the top and down near the bottom", () => {
    expect(edgeScroll(top + 10, top, bottom)).toBeLessThan(0);
    expect(edgeScroll(bottom - 10, top, bottom)).toBeGreaterThan(0);
  });

  it("goes faster the closer the finger is to the edge", () => {
    const near = Math.abs(edgeScroll(bottom - 4, top, bottom));
    const far = Math.abs(edgeScroll(bottom - 50, top, bottom));
    expect(near).toBeGreaterThan(far);
  });

  // A finger dragged past the end of the list is still asking to scroll, and
  // the fastest it can ask for is the same speed as the edge itself.
  it("caps the speed, including past the edge", () => {
    const atEdge = edgeScroll(bottom, top, bottom);
    expect(edgeScroll(bottom + 400, top, bottom)).toBe(atEdge);
    expect(edgeScroll(top - 400, top, bottom)).toBe(-atEdge);
  });
});
