import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * sw.js's notification-tap ROUTING, exercised against the real worker source.
 *
 * Nothing loaded sw.js before this file, and that is precisely how tap routing
 * broke three times. The last one (2026-09-01) was not a change to any
 * notification code at all: the framed terminal attach moved its positional
 * args off the page URL and onto iframe.name, because the URL is a cache key
 * and a session in the query made every session a fresh 1.8 MB download. The
 * worker picked the lobby out of clients.matchAll() by "has no ?arg=", so the
 * now-bare terminal iframe started reading as the lobby, took a message it had
 * no listener for, and the handler returned having done nothing.
 *
 * A current build has no terminal iframe to be confused by — term.html went on
 * 2026-09-05 — but the worker still has to pick between lobby tabs, and a
 * browser holding an old install can still hand it a stale client. The
 * ask-and-answer below is what settles both.
 *
 * So these tests drive the worker the way a tap does — real source, fake
 * clients — and the first one fails against that shipped code.
 */

const SRC = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../public/sw.js"),
  "utf8",
);

interface FakeClient {
  url: string;
  focused?: boolean;
  focus: () => Promise<void>;
  postMessage: (msg: unknown, transfer?: unknown[]) => void;
}

/** A window client that answers the worker's handshake, like a real lobby. */
function lobby(url = "/", focused = false, ack = true): FakeClient & { got: unknown[] } {
  const got: unknown[] = [];
  return {
    url,
    focused,
    got,
    focus: vi.fn(async () => {}),
    postMessage: (msg: unknown, transfer?: unknown[]) => {
      got.push(msg);
      const port = transfer?.[0] as MessagePort | undefined;
      if (ack && port) port.postMessage({ type: "tl-activate-ack" });
    },
  };
}

/**
 * The three databases the worker reads, in one fake.
 *
 * They are separate databases on purpose and the worker opens each at version 1:
 * `tl-badge`/`seen` is what the page has already shown (store/visits.ts),
 * `tl-notif`/`pending` is the tap stash it writes itself, and `tl-device`/`meta`
 * mirrors the telemetry device id a worker cannot read out of localStorage. A
 * single-slot fake answered every get with the same record, which made a stash
 * write indistinguishable from a seen-set read.
 *
 * `seen === null` means the page has never written, which is the fallback path.
 */
interface FakeDbs {
  seen?: string[] | null;
  device?: string | null;
  /** The stash, live: the worker's writes land here and the test reads them. */
  pending?: Map<string, unknown>;
}

