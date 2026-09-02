import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createNotificationSystem } from "../src/notify/notifications";
import type { TitleSession } from "../src/notify/title";

/**
 * The iOS cold-launch landing.
 *
 * A killed PWA fires no notificationclick, so the tapped session reaches the app
 * only as the record sw.js wrote at push time. The boot handler used to defer to
 * any selection the URL already carried — which sounded careful, and was the bug:
 * an installed PWA does not reliably come back on start_url. iOS restores it at
 * the URL it was last showing, so the tap was discarded and the user landed back
 * where they already were.
 */
const tracked = vi.hoisted(() => ({ events: [] as { name: string; attrs?: Record<string, unknown> }[] }));
vi.mock("../src/telemetry/track", () => ({
  track: (name: string, attrs?: Record<string, unknown>) => {
    tracked.events.push({ name, attrs });
  },
}));

vi.mock("../src/notify/favicon", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/notify/favicon")>();
  return { ...actual, createFaviconBadger: () => ({ apply: () => {} }) };
});

/** Just enough IndexedDB for readAndClearPendingSession. */
function fakeIDB(record: unknown) {
  let stored = record;
  return {
    open: () => {
      const req: Record<string, unknown> = {};
      const get: Record<string, unknown> = {};
      const store = {
        get: () => {
          get.result = stored;
          queueMicrotask(() => (get.onsuccess as (() => void) | undefined)?.());
          return get;
        },
        delete: () => {
          stored = undefined;
        },
        put: () => {},
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
}

beforeEach(() => {
  localStorage.clear();
  tracked.events.length = 0;
});
afterEach(() => {
  localStorage.clear();
  Reflect.deleteProperty(globalThis as object, "indexedDB");
});

/** Boot the app as if iOS had just cold-launched it at `restoredAt`. */
async function coldLaunch(opts: { stash: unknown; restoredAt: string | null }) {
  Object.defineProperty(globalThis, "indexedDB", {
    value: fakeIDB(opts.stash),
    configurable: true,
    writable: true,
  });
  const activated: string[] = [];
  const [sessions] = createSignal<TitleSession[]>([]);
  const [selected] = createSignal<string | null>(opts.restoredAt);
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
      onActivateSession: (n) => activated.push(n),
    });
  });
  await new Promise((r) => setTimeout(r, 60));
  dispose();
  return activated;
}

const fresh = (session: string) => ({ session, ts: Date.now(), tapped: false });

describe("cold-launch landing", () => {
  it("THE BUG: lands on the notified session even when iOS restored another one", async () => {
    const activated = await coldLaunch({ stash: fresh("issues"), restoredAt: "trip-casia" });
    expect(activated).toEqual(["issues"]);
  });

  it("lands on it from a bare start_url too", async () => {
    const activated = await coldLaunch({ stash: fresh("issues"), restoredAt: null });
    expect(activated).toEqual(["issues"]);
  });

  it("does nothing when the app is already on the notified session", async () => {
    const activated = await coldLaunch({ stash: fresh("issues"), restoredAt: "issues" });
    expect(activated).toEqual([]);
  });

  it("ignores a stash too old to be a tap", async () => {
    const stale = { session: "issues", ts: Date.now() - 31 * 60 * 1000, tapped: false };
    const activated = await coldLaunch({ stash: stale, restoredAt: "trip-casia" });
    expect(activated).toEqual([]);
  });

  it("ignores a malformed session name", async () => {
    const bad = { session: "not a valid name", ts: Date.now(), tapped: false };
    const activated = await coldLaunch({ stash: bad, restoredAt: null });
    expect(activated).toEqual([]);
  });

  it("does nothing when there is no stash at all — a plain icon launch", async () => {
    const activated = await coldLaunch({ stash: undefined, restoredAt: "trip-casia" });
    expect(activated).toEqual([]);
  });
});

/**
 * Whether the tap routed used to be invisible, which is why four fixes in a row
 * were guesses: a rejected stash and no stash at all looked identical from the
 * journal. Each branch now says which it was, so the next iOS report is
 * answerable without a device to drive.
 */
describe("cold-launch landing — reports what it decided", () => {
  const reasons = () =>
    tracked.events.filter((e) => e.name === "notify.stash_read").map((e) => e.attrs?.["tl.reason"]);

  it("acted", async () => {
    await coldLaunch({ stash: fresh("issues"), restoredAt: "trip-casia" });
    expect(reasons()).toEqual(["acted"]);
    expect(tracked.events.some((e) => e.name === "notify.clicked")).toBe(true);
  });

  it("absent — a plain icon launch, or a write that never landed", async () => {
    await coldLaunch({ stash: undefined, restoredAt: "trip-casia" });
    expect(reasons()).toEqual(["absent"]);
  });

  it("stale — the age gate threw the tap away", async () => {
    const old = { session: "issues", ts: Date.now() - 31 * 60 * 1000, tapped: false };
    await coldLaunch({ stash: old, restoredAt: "trip-casia" });
    expect(reasons()).toEqual(["stale"]);
  });

  it("already — nothing to do", async () => {
    await coldLaunch({ stash: fresh("issues"), restoredAt: "issues" });
    expect(reasons()).toEqual(["already"]);
  });
});
