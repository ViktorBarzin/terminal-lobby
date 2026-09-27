/**
 * The permission modes the mode dial lists, and the words it uses for them.
 *
 * The dial replaced a chip that stepped the mode on every click. A click now
 * opens a list of every mode with one line on what it does, and picking one
 * asks the server to walk Shift+Tab until the pane shows it (wire contract 1,
 * decided 2026-09-24). What is pinned here is the table that list is drawn
 * from and the words it borrows from the CLI's own mode titles.
 */
import { describe, it, expect } from "vitest";
import { MODES, isDangerMode, modeId, modeRow, modeTitle } from "../src/logic/modes";

describe("the mode list", () => {
  // The T3 pass (2026-09-27) orders the four that ask first as the sheet
  // draws them: Manual, Edits, Auto, then Plan, which changes nothing and so
  // sits apart from the three that act.
  it("lists six modes in the sheet's order, the four that ask first and then the two that do not", () => {
    expect(MODES.map((m) => m.id)).toEqual([
      "manual",
      "acceptEdits",
      "auto",
      "plan",
      "bypassPermissions",
      "dontAsk",
    ]);
    expect(MODES.map((m) => m.tone)).toEqual([
      "safe",
      "caution",
      "caution",
      "plan",
      "danger",
      "danger",
    ]);
  });

  it("gives every mode one line on what it does", () => {
    for (const m of MODES) expect(m.line.length, m.id).toBeGreaterThan(10);
    expect(modeRow("manual")?.line).toBe("Asks before every edit and command");
    expect(modeRow("bypassPermissions")?.line).toBe("Nothing asks. Every tool runs");
  });

  // The prototype called No ask "the same as bypass, under the CLI's newer
  // name". The 2.1.281 binary maps dontAsk to deny: a tool that would have
  // asked is refused, with "Permission to use X has been denied because Claude
  // Code is running in don't ask mode" (memory #13914).
  it("says No ask refuses, because that is what the CLI does in it", () => {
    expect(modeRow("dontAsk")?.line).toBe("Nothing asks. Anything that would ask is refused");
  });
});

describe("a mode's name", () => {
  it("uses the CLI's own titles, shortened where they run long", () => {
    expect(modeTitle("manual")).toBe("Manual");
    expect(modeTitle("plan")).toBe("Plan");
    expect(modeTitle("acceptEdits")).toBe("Edits");
    expect(modeTitle("auto")).toBe("Auto");
    expect(modeTitle("bypassPermissions")).toBe("Bypass");
    expect(modeTitle("dontAsk")).toBe("No ask");
  });

  // `default` is what the CLI called `manual` before the rename, and it is
  // still what older transcripts in ~/.claude/projects say: 281 of those
  // records against 0 saying `manual` when the chip this replaces was written.
  it("reads a pre-rename `default` as Manual", () => {
    expect(modeTitle("default")).toBe("Manual");
    expect(modeId("default")).toBe("manual");
  });

  it("passes an unfamiliar mode through unchanged", () => {
    expect(modeTitle("somethingNew")).toBe("somethingNew");
    expect(modeId("somethingNew")).toBeUndefined();
    expect(modeRow("somethingNew")).toBeUndefined();
  });
});

describe("the modes where nothing asks first", () => {
  it("are bypass and no ask, and nothing else", () => {
    expect(MODES.filter((m) => isDangerMode(m.id)).map((m) => m.id)).toEqual([
      "bypassPermissions",
      "dontAsk",
    ]);
    expect(isDangerMode("default")).toBe(false);
    expect(isDangerMode("")).toBe(false);
  });

  // The Quiet line also wrote the mode into the field's placeholder. The T3
  // pass keeps one sentence there whatever the mode, and the danger border is
  // the signal (Composer.layout.test.tsx).
});