function fakeIndexedDB(dbs: FakeDbs) {
  const pending = dbs.pending ?? new Map<string, unknown>();
  const seen = dbs.seen ?? null;
  return {
    open: (name: string) => {
      const req: Record<string, unknown> = {};
      const store = {
        get: (k: string) => {
          const g: Record<string, unknown> = {};
          if (name === "tl-badge") g.result = seen === null ? undefined : { names: seen };
          else if (name === "tl-device") g.result = dbs.device ?? undefined;
          else g.result = pending.get(k);
          return g;
        },
        put: (v: unknown, k: string) => {
          if (name === "tl-notif") pending.set(k, v);
        },
        delete: (k: string) => pending.delete(k),
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

interface TelemetryEvent {
  name: string;
  attrs: Record<string, unknown>;
}

/** Load the real worker with a stubbed global scope and return its listeners. */
function loadWorker(
  clients: FakeClient[],
  openWindow: unknown = vi.fn(async () => null),
  seen: string[] | null = null,
  dbs: FakeDbs = {},
  /**
   * `origin` is what self.location reports (a plain-http dev origin is a secure
   * context, so a worker really does run on one), and `putOk` whether the server
   * accepted the subscription PUT.
   */
  env: { origin?: string; putOk?: boolean } = {},
) {
  const listeners = new Map<string, (e: unknown) => void>();
  const navigator = { setAppBadge: vi.fn(async () => {}), clearAppBadge: vi.fn(async () => {}) };
  const pending = dbs.pending ?? new Map<string, unknown>();
  /** Every telemetry event the worker posted, flattened out of its batches. */
  const events: TelemetryEvent[] = [];
  /** Every non-telemetry request, so the re-subscribe PUT body is inspectable. */
  const requests: { url: string; init?: Record<string, unknown> }[] = [];
  const vapid = "BJ_test_key";
  interface FakeResponse {
    ok: boolean;
    status: number;
    text: () => Promise<string>;
  }
  const fetch = vi.fn(
    async (url: string, init?: Record<string, unknown>): Promise<FakeResponse> => {
      if (url === "/api/sessions/telemetry") {
        const body = JSON.parse(String(init?.body)) as { events: TelemetryEvent[] };
        events.push(...body.events);
        return { ok: true, status: 200, text: async () => "" };
      }
      requests.push({ url, init });
      const ok = init?.method === "PUT" ? (env.putOk ?? true) : true;
      return { ok, status: ok ? 200 : 400, text: async () => vapid };
    },
  );
  const self = {
    addEventListener: (t: string, fn: (e: unknown) => void) => listeners.set(t, fn),
    skipWaiting: vi.fn(),
    navigator,
    location: (() => {
      const origin = env.origin ?? "https://terminal.viktorbarzin.me";
      return { origin, protocol: new URL(origin).protocol };
    })(),
    registration: {
      showNotification: vi.fn(async () => {}),
      pushManager: {
        subscribe: vi.fn(async () => ({
          endpoint: "https://push.example/new",
          toJSON: () => ({ endpoint: "https://push.example/new", keys: { p256dh: "k", auth: "a" } }),
        })),
      },
    },
    clients: {
      matchAll: vi.fn(async () => clients),
      openWindow,
    },
  };
  new Function(
    "self",
    "indexedDB",
    "MessageChannel",
    "setTimeout",
    "URL",
    "atob",
    "fetch",
    SRC,
  )(
    self,
    fakeIndexedDB({ ...dbs, seen, pending }),
    MessageChannel,
    setTimeout,
    URL,
    (s: string) => s,
    fetch,
  );
  return { listeners, self, navigator, openWindow, pending, events, requests, fetch };
}

/** Fire notificationclick the way the browser does, and wait for waitUntil. */
async function tap(listeners: Map<string, (e: unknown) => void>, session: string | null) {
  const waits: Promise<unknown>[] = [];
  const event = {
    notification: { close: vi.fn(), data: { session } },
    waitUntil: (p: Promise<unknown>) => waits.push(p),
  };
  listeners.get("notificationclick")!(event);
  await Promise.all(waits);
  return event;
}

/** The events of one name, in the order the worker posted them. */
const named = (events: TelemetryEvent[], name: string) => events.filter((e) => e.name === name);

/** The single event of one name, failing loudly when the worker emitted none. */
function only(events: TelemetryEvent[], name: string): TelemetryEvent {
  const hits = named(events, name);
  expect(hits).toHaveLength(1);
  return hits[0] as TelemetryEvent;
}

describe("notificationclick routing", () => {
  it("switches the LOBBY, not the bare terminal iframe matchAll returns first", async () => {
    // The exact shape measured in a real browser on 2026-09-01: the terminal
    // iframe carries no query at all, and comes back before the lobby.
    const term = lobby("http://x/assets/term-2d2be4d7a166.html", true, false);
    const app = lobby("http://x/", false, true);
    const { listeners } = loadWorker([term, app]);

    await tap(listeners, "myprotein");

    expect(app.got).toEqual([{ type: "tl-activate-session", session: "myprotein" }]);
    expect(term.got).toEqual([]);
  });

  it("still recognises the legacy ?arg= terminal", async () => {
    const term = lobby("http://x/term.html?arg=trip-casia", true, false);
    const app = lobby("http://x/", false, true);
    const { listeners } = loadWorker([term, app]);

    await tap(listeners, "memory");

    expect(app.got).toHaveLength(1);
    expect(term.got).toEqual([]);
  });

  it("prefers the focused lobby when several are open", async () => {
    const bg = lobby("http://x/", false, true);
    const fg = lobby("http://x/", true, true);
    const { listeners } = loadWorker([bg, fg]);

    await tap(listeners, "health");

    expect(fg.got).toHaveLength(1);
    expect(bg.got).toEqual([]); // no hijacking every window
    expect(fg.focus).toHaveBeenCalled();
  });

  it("tries the next lobby when the first never answers", async () => {
    const mute = lobby("http://x/", true, false); // looks like a lobby, is not
    const real = lobby("http://x/", false, true);
    const { listeners } = loadWorker([mute, real]);

    await tap(listeners, "ux");

    expect(mute.got).toHaveLength(1); // tried
    expect(real.got).toHaveLength(1); // and landed
  });

  it("opens a window only when no lobby is open at all", async () => {
    const term = lobby("http://x/assets/term-abc123.html", true, false);
    const openWindow = vi.fn(async () => null);
    const { listeners } = loadWorker([term], openWindow);

    await tap(listeners, "vpn");

    expect(openWindow).toHaveBeenCalledWith("/#vpn");
  });

  it("does not open a second window when the app is already up", async () => {
    const app = lobby("http://x/", true, true);
    const openWindow = vi.fn(async () => null);
    const { listeners } = loadWorker([app], openWindow);

    await tap(listeners, "vpn");

    expect(openWindow).not.toHaveBeenCalled();
  });

  it("a session-less test tap only foregrounds — it never switches", async () => {
    const app = lobby("http://x/", true, true);
    const { listeners } = loadWorker([app]);

    await tap(listeners, null);

    expect(app.focus).toHaveBeenCalled();
    expect(app.got).toEqual([]);
  });
});

describe("push badge", () => {
  const push = async (
    listeners: Map<string, (e: unknown) => void>,
    data: Record<string, unknown>,
  ) => {
    const waits: Promise<unknown>[] = [];
    listeners.get("push")!({
      data: { json: () => data },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    await Promise.all(waits);
  };

  it("paints the count the server sent", async () => {
    const { listeners, navigator } = loadWorker([]); // nothing on screen
    await push(listeners, { title: "t", body: "b", tag: "tl-a", session: "a", badge: 4 });
    expect(navigator.setAppBadge).toHaveBeenCalledWith(4);
  });

  it("clears the icon on a zero", async () => {
    const { listeners, navigator } = loadWorker([]);
    await push(listeners, { title: "t", body: "b", tag: "tl-a", session: "a", badge: 0 });
    expect(navigator.clearAppBadge).toHaveBeenCalled();
  });

  it("leaves the icon alone when the payload carries no badge (the test push)", async () => {
    const { listeners, navigator } = loadWorker([]);
    await push(listeners, { title: "Test notification", body: "b", tag: "tl-test", session: "" });
    expect(navigator.setAppBadge).not.toHaveBeenCalled();
    expect(navigator.clearAppBadge).not.toHaveBeenCalled();
  });

  it("still shows the notification when badging is unavailable", async () => {
    const { listeners, self } = loadWorker([]);
    // @ts-expect-error deliberately removing the API the way a plain browser does
    self.navigator.setAppBadge = undefined;
    await push(listeners, { title: "t", body: "b", tag: "tl-a", session: "a", badge: 2 });
    expect(self.registration.showNotification).toHaveBeenCalled();
  });
});

/**
 * There is ONE copy of every PWA asset now.
 *
 * This block used to pin `frontend/` byte-identical to `frontend-v2/public/`,
 * because the Debian package installed the first and vite served the second, so
 * an edit to one alone either never reached the box or made dev and production
 * disagree. release/manifest.go now points at `frontend-v2/public/` and the
 * `frontend/` copies are deleted, so the drift this guarded has no second copy
 * to happen in. What replaced it lives in release/manifest_test.go:
 * TestEverySourceFileInTheManifestExistsInTheRepo and
 * TestEveryStagedSourceDirectoryIsCopiedIntoTheStage, which check that the file
 * the manifest names exists and that build-deb.sh stages it.
 *
 * The one thing worth keeping here is that the worker this suite drives IS the
 * worker the package ships, since every test above would otherwise be exercising
 * a file nobody installs.
 */
describe("the shipped service worker", () => {
  it("is the file release/manifest.go installs", () => {
    const manifest = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../release/manifest.go"),
      "utf8",
    );
    expect(manifest).toContain("frontend-v2/public/sw.js");
    expect(manifest).not.toContain('"frontend/sw.js"');
  });
});

/**
 * B1: the tap that left no trace.
 *
 * Measured over 7 days of notify.stash_read on the deployed build: 51 reads of
 * 795 routed, and 376 came back `absent`, with no record at all. The click handler
 * is why. When window clients exist it posts the switch and waits ACK_MS for a
 * reply, and on iOS the page is not running JS yet when clients.matchAll()
 * resolves, so postMessage to a waking client is dropped (WebKit bug 268797).
 * Nobody answers, the loop ends, and the handler used to return having written
 * NOTHING. The tap simply disappeared.
 *
 * So every branch now leaves a record. It costs one IndexedDB write on a path
 * that already worked, and the page consumes the record when it acts on the
 * message, so a warm tap that DID land cannot route twice.
 */
describe("notificationclick always leaves a tap record", () => {
  const stashed = (pending: Map<string, unknown>, session: string) =>
    pending.get(session) as { session: string; tapped: boolean } | undefined;

  it("records the tap when a lobby ACKNOWLEDGED the switch", async () => {
    const app = lobby("http://x/", true, true);
    const { listeners, pending } = loadWorker([app]);

    await tap(listeners, "k7m2q9x4tp0v");

    expect(app.got).toHaveLength(1);
    expect(stashed(pending, "k7m2q9x4tp0v")).toMatchObject({
      session: "k7m2q9x4tp0v",
      tapped: true,
    });
  });

  it("records the tap when NOBODY answers, the iPhone case", async () => {
    // Two lobby-shaped windows, neither running JS yet. This is what a warm
    // iOS tap looks like from inside the worker.
    const asleep = lobby("http://x/", true, false);
    const alsoAsleep = lobby("http://x/", false, false);
    const { listeners, pending } = loadWorker([asleep, alsoAsleep]);

    await tap(listeners, "b3n8h1x5r2wq");

    expect(asleep.got).toHaveLength(1); // posted to
    expect(alsoAsleep.got).toHaveLength(1); // and to
    expect(stashed(pending, "b3n8h1x5r2wq")).toMatchObject({ tapped: true });
  });

  it("records the tap on the cold openWindow branch", async () => {
    const { listeners, pending } = loadWorker([]);

    await tap(listeners, "vpn");

    expect(stashed(pending, "vpn")).toMatchObject({ tapped: true });
  });

  it("mirrors the record into the legacy `last` slot for an older page", async () => {
    const { listeners, pending } = loadWorker([lobby("http://x/", true, false)]);

    await tap(listeners, "myprotein");

    expect(pending.get("last")).toMatchObject({ session: "myprotein", tapped: true });
  });

  it("writes NOTHING for a session-less test tap", async () => {
    const { listeners, pending } = loadWorker([lobby("http://x/", true, true)]);

    await tap(listeners, null);

    expect([...pending.keys()]).toEqual([]);
  });
});

/**
 * notify.tap: which arm the click took.
 *
 * The click handler emitted nothing at all, so the only instrument on the tap
 * path was the page's notify.stash_read, which cannot see a tap that never
 * reached a page. This is the other half: what the WORKER did.
 */
describe("notify.tap telemetry", () => {
  const kinds = (events: TelemetryEvent[]) => named(events, "notify.tap").map((e) => e.attrs["tl.kind"]);

  it.each([
    ["acked", () => [lobby("http://x/", true, true)]],
    ["posted", () => [lobby("http://x/", true, false)]],
    ["opened", () => []],
  ])("reports %s", async (kind, clients) => {
    const { listeners, events } = loadWorker(clients());
    await tap(listeners, "k7m2q9x4tp0v");
    expect(kinds(events)).toEqual([kind]);
  });

  it("reports a session-less tap as focused, with no tl.session", async () => {
    const { listeners, events } = loadWorker([lobby("http://x/", true, true)]);

    await tap(listeners, null);

    const ev = only(events, "notify.tap");
    expect(ev.attrs["tl.kind"]).toBe("focused");
    expect(ev.attrs).not.toHaveProperty("tl.session");
  });

  it("reports failed when the browser cannot open a window", async () => {
    // No lobby and no openWindow: nothing carried the tap anywhere, and that is
    // the one outcome worth telling apart from a routed one.
    const { listeners, events } = loadWorker([], null);
    await tap(listeners, "vpn");
    expect(kinds(events)).toEqual(["failed"]);
  });

  it("carries the session and the window count", async () => {
    const { listeners, events } = loadWorker([lobby("http://x/", true, true), lobby("http://x/")]);

    await tap(listeners, "k7m2q9x4tp0v");

    const ev = only(events, "notify.tap");
    expect(ev.attrs["tl.session"]).toBe("k7m2q9x4tp0v");
    expect(ev.attrs["tl.count"]).toBe(2);
  });

  it("stamps the device id the page mirrored into IndexedDB", async () => {
    const device = "0123456789abcdef0123456789abcdef";
    const { listeners, events } = loadWorker([lobby("http://x/", true, true)], undefined, null, {
      device,
    });

    await tap(listeners, "k7m2q9x4tp0v");

    // Every worker event carries it, not just the tap: a stash written on this
    // phone can then be joined to the read that consumed it.
    for (const ev of events) expect(ev.attrs["tl.device"]).toBe(device);
  });

  it("omits tl.device rather than minting one when the mirror is empty", async () => {
    const { listeners, events } = loadWorker([lobby("http://x/", true, true)]);

    await tap(listeners, "k7m2q9x4tp0v");

    expect(events.length).toBeGreaterThan(0);
    for (const ev of events) expect(ev.attrs).not.toHaveProperty("tl.device");
  });
});

/**
 * Declarative Web Push (iOS/iPadOS 18.4, Safari 18.4).
 *
 * The server sends ONE document that both worlds read. Chrome never runs the
 * declarative parser and gets the whole JSON through event.data.json(). WebKit
 * parses it, and because the server sets top-level "mutable": true it still
 * starts this worker, but event.data is NULL and the payload arrives as
 * event.notification, with our own fields on event.notification.data.
 */
describe("push, the declarative shape", () => {
  /** The exact wire shape tmux-api emits, per the pushsender contract. */
  const declarative = (over: Record<string, unknown> = {}) => ({
    notification: {
      title: "Worktree cleanup finished",
      body: "Claude finished its turn.",
      navigate: "https://terminal.viktorbarzin.me/?session=k7m2q9x4tp0v",
      tag: "tl-k7m2q9x4tp0v",
      app_badge: 2,
      data: {
        session: "k7m2q9x4tp0v",
        waiting: { a: ["k7m2q9x4tp0v"], d: ["b3n8h1x5r2wq"] },
      },
      ...over,
    },
  });

  const fire = async (
    listeners: Map<string, (e: unknown) => void>,
    event: Record<string, unknown>,
  ) => {
    const waits: Promise<unknown>[] = [];
    listeners.get("push")!({ data: null, waitUntil: (p: Promise<unknown>) => waits.push(p), ...event });
    await Promise.all(waits);
  };

  it("shows NOTHING itself, WebKit is already displaying the payload's banner", async () => {
    const { listeners, self } = loadWorker([]);
    await fire(listeners, declarative());
    // Calling showNotification here would replace WebKit's own notification,
    // and a replacement needs its own valid absolute navigate or it throws.
    expect(self.registration.showNotification).not.toHaveBeenCalled();
  });

  it("still stashes the session out of notification.data", async () => {
    const { listeners, pending } = loadWorker([]);
    await fire(listeners, declarative());
    expect(pending.get("k7m2q9x4tp0v")).toMatchObject({
      session: "k7m2q9x4tp0v",
      tapped: false,
    });
  });

  it("still subtracts this device's seen set from the named waiting list", async () => {
    // 1 awaiting + 1 finished, and the finished one has been read here, so 1.
    const { listeners, navigator } = loadWorker([], undefined, ["b3n8h1x5r2wq"]);
    await fire(listeners, declarative());
    expect(navigator.setAppBadge).toHaveBeenCalledWith(1);
  });

  // WebKit does not put app_badge on the Notification it builds. A Notification
  // carries title, body, tag and data; the count reaches the worker as
  // PushEvent.appBadge. Reading it off the notification found undefined every
  // time, so the fallback never fired.
  it("falls back to the event's appBadge when the waiting list was over the cap", async () => {
    const { listeners, navigator } = loadWorker([], undefined, []);
    await fire(listeners, { appBadge: 2, ...declarative({ data: { session: "k7m2q9x4tp0v" } }) });
    expect(navigator.setAppBadge).toHaveBeenCalledWith(2);
  });

  it("still reads a payload-shaped app_badge, for an engine that hands it over", async () => {
    const { listeners, navigator } = loadWorker([], undefined, []);
    await fire(listeners, declarative({ data: { session: "k7m2q9x4tp0v" } }));
    expect(navigator.setAppBadge).toHaveBeenCalledWith(2);
  });

  it("leaves the icon alone when the payload carries no app_badge (the test push)", async () => {
    const { listeners, navigator, pending } = loadWorker([]);
    await fire(listeners, {
      notification: {
        title: "Test notification",
        body: "If you can read this, push delivery works on this device.",
        navigate: "https://terminal.viktorbarzin.me/",
        tag: "tl-test",
        data: { session: "" },
      },
    });
    expect(navigator.setAppBadge).not.toHaveBeenCalled();
    expect(navigator.clearAppBadge).not.toHaveBeenCalled();
    expect([...pending.keys()]).toEqual([]); // a diagnostic never stashes
  });

  it("survives a notification with no data at all", async () => {
    const { listeners, self, navigator } = loadWorker([]);
    await fire(listeners, { notification: { title: "t", body: "b", tag: "tl" } });
    expect(self.registration.showNotification).not.toHaveBeenCalled();
    expect(navigator.setAppBadge).not.toHaveBeenCalled();
  });

  it("Chrome, given the SAME document, still shows its own notification", async () => {
    // Chrome ignores web_push/mutable and hands the whole JSON to event.data.
    const { listeners, self, pending } = loadWorker([]);
    const waits: Promise<unknown>[] = [];
    listeners.get("push")!({
      data: {
        json: () => ({
          web_push: 8030,
          mutable: true,
          notification: declarative().notification,
          title: "Worktree cleanup finished",
          body: "Claude finished its turn.",
          tag: "tl-k7m2q9x4tp0v",
          session: "k7m2q9x4tp0v",
          badge: 2,
          waiting: { a: ["k7m2q9x4tp0v"], d: ["b3n8h1x5r2wq"] },
        }),
      },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    await Promise.all(waits);

    // Required: a Chrome push handler that shows nothing gets Chrome's own
    // "site updated in background" notice instead.
    expect(self.registration.showNotification).toHaveBeenCalledWith(
      "Worktree cleanup finished",
      expect.objectContaining({ tag: "tl-k7m2q9x4tp0v", body: "Claude finished its turn." }),
    );
    expect(pending.get("k7m2q9x4tp0v")).toMatchObject({ session: "k7m2q9x4tp0v" });
  });
});

/**
 * The rotated subscription carries the origin too.
 *
 * The server records a subscription's origin so it can build the absolute
 * `navigate` URL Declarative Web Push requires (a relative one is a SyntaxError
 * and WebKit drops the whole message). A pushsubscriptionchange mints a NEW
 * endpoint, so the store's same-endpoint preservation does not cover it: without
 * this the rotated device would silently drop back to the flat payload and stop
 * routing taps on iOS.
 */
describe("pushsubscriptionchange", () => {
  it("PUTs the new subscription with this worker's origin", async () => {
    const { listeners, requests } = loadWorker([]);
    const waits: Promise<unknown>[] = [];
    listeners.get("pushsubscriptionchange")!({
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    await Promise.all(waits);

    const put = requests.find((r) => r.init?.method === "PUT");
    expect(put).toBeDefined();
    expect(JSON.parse(String(put?.init?.body))).toMatchObject({
      endpoint: "https://push.example/new",
      origin: "https://terminal.viktorbarzin.me",
    });
  });

  /**
   * The server refuses anything but an absolute https origin (push.go
   * validatePushOrigin) and 400s the whole PUT with it, so a plain-http origin
   * has to be withheld rather than sent. http://localhost and http://127.0.0.1
   * are secure contexts, so a service worker really does run and rotate there;
   * pwa/push.ts already applies this test on the page side (secureOrigin).
   */
  it("withholds a plain-http origin rather than losing the whole PUT", async () => {
    const { listeners, requests } = loadWorker([], undefined, null, {}, {
      origin: "http://127.0.0.1:8080",
    });
    const waits: Promise<unknown>[] = [];
    listeners.get("pushsubscriptionchange")!({
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    await Promise.all(waits);

    const put = requests.find((r) => r.init?.method === "PUT");
    expect(put).toBeDefined();
    const body = JSON.parse(String(put?.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ endpoint: "https://push.example/new" });
    expect(body.origin).toBeUndefined();
  });

  /**
   * The old endpoint is the only one still working until the new one is stored.
   * Deleting it after a rejected PUT leaves the device with no subscription at
   * all and no background push until someone reopens the app.
   */
  it("keeps the old endpoint when the server refuses the new subscription", async () => {
    const { listeners, requests } = loadWorker([], undefined, null, {}, { putOk: false });
    const waits: Promise<unknown>[] = [];
    listeners.get("pushsubscriptionchange")!({
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      oldSubscription: { endpoint: "https://push.example/old" },
    });
    await Promise.all(waits);

    expect(requests.some((r) => r.init?.method === "PUT")).toBe(true);
    expect(requests.some((r) => r.init?.method === "DELETE")).toBe(false);
  });

  it("retires the old endpoint once the new one is stored", async () => {
    const { listeners, requests } = loadWorker([]);
    const waits: Promise<unknown>[] = [];
    listeners.get("pushsubscriptionchange")!({
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      oldSubscription: { endpoint: "https://push.example/old" },
    });
    await Promise.all(waits);

    const del = requests.find((r) => r.init?.method === "DELETE");
    expect(JSON.parse(String(del?.init?.body))).toEqual({
      endpoint: "https://push.example/old",
    });
  });
});

/**
 * Who owns the icon while the app is OPEN.
 *
 * The page has the visit store, so it knows which finished sessions have been
 * read and its number is the smaller, truer one. The worker's count comes from
 * the server, which cannot know that. A push landing while the lobby is on
 * screen used to overwrite the good number with the bigger one, which is what
 * the user saw as the counter resetting upward.
 */
describe("push badge — deferring to a visible page", () => {
  const push = async (
    listeners: Map<string, (e: unknown) => void>,
    data: Record<string, unknown>,
  ) => {
    const waits: Promise<unknown>[] = [];
    listeners.get("push")!({
      data: { json: () => data },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    await Promise.all(waits);
  };
  const payload = { title: "t", body: "b", tag: "tl-a", session: "a", badge: 9 };

  /** A window client with a visibility state, which lobby() does not carry. */
  const win = (url: string, focused: boolean, visibilityState: string) => ({
    ...lobby(url, focused, true),
    visibilityState,
  });

  it("does not paint while a focused lobby is on screen", async () => {
    const { listeners, navigator } = loadWorker([win("http://x/", true, "visible")]);
    await push(listeners, payload);
    expect(navigator.setAppBadge).not.toHaveBeenCalled();
  });

  it("does not paint while a visible but unfocused lobby is on screen", async () => {
    const { listeners, navigator } = loadWorker([win("http://x/", false, "visible")]);
    await push(listeners, payload);
    expect(navigator.setAppBadge).not.toHaveBeenCalled();
  });

  it("DOES paint when every window is hidden — a backgrounded PWA parks its poll", async () => {
    const { listeners, navigator } = loadWorker([win("http://x/", false, "hidden")]);
    await push(listeners, payload);
    expect(navigator.setAppBadge).toHaveBeenCalledWith(9);
  });

  it("DOES paint when the only visible window is a terminal frame, not the lobby", async () => {
    const { listeners, navigator } = loadWorker([
      win("http://x/assets/term-2d2be4d7a166.html", true, "visible"),
    ]);
    await push(listeners, payload);
    expect(navigator.setAppBadge).toHaveBeenCalledWith(9);
  });

  it("still shows the notification when a lobby is on screen", async () => {
    const c = win("http://x/", true, "visible");
    const { listeners, self } = loadWorker([c]);
    await push(listeners, payload);
    expect(self.registration.showNotification).toHaveBeenCalled();
  });
});

/**
 * The number, once the server sends the POPULATION instead of a total.
 *
 * This is the fix for "the counter wrongly resets to a bigger number": the
 * worker now subtracts the finished sessions this device has already shown,
 * which is what the page does, so the two writers arrive at the same figure.
 */
describe("push badge — the device applies its own seen set", () => {
  const hidden = () => ({ ...lobby("http://x/", false, true), visibilityState: "hidden" });
  const push = async (
    listeners: Map<string, (e: unknown) => void>,
    data: Record<string, unknown>,
  ) => {
    const waits: Promise<unknown>[] = [];
    listeners.get("push")!({
      data: { json: () => data },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    await Promise.all(waits);
  };
  const payload = (over: Record<string, unknown> = {}) => ({
    title: "t",
    body: "b",
    tag: "tl-z",
    session: "z",
    badge: 99, // must be IGNORED whenever `waiting` is present
    waiting: { a: [], d: ["a", "b", "c"] },
    ...over,
  });

  it("counts only the finished sessions this device has NOT shown", async () => {
    const { listeners, navigator } = loadWorker([hidden()], undefined, ["a", "b"]);
    await push(listeners, payload());
    expect(navigator.setAppBadge).toHaveBeenCalledWith(1); // only "c"
  });

  it("counts every finished session when the device has shown none", async () => {
    const { listeners, navigator } = loadWorker([hidden()], undefined, []);
    await push(listeners, payload());
    expect(navigator.setAppBadge).toHaveBeenCalledWith(3);
  });

  it("adds awaiting sessions unconditionally — a prompt is waiting however often you have looked", async () => {
    const { listeners, navigator } = loadWorker([hidden()], undefined, ["a", "b", "c"]);
    await push(listeners, payload({ waiting: { a: ["p", "q"], d: ["a", "b", "c"] } }));
    expect(navigator.setAppBadge).toHaveBeenCalledWith(2);
  });

  it("re-counts the session this push is ABOUT, even though it was read before", async () => {
    // "a" is in the seen set, but "a" just finished again — so it is unread now.
    const { listeners, navigator } = loadWorker([hidden()], undefined, ["a", "b", "c"]);
    await push(listeners, payload({ session: "a" }));
    expect(navigator.setAppBadge).toHaveBeenCalledWith(1);
  });

  it("clears the icon when everything has been read", async () => {
    const { listeners, navigator } = loadWorker([hidden()], undefined, ["a", "b", "c"]);
    await push(listeners, payload({ session: "" }));
    expect(navigator.clearAppBadge).toHaveBeenCalled();
  });

  it("falls back to the server's total when the device has no record at all", async () => {
    const { listeners, navigator } = loadWorker([hidden()], undefined, null);
    await push(listeners, payload());
    expect(navigator.setAppBadge).toHaveBeenCalledWith(3); // nothing subtracted
  });

  it("uses `badge` when the payload carries no named set (over the cap, or an old server)", async () => {
    const { listeners, navigator } = loadWorker([hidden()], undefined, ["a", "b"]);
    await push(listeners, payload({ waiting: undefined }));
    expect(navigator.setAppBadge).toHaveBeenCalledWith(99);
  });

  it("still defers to a visible lobby, named set or not", async () => {
    const onscreen = { ...lobby("http://x/", true, true), visibilityState: "visible" };
    const { listeners, navigator } = loadWorker([onscreen], undefined, ["a"]);
    await push(listeners, payload());
    expect(navigator.setAppBadge).not.toHaveBeenCalled();
    expect(navigator.clearAppBadge).not.toHaveBeenCalled();
  });
});
