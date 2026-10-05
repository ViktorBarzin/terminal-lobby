import { describe, it, expect } from "vitest";
import {
  columnCss,
  fromDrag,
  matchingPreset,
  nudge,
  readTextColumn,
  serializeTextColumn,
  TEXT_COL_DEFAULT,
  TEXT_COL_MIN,
  TEXT_COL_PRESETS,
  TEXT_COL_SNAP,
} from "../src/store/text-column.logic";

describe("what a browser reads back", () => {
  it.each([
    [null, TEXT_COL_DEFAULT],
    ["", TEXT_COL_DEFAULT],
    ["wide", TEXT_COL_DEFAULT],
    ["NaN", TEXT_COL_DEFAULT],
    ["full", "full"],
    ["1000", 1000],
    ["1000.6", 1001],
    ["120", TEXT_COL_MIN],
  ] as const)("reads %j as %j", (raw, want) => {
    expect(readTextColumn(raw)).toBe(want);
  });
});

describe("what gets stored", () => {
  it("stores nothing for the default, so a reset leaves no key behind", () => {
    expect(serializeTextColumn(TEXT_COL_DEFAULT)).toBeNull();
  });

  it.each([
    [1000, "1000"],
    ["full", "full"],
  ] as const)("stores %j as %j", (v, want) => {
    expect(serializeTextColumn(v)).toBe(want);
  });

  it("round-trips every preset", () => {
    for (const p of TEXT_COL_PRESETS) {
      expect(readTextColumn(serializeTextColumn(p.value))).toBe(p.value);
    }
  });
});

describe("the width a drag asks for", () => {
  it("passes a width inside the room through, rounded to a pixel", () => {
    expect(fromDrag(900.4, 1400)).toBe(900);
  });

  it("holds the minimum", () => {
    expect(fromDrag(100, 1400)).toBe(TEXT_COL_MIN);
  });

  it("goes full once the edge reaches the room's edge", () => {
    expect(fromDrag(1400 - TEXT_COL_SNAP, 1400)).toBe("full");
    expect(fromDrag(5000, 1400)).toBe("full");
    expect(fromDrag(1400 - TEXT_COL_SNAP - 1, 1400)).toBe(1400 - TEXT_COL_SNAP - 1);
  });

  it("keeps the minimum when the room is narrower than it", () => {
    // A view too narrow for the minimum already shows the whole width; what a
    // drag stores there must not be "full", or a wide window would inherit it.
    expect(fromDrag(500, 400)).toBe(TEXT_COL_MIN);
  });
});

describe("a key press on the grip", () => {
  it("widens and narrows from a pixel width", () => {
    expect(nudge(1000, 40, 1600)).toBe(1040);
    expect(nudge(1000, -40, 1600)).toBe(960);
  });

  it("narrows out of full from the width full is showing", () => {
    expect(nudge("full", -40, 1600)).toBe(1560);
  });

  it("stays full when widened", () => {
    expect(nudge("full", 40, 1600)).toBe("full");
  });
});

describe("what CSS reads", () => {
  it.each([
    [760, "760px"],
    [1234, "1234px"],
    ["full", "100%"],
  ] as const)("%j is %j", (v, want) => {
    expect(columnCss(v)).toBe(want);
  });
});

describe("which preset the Settings strip lights", () => {
  it("lights the preset a width equals", () => {
    expect(matchingPreset(TEXT_COL_DEFAULT)?.label).toBe("Normal");
    expect(matchingPreset("full")?.label).toBe("Full");
  });

  it("lights none for a width a drag picked", () => {
    expect(matchingPreset(913)).toBeUndefined();
  });
});
