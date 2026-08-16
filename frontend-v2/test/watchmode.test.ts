import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  loadWatch,
  saveWatch,
  WATCH_KEY_PREFIX,
} from "../src/store/watchmode";

describe("watch mode — per session, per device", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to driving, so nothing changes for anyone who never opts in", () => {
    expect(loadWatch("foo")).toBe(false);
  });

  it("remembers watching for one session without touching another", () => {
    saveWatch("foo", true);
    expect(loadWatch("foo")).toBe(true);
    expect(loadWatch("bar")).toBe(false);
  });

  it("turning it back off clears the key rather than storing a default", () => {
    saveWatch("foo", true);
    expect(localStorage.getItem(WATCH_KEY_PREFIX + "foo")).not.toBeNull();
    saveWatch("foo", false);
    expect(localStorage.getItem(WATCH_KEY_PREFIX + "foo")).toBeNull();
    expect(loadWatch("foo")).toBe(false);
  });

  it("survives a storage that throws (private mode) by falling back to driving", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(loadWatch("foo")).toBe(false);
    spy.mockRestore();

    const setSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => saveWatch("foo", true)).not.toThrow();
    setSpy.mockRestore();
  });

  it("only an exact stored marker means watch — junk reads as driving", () => {
    for (const junk of ["", "false", "0", "yes", "RO", "null"]) {
      localStorage.setItem(WATCH_KEY_PREFIX + "foo", junk);
      expect(loadWatch("foo")).toBe(false);
    }
  });

  /**
   * The key is per-session and per-device by construction: it lives in
   * localStorage (never synced to the server) and carries the session name. A
   * phone watching `main` must not make the desktop's `main` read-only, and the
   * server holds no watch state at all — it only ever answers the request an
   * individual attach makes.
   */
  it("is namespaced per session under a versioned prefix", () => {
    saveWatch("main", true);
    expect(Object.keys(localStorage)).toEqual([WATCH_KEY_PREFIX + "main"]);
    expect(WATCH_KEY_PREFIX).toMatch(/^tl:.*:v\d+:$/);
  });
});
