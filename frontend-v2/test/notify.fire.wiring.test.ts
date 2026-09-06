import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createNotificationSystem } from "../src/notify/notifications";
import type { TitleSession } from "../src/notify/title";
import type { FaviconKind } from "../src/notify/favicon";

/**
 * What the banner says, wired into the running app.
 *
 * fire.ts knows how to raise a notification; this is the half that decides
 * which words go in it. The bug (2026-09-06): the app handed it a session
 * NAME, and a name has been an opaque id since ADR-0019 — so a turn finishing
 * read `k7m2q9x4tp0v finished` on the phone.
 */
const h = vi.hoisted(() => {
  // notifications.ts reads `typeof Notification` once, at import. jsdom has no
  // Notification, so the stub has to exist BEFORE the module graph loads.
  (globalThis as { Notification?: unknown }).Notification = Object.assign(function () {}, {
    permission: "granted",
    requestPermission: () => Promise.resolve("granted"),
  });
  return { fired: [] as { session: string; label: string; kind: string }[] };
});

vi.mock("../src/notify/fire", () => ({
  fireNotification: (session: string, label: string, kind: string) => {
    h.fired.push({ session, label, kind });
    return Promise.resolve();
  },
}));

vi.mock("../src/pwa/push", () => ({
  PUSH_SUBS_API: "/api/sessions/push-subscriptions",
  VAPID_PUBLIC_API: "/api/sessions/push/vapid-public",
  PUSH_TEST_API: "/api/sessions/push/test",
  // "no": the server does not push to this device, so the PAGE is the notifier.
  deviceSubscriptionState: () => Promise.resolve("no"),
  reportFocus: () => Promise.resolve(true),
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

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

interface Harness {
  setSessions: (s: TitleSession[]) => void;
  dispose: () => void;
}

function mount(initial: TitleSession[]): Harness {
  const [sessions, setSessions] = createSignal<TitleSession[]>(initial);
  const [selected] = createSignal<string | null>(null);
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
  return { setSessions, dispose };
}

describe("what a page-fired banner calls a session", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("tl:notify:v1", "1");
    // The tab is away, so no session is suppressed for being on screen.
    Object.defineProperty(document, "hasFocus", { value: () => false, configurable: true });
    h.fired.length = 0;
  });
  afterEach(() => localStorage.clear());

  it("uses the title, and keeps the id as the address", async () => {
    const app = mount([{ name: "6j0wjvxxf7e5", title: "Restore feature", state: "running" }]);
    await settle();
    app.setSessions([{ name: "6j0wjvxxf7e5", title: "Restore feature", state: "done" }]);
    await settle();

    expect(h.fired).toEqual([
      { session: "6j0wjvxxf7e5", label: "Restore feature", kind: "done" },
    ]);
    app.dispose();
  });

  // An untitled session has nothing but its id, and an id beats a banner that
  // cannot say which session it is about — the rule tmux-api's pushLabel uses.
  it("falls back to the id when a session has no title", async () => {
    const app = mount([{ name: "4txnmy85ftja", state: "running" }]);
    await settle();
    app.setSessions([{ name: "4txnmy85ftja", state: "awaiting" }]);
    await settle();

    expect(h.fired).toEqual([
      { session: "4txnmy85ftja", label: "4txnmy85ftja", kind: "awaiting" },
    ]);
    app.dispose();
  });
});
