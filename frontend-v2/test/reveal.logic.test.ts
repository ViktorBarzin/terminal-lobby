/**
 * How far a card's scroll box moves to show the whole field row.
 *
 * Found live on 2026-09-27 on the Android emulator: the plan card's "Tell
 * Claude what to change" field took the focus, the keyboard came up and the
 * card body scrolled, but it stopped 18px short (scroller bottom 404, field
 * row 368 to 422), so the row's round Send was cut through the middle.
 */
import { describe, expect, it } from "vitest";
import { revealBy } from "../src/components/reveal.logic";

describe("revealBy", () => {
  it("scrolls down by what the row hangs below the box, measured live", () => {
    expect(revealBy({ top: 222, bottom: 404 }, { top: 368, bottom: 422 })).toBe(18);
  });

  it("scrolls up by what the row sits above the box", () => {
    expect(revealBy({ top: 200, bottom: 400 }, { top: 180, bottom: 234 })).toBe(-20);
  });

  it("leaves a row already in view alone", () => {
    expect(revealBy({ top: 200, bottom: 400 }, { top: 250, bottom: 304 })).toBe(0);
  });

  it("shows the row's bottom, where Send is, when the row is taller than the box", () => {
    expect(revealBy({ top: 200, bottom: 240 }, { top: 190, bottom: 300 })).toBe(60);
  });
});
