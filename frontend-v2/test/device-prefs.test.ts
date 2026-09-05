import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  FLOW_KILL_KEY,
  GESTURES_KILL_KEY,
  clearLocalData,
  flowControlWanted,
  gesturesEnabled,
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

  it("treats anything else as on, matching the page's own test", () => {
    localStorage.setItem(FLOW_KILL_KEY, "yes");
    expect(flowControlWanted()).toBe(true);
  });
});

/**
 * The gestures master kill, which `terminal/wheel.ts` needs as half of its
 * `SmoothGates` and which nothing in frontend-v2 read before.
 *
 * Its whole job is to work when other things do not: a person sets it by hand
 * to stop a misbehaving gesture on the device it is misbehaving on, with no
 * redeploy and no working prefs machinery. So the tests here are about the
 * awkward inputs, not the happy one.
 */
describe("the gestures master kill", () => {
  it("is spelled the way a person types it", () => {
    // Nothing writes this key: it is set by hand on a device whose gestures are
    // misbehaving, so the literal IS the interface. A rename here would leave
    // every written-down instruction pointing at a key nobody reads.
    //
    // It used to be checked against frontend/term.html's own copy of the reader
    // as well, because both documents read the same key off the same origin.
    // There is one document now, and this is its only reader.
    expect(GESTURES_KILL_KEY).toBe("tl-gestures");
  });

  it("is on when the key is unset", () => {
    expect(gesturesEnabled()).toBe(true);
  });

  it("is off only for the literal 'off'", () => {
    localStorage.setItem(GESTURES_KILL_KEY, "off");
    expect(gesturesEnabled()).toBe(false);
  });

  it("treats anything else as on, matching the terminal page's test", () => {
    for (const v of ["", "on", "OFF", "false", "0", "no"]) {
      localStorage.setItem(GESTURES_KILL_KEY, v);
      expect(gesturesEnabled(), v).toBe(true);
    }
  });

  it("answers ON when storage throws, rather than losing every gesture", () => {
    // A locked-down browser must not be a browser with no gestures. This is the
    // vanilla `catch` answer, and getting it backwards would disable touch
    // scrolling on the devices least able to report it.
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    try {
      expect(gesturesEnabled()).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("re-reads on every call, so a flip needs no reload", () => {
    // terminal/wheel.ts asks for `smoothOn` on every wheel, so the next wheel
    // after a flip already behaves differently. A cached read here would hold
    // the old answer for the life of the page.
    expect(gesturesEnabled()).toBe(true);
    localStorage.setItem(GESTURES_KILL_KEY, "off");
    expect(gesturesEnabled()).toBe(false);
    localStorage.removeItem(GESTURES_KILL_KEY);
    expect(gesturesEnabled()).toBe(true);
  });

  it("is wiped by clear-local-data, being a tl- key like the rest", async () => {
    localStorage.setItem(GESTURES_KILL_KEY, "off");
    await clearLocalData({ alsoRoamed: false, reload: () => {} });
    expect(localStorage.getItem(GESTURES_KILL_KEY)).toBeNull();
    expect(gesturesEnabled()).toBe(true);
  });
});

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
