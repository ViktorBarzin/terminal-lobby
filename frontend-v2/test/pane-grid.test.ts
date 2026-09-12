import { beforeEach, describe, expect, it } from "vitest";
import { lsSet } from "../src/lib/storage";
import { PANE_GRID_KEY, readPaneGrid, rememberPaneGrid } from "../src/store/pane-grid";

describe("the grid a hidden terminal boots at", () => {
  beforeEach(() => {
    lsSet(PANE_GRID_KEY, null);
  });

  it("has nothing to say before any terminal has reported one", () => {
    expect(readPaneGrid()).toBeNull();
  });

  it("hands back the grid the last visible terminal reported", () => {
    rememberPaneGrid(128, 35);
    expect(readPaneGrid()).toEqual({ cols: 128, rows: 35 });
  });

  it("survives the page, because a cold load hovers before it shows a terminal", () => {
    rememberPaneGrid(120, 40);
    expect(JSON.parse(localStorage.getItem(PANE_GRID_KEY) ?? "null")).toEqual({
      cols: 120,
      rows: 40,
    });
  });

  it("keeps the newest, since the pane is whatever size the window is now", () => {
    rememberPaneGrid(128, 35);
    rememberPaneGrid(90, 50);
    expect(readPaneGrid()).toEqual({ cols: 90, rows: 50 });
  });

  // xterm's own default is 80x24, and a terminal that boots hidden already
  // falls back to it. Storing a grid that says the same thing buys nothing and
  // would let one genuinely tiny window teach every later hover to be tiny.
  it("refuses a grid at or below xterm's own fallback", () => {
    rememberPaneGrid(128, 35);
    rememberPaneGrid(80, 24);
    expect(readPaneGrid()).toEqual({ cols: 128, rows: 35 });
  });

  // A fit that ran against a host mid-teardown can report a degenerate grid,
  // and writing it would send the next hover to a one-column pty.
  it.each([
    [0, 0],
    [-1, 40],
    [120, 0],
    [Number.NaN, 40],
    [120, Number.POSITIVE_INFINITY],
  ])("refuses the nonsense grid %sx%s", (cols, rows) => {
    rememberPaneGrid(128, 35);
    rememberPaneGrid(cols, rows);
    expect(readPaneGrid()).toEqual({ cols: 128, rows: 35 });
  });

  // Stored state is input like any other: a hand-edited or half-written value
  // must not reach term.resize().
  it.each([
    ["not json", "{{{"],
    ["the wrong shape", '{"width":128}'],
    ["a string grid", '{"cols":"128","rows":"35"}'],
    ["a degenerate stored grid", '{"cols":0,"rows":0}'],
    ["null", "null"],
  ])("reads back nothing from %s", (_label, stored) => {
    lsSet(PANE_GRID_KEY, stored);
    expect(readPaneGrid()).toBeNull();
  });

  it("rounds a fractional grid rather than refusing it", () => {
    rememberPaneGrid(128.4, 35.6);
    expect(readPaneGrid()).toEqual({ cols: 128, rows: 36 });
  });
});
