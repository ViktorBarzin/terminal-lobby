import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_TERMINAL_RENDERER,
  FLOW_KILL_KEY,
  GESTURES_KILL_KEY,
  TERMINAL_RENDERER_KEY,
  clearLocalData,
  flowControlWanted,
  gesturesEnabled,
  setFlowControlEnabled,
  setTerminalRenderer,
  terminalRenderer,
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
 * The gestures master kill, which `terminal/wheel.ts` needs as half of its
 * `SmoothGates` and which nothing in frontend-v2 read before.
 *
 * Its whole job is to work when other things do not: a person sets it by hand
 * to stop a misbehaving gesture on the device it is misbehaving on, with no
 * redeploy and no working prefs machinery. So the tests here are about the
 * awkward inputs, not the happy one.
 */
describe("the gestures master kill", () => {
  it("uses the key the terminal page reads, spelled the same way", () => {
    // Same origin, same key: a flip made for term.html has to reach the native
    // terminal too, and a typo here would be a switch that silently does nothing.
    const term = readFileSync(resolve(__dirname, "../..", "frontend/term.html"), "utf8");
    expect(GESTURES_KILL_KEY).toBe("tl-gestures");
    expect(term).toContain("const GESTURES_KILL_KEY = 'tl-gestures';");
    expect(term).toContain(
      "return localStorage.getItem(GESTURES_KILL_KEY) !== 'off';",
    );
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
    // term.html calls its own reader from inside the wheel handler, so the next
    // wheel after a flip already behaves differently. A cached read here would
    // hold the old answer for the life of the page.
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

/**
 * WHICH TERMINAL this browser renders, which is the escape hatch the flip
 * (2026-09-04) rests on.
 *
 * The reason it is a stored setting and not just a URL flag is
 * `manifest.webmanifest`: `start_url` is `/`, so an app launched from a
 * home-screen icon opens with no query string and `?native=0` cannot reach it.
 * On an installed PWA this key is the only way back to the iframe, so the tests
 * here are about it surviving and about it never guessing.
 */
describe("which terminal this device renders", () => {
  it("has no answer until this browser gives one", () => {
    // null, not "native": the absence is what lets the app's default apply,
    // and a reader that saw "native" here could not tell a choice from a
    // default (SessionView's precedence needs the difference).
    expect(terminalRenderer()).toBeNull();
  });

  it("defaults to the terminal the app renders itself", () => {
    // The flip. This constant IS the default, since SessionView's
    // `wantsNativeTerminal` falls back to it, so flipping back is this line.
    expect(DEFAULT_TERMINAL_RENDERER).toBe("native");
  });

  it.each(["iframe", "native"] as const)("stores %s and reads it back", (choice) => {
    setTerminalRenderer(choice);
    expect(localStorage.getItem(TERMINAL_RENDERER_KEY)).toBe(choice);
    expect(terminalRenderer()).toBe(choice);
  });

  it("writes 'native' out rather than deleting the key", () => {
    // Flow control above means "on" by ABSENCE, because its reader only looks
    // for "off". This one has two real values, and an explicit "native" has to
    // outlive the default moving: someone who chose it should keep it.
    setTerminalRenderer("iframe");
    setTerminalRenderer("native");
    expect(localStorage.getItem(TERMINAL_RENDERER_KEY)).toBe("native");
    expect(terminalRenderer()).toBe("native");
  });

  it("survives the page going away, being plain localStorage", () => {
    setTerminalRenderer("iframe");
    // The read is not cached anywhere: every call goes back to storage, which
    // is what makes a reload, and a PWA cold launch, find the same answer.
    expect(terminalRenderer()).toBe("iframe");
    expect(terminalRenderer()).toBe("iframe");
  });

  it("treats a value it does not understand as no choice at all", () => {
    // A key written by a later version, or by hand. Picking a terminal from a
    // string nobody here can interpret is worse than letting the default stand.
    for (const v of ["", "IFRAME", "ttyd", "1", "true", "xterm"]) {
      localStorage.setItem(TERMINAL_RENDERER_KEY, v);
      expect(terminalRenderer(), v).toBeNull();
    }
  });

  it("answers null when storage throws, rather than throwing at the caller", () => {
    // A browser that refuses storage cannot carry a choice, so it gets the
    // default. SessionView calls this while rendering; an exception escaping
    // here would take the session view with it.
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    try {
      expect(terminalRenderer()).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("swallows a refused write, leaving the default standing", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      expect(() => setTerminalRenderer("iframe")).not.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(terminalRenderer()).toBeNull();
  });

  it("is wiped by clear-local-data, back to the default", async () => {
    // The `tl-` prefix is deliberate: Clear local data covers it, so a device
    // parked on the iframe returns to the default rather than keeping a choice
    // nobody can remember making.
    setTerminalRenderer("iframe");
    await clearLocalData({ alsoRoamed: false, reload: () => {} });
    expect(localStorage.getItem(TERMINAL_RENDERER_KEY)).toBeNull();
    expect(terminalRenderer()).toBeNull();
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
