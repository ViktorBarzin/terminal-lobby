import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createNotificationSystem } from "../src/notify/notifications";
import type { TitleSession } from "../src/notify/title";
import type { FaviconKind } from "../src/notify/favicon";

/**
 * The reporter, wired into the running app.
 *
 * focus.ts decides WHAT to say; this is the half that says it. What matters here
 * is that the app actually opens its mouth at the two moments that carry the
 * whole feature — the session on screen changing, and this device learning the
 * server pushes to it — and that a device the server does not push to stays
 * silent, because it has no endpoint to report under.
 */
const h = vi.hoisted(() => ({
  reports: [] as string[],
  delivers: "yes" as "yes" | "no" | "unsupported",
  /** when set, a report parks here instead of resolving, so the test can hold one in flight. */
  hold: null as null | (() => void),
}));

vi.mock("../src/pwa/push", () => ({
  PUSH_SUBS_API: "/api/sessions/push-subscriptions",
  VAPID_PUBLIC_API: "/api/sessions/push/vapid-public",
  PUSH_TEST_API: "/api/sessions/push/test",
  deviceSubscriptionState: () => Promise.resolve(h.delivers),
  reportFocus: (session: string) => {
    h.reports.push(session);
    if (!h.hold) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      h.hold = () => resolve(true);
    });
  },
  subscribePush: () => Promise.resolve(),
  unsubscribePush: () => Promise.resolve(),
  testAllDevices: () => Promise.resolve({ ok: true, sent: 0, pruned: 0 }),
}));

vi.mock("../src/notify/favicon", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/notify/favicon")>();
  return {
    ...actual,
    createFaviconBadger: () => ({ apply: (_: FaviconKind) => {} }),
  };
});

/** Let the async device-subscription check and the report promise settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

interface Harness {
  setSelected: (s: string | null) => void;
  dispose: () => void;
}

function mount(initial: string | null): Harness {
  const [sessions] = createSignal<TitleSession[]>([]);
  const [selected, setSelected] = createSignal<string | null>(initial);
  const [loading] = createSignal(false);
  let dispose!: () => void;
  createRoot((d) => {
    dispose = d;
    createNotificationSystem({
      sessions,
      selected,
      osUser: () => "wizard",
      notifyPrefs: () => ({ onDone: true, onAwaiting: true }),
      loading,
      toast: () => {},
      onActivateSession: () => {},
    });
  });
  return { setSelected, dispose };
}

describe("reporting what this device is showing", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(document, "hasFocus", {
      value: () => true,
      configurable: true,
    });
    h.reports.length = 0;
    h.delivers = "yes";
    h.hold = null;
  });
  afterEach(() => localStorage.clear());

  it("says what is on screen once it knows the server pushes here", async () => {
    const app = mount("billing");
    await settle();
    expect(h.reports).toEqual(["billing"]);
    app.dispose();
  });

  it("says so again when you move to another session", async () => {
    const app = mount("billing");
    await settle();
    app.setSelected("invoices");
    await settle();
    expect(h.reports).toEqual(["billing", "invoices"]);
    app.dispose();
  });

  // Going back to the lobby list is a look-away, and it is the case the whole
  // request turns on: from there, every session should be able to reach you.
  it("says it is showing nothing when you go back to the list", async () => {
    const app = mount("billing");
    await settle();
    app.setSelected(null);
    await settle();
    expect(h.reports).toEqual(["billing", ""]);
    app.dispose();
  });

  it("does not repeat itself while you sit on one session", async () => {
    const app = mount("billing");
    await settle();
    app.setSelected("billing");
    await settle();
    expect(h.reports).toEqual(["billing"]);
    app.dispose();
  });

  // Only one request is in the air at a time, so two POSTs cannot land out of
  // order and leave the server holding the session you just left. A move made
  // while one is in flight is therefore deferred, not dropped — dropping it
  // would produce that exact stale state until the next tick.
  it("catches up on a move made while a report was in the air", async () => {
    const app = mount("billing");
    await settle();
    expect(h.reports).toEqual(["billing"]);

    h.hold = () => {}; // the next report parks
    app.setSelected("invoices");
    await settle();
    expect(h.reports).toEqual(["billing", "invoices"]);

    app.setSelected("payroll"); // moved again, still in flight
    await settle();
    expect(h.reports).toEqual(["billing", "invoices"]);

    h.hold?.(); // the parked report lands
    h.hold = null;
    await settle();
    expect(h.reports).toEqual(["billing", "invoices", "payroll"]);
    app.dispose();
  });

  // Nothing to report under: the server has no subscription for this browser,
  // so it is not a device any of this applies to.
  it("stays silent on a device the server does not push to", async () => {
    h.delivers = "no";
    const app = mount("billing");
    await settle();
    expect(h.reports).toEqual([]);
    app.dispose();
  });
});
