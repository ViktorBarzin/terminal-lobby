/**
 * Opening a session this device has already read.
 *
 * The window used to arrive every time — measured 766,661 to 2,098,703 bytes per
 * session, 233,472 B gzipped — because nothing was held between opens. With the
 * transcript stored, the timeline is seeded from disk and the stream resumes from
 * that cursor, so only what happened since crosses the wire.
 *
 * What is pinned here is the WIRING, not the cache's arithmetic (that is
 * transcript-cache.test.ts): that the store seeds before the stream says
 * anything, that it resumes from the highest id held, and that a transcript the
 * server no longer recognises is dropped rather than shown.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRoot } from "solid-js";
import { createSessionStore } from "../src/store/session";
import type { Event } from "../src/types/events";
import type { TranscriptCache } from "../src/store/transcript-cache";

const g = globalThis as unknown as { EventSource: unknown };
const realES = g.EventSource;

/** Records the URLs asked for, and never delivers anything on its own. */
function installEventSource(urls: string[]): void {
  g.EventSource = class {
    constructor(url: string) {
      urls.push(url);
    }
    close(): void {}
    addEventListener(type: string, fn: (ev: { data: string }) => void): void {
      if (type === "ready") fn({ data: JSON.stringify({ cursor: 0, epoch: "epoch-a" }) });
    }
    removeEventListener(): void {}
  };
}

const ev = (id: number): Event => ({ session: "cached", id, kind: "text", body: `line ${id}` });

const fakeCache = (over: Partial<TranscriptCache> = {}): TranscriptCache =>
  ({
    enabled: true,
    read: async () => null,
    save: async () => {},
    drop: async () => {},
    ...over,
  }) as TranscriptCache;

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  g.EventSource = realES;
  vi.unstubAllGlobals();
});

describe("a session opened from the cache", () => {
  it("shows what it already held, and asks only for what came after", async () => {
    const urls: string[] = [];
    installEventSource(urls);
    const cache = fakeCache({
      read: async () => ({ events: [ev(1), ev(2), ev(7)], epoch: "epoch-a" }),
    });

    let store!: ReturnType<typeof createSessionStore>;
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      store = createSessionStore("cached", { cache });
    });
    await settle();

    expect(store.events.map((e) => e.id)).toEqual([1, 2, 7]);
    // The cursor is the highest id held — not zero, which would replay the
    // whole window this exists to avoid.
    expect(urls.at(-1)).toContain("lastEventId=7");
    dispose();
  });

  it("opens the ordinary way when nothing is held", async () => {
    const urls: string[] = [];
    installEventSource(urls);
    let store!: ReturnType<typeof createSessionStore>;
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      store = createSessionStore("cached", { cache: fakeCache() });
    });
    await settle();
    expect(store.events).toHaveLength(0);
    expect(urls.at(-1)).not.toContain("lastEventId");
    dispose();
  });

  it("stores the transcript against the epoch the server named", async () => {
    const urls: string[] = [];
    installEventSource(urls);
    const saved: Array<{ epoch: string; ids: number[] }> = [];
    const cache = fakeCache({
      read: async () => ({ events: [ev(1)], epoch: "epoch-a" }),
      save: async (_s: string, epoch: string, events: readonly Event[]) => {
        saved.push({ epoch, ids: events.map((e) => e.id) });
      },
    });
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      createSessionStore("cached", { cache });
    });
    // The write is deferred off the render path (idle callback / timeout).
    await new Promise((r) => setTimeout(r, 600));
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.at(-1)!.epoch).toBe("epoch-a");
    dispose();
  });

  it("drops what it held when the server resyncs the log", async () => {
    // A rewritten, compacted or restored transcript reuses ids for different
    // events. The client already resyncs on that; the cache has to go with it,
    // or the next open seeds the same wrong ids again.
    const urls: string[] = [];
    installEventSource(urls);
    const dropped: string[] = [];
    const cache = fakeCache({
      read: async () => ({ events: [ev(9)], epoch: "epoch-old" }),
      drop: async (s: string) => void dropped.push(s),
    });
    let store!: ReturnType<typeof createSessionStore>;
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      store = createSessionStore("cached", { cache });
    });
    await settle();
    // The fake server names a different log than the cache did, which is what
    // the client's foreignLog check exists for: everything held is dropped and
    // the session opens from the start, so nothing from the old log is shown.
    expect(store.events).toHaveLength(0);
    expect(dropped).toContain("cached");
    dispose();
  });
});
