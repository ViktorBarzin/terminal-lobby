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
 * now-bare terminal iframe started reading as the lobby, took a message it has
 * no listener for, and the handler returned having done nothing.
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

/** Load the real worker with a stubbed global scope and return its listeners. */
function loadWorker(clients: FakeClient[], openWindow = vi.fn(async () => null)) {
  const listeners = new Map<string, (e: unknown) => void>();
  const navigator = { setAppBadge: vi.fn(async () => {}), clearAppBadge: vi.fn(async () => {}) };
  const self = {
    addEventListener: (t: string, fn: (e: unknown) => void) => listeners.set(t, fn),
    skipWaiting: vi.fn(),
    navigator,
    registration: { showNotification: vi.fn(async () => {}) },
    clients: {
      matchAll: vi.fn(async () => clients),
      openWindow,
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("self", "indexedDB", "MessageChannel", "setTimeout", "URL", "atob", SRC)(
    self,
    undefined,
    MessageChannel,
    setTimeout,
    URL,
    (s: string) => s,
  );
  return { listeners, self, navigator, openWindow };
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
    const { listeners, navigator } = loadWorker([]);
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
 * The two copies of the worker.
 *
 * `frontend-v2/public/sw.js` is the one vite serves and the one these tests
 * drive; `frontend/sw.js` is the one the Debian package actually installs to
 * /usr/local/share/ttyd/sw.js (release/manifest.go). Nothing else keeps them in
 * step, and the natural place to edit is the copy that does NOT ship — so an
 * edit to one alone means either the fix never reaches the box, or dev and
 * production quietly disagree about how a notification tap is routed.
 */
describe("the shipped worker", () => {
  it("is byte-identical to the one under test", () => {
    const shipped = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../frontend/sw.js"),
      "utf8",
    );
    expect(shipped).toBe(SRC);
  });
});
