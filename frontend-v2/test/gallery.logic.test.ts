import { describe, it, expect } from "vitest";
import {
  sortNewestFirst,
  badgeLabel,
  stepBack,
  type StoredImage,
} from "../src/store/gallery.logic";

const img = (over: Partial<StoredImage> = {}): StoredImage => ({
  name: "pasted-1.png",
  path: "/var/lib/clipboard-store/u/s/pasted-1.png",
  size: 10,
  mtime: 1000,
  kind: "pasted",
  ...over,
});

describe("sortNewestFirst — gallery list ordering", () => {
  it("orders by mtime descending (newest first)", () => {
    const a = img({ name: "a", mtime: 100 });
    const b = img({ name: "b", mtime: 300 });
    const c = img({ name: "c", mtime: 200 });
    expect(sortNewestFirst([a, b, c]).map((x) => x.name)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("is stable for equal mtimes (same-second pastes keep server order)", () => {
    const a = img({ name: "a", mtime: 500 });
    const b = img({ name: "b", mtime: 500 });
    const c = img({ name: "c", mtime: 500 });
    expect(sortNewestFirst([a, b, c]).map((x) => x.name)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("does not mutate the input array", () => {
    const list = [img({ name: "a", mtime: 1 }), img({ name: "b", mtime: 2 })];
    const before = [...list];
    sortNewestFirst(list);
    expect(list).toEqual(before);
  });

  it("handles empty and single-element lists", () => {
    expect(sortNewestFirst([])).toEqual([]);
    expect(sortNewestFirst([img()])).toHaveLength(1);
  });
});

describe("badgeLabel — show-image badge", () => {
  it("badges 'displayed' (show-image) renders as 'shown'", () => {
    expect(badgeLabel(img({ kind: "displayed" }))).toBe("shown");
  });

  it("no badge for pasted / legacy / unknown kinds", () => {
    expect(badgeLabel(img({ kind: "pasted" }))).toBeNull();
    expect(badgeLabel(img({ kind: "" }))).toBeNull();
    expect(badgeLabel(img({ kind: "whatever" }))).toBeNull();
  });
});

describe("stepBack — lightbox → grid → closed", () => {
  it("the lightbox steps back to the grid it opened from", () => {
    expect(stepBack("lightbox")).toBe("grid");
  });
  it("the grid steps back to closed", () => {
    expect(stepBack("grid")).toBe("closed");
  });
  it("closed stays closed", () => {
    expect(stepBack("closed")).toBe("closed");
  });
});
