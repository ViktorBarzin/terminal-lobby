/**
 * The thin line above the composer's pill: how it words the watching state,
 * and how much of it fits.
 *
 * Which state the turn is in, and the precedence the line used to report it
 * by, moved with the words into the live group at the end of the conversation
 * on 2026-09-27 (timeline.live.test.ts).
 */
import { describe, it, expect } from "vitest";
import { roomFor, splitReason } from "../src/components/statusline.logic";

describe("splitReason", () => {
  it("names who is being watched, and keeps the rest as the reason", () => {
    expect(splitReason("Watching emo — take control to type in their session")).toEqual({
      head: "Watching emo",
      rest: "take control to type in their session",
    });
    expect(splitReason("Watching: this device does not type into the session")).toEqual({
      head: "Watching",
      rest: "this device does not type into the session",
    });
  });

  it("falls back to the plain word when the reason has no head of its own", () => {
    expect(splitReason("view only")).toEqual({
      head: "Watching",
      rest: "view only",
    });
  });
});

describe("roomFor", () => {
  // Container queries would be the natural tool, and Safari 15.6, the oldest
  // engine served (lib/baseline-polyfills.ts), has none. The line measures its
  // own width instead and folds by these bands.
  it.each([
    [1000, "wide"],
    [781, "wide"],
    [780, "mid"],
    [601, "mid"],
    [600, "narrow"],
    [461, "narrow"],
    [460, "tight"],
    [320, "tight"],
  ])("puts %ipx in the %s band", (w, room) => {
    expect(roomFor(w)).toBe(room);
  });

  it("stays wide where nothing can be measured", () => {
    expect(roomFor(0)).toBe("wide");
  });
});
