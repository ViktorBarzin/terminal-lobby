import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  FLOW_KILL_KEY,
  clearLocalData,
  flowControlWanted,
  setFlowControlEnabled,
} from "../src/store/device-prefs";

beforeEach(() => localStorage.clear());

/**
 * Flow control is a PER-BROWSER kill switch, not a roamed pref: the same
 * posture the vanilla page gave it, and the terminal iframe picks a flip up
 * live through a `storage` event (another window wrote the key), releasing a
 * paused stream immediately.
 */
describe("flow control — the per-browser kill switch", () => {
  it("is on when the key is unset", () => {
    expect(flowControlWanted()).toBe(true);
  });

  it("is off only for the literal 'off'", () => {
    setFlowControlEnabled(false);
    expect(localStorage.getItem(FLOW_KILL_KEY)).toBe("off");
    expect(flowControlWanted()).toBe(false);
  });

  it("re-enabling REMOVES the key rather than writing a truthy value", () => {
    // The terminal page tests `!== 'off'`, so any leftover value reads as on —
    // but leaving one behind would make the doc lie about what is stored.
    setFlowControlEnabled(false);
    setFlowControlEnabled(true);
    expect(localStorage.getItem(FLOW_KILL_KEY)).toBeNull();
    expect(flowControlWanted()).toBe(true);
  });

  it("treats anything else as on, matching the terminal page's test", () => {
    localStorage.setItem(FLOW_KILL_KEY, "yes");
    expect(flowControlWanted()).toBe(true);
  });
});

/**
 * Clear local data wipes THIS browser's terminal-lobby keys. It must take the
 * whole family and nothing else — someone else's key sharing the origin is not
 * ours to delete.
 */
describe("clearLocalData", () => {
  const seed = () => {
    localStorage.setItem("tl:prefs:v1", "{}");
    localStorage.setItem("tl:keybindings:v1", "{}");
    localStorage.setItem("tl-font-size", "14");
    localStorage.setItem("tl-diagnostics", "off");
    localStorage.setItem("tmux-theme", "carbon");
    localStorage.setItem("tmux-sidebar-collapsed", "1");
    localStorage.setItem("unrelated-app-key", "keep me");
    localStorage.setItem("somethingelse", "keep me too");
  };

  it("removes every tl: / tl- / tmux- key and nothing else", async () => {
    seed();
    const reload = vi.fn();
    await clearLocalData({ alsoRoamed: false, reload });
    expect(localStorage.getItem("tl:prefs:v1")).toBeNull();
    expect(localStorage.getItem("tl:keybindings:v1")).toBeNull();
    expect(localStorage.getItem("tl-font-size")).toBeNull();
    expect(localStorage.getItem("tl-diagnostics")).toBeNull();
    expect(localStorage.getItem("tmux-theme")).toBeNull();
    expect(localStorage.getItem("tmux-sidebar-collapsed")).toBeNull();
    // not ours
    expect(localStorage.getItem("unrelated-app-key")).toBe("keep me");
    expect(localStorage.getItem("somethingelse")).toBe("keep me too");
    expect(reload).toHaveBeenCalled();
  });

  it("does not touch the server unless asked", async () => {
    seed();
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    await clearLocalData({ alsoRoamed: false, reload: () => {}, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("PUTs the DEFAULT doc when asked to reset roamed settings too", async () => {
    seed();
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    await clearLocalData({ alsoRoamed: true, reload: () => {}, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toContain("/prefs");
    expect(init.method).toBe("PUT");
    const body = JSON.parse(String(init.body));
    // The defaults, not an empty object: a bare {} would leave the server doc
    // with no keys at all, and the next device to adopt it would see nothing.
    expect(body.fontSize).toBeDefined();
    expect(body.cursorStyle).toBe("block");
    expect(body.gestures.wheelSmooth).toBe(true);
  });

  it("still clears this browser when the server reset fails", async () => {
    seed();
    const reload = vi.fn();
    const onError = vi.fn();
    await clearLocalData({
      alsoRoamed: true,
      reload,
      onError,
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    expect(onError).toHaveBeenCalled();
    expect(localStorage.getItem("tl:prefs:v1")).toBeNull();
    expect(reload).toHaveBeenCalled();
  });
});
