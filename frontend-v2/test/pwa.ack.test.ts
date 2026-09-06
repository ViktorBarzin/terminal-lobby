import { describe, it, expect, vi, afterEach } from "vitest";
import { registerServiceWorker } from "../src/pwa/register";

/**
 * The page's half of the tap handshake.
 *
 * sw.js cannot pick the right window by URL alone — it tried, and an unrelated
 * change to a page URL silently killed tap routing twice — so it asks, and moves
 * on to the next window when nobody answers.
 * This reply is what makes that work, which makes it load-bearing rather than
 * decorative: without it every tap costs a 400 ms timeout per candidate.
 */
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
  Reflect.deleteProperty(navigator as object, "serviceWorker");
});

/** Deliver a switch the way sw.js does, and resolve with the reply (or null). */
function send(
  sw: ReturnType<typeof stubServiceWorker>,
  data: unknown,
  withPort = true,
): Promise<unknown> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => resolve(e.data);
    sw.dispatchEvent(
      new MessageEvent("message", { data, ports: withPort ? [ch.port2] : [] }),
    );
    setTimeout(() => resolve(null), 150);
  });
}

describe("notification-tap acknowledgement", () => {
  it("activates the session and tells the worker it landed", async () => {
    const sw = stubServiceWorker();
    const onActivateSession = vi.fn(() => true);
    const handle = registerServiceWorker({ onActivateSession });

    const reply = await send(sw, { type: "tl-activate-session", session: "myprotein" });

    expect(onActivateSession).toHaveBeenCalledWith("myprotein");
    expect(reply).toEqual({ type: "tl-activate-ack" });
    handle.dispose();
  });

  it("stays silent for a message that is not a switch", async () => {
    const sw = stubServiceWorker();
    const onActivateSession = vi.fn(() => true);
    const handle = registerServiceWorker({ onActivateSession });

    expect(await send(sw, { type: "something-else", session: "myprotein" })).toBeNull();
    expect(onActivateSession).not.toHaveBeenCalled();
    handle.dispose();
  });

  it("refuses a malformed session name, and does not acknowledge one", async () => {
    const sw = stubServiceWorker();
    const onActivateSession = vi.fn(() => true);
    const handle = registerServiceWorker({ onActivateSession });

    expect(
      await send(sw, { type: "tl-activate-session", session: "not a valid name" }),
    ).toBeNull();
    expect(onActivateSession).not.toHaveBeenCalled();
    handle.dispose();
  });

  /**
   * A window that will not take the switch — a lens tab acting as another user
   * — must not answer either. sw.js reads the silence as "not a lobby" and posts
   * to the next window; an ack would end the fan-out there and the clear behind
   * it would take the record the reader's own window was going to route on.
   */
  it("neither acknowledges nor clears when the page refuses the switch", async () => {
    const sw = stubServiceWorker();
    const onActivateSession = vi.fn(() => false);
    const handle = registerServiceWorker({ onActivateSession });

    const reply = await send(sw, { type: "tl-activate-session", session: "myprotein" });

    expect(onActivateSession).toHaveBeenCalledWith("myprotein");
    expect(reply).toBeNull();
    handle.dispose();
  });

  it("still switches when an older worker posts without a port", async () => {
    const sw = stubServiceWorker();
    const onActivateSession = vi.fn(() => true);
    const handle = registerServiceWorker({ onActivateSession });

    await send(sw, { type: "tl-activate-session", session: "health" }, false);

    expect(onActivateSession).toHaveBeenCalledWith("health");
    handle.dispose();
  });
});
