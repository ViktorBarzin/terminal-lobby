import { beforeEach, describe, expect, it } from "vitest";
import { forgetHostBox, lastHostBox, rememberHostBox } from "../src/terminal/lastbox";

/**
 * The box a hidden preload borrows. `fit.ts` refuses to fit a 0x0 host and
 * records the fit as owed, which is right for a kept session and wrong for a
 * preload: it opened at xterm's 80x24 default and re-fitted on the click that
 * revealed it, moving the reflow rather than removing it (ADR-0026).
 */
describe("the last host box", () => {
  beforeEach(forgetHostBox);

  it("is null until a terminal has measured one", () => {
    expect(lastHostBox()).toBeNull();
  });

  it("hands back the last real box", () => {
    rememberHostBox({ width: 1280, height: 720 });
    expect(lastHostBox()).toEqual({ width: 1280, height: 720 });
  });

  it("keeps the newest, because the window may have been resized since", () => {
    rememberHostBox({ width: 1280, height: 720 });
    rememberHostBox({ width: 800, height: 600 });
    expect(lastHostBox()).toEqual({ width: 800, height: 600 });
  });

  // The whole point of the guard this borrows past. A hidden host measures 0x0,
  // and fitting xterm against that computes a ~13x7 grid which tmux then
  // applies to the real window, squeezing every other client on the session.
  it.each([
    ["a hidden host", { width: 0, height: 0 }],
    ["zero width alone", { width: 0, height: 720 }],
    ["zero height alone", { width: 1280, height: 0 }],
    ["a negative box", { width: -1, height: -1 }],
    ["nothing to measure", null],
  ])("never records %s", (_label, box) => {
    rememberHostBox({ width: 1280, height: 720 });
    rememberHostBox(box);
    expect(lastHostBox()).toEqual({ width: 1280, height: 720 });
  });

  it("copies the box, so a caller mutating its own object cannot rewrite history", () => {
    const live = { width: 1280, height: 720 };
    rememberHostBox(live);
    live.width = 13;
    expect(lastHostBox()).toEqual({ width: 1280, height: 720 });
  });
});
