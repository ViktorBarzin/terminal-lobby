import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadWatch, saveWatch, WATCH_KEY_PREFIX } from "../src/store/watchmode";

/**
 * Watch-mode storage. The three-state contract and the automatic rule live in
 * watchmode.auto.test.ts; this file covers the properties that hold whatever
 * the resolution rule is — where the state lives, and what happens when the
 * browser will not let us keep it.
 */
describe("watch mode — where the choice is kept", () => {
  beforeEach(() => localStorage.clear());

  it("keeps each session's choice separate", () => {
    saveWatch("foo", true);
    saveWatch("bar", false);
    expect(loadWatch("foo")).toBe(true);
    expect(loadWatch("bar")).toBe(false);
    expect(loadWatch("untouched")).toBeUndefined();
  });

  it("is namespaced per session under a versioned prefix", () => {
    saveWatch("main", true);
    expect(Object.keys(localStorage)).toEqual([WATCH_KEY_PREFIX + "main"]);
    expect(WATCH_KEY_PREFIX).toMatch(/^tl:.*:v\d+:$/);
  });

  /**
   * Per-device by construction: the choice lives in localStorage and is never
   * sent to the server as state. A phone watching `main` must not make the
   * desktop's `main` read-only — the server holds no watch state at all, it
   * only ever answers the request one individual attach makes.
   */
  it("never leaves the browser", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    saveWatch("main", true);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("falls back to automatic when storage throws (private mode)", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(loadWatch("foo")).toBeUndefined();
    get.mockRestore();

    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => saveWatch("foo", true)).not.toThrow();
    set.mockRestore();
  });
});
