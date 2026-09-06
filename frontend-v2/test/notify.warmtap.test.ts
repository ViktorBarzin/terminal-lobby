import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createNotificationSystem } from "../src/notify/notifications";
import type { TitleSession } from "../src/notify/title";

/**
 * The WARM tap, and what it has to leave behind.
 *
 * sw.js writes a record at push time (the receipt) and posts `tl-activate-session`
 * when a lobby window is open to take the tap. The page switched to the session
 * and then consumed the LEGACY `last` key alone, so the per-session record the
 * store is actually keyed by survived. The next return to the foreground read it,
 * decided it was a tap, and pulled the reader off whatever they had moved to.
 *
 * The store has been one record per session since 2026-09-02 (a17306e); `last` is
 * a mirror of one of them, not the record.
 */
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

interface Stashed {
  session: string;
  ts: number;
  tapped?: boolean;
}

/** The 'pending' store: one row per session, plus the legacy `last` mirror. */
function makeStash(records: readonly Stashed[]) {
  const rows = new Map<string, unknown>();
  for (const r of records) rows.set(r.session, r);
  if (records.length > 0) rows.set("last", records[records.length - 1]);

  const idb = {
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
  };
  return { idb, kept: () => [...rows.keys()].sort() };
}

/** A service worker that can post a message at the page, like a tap does. */
function stubServiceWorker() {
  const target = new EventTarget();
  Object.defineProperty(navigator, "serviceWorker", {
    value: {
      register: async () => ({}) as ServiceWorkerRegistration,
      // No getNotifications: the shade is unreadable, which is the honest
      // default on a browser that answers a tap with a postMessage.
      getRegistration: async () => undefined,
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      dispatchEvent: target.dispatchEvent.bind(target),
    },
    configurable: true,
    writable: true,
  });
  return (session: string) => {
    const ch = new MessageChannel();
    target.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "tl-activate-session", session },
        ports: [ch.port2],
      }),
    );
  };
}

const useStash = (stash: { idb: unknown }): void => {
  Object.defineProperty(globalThis, "indexedDB", {
    value: stash.idb,
    configurable: true,
    writable: true,
  });
};

beforeEach(() => {
  localStorage.clear();
  tracked.events.length = 0;
});
afterEach(() => {
  localStorage.clear();
  Reflect.deleteProperty(globalThis as object, "indexedDB");
  Reflect.deleteProperty(navigator as object, "serviceWorker");
});

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

/**
 * Boot with nothing waiting, take a warm tap, walk somewhere else, come back.
 * `tapped` is what sw.js recorded: false is the push-time receipt on its own,
 * true is the receipt plus a click it managed to record.
 */
async function warmTapThenReturn(tapped: boolean): Promise<{
  activated: string[];
  kept: string[];
  reasons: unknown[];
}> {
  const empty = makeStash([]);
  useStash(empty);
  const postTap = stubServiceWorker();

  const activated: string[] = [];
  const [sessions] = createSignal<TitleSession[]>([]);
  const [selected, setSelected] = createSignal<string | null>("trip-casia");
  let dispose!: () => void;
  createRoot((d) => {
    dispose = d;
    createNotificationSystem({
      sessions,
      selected,
      osUser: () => "wizard",
      notifyPrefs: () => ({ onDone: true, onAwaiting: true }),
      loading: () => false,
      polls: () => 1,
      toast: () => {},
      onActivateSession: (n) => {
        activated.push(n);
        setSelected(n);
      },
    });
  });
  await tick(40);

  // A push lands while the app is in the background: sw.js writes the record.
  const stash = makeStash([{ session: "issues", ts: Date.now(), tapped }]);
  useStash(stash);

  // The tap: a lobby window was open, so the worker posts the switch.
  postTap("issues");
  await tick();

  // The reader answers the notification and then moves on by hand.
  setSelected("cache-omages");

  // Back to the app later. Nothing should follow them here.
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
  await tick();
  dispose();

  return {
    activated,
    kept: stash.kept(),
    reasons: tracked.events
      .filter((e) => e.name === "notify.stash_read")
      .map((e) => e.attrs?.["tl.reason"]),
  };
}

describe("a warm tap consumes the record it acted on", () => {
  for (const tapped of [false, true]) {
    it(`THE BUG: does not route a second time on the next wake (tapped: ${tapped})`, async () => {
      const out = await warmTapThenReturn(tapped);
      expect(out.activated).toEqual(["issues"]);
      // The row and its legacy mirror are both gone, so the wake found nothing
      // and said nothing.
      expect(out.kept).toEqual([]);
      expect(out.reasons).toEqual(["absent"]); // boot only, before the push landed
    });
  }
});
