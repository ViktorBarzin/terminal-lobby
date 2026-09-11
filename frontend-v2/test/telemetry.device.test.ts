import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from "vitest";

import {
  DEVICE_ATTR,
  DEVICE_DB,
  DEVICE_ID_KEY,
  DEVICE_ID_RECORD,
  DEVICE_STORE,
  deviceId,
  mirrorDeviceId,
} from "../src/telemetry/device";

/**
 * A fresh copy of the module, with its memo unset.
 *
 * `deviceId()` memoises, which is the whole point of it: a browser that refuses
 * storage must still answer the same id for the life of the page instead of
 * inventing one per event. That memo makes "what happens on the next load"
 * untestable from a single import, so the reload cases re-import.
 */
async function freshModule(): Promise<typeof import("../src/telemetry/device")> {
  vi.resetModules();
  return await import("../src/telemetry/device");
}

describe("deviceId", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("mints a 32-hex id and writes it to localStorage", () => {
    const id = deviceId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(localStorage.getItem(DEVICE_ID_KEY)).toBe(id);
  });

  // The id is what makes "this phone wrote the stash and this phone read it"
  // answerable. If it changed per load, every correlation would be one event
  // long, which is the state that made six notification fixes guesses.
  it("survives a reload", async () => {
    const first = (await freshModule()).deviceId();
    const second = (await freshModule()).deviceId();
    expect(second).toBe(first);
  });

  it("is stable across calls within a page life", () => {
    expect(deviceId()).toBe(deviceId());
  });

  /**
   * Anything not in the minted shape is replaced rather than trusted. A value
   * that arrived some other way (a hand-edited store, a future format, a half
   * write) would otherwise travel on every event as though this module had
   * produced it.
   */
  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["too short", "abc123"],
    ["not hex", "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"],
    ["uppercase", "ABCDEF01234567890ABCDEF012345678"],
    ["an email", "viktor@example.com"],
    ["over-long", "0".repeat(64)],
  ])("replaces a stored value that is %s", async (_label, stored) => {
    localStorage.setItem(DEVICE_ID_KEY, stored);
    const id = (await freshModule()).deviceId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id).not.toBe(stored);
    expect(localStorage.getItem(DEVICE_ID_KEY)).toBe(id);
  });

  it("keeps a well-formed stored id exactly as it is", async () => {
    const stored = "0123456789abcdef0123456789abcdef";
    localStorage.setItem(DEVICE_ID_KEY, stored);
    expect((await freshModule()).deviceId()).toBe(stored);
  });

  // Two installations must not collide: the id addresses a device, and a shared
  // one would merge two devices into one series.
  it("mints a different id per installation", async () => {
    const a = (await freshModule()).deviceId();
    localStorage.clear();
    const b = (await freshModule()).deviceId();
    expect(b).not.toBe(a);
  });

  /**
   * Safari with cookies blocked throws on the `localStorage` getter itself, so
   * the failure has to be caught rather than tested for. lib/storage.ts already
   * owns that; this pins that the module degrades to a page-life id instead of
   * throwing on boot or minting one per event.
   */
  it("still answers a stable id when storage refuses", async () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("SecurityError");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("SecurityError");
    });
    onTestFinished(() => {
      get.mockRestore();
      set.mockRestore();
    });
    const mod = await freshModule();
    const id = mod.deviceId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(mod.deviceId()).toBe(id);
  });

  it("names the attribute in the tl.* namespace", () => {
    expect(DEVICE_ATTR).toBe("tl.device");
  });
});

/** One `put` the fake recorded. */
interface Written {
  db: string;
  store: string;
  key: string;
  value: unknown;
}

interface FakeIDBOptions {
  /** How the write transaction ends. `abort` is the one with no preceding error. */
  tx?: "complete" | "error" | "abort";
  /** The open request fires `error` instead of `success`. */
  openFails?: boolean;
  /** `indexedDB.open` throws synchronously (a blocked store). */
  openThrows?: boolean;
  /** `transaction()` throws, e.g. the store is missing. */
  txThrows?: boolean;
}

/**
 * Enough of IndexedDB for one open-and-put. jsdom ships none at all, so a fake
 * is the only way to exercise the write, and hand-rolling it is what lets the
 * abort path be driven — a real store aborts only under storage pressure.
 */
