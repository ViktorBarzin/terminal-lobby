import { describe, it, expect } from "vitest";
import {
  clampSidebarWidth,
  readStoredWidth,
  CONTENT_W_MIN,
  SIDEBAR_W_DEFAULT,
  SIDEBAR_W_MAX,
  SIDEBAR_W_MIN,
} from "../src/store/sidebar-width.logic";

describe("the width a drag is allowed to reach", () => {
  it("passes a width inside the range through, rounded to a pixel", () => {
    expect(clampSidebarWidth(340)).toBe(340);
    expect(clampSidebarWidth(340.4)).toBe(340);
    expect(clampSidebarWidth(340.6)).toBe(341);
  });

  it("holds the ends", () => {
    expect(clampSidebarWidth(10)).toBe(SIDEBAR_W_MIN);
    expect(clampSidebarWidth(5000)).toBe(SIDEBAR_W_MAX);
  });

  it("leaves the session pane its minimum on a narrow window", () => {
    // 900 wide: the list may reach 540, not the 560 the range would allow.
    expect(clampSidebarWidth(560, 900)).toBe(900 - CONTENT_W_MIN);
    // Wide enough that the window is not the binding constraint.
    expect(clampSidebarWidth(560, 1920)).toBe(SIDEBAR_W_MAX);
  });

  it("keeps the list's minimum on a window too narrow to satisfy both", () => {
    // 500 - 360 = 140, below the list's own floor. The floor wins: at this
    // width sidebar.css has already stacked the two panes.
    expect(clampSidebarWidth(400, 500)).toBe(SIDEBAR_W_MIN);
  });

  it("ignores a viewport that is not a usable number", () => {
    expect(clampSidebarWidth(560, 0)).toBe(SIDEBAR_W_MAX);
    expect(clampSidebarWidth(560, Number.NaN)).toBe(SIDEBAR_W_MAX);
  });

  it("answers the default for anything that is not a number", () => {
    // The case store/dock.ts was caught by: Number(null) is 0, not NaN, so a
    // browser that never dragged must not be clamped to the minimum.
    expect(clampSidebarWidth(undefined)).toBe(SIDEBAR_W_DEFAULT);
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_W_DEFAULT);
    expect(clampSidebarWidth("wide")).toBe(SIDEBAR_W_DEFAULT);
  });
});

describe("what a browser reads back", () => {
  it("takes a stored width", () => {
    expect(readStoredWidth("420")).toBe(420);
  });

  it("takes the default when nothing was ever stored", () => {
    expect(readStoredWidth(null)).toBe(SIDEBAR_W_DEFAULT);
    expect(readStoredWidth("")).toBe(SIDEBAR_W_DEFAULT);
  });

  it("takes the default from a key someone else corrupted", () => {
    expect(readStoredWidth("{}")).toBe(SIDEBAR_W_DEFAULT);
  });
});
