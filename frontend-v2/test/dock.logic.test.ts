import { describe, it, expect } from "vitest";
import {
  clampRatio,
  DOCK_RATIO_DEFAULT,
  firstFreeShellName,
  hideDockedSession,
  nextDockAction,
} from "../src/store/dock.logic";
import { emptyLayout, type Layout, type Session } from "../src/types/lobby";

const sess = (name: string): Session => ({
  name, attached: 0, lastActivity: 0, created: 0, owner: "wizard",
});
const withDock = (session: string, visible: boolean): Layout => ({
  ...emptyLayout(), dock: { session, visible },
});

describe("scratch-shell naming — the same names the vanilla page picks", () => {
  it("takes `shell` when it is free", () => {
    expect(firstFreeShellName([])).toBe("shell");
    expect(firstFreeShellName(["work", "notes"])).toBe("shell");
  });

  it("walks to the first free numbered name, skipping gaps in use", () => {
    expect(firstFreeShellName(["shell"])).toBe("shell-2");
    expect(firstFreeShellName(["shell", "shell-2", "shell-3"])).toBe("shell-4");
    // a gap is reused rather than skipped past
    expect(firstFreeShellName(["shell", "shell-3"])).toBe("shell-2");
  });
});

describe("Ctrl+J cycles create → hide → show", () => {
  it("creates when nothing is docked", () => {
    expect(nextDockAction(emptyLayout(), ["work"])).toEqual({ kind: "create", name: "shell" });
  });

  it("hides a visible dock — the shell keeps running", () => {
    expect(nextDockAction(withDock("shell", true), ["shell"])).toEqual({ kind: "hide" });
  });

  it("shows the SAME shell again rather than making a second one", () => {
    expect(nextDockAction(withDock("shell", false), ["shell"])).toEqual({ kind: "show" });
  });
});

describe("the docked shell is not a sidebar thread", () => {
  it("is hidden from the list while docked", () => {
    const list = [sess("work"), sess("shell")];
    expect(hideDockedSession(list, withDock("shell", true), true).map((s) => s.name)).toEqual([
      "work",
    ]);
    // hidden-but-docked still counts as docked
    expect(hideDockedSession(list, withDock("shell", false), true).map((s) => s.name)).toEqual([
      "work",
    ]);
  });

  it("comes back the moment it is un-docked", () => {
    const list = [sess("work"), sess("shell")];
    expect(hideDockedSession(list, emptyLayout(), true).map((s) => s.name)).toEqual([
      "work",
      "shell",
    ]);
  });

  // A PHONE HAS NO DOCK, SO IT CANNOT HIDE A SESSION BEHIND ONE. `layout.dock`
  // roams, so a shell docked at a desk arrives on the phone still set. The panel
  // is gated off there (store/dock.ts `allowed`), so hiding the card as well
  // left the session running, in no list and in no panel, reachable only by
  // going back to a desktop. Measured live 2026-09-06: wizard's layout carried
  // `dock: {session: "shell", visible: true}` and `shell` was a running session.
  //
  // The vanilla page drew the same line, and its design doc says why:
  // "On mobile (no dock) it falls through as a normal card so it's never lost."
  it("falls through as an ordinary card where the dock cannot render", () => {
    const list = [sess("work"), sess("shell")];
    expect(hideDockedSession(list, withDock("shell", true), false).map((s) => s.name)).toEqual([
      "work",
      "shell",
    ]);
  });

  it("still hides it where the dock CAN render, docked and visible or not", () => {
    const list = [sess("work"), sess("shell")];
    expect(hideDockedSession(list, withDock("shell", true), true).map((s) => s.name)).toEqual([
      "work",
    ]);
    expect(hideDockedSession(list, withDock("shell", false), true).map((s) => s.name)).toEqual([
      "work",
    ]);
  });
});

describe("split ratio", () => {
  it("clamps to a usable band and defaults on garbage", () => {
    expect(clampRatio(30)).toBe(30);
    expect(clampRatio(2)).toBe(15);
    expect(clampRatio(99)).toBe(80);
    expect(clampRatio(NaN)).toBe(DOCK_RATIO_DEFAULT);
    expect(clampRatio("nonsense")).toBe(DOCK_RATIO_DEFAULT);
  });
});
