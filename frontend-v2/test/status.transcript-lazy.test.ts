/**
 * A transcript stream nobody has asked to open is not a stream in trouble.
 *
 * v1 opens a session on the TERMINAL view and defers the first `/events`
 * connect until Text is shown (session.lazy.test.ts covers that contract). The
 * status signal's initial value is `connecting`, so from the outside a stream
 * that has never been asked to open is indistinguishable from one that is
 * trying and failing — and the connection panel reported the first as the
 * second: "The transcript stream is reconnecting", badge amber, on a session
 * whose terminal was working perfectly.
 *
 * `started` is what tells them apart, and these pin both halves.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRoot } from "solid-js";
import { createSessionStore } from "../src/store/session";
import { transcriptChannel } from "../src/diagnostics/status";

const g = globalThis as unknown as { EventSource?: unknown };
const sources: { url: string }[] = [];

describe("the transcript channel while the stream is still closed", () => {
  let origES: unknown;
  beforeEach(() => {
    origES = g.EventSource;
    sources.length = 0;
    g.EventSource = class {
      onopen: ((e: unknown) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      constructor(public url: string) {
        sources.push(this);
      }
      addEventListener() {}
      close() {}
    };
  });
  afterEach(() => {
    g.EventSource = origES;
  });

  it("has not started before anyone shows the Text view", () => {
    createRoot((dispose) => {
      const store = createSessionStore("s1", { autoStart: false });
      expect(store.started()).toBe(false);
      expect(sources).toHaveLength(0);
      dispose();
    });
  });

  /**
   * THE REGRESSION. `status` says `connecting` here, and mapping that straight
   * through is what put "Reconnecting" on the badge of a terminal-only session.
   */
  it("reports unknown, not a fault, while the stream is unopened", () => {
    createRoot((dispose) => {
      const store = createSessionStore("s1", { autoStart: false });
      expect(store.status()).toBe("connecting"); // the trap
      const reported = store.started() ? store.status() : null;
      const channel = transcriptChannel(reported);
      expect(channel.state).toBe("unknown");
      expect(channel.detail).toBe("not open");
      dispose();
    });
  });

  it("starts reporting once the Text view opens the stream", () => {
    createRoot((dispose) => {
      const store = createSessionStore("s1", { autoStart: false });
      store.start();
      expect(store.started()).toBe(true);
      expect(sources).toHaveLength(1);
      const channel = transcriptChannel(store.started() ? store.status() : null);
      // Now `connecting` MEANS something: a connect is genuinely in flight.
      expect(channel.state).toBe("degraded");
      dispose();
    });
  });

  it("stays started once opened, so the row does not flicker back to unknown", () => {
    createRoot((dispose) => {
      const store = createSessionStore("s1", { autoStart: false });
      store.start();
      store.start(); // idempotent
      expect(store.started()).toBe(true);
      expect(sources).toHaveLength(1);
      dispose();
    });
  });

  it("is started from the outset when the store connects eagerly", () => {
    createRoot((dispose) => {
      const store = createSessionStore("s2", {});
      expect(store.started()).toBe(true);
      dispose();
    });
  });
});
