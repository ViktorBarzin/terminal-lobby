import { describe, it, expect, beforeEach, onTestFinished, vi } from "vitest";
import {
  FLOW_KILL_KEY,
  GESTURES_KILL_KEY,
  clearLocalData,
  flowControlWanted,
  gesturesEnabled,
  setFlowControlEnabled,
} from "../src/store/device-prefs";
import { closeSharedTranscriptDb, sharedIndexedDbBackend } from "../src/store/transcript-cache";

beforeEach(() => localStorage.clear());

/**
 * Flow control is a PER-BROWSER kill switch, not a roamed pref: the same
 * posture the vanilla page gave it. It exists to rescue a wedged stream on the
 * machine that is wedged, so roaming it would carry a local rescue everywhere.
 *
 * These tests cover the key and its read. Nothing in the native terminal
 * consumes the answer yet — flow-control accounting is one of the things
 * SessionView lists as having gone with term.html on 2026-09-05 — so a flip
 * currently changes what this function returns and nothing else.
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

  /**
   * A fake indexedDB whose deletes never complete on their own. jsdom has no
   * IndexedDB at all, so the stub is also what makes the sweep reachable here.
   */
  const fakeIDB = (behaviour: "blocked" | "abort" | "success" | "throw") => {
    const asked: string[] = [];
    const idb = {
      deleteDatabase(name: string) {
        asked.push(name);
        if (behaviour === "throw") throw new DOMException("denied");
        const req = new EventTarget() as EventTarget & { result: unknown };
        if (behaviour !== "blocked") {
          queueMicrotask(() => req.dispatchEvent(new Event(behaviour)));
        }
        return req;
      },
    };
    const prev = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    Object.defineProperty(globalThis, "indexedDB", { value: idb, configurable: true });
    onTestFinished(() => {
      if (prev) Object.defineProperty(globalThis, "indexedDB", prev);
      else delete (globalThis as { indexedDB?: unknown }).indexedDB;
    });
    return asked;
  };

  it("deletes the four databases this app owns", async () => {
    const asked = fakeIDB("success");
    const reload = vi.fn();
    await clearLocalData({ alsoRoamed: false, reload, idbTimeoutMs: 50 });
    expect(asked.sort()).toEqual([
      "tl-badge",
      "tl-device",
      "tl-notif",
      "tl-transcripts",
    ]);
    expect(reload).toHaveBeenCalled();
  });

  /**
   * The one that matters. `deleteDatabase` fires `blocked` and then sits there
   * for as long as another context holds the database open, and two of the
   * four ARE held open: tl-transcripts by a module-level memo in
   * transcript-cache, tl-notif by the service worker. A sweep that waits for
   * those never reloads, and the user is left staring at a dead button.
   */
  it("still reloads when every delete blocks", async () => {
    fakeIDB("blocked");
    const reload = vi.fn();
    await clearLocalData({ alsoRoamed: false, reload, idbTimeoutMs: 20 });
    expect(reload).toHaveBeenCalled();
  });

  // A transaction can abort WITHOUT ever firing error. No `abort` listener and
  // the promise stays pending for the whole timeout, or forever if the timeout
  // were dropped.
  it("still reloads when a delete aborts without an error", async () => {
    fakeIDB("abort");
    const reload = vi.fn();
    const started = Date.now();
    await clearLocalData({ alsoRoamed: false, reload, idbTimeoutMs: 5_000 });
    expect(reload).toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("still clears the rest when indexedDB itself refuses", async () => {
    seed();
    fakeIDB("throw");
    const reload = vi.fn();
    await clearLocalData({ alsoRoamed: false, reload, idbTimeoutMs: 20 });
    expect(localStorage.getItem("tl:prefs:v1")).toBeNull();
    expect(reload).toHaveBeenCalled();
  });

  it("does not fall over on a browser with no indexedDB at all", async () => {
    const reload = vi.fn();
    await clearLocalData({ alsoRoamed: false, reload, idbTimeoutMs: 20 });
    expect(reload).toHaveBeenCalled();
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

/**
 * The confirm text names "cached session transcripts", and `tl-transcripts` is
 * the one database the page itself holds open: transcript-cache memoises an
 * IDBDatabase for the life of the tab, so the delete would fire `blocked`,
 * degrade to a no-op, and reload with every transcript still on disk. The
 * service worker's `tl-notif` is genuinely another execution context and stays
 * on the blocked path; this one is ours to close.
 */
describe("clearLocalData closes the transcript handle it can close", () => {
  /** Enough of IndexedDB for transcript-cache to open a database and read from
   *  it, recording the order of `close` against each `deleteDatabase`. */
  const fakeIDBWithOpen = () => {
    const order: string[] = [];
    const req = <T>(result: T): IDBRequest<T> => {
      const r = { onsuccess: null, onerror: null, result } as unknown as IDBRequest<T> & {
        onsuccess: (() => void) | null;
      };
      queueMicrotask(() => r.onsuccess?.(new Event("success") as never));
      return r;
    };
    const store = {
      get: () => req(undefined),
      put: () => req(undefined),
      delete: () => req(undefined),
      getAll: () => req([]),
    };
    const database = {
      objectStoreNames: { contains: () => true },
      createObjectStore: () => store,
      transaction: () => ({ objectStore: () => store, onabort: null, error: null }),
      close: () => order.push("close"),
    };
    const idb = {
      open() {
        const r = {
          onsuccess: null,
          onerror: null,
          onblocked: null,
          onupgradeneeded: null,
          result: database,
        } as unknown as IDBOpenDBRequest & { onsuccess: (() => void) | null };
        queueMicrotask(() => r.onsuccess?.(new Event("success") as never));
        return r;
      },
      deleteDatabase(name: string) {
        order.push(`delete:${name}`);
        const r = new EventTarget();
        queueMicrotask(() => r.dispatchEvent(new Event("success")));
        return r;
      },
    };
    const prev = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    Object.defineProperty(globalThis, "indexedDB", { value: idb, configurable: true });
    onTestFinished(() => {
      if (prev) Object.defineProperty(globalThis, "indexedDB", prev);
      else delete (globalThis as { indexedDB?: unknown }).indexedDB;
    });
    return order;
  };

  it("closes the memoised handle BEFORE deleting tl-transcripts", async () => {
    const order = fakeIDBWithOpen();
    const backend = sharedIndexedDbBackend();
    expect(backend).not.toBeNull();
    await backend?.read("some-session"); // forces the open the wipe has to undo

    await clearLocalData({ alsoRoamed: false, reload: () => {}, idbTimeoutMs: 20 });

    expect(order.indexOf("close")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("close")).toBeLessThan(order.indexOf("delete:tl-transcripts"));
  });

  it("reopens on the next read, so a wipe does not leave the cache dead", async () => {
    fakeIDBWithOpen();
    const backend = sharedIndexedDbBackend();
    await backend?.read("s");
    await closeSharedTranscriptDb();
    await expect(backend?.read("s")).resolves.toBeNull();
  });
});
