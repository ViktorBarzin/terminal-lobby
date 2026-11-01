import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRoot } from "solid-js";

vi.mock("../src/telemetry/track", () => ({ track: () => {} }));

import { carryViewMode, createViewMode, loadMode } from "../src/store/viewmode";

/**
 * The framed T3 view was retired (ADR-0046), and a browser that used it still
 * holds "t3" under tl:viewmode:v1:<session>. Every stored value that is not
 * text or terminal reads as the default, so that session opens in the Text
 * view and its switch works as it does everywhere else.
 */
describe("view mode: a value the lobby no longer offers", () => {
  beforeEach(() => localStorage.clear());

  it.each(["t3", "T3", "frame", ""])("reads a stored %j as the text default", (stored) => {
    localStorage.setItem("tl:viewmode:v1:auth", stored);
    expect(loadMode("auth")).toBe("text");
  });

  it("opens a session left in the T3 view in text, and the switch goes to the terminal", () => {
    localStorage.setItem("tl:viewmode:v1:auth", "t3");
    createRoot((dispose) => {
      const [mode, , toggle] = createViewMode(() => "auth");
      expect(mode()).toBe("text");
      toggle();
      expect(mode()).toBe("terminal");
      expect(localStorage.getItem("tl:viewmode:v1:auth")).toBe("terminal");
      dispose();
    });
  });

  it("does not carry a stale t3 onto a renamed session", () => {
    localStorage.setItem("tl:viewmode:v1:824smya2cmz5", "t3");
    carryViewMode("824smya2cmz5", "beads");
    expect(localStorage.getItem("tl:viewmode:v1:beads")).toBeNull();
    expect(loadMode("beads")).toBe("text");
  });
});