function installFakeIDB(opts: FakeIDBOptions = {}): { written: Written[]; opened: string[] } {
  const written: Written[] = [];
  const opened: string[] = [];

  interface OpenRequest {
    result: unknown;
    onupgradeneeded: (() => void) | null;
    onsuccess: (() => void) | null;
    onerror: (() => void) | null;
  }

  const fake = {
    open(name: string): OpenRequest {
      opened.push(name);
      if (opts.openThrows) throw new DOMException("SecurityError");
      const req: OpenRequest = {
        result: undefined,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
      };
      queueMicrotask(() => {
        if (opts.openFails) {
          req.onerror?.();
          return;
        }
        const db = {
          createObjectStore: (): unknown => ({}),
          close: (): void => {},
          transaction: (store: string) => {
            if (opts.txThrows) throw new DOMException("NotFoundError");
            const tx: {
              oncomplete: (() => void) | null;
              onerror: (() => void) | null;
              onabort: (() => void) | null;
              objectStore: () => { put: (value: unknown, key: string) => void };
            } = {
              oncomplete: null,
              onerror: null,
              onabort: null,
              objectStore: () => ({
                put: (value: unknown, key: string) => {
                  written.push({ db: name, store, key, value });
                },
              }),
            };
            queueMicrotask(() => {
              const end = opts.tx ?? "complete";
              if (end === "complete") tx.oncomplete?.();
              else if (end === "error") tx.onerror?.();
              else tx.onabort?.();
            });
            return tx;
          },
        };
        req.result = db;
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };

  const prev = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", { value: fake, configurable: true });
  onTestFinished(() => {
    if (prev) Object.defineProperty(globalThis, "indexedDB", prev);
    else delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });
  return { written, opened };
}

/**
 * The mirror exists because a service worker cannot read localStorage, and the
 * worker is the only context that sees a notification tap on the cold path. The
 * page writes the id here; sw.js reads it and stamps it on its own events, so a
 * stash written by one device and read by the same device can be joined.
 */
describe("mirrorDeviceId", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the id where the worker looks for it", async () => {
    const { written, opened } = installFakeIDB();
    await mirrorDeviceId("0123456789abcdef0123456789abcdef");
    expect(opened).toEqual([DEVICE_DB]);
    expect(written).toEqual([
      {
        db: DEVICE_DB,
        store: DEVICE_STORE,
        key: DEVICE_ID_RECORD,
        value: "0123456789abcdef0123456789abcdef",
      },
    ]);
  });

  it("mirrors this device's own id when called with no argument", async () => {
    const { written } = installFakeIDB();
    await mirrorDeviceId();
    expect(written[0]?.value).toBe(deviceId());
  });

  it("uses a database of its own, never the worker's tl-notif", async () => {
    // tl-notif is opened at version 1 by sw.js. Adding a store there would need
    // a version bump, and the worker's open at v1 would then fail outright,
    // taking the tap stash with it. A separate database has no such coupling.
    const { opened } = installFakeIDB();
    await mirrorDeviceId("0123456789abcdef0123456789abcdef");
    expect(opened).not.toContain("tl-notif");
  });

  /**
   * Every one of these has to resolve. Boot awaits nothing on this write today,
   * but a promise that can hang is a promise that will be awaited by someone
   * eventually, and an IndexedDB transaction can fire `abort` with no preceding
   * `error` at all.
   */
  it.each([
    ["the transaction completes", { tx: "complete" as const }],
    ["the transaction errors", { tx: "error" as const }],
    ["the transaction aborts with no error first", { tx: "abort" as const }],
    ["the open request fails", { openFails: true }],
    ["open throws synchronously", { openThrows: true }],
    ["transaction() throws", { txThrows: true }],
  ])("resolves when %s", async (_label, opts: FakeIDBOptions) => {
    installFakeIDB(opts);
    await expect(mirrorDeviceId("0123456789abcdef0123456789abcdef")).resolves.toBeUndefined();
  });

  it("resolves on a browser with no indexedDB at all", async () => {
    const prev = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    onTestFinished(() => {
      if (prev) Object.defineProperty(globalThis, "indexedDB", prev);
    });
    await expect(mirrorDeviceId("0123456789abcdef0123456789abcdef")).resolves.toBeUndefined();
  });
});
