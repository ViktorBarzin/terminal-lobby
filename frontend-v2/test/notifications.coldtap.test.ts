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

/**
 * Just enough IndexedDB for the stash. The store is now keyed PER SESSION and
 * read with getAll(), so the fake keeps a map rather than one slot.
 */
function fakeIDB(record: unknown) {
  return fakeIDBWith(record === undefined || record === null ? [] : [record]);
}

/** The same store with several records in it, the way several pushes leave it. */
function fakeIDBWith(records: readonly unknown[]) {
  const rows = new Map<string, unknown>();
  for (const record of records) {
    const r = record as { session?: string };
    rows.set(r.session || "last", record);
    rows.set("last", record);
  }
  return {
    open: () => {
      const req: Record<string, unknown> = {};
      const store = {
        get: (k: string) => {
          const g: Record<string, unknown> = { result: rows.get(k) };
          queueMicrotask(() => (g.onsuccess as (() => void) | undefined)?.());
          return g;
        },
        getAll: () => {
          const g: Record<string, unknown> = {};
          // De-duplicated by the reader, so mirroring `last` is harmless.
          g.result = [...new Set(rows.values())];
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
    const stale = { session: "issues", ts: Date.now() - 61 * 60 * 1000, tapped: false };
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
    const old = { session: "issues", ts: Date.now() - 61 * 60 * 1000, tapped: false };
    await coldLaunch({ stash: old, restoredAt: "trip-casia" });
    expect(reasons()).toEqual(["stale"]);
  });

  it("already — nothing to do", async () => {
    await coldLaunch({ stash: fresh("issues"), restoredAt: "issues" });
    expect(reasons()).toEqual(["already"]);
  });
});

/**
 * The failure the journal found, 2026-09-02, and the one four earlier fixes
 * could not have covered.
 *
 * On iOS, tapping a notification for an ALREADY-RUNNING PWA foregrounds it
 * without firing notificationclick and without reloading. The warm path has no
 * event; the cold path has no boot. Measured on Viktor's phone: taps produced
 * neither notify.clicked nor notify.stash_read while the app was plainly alive
 * (terminal.softkey throughout, no app.loaded). So the record has to be re-read
 * when the document comes back to the foreground.
 */
describe("foreground landing — a resident PWA that iOS merely brought forward", () => {
  /**
   * Which event a foregrounding actually delivers is not ours to choose. A tab
   * coming back can fire visibilitychange, or window focus alone, or pageshow
   * from the bfcache. Only visibilitychange re-read the stash, so a return that
   * fired either of the other two left the tap sitting there unread.
   */
  type Wake = "visibilitychange" | "focus" | "pageshow";

  /** Bring the app to the front the way `wake` says. */
  function foregroundBy(wake: Wake): void {
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    Object.defineProperty(document, "hasFocus", { value: () => true, configurable: true });
    if (wake === "visibilitychange") document.dispatchEvent(new Event("visibilitychange"));
    else window.dispatchEvent(new Event(wake));
  }

  /** Boot with nothing waiting, then have a push arrive, then foreground. */
  async function residentThenTapped(opts: {
    stash: unknown;
    showing: string | null;
    wake?: Wake;
  }) {
    Object.defineProperty(globalThis, "indexedDB", {
      value: fakeIDB(undefined), // nothing waiting at boot
      configurable: true,
      writable: true,
    });
    const activated: string[] = [];
    const [sessions] = createSignal<TitleSession[]>([]);
    const [selected] = createSignal<string | null>(opts.showing);
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
    await new Promise((r) => setTimeout(r, 40));

    // A push lands while the app sits in the background: sw.js writes the record.
    Object.defineProperty(globalThis, "indexedDB", {
      value: fakeIDB(opts.stash),
      configurable: true,
      writable: true,
    });
    // iOS brings the app forward. No notificationclick, no reload — just this.
    foregroundBy(opts.wake ?? "visibilitychange");
    await new Promise((r) => setTimeout(r, 60));
    dispose();
    return activated;
  }

  for (const wake of ["visibilitychange", "focus", "pageshow"] as const) {
    it(`lands on the notified session when merely foregrounded (${wake})`, async () => {
      const activated = await residentThenTapped({
        stash: fresh("issues"),
        showing: "trip-casia",
        wake,
      });
      expect(activated).toEqual(["issues"]);
    });

    it(`says nothing at all when the stash is empty (${wake})`, async () => {
      // Three events for one foregrounding, so a read that found nothing must
      // stay quiet or the journal fills with noise and `absent` stops meaning
      // "the write never landed".
      tracked.events.length = 0;
      await residentThenTapped({ stash: undefined, showing: "trip-casia", wake });
      expect(
        tracked.events.filter((e) => e.name === "notify.stash_read").map((e) => e.attrs),
      ).toEqual([{ "tl.reason": "absent" }]); // boot's, and only boot's
    });
  }

  it("stays put when nothing is waiting — an ordinary return to the app", async () => {
    const activated = await residentThenTapped({ stash: undefined, showing: "trip-casia" });
    expect(activated).toEqual([]);
  });

  it("stays put for a record too old to be a tap", async () => {
    const stale = { session: "issues", ts: Date.now() - 61 * 60 * 1000, tapped: false };
    const activated = await residentThenTapped({ stash: stale, showing: "trip-casia" });
    expect(activated).toEqual([]);
  });

  it("does nothing when it is already showing the notified session", async () => {
    const activated = await residentThenTapped({ stash: fresh("issues"), showing: "issues" });
    expect(activated).toEqual([]);
  });
});

/**
 * One return to the foreground is one verdict in the journal.
 *
 * visibilitychange, window focus and pageshow can all fire for a single
 * foregrounding, and each of them reads the stash. A record that routes nowhere
 * survives every one of them on purpose — spentSessions keeps a live receipt
 * whose banner is still up — so reporting per READ multiplied `untapped` and
 * `stale` by however many events the platform happened to fire. Those two
 * buckets held 357 of the 795 reads in the seven days to 2026-09-06, and they
 * are the numbers every fix to this path gets judged against.
 */
describe("foreground landing — reports once per foregrounding", () => {
  /** A receipt too old for its own window, with no shade to prove it gone. */
  const aged = () => ({ session: "issues", ts: Date.now() - 5 * 60 * 1000, tapped: false });

  async function wakeWith(events: readonly ("visibilitychange" | "focus" | "pageshow")[]) {
    Object.defineProperty(globalThis, "indexedDB", {
      value: fakeIDB(undefined),
      configurable: true,
      writable: true,
    });
    const [sessions] = createSignal<TitleSession[]>([]);
    const [selected] = createSignal<string | null>("trip-casia");
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
        onActivateSession: () => {},
      });
    });
    await new Promise((r) => setTimeout(r, 40));
    Object.defineProperty(globalThis, "indexedDB", {
      value: fakeIDB(aged()),
      configurable: true,
      writable: true,
    });
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    for (const e of events) {
      if (e === "visibilitychange") document.dispatchEvent(new Event(e));
      else window.dispatchEvent(new Event(e));
      await new Promise((r) => setTimeout(r, 20));
    }
    return { dispose };
  }

  const reasons = () =>
    tracked.events.filter((e) => e.name === "notify.stash_read").map((e) => e.attrs?.["tl.reason"]);

  it("three events, one untapped", async () => {
    const { dispose } = await wakeWith(["visibilitychange", "focus", "pageshow"]);
    dispose();
    expect(reasons()).toEqual(["absent", "untapped"]); // boot's absent, then one verdict
  });

  it("a real look-away in between makes the next return a new question", async () => {
    const { dispose } = await wakeWith(["visibilitychange", "focus"]);
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
    await new Promise((r) => setTimeout(r, 30));
    dispose();
    expect(reasons()).toEqual(["absent", "untapped", "untapped"]);
  });
});

