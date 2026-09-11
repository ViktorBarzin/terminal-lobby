/**
 * This file runs on an https page on purpose: the origin is only recorded on a
 * secure one, and the wiring under test is what puts it in the PUT body.
 *
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://terminal.viktorbarzin.me/" }
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { secureOrigin, subscribePush, PUSH_SUBS_API, VAPID_PUBLIC_API } from "../src/pwa/push";

/**
 * The page origin recorded on this device's push subscription.
 *
 * It is the only way the server can put an ABSOLUTE navigate URL in a
 * Declarative Web Push message (tmux-api/pushsender.go): the server sees only
 * the ingress-forwarded request and has no public-origin config, and WebKit
 * drops a message whose navigate it cannot parse — banner and all. So the
 * browser tells it.
 */
describe("which origin is worth recording", () => {
  for (const c of [
    { name: "an https page sends its origin", loc: { protocol: "https:", origin: "https://terminal.viktorbarzin.me" }, want: "https://terminal.viktorbarzin.me" },
    // The server validates strictly and 400s a bad origin, which would take the
    // whole subscription with it. A plain-http dev page keeps push by staying
    // quiet and taking the flat payload.
    { name: "a plain-http page sends none", loc: { protocol: "http:", origin: "http://localhost:5173" }, want: undefined },
    { name: "no page at all sends none", loc: undefined, want: undefined },
  ]) {
    it(c.name, () => {
      expect(secureOrigin(c.loc)).toBe(c.want);
    });
  }
});

/** A browser that has a service worker, a VAPID key and a subscription to give. */
function stubPushBrowser() {
  const sub = {
    endpoint: "https://push.example/abc",
    toJSON: () => ({ endpoint: "https://push.example/abc", keys: { p256dh: "BPk", auth: "c2Vj" } }),
  };
  Object.defineProperty(navigator, "serviceWorker", {
    value: { ready: Promise.resolve({ pushManager: { getSubscription: async () => sub } }) },
    configurable: true,
    writable: true,
  });
  (window as unknown as { PushManager: unknown }).PushManager = class {};
  const puts: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === VAPID_PUBLIC_API) return new Response("BPublicKey");
      if (url === PUSH_SUBS_API && init?.method === "PUT") {
        puts.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    }),
  );
  return puts;
}

afterEach(() => {
  Reflect.deleteProperty(navigator as object, "serviceWorker");
  Reflect.deleteProperty(window as object, "PushManager");
  vi.unstubAllGlobals();
});

describe("what the subscription PUT carries", () => {
  // Endpoint and keys exactly as before, plus the origin. The server stores it
  // against this endpoint and can then address this device with an absolute
  // navigate URL.
  it("adds the origin to the subscription the browser gave it", async () => {
    const puts = stubPushBrowser();
    await subscribePush();
    expect(puts).toHaveLength(1);
    expect(puts[0]).toEqual({
      endpoint: "https://push.example/abc",
      keys: { p256dh: "BPk", auth: "c2Vj" },
      origin: "https://terminal.viktorbarzin.me",
    });
  });
});
