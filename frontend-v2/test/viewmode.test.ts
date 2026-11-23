import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";

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

/**
 * A session with no Claude in it opens in the Terminal (Viktor, 2026-11-23).
 * Its Text view had nothing to show but a note pointing at the Terminal, twice.
 * The caller says which default applies, and a choice the person made still
 * wins in both directions.
 */
describe("view mode: a session with no Claude", () => {
  beforeEach(() => localStorage.clear());

  it("opens in the terminal when the caller's default says so", () => {
    createRoot((dispose) => {
      const [mode] = createViewMode(
        () => "shell1",
        () => "terminal",
      );
      expect(mode()).toBe("terminal");
      dispose();
    });
  });

  it("follows the default when it changes, as Claude exiting does", () => {
    // Outside the root's own body, so its effects are running by then.
    const [noClaude, setNoClaude] = createSignal(false);
    const { mode, dispose } = createRoot((dispose) => {
      const [mode] = createViewMode(
        () => "s",
        () => (noClaude() ? "terminal" : "text"),
      );
      return { mode, dispose };
    });
    expect(mode()).toBe("text");
    setNoClaude(true);
    expect(mode()).toBe("terminal");
    dispose();
  });

  it("keeps the Text view for a person who picked it on a Claude-less session", () => {
    createRoot((dispose) => {
      const [mode, setMode] = createViewMode(
        () => "shell2",
        () => "terminal",
      );
      setMode("text");
      expect(localStorage.getItem("tl:viewmode:v1:shell2")).toBe("text");
      expect(loadMode("shell2", "terminal")).toBe("text");
      expect(mode()).toBe("text");
      dispose();
    });
  });

  it("still prunes a choice that matches the default in force", () => {
    createRoot((dispose) => {
      const [, setMode] = createViewMode(
        () => "shell3",
        () => "terminal",
      );
      setMode("text");
      setMode("terminal");
      expect(localStorage.getItem("tl:viewmode:v1:shell3")).toBeNull();
      dispose();
    });
  });
});
