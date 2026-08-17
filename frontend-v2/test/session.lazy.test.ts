import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRoot } from "solid-js";
import { createSessionStore } from "../src/store/session";

/**
 * The store's LAZY connect contract.
 *
 * v1 opens a session on the Terminal view and Text mode is opt-in (Cmd/Ctrl-J
 * or the [Text] segment), but the store opened `/events/<session>` from its
 * constructor — so every session paid for a stream, and for a reconnect ladder
 * on a flaky network, on behalf of a view most of them never showed. A plain
 * shell session has no Claude transcript to stream at all: session-events
 * answers 404, so the eager connect also cost one console error per session per
 * load.
 *
 * `autoStart: false` + `start()` moves the FIRST connect to whoever knows Text
 * is being shown. Everything after that first connect is unchanged — including
 * the fact that nothing ever re-opens or tears down the stream behind it.
 */

interface FakeSource {
  url: string;
  closed: boolean;
  onopen: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
}

const sources: FakeSource[] = [];
const g = globalThis as unknown as { EventSource?: unknown };

describe("session store — lazy connect", () => {
  let origES: unknown;
  beforeEach(() => {
    origES = g.EventSource;
    sources.length = 0;
    g.EventSource = class implements FakeSource {
      onopen: ((ev: unknown) => void) | null = null;
      onerror: ((ev: unknown) => void) | null = null;
      onmessage: ((ev: { data: string }) => void) | null = null;
      closed = false;
      constructor(public url: string) {
        sources.push(this);
      }
      close(): void {
        this.closed = true;
      }
    };
  });
  afterEach(() => {
    g.EventSource = origES;
  });

  it("opens no stream at construction when autoStart is false", () => {
    createRoot((dispose) => {
      const store = createSessionStore("s", { autoStart: false });
      expect(sources).toHaveLength(0);
      // An un-opened stream has no events — the correct state for a session
      // whose transcript was never asked for, and what the transcript-derived
      // consumers (preview recents, timeline rows) see until it is.
      expect(store.events).toHaveLength(0);
      dispose();
    });
  });

  it("still connects at construction by default (unchanged for every other caller)", () => {
    createRoot((dispose) => {
      createSessionStore("s");
      expect(sources).toHaveLength(1);
      dispose();
    });
  });

  it("connects on start(), exactly once however often it is called", () => {
    createRoot((dispose) => {
      const store = createSessionStore("s", { autoStart: false });
      store.start();
      expect(sources).toHaveLength(1);
      store.start();
      store.start();
      // start() is the view's "text mode is showing" signal, which a Solid
      // effect re-runs on every unrelated re-read; a second connect there would
      // drop the live source's replay cursor on the floor.
      expect(sources).toHaveLength(1);
      dispose();
    });
  });

  it("reads as connecting — never as a failure — before the first connect", () => {
    createRoot((dispose) => {
      const store = createSessionStore("s", { autoStart: false });
      // The session bar renders this verbatim the instant Text is opened. A
      // stream nobody has asked for yet is not a broken one.
      expect(store.status()).toBe("connecting");
      dispose();
    });
  });

  it("closes safely when the stream was never started", () => {
    createRoot((dispose) => {
      const store = createSessionStore("s", { autoStart: false });
      expect(() => store.close()).not.toThrow();
      expect(sources).toHaveLength(0);
      dispose();
    });
    expect(sources).toHaveLength(0);
  });

  it("disposes safely when the stream was never started", () => {
    expect(() =>
      createRoot((dispose) => {
        createSessionStore("s", { autoStart: false });
        dispose(); // onCleanup → close() on a client that never opened anything
      }),
    ).not.toThrow();
    expect(sources).toHaveLength(0);
  });

  it("stays closed: start() after close() does not resurrect the stream", () => {
    createRoot((dispose) => {
      const store = createSessionStore("s", { autoStart: false });
      store.close();
      store.start();
      // Disposal is final. The view that owned this store is gone; a late
      // effect flush must not leave a live EventSource behind it.
      expect(sources).toHaveLength(0);
      dispose();
    });
  });

  it("closes the live source when it WAS started", () => {
    createRoot((dispose) => {
      const store = createSessionStore("s", { autoStart: false });
      store.start();
      expect(sources).toHaveLength(1);
      store.close();
      expect(sources[0]?.closed).toBe(true);
      dispose();
    });
  });

  // Events are coalesced into one store write per frame (see the store), so a
  // delivery is visible after a frame rather than inside the same tick.
  it("delivers events once started", async () => {
    let store!: ReturnType<typeof createSessionStore>;
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      store = createSessionStore("s", { autoStart: false });
      store.start();
    });
    sources[0]?.onmessage?.({
      data: JSON.stringify({ id: 1, kind: "text", session: "s", body: "hi" }),
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(store.events).toHaveLength(1);
    expect(store.events[0]?.body).toBe("hi");
    dispose();
  });
});
