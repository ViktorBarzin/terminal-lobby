import { beforeEach, describe, expect, it } from "vitest";
import { forgetGrid, lastGrid, rememberGrid } from "../src/terminal/lastbox";

/**
 * The grid a hidden preload borrows. `fit.ts` refuses to fit a 0x0 host and
 * records the fit as owed, which is right for a kept session and wrong for a
 * preload: it opened at xterm's 80x24 default and re-fitted on the click that
 * revealed it, moving the reflow rather than removing it (ADR-0026).
 */
describe("the last fitted grid", () => {
  beforeEach(forgetGrid);

  it("is null until a terminal has fitted", () => {
    expect(lastGrid()).toBeNull();
  });

  it("hands back the last real grid", () => {
    rememberGrid({ cols: 157, rows: 46 });
    expect(lastGrid()).toEqual({ cols: 157, rows: 46 });
  });

  it("keeps the newest, because the window may have been resized since", () => {
    rememberGrid({ cols: 157, rows: 46 });
    rememberGrid({ cols: 80, rows: 24 });
    expect(lastGrid()).toEqual({ cols: 80, rows: 24 });
  });

  // The whole point of the guard this borrows past. A hidden host measures 0x0,
  // and fitting xterm against that proposes a floor grid — measured 11x5 on
  // 2026-09-12 — which tmux would then apply to the real window.
  it.each([
    ["a hidden host's grid", { cols: 0, rows: 0 }],
    ["zero columns alone", { cols: 0, rows: 46 }],
    ["zero rows alone", { cols: 157, rows: 0 }],
    ["a negative box", { cols: -1, rows: -1 }],
    ["nothing to measure", null],
  ])("never records %s", (_label, box) => {
    rememberGrid({ cols: 157, rows: 46 });
    rememberGrid(box);
    expect(lastGrid()).toEqual({ cols: 157, rows: 46 });
  });

  it("copies the grid, so a caller mutating its own object cannot rewrite history", () => {
    const live = { cols: 157, rows: 46 };
    rememberGrid(live);
    live.cols = 11;
    expect(lastGrid()).toEqual({ cols: 157, rows: 46 });
  });
});
