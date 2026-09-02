/**
 * ONE CONNECTION INDICATOR AT A TIME.
 *
 * Measured on 2026-09-02, a single dropped terminal socket was announced three
 * times on one screen: the terminal's own pill said "Reconnecting… (attempt 7)",
 * the session bar's badge said "Reconnecting" 40px above it, and the sidebar
 * header's badge — scoped to channels a list screen can answer for, so it knew
 * nothing about the terminal — sat there green. Two identical statements and one
 * contradiction.
 *
 * The rule that fixes it: the sidebar's badge exists for screens with NO session
 * bar (the phone's list, which is the whole viewport, and the desktop empty
 * state) and stands down everywhere else. This pins that rule, because the
 * layout it depends on cannot be driven from a desktop browser — the phone flip
 * requires `pointer: coarse`, which a resized window does not report.
 */
import { describe, it, expect } from "vitest";
import { sessionBarOnScreen } from "../src/components/lobby.logic";

describe("where the connection badge lives", () => {
  it("is in the session bar on a desktop with a session open", () => {
    expect(sessionBarOnScreen({ selected: true, flip: false, collapsed: false })).toBe(true);
  });

  it("is not, on a desktop with nothing selected — so the sidebar carries it", () => {
    expect(sessionBarOnScreen({ selected: false, flip: false, collapsed: false })).toBe(false);
  });

  /** The phone's list screen IS the whole viewport: no session bar is on it, so
   *  without the sidebar's badge that surface would have no status at all. */
  it("is not, on the phone's list screen", () => {
    expect(sessionBarOnScreen({ selected: true, flip: true, collapsed: false })).toBe(false);
  });

  it("is, on the phone's session screen", () => {
    expect(sessionBarOnScreen({ selected: true, flip: true, collapsed: true })).toBe(true);
  });

  /** A phone showing the list with nothing selected is still a list screen. */
  it("is not, on a phone with no session at all", () => {
    expect(sessionBarOnScreen({ selected: false, flip: true, collapsed: false })).toBe(false);
    expect(sessionBarOnScreen({ selected: false, flip: true, collapsed: true })).toBe(false);
  });

  /** The two badges are mutually exclusive by construction: the sidebar renders
   *  exactly when this is false, so there is no state where both are up. */
  it("never lets both badges be on screen together", () => {
    for (const selected of [true, false]) {
      for (const flip of [true, false]) {
        for (const collapsed of [true, false]) {
          const bar = sessionBarOnScreen({ selected, flip, collapsed });
          const sidebar = !bar;
          expect(bar && sidebar).toBe(false);
        }
      }
    }
  });
});
