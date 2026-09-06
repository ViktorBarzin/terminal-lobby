import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import type { TitleSession } from "../src/notify/title";

/**
 * A tab acting as someone else takes NEITHER tap handoff, and leaves the stash
 * UNREAD rather than clearing it.
 *
 * Push subscriptions deliberately resolve the real caller (pwa/push.ts spells
 * its paths out rather than going through apiUrl), so every notification on this
 * browser names one of YOUR sessions. Opening your session name inside a lens
 * would open it under THEIR identity. Your own tab is still there to take the
 * tap, which is why the record has to survive this one.
 *
 * `?as=` is read once at module load by config.ts, so the switched tab is set up
 * by mocking that constant for the whole file.
 */
vi.mock("../src/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/config")>();
  return { ...actual, ACT_AS: "bob" };
});

const tracked = vi.hoisted(() => ({
  events: [] as { name: string; attrs?: Record<string, unknown> }[],
}));
vi.mock("../src/telemetry/track", () => ({
  track: (name: string, attrs?: Record<string, unknown>) => {
    tracked.events.push({ name, attrs });
  },
}));

vi.mock("../src/notify/favicon", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/notify/favicon")>();
  return { ...actual, createFaviconBadger: () => ({ apply: () => {} }) };
});

const { createNotificationSystem } = await import("../src/notify/notifications");

/** One fresh receipt waiting, the way sw.js leaves it at push time. */
function makeStash() {
  const rows = new Map<string, unknown>([
    ["issues", { session: "issues", ts: Date.now(), tapped: false }],
  ]);
  rows.set("last", rows.get("issues"));
  return {
    idb: {
      open: () => {
        const req: Record<string, unknown> = {};
        const store = {
          get: (k: string) => {
            const g: Record<string, unknown> = { result: rows.get(k) };
            queueMicrotask(() => (g.onsuccess as (() => void) | undefined)?.());
            return g;
          },
          getAll: () => ({ result: [...new Set(rows.values())] }) as Record<string, unknown>,
          put: (v: unknown, k: string) => rows.set(k, v),
          delete: (k: string) => rows.delete(k),
        };
        const tx: Record<string, unknown> = { objectStore: () => store };
        req.result = { transaction: () => tx, close: () => {}, createObjectStore: () => {} };
        setTimeout(() => {
          (req.onsuccess as (() => void) | undefined)?.();
          setTimeout(() => (tx.oncomplete as (() => void) | undefined)?.(), 0);
        }, 0);
        return req;
      },
    },
    kept: () => [...rows.keys()].sort(),
  };
}

beforeEach(() => {
  localStorage.clear();
  tracked.events.length = 0;
});
/** Enough of navigator.serviceWorker for registerServiceWorker to listen on. */
function stubServiceWorker() {
  const target = new EventTarget();
  const sw = {
    register: vi.fn(async () => ({}) as ServiceWorkerRegistration),
    getRegistration: vi.fn(async () => undefined),
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  };
  Object.defineProperty(navigator, "serviceWorker", {
    value: sw,
    configurable: true,
    writable: true,
  });
  return sw;
}

afterEach(() => {
  localStorage.clear();
  Reflect.deleteProperty(globalThis as object, "indexedDB");
  Reflect.deleteProperty(navigator as object, "serviceWorker");
});

describe("a lens tab and the tap stash", () => {
  it("neither routes nor clears it, at boot or on any wake", async () => {
    const stash = makeStash();
    Object.defineProperty(globalThis, "indexedDB", {
      value: stash.idb,
      configurable: true,
      writable: true,
    });
    const activated: string[] = [];
    const [sessions] = createSignal<TitleSession[]>([]);
    const [selected] = createSignal<string | null>("trip-casia");
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      createNotificationSystem({
        sessions,
        selected,
        osUser: () => "bob",
        notifyPrefs: () => ({ onDone: true, onAwaiting: true }),
        loading: () => false,
        polls: () => 1,
        toast: () => {},
        onActivateSession: (n) => activated.push(n),
      });
    });
    await new Promise((r) => setTimeout(r, 40));

    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("pageshow"));
    await new Promise((r) => setTimeout(r, 60));
    dispose();

    expect(activated).toEqual([]);
    expect(stash.kept()).toEqual(["issues", "last"]);
    expect(tracked.events.filter((e) => e.name === "notify.stash_read")).toEqual([]);
  });

  /**
   * The WARM handoff, which the wake tests above never exercised.
   *
   * sw.js posts the switch to window clients sorted focused-first and stops at
   * the first one that answers, so a focused lens is routinely the one it asks.
   * Answering there would end the fan-out at a window that cannot act, and the
   * clear that followed took the record the reader's own window was going to
   * route on. Silence is what sends the worker to the next candidate.
   */
  it("does not answer the worker's switch, and leaves the record for a real tab", async () => {
    const stash = makeStash();
    Object.defineProperty(globalThis, "indexedDB", {
      value: stash.idb,
      configurable: true,
      writable: true,
    });
    const sw = stubServiceWorker();
    const activated: string[] = [];
    const [sessions] = createSignal<TitleSession[]>([]);
    const [selected] = createSignal<string | null>("trip-casia");
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      createNotificationSystem({
        sessions,
        selected,
        osUser: () => "bob",
        notifyPrefs: () => ({ onDone: true, onAwaiting: true }),
        loading: () => false,
        polls: () => 1,
        toast: () => {},
        onActivateSession: (n) => activated.push(n),
      });
    });
    await new Promise((r) => setTimeout(r, 40));

    const ch = new MessageChannel();
    let ack: unknown = null;
    ch.port1.onmessage = (e) => (ack = e.data);
    sw.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "tl-activate-session", session: "issues" },
        ports: [ch.port2],
      }),
    );
    await new Promise((r) => setTimeout(r, 60));
    dispose();

    expect(activated).toEqual([]);
    expect(ack).toBeNull();
    expect(stash.kept()).toEqual(["issues", "last"]);
  });
});
