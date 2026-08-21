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
   * A LENS KEEPS ITS OWN KEYS. The key is otherwise the bare session name,
   * which is shared with YOUR session of that name — so choosing to drive
   * emo's `code` would decide how your own `code` opens, days later, from a
   * decision you made about someone else's box.
   */
  it("keeps a lens's choice apart from your own session of the same name", () => {
    saveWatch("code", true); // your own `code`: watch
    saveWatch("code", false, "emo"); // emo's `code`, seen through a lens: drive
    expect(loadWatch("code")).toBe(true);
    expect(loadWatch("code", "emo")).toBe(false);
    expect(loadWatch("code", "ancamilea")).toBeUndefined();
  });

  // No session name can reach the lens namespace: tmux-api, tmux-attach.sh and
  // sessionio all bound a name to [a-zA-Z0-9_-]{1,32}, so the colons cannot
  // appear in one.
  it("puts a lens's keys under the target's own name", () => {
    saveWatch("work", true, "emo");
    expect(Object.keys(localStorage)).toEqual([WATCH_KEY_PREFIX + "as:emo:work"]);
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