/**
 * Declarative Web Push (iOS/iPadOS 18.4+) answers the question this whole file
 * exists to guess at.
 *
 * WebKit never dispatches notificationclick for a notification carrying a
 * `navigate` URL (Notifications spec 2.7 steps 5 and 6). It opens the URL
 * instead, and tmux-api builds that URL as `<origin>/?session=<name>`. So on the
 * one platform where the stash has been wrong six times, the OS states which
 * banner was tapped, and the stash must not talk it out of it.
 */
describe("cold-launch landing — the navigate URL of a declarative tap", () => {
  const fresh2 = (session: string, agoMs: number) => ({
    session,
    ts: Date.now() - agoMs,
    tapped: false,
  });

  async function launchAt(url: string, records: readonly unknown[], restoredAt: string | null) {
    window.history.replaceState(null, "", url);
    Object.defineProperty(globalThis, "indexedDB", {
      value: fakeIDBWith(records),
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
    window.history.replaceState(null, "", "/");
    return activated;
  }

  it("lands on the session the OS opened, not the newest receipt", async () => {
    // Two pushes 70 s apart, neither of them a recorded click, and no shade to
    // read. Newest-first says `ux`; the URL says the reader tapped `issues`.
    const records = [fresh2("ux", 20 * 1000), fresh2("issues", 90 * 1000)];
    expect(await launchAt("/?session=issues", records, "trip-casia")).toEqual(["issues"]);
    expect(await launchAt("/", records, "trip-casia")).toEqual(["ux"]);
  });

  it("ignores a query left over from an earlier tap, with no record behind it", async () => {
    const records = [fresh2("ux", 20 * 1000)];
    expect(await launchAt("/?session=trip-casia", records, "issues")).toEqual(["ux"]);
  });
});
