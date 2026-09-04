import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createNotificationSystem } from "../src/notify/notifications";
import type { TitleSession } from "../src/notify/title";

/**
 * What the app is allowed to THROW AWAY when it comes to the front.
 *
 * The cold-launch handler runs at boot and again on every return to the
 * foreground, and when it cannot identify a tap it prunes. It pruned every
 * record `stashIsActionable` refused, and that predicate refuses two very
 * different things: a receipt past the 15-minute outer window, which is over,
 * and a receipt whose banner is STILL ON SCREEN, which is not over at all. The
 * reader has simply not tapped it yet.
 *
 * So opening the app by its icon, or switching back to it, deleted the record
 * for every notification still sitting in the shade. Tapping one of those
 * banners afterwards found nothing to route on. Measured over 72 hours on the
 * deployed build: of 237 stash reads only 30 routed, and 44 came back `absent`
 * with the record gone — 16 of those had been written less than 15 minutes
 * before, so the window had not expired, something had removed them.
 *
 * Viktor's pattern is what makes this bite. Pushes for one session arrive a
 * median of 956 seconds apart and he answers them minutes later, while the
 * unconditional routing window is 120 seconds. Nearly every real tap lands in
 * the range this prune was clearing.
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

interface Stashed {
  session: string;
  ts: number;
  tapped?: boolean;
}

/**
 * The stash, kept across boots so a second launch sees what the first left
 * behind. Keyed per session, plus the legacy slot sw.js still writes.
 */
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
        getAll: () => {
          const g: Record<string, unknown> = { result: [...new Set(rows.values())] };
          return g;
        },
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
  return {
    idb,
    /** Which sessions still have a record, ignoring the legacy mirror. */
    kept: () => [...rows.keys()].filter((k) => k !== "last").sort(),
  };
}

/** The banners currently in the shade, by session. Mutable between launches. */
function showBanners(sessions: readonly string[]) {
  const open = new Set(sessions);
  Object.defineProperty(globalThis.navigator, "serviceWorker", {
    value: {
      getRegistration: async () => ({
        getNotifications: async ({ tag }: { tag: string }) =>
          open.has(tag.replace(/^tl-/, "")) ? [{ tag }] : [],
      }),
      addEventListener: () => {},
      removeEventListener: () => {},
      register: async () => ({}),
    },
    configurable: true,
  });
  return open;
}

beforeEach(() => {
  localStorage.clear();
  tracked.events.length = 0;
});
afterEach(() => {
  localStorage.clear();
  Reflect.deleteProperty(globalThis as object, "indexedDB");
  Reflect.deleteProperty(globalThis.navigator as object, "serviceWorker");
});

/** Bring the app to the front against an existing stash. */
async function foreground(stash: { idb: unknown }, restoredAt: string | null): Promise<string[]> {
  Object.defineProperty(globalThis, "indexedDB", {
    value: stash.idb,
    configurable: true,
    writable: true,
  });
  const activated: string[] = [];
  const [sessions] = createSignal<TitleSession[]>([]);
  const [selected] = createSignal<string | null>(restoredAt);
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

const minutesAgo = (m: number, session: string): Stashed => ({
  session,
  ts: Date.now() - m * 60 * 1000,
  tapped: false,
});

describe("the foreground prune", () => {
  it("THE BUG: keeps a record whose banner is still on screen, so a later tap lands", async () => {
    const stash = makeStash([minutesAgo(3, "issues")]);
    showBanners(["issues"]);

    // Opening the app by its icon while the banner is still up. Nothing to
    // route on, and nothing to throw away either.
    expect(await foreground(stash, "trip-casia")).toEqual([]);
    expect(stash.kept()).toEqual(["issues"]);

    // Now the banner goes, which on iOS is what a tap looks like after the
    // fact. The record has to still be there for that to mean anything.
    showBanners([]);
    expect(await foreground(stash, "trip-casia")).toEqual(["issues"]);
  });

  it("still forgets a record past the outer window", async () => {
    const stash = makeStash([minutesAgo(31, "issues")]);
    showBanners([]);
    expect(await foreground(stash, "trip-casia")).toEqual([]);
    expect(stash.kept()).toEqual([]);
  });

  it("forgets the expired one and keeps the live one", async () => {
    const stash = makeStash([minutesAgo(31, "old"), minutesAgo(3, "issues")]);
    showBanners(["issues"]);
    expect(await foreground(stash, "trip-casia")).toEqual([]);
    expect(stash.kept()).toEqual(["issues"]);
  });

  it("keeps a record it could not read the banner for", async () => {
    // No service worker registration to ask, so the count is unknowable. An
    // unknown must never be spent as if it were an answer.
    const stash = makeStash([minutesAgo(3, "issues")]);
    Object.defineProperty(globalThis.navigator, "serviceWorker", {
      value: {
        getRegistration: async () => undefined,
        addEventListener: () => {},
        removeEventListener: () => {},
        register: async () => ({}),
      },
      configurable: true,
    });
    await foreground(stash, "trip-casia");
    expect(stash.kept()).toEqual(["issues"]);
  });

  it("consumes the record it actually routed on", async () => {
    const stash = makeStash([minutesAgo(3, "issues")]);
    showBanners([]);
    expect(await foreground(stash, "trip-casia")).toEqual(["issues"]);
    expect(stash.kept()).toEqual([]);
  });
});
