import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createCollapseStore, SHARED_KEY, SYSTEM_KEY, UNGROUPED_KEY } from "../src/store/collapse";

/**
 * The one key in the collapse store that starts closed.
 *
 * System is where the sessions nobody asked for end up, so it opens closed and
 * stays closed until somebody opens it — the opposite default from every other
 * group, and the reason the store records a DIFFERENCE from the default rather
 * than "is collapsed".
 */

const USER = "wizard";
const store = () => createCollapseStore(() => USER);
const stored = (): string[] => JSON.parse(localStorage.getItem(`tmux-collapsed-${USER}`) ?? "[]");

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("collapse defaults", () => {
  it("starts :system collapsed and everything else expanded", () => {
    const c = store();
    expect(c.isCollapsed(SYSTEM_KEY)).toBe(true);
    expect(c.isCollapsed(UNGROUPED_KEY)).toBe(false);
    expect(c.isCollapsed(SHARED_KEY)).toBe(false);
    expect(c.isCollapsed("someproject")).toBe(false);
  });

  it("toggles :system open, and that sticks on this device", () => {
    const c = store();
    c.toggle(SYSTEM_KEY);
    expect(c.isCollapsed(SYSTEM_KEY)).toBe(false);
    // A second store reading the same localStorage is the reload.
    expect(store().isCollapsed(SYSTEM_KEY)).toBe(false);
    c.toggle(SYSTEM_KEY);
    expect(c.isCollapsed(SYSTEM_KEY)).toBe(true);
    expect(store().isCollapsed(SYSTEM_KEY)).toBe(true);
  });

  it("expand() opens :system and is a no-op once it is open", () => {
    // Selecting a system session auto-expands its group (store/lobby.ts), which
    // is the only path that opens a group without a click.
    const c = store();
    c.expand(SYSTEM_KEY);
    expect(c.isCollapsed(SYSTEM_KEY)).toBe(false);
    const before = c.version();
    c.expand(SYSTEM_KEY);
    expect(c.version()).toBe(before);
  });

  it("does not move any other key's default", () => {
    const c = store();
    c.toggle(UNGROUPED_KEY);
    expect(c.isCollapsed(UNGROUPED_KEY)).toBe(true);
    c.expand(UNGROUPED_KEY);
    expect(c.isCollapsed(UNGROUPED_KEY)).toBe(false);
    expect(stored()).not.toContain(UNGROUPED_KEY);
  });

  it("reads a store written before :system existed as collapsed", () => {
    // Every device already carries one of these. The key is absent, and absent
    // has to mean closed for System and open for a project in the same file.
    localStorage.setItem(`tmux-collapsed-${USER}`, JSON.stringify(["work"]));
    const c = store();
    expect(c.isCollapsed("work")).toBe(true);
    expect(c.isCollapsed(SYSTEM_KEY)).toBe(true);
  });
});
