import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";

const tracked = vi.hoisted(() => ({ events: [] as { name: string; attrs: unknown }[] }));
vi.mock("../src/telemetry/track", () => ({
  track: (name: string, attrs: unknown) => void tracked.events.push({ name, attrs }),
}));

import { carryViewMode, createViewMode, loadMode, saveMode } from "../src/store/viewmode";

/**
 * The third view (docs/plans/2026-10-12-t3-view-design.md decision 11): T3
 * Code's web client, offered to an admin on their own Claude sessions. The
 * stored choice is per session and per device like the other two, and a
 * device that may not show it reads the default rather than an empty pane.
 */
describe("view mode: the T3 view", () => {
  beforeEach(() => {
    localStorage.clear();
    tracked.events.length = 0;
  });

  it("stores and reads t3 as a deviation from the text default", () => {
    saveMode("auth", "t3");
    expect(localStorage.getItem("tl:viewmode:v1:auth")).toBe("t3");
    expect(loadMode("auth")).toBe("t3");
  });

  it("records the switch as view.switched with tl.to = t3", () => {
    saveMode("auth", "t3");
    expect(tracked.events).toEqual([
      { name: "view.switched", attrs: { "tl.to": "t3", "tl.session": "auth" } },
    ]);
  });

  it("carries a t3 choice across a rename", () => {
    saveMode("824smya2cmz5", "t3");
    carryViewMode("824smya2cmz5", "beads");
    expect(loadMode("beads")).toBe("t3");
    expect(localStorage.getItem("tl:viewmode:v1:824smya2cmz5")).toBeNull();
  });

  it("reads anything else stored as the default", () => {
    localStorage.setItem("tl:viewmode:v1:auth", "T3");
    expect(loadMode("auth")).toBe("text");
  });

  it("shows text while T3 is not offered, and keeps the stored choice for when it is", () => {
    localStorage.setItem("tl:viewmode:v1:auth", "t3");
    createRoot((dispose) => {
      const [offered, setOffered] = createSignal(false);
      const [mode] = createViewMode(() => "auth", offered);
      expect(mode()).toBe("text");
      // /whoami lands and says admin: the stored view comes back.
      setOffered(true);
      expect(mode()).toBe("t3");
      expect(localStorage.getItem("tl:viewmode:v1:auth")).toBe("t3");
      dispose();
    });
  });

  it("a session with no offer at all never shows t3", () => {
    localStorage.setItem("tl:viewmode:v1:auth", "t3");
    createRoot((dispose) => {
      const [mode] = createViewMode(() => "auth");
      expect(mode()).toBe("text");
      dispose();
    });
  });

  it("the toggle leaves t3 for text, as it leaves the terminal", () => {
    createRoot((dispose) => {
      const [mode, set, toggle] = createViewMode(
        () => "auth",
        () => true,
      );
      set("t3");
      expect(mode()).toBe("t3");
      toggle();
      expect(mode()).toBe("text");
      toggle();
      expect(mode()).toBe("terminal");
      dispose();
    });
  });
});
