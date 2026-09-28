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
import * as trackMod from "../src/telemetry/track";
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
      read: async () => ({ events: [ev(1), ev(2), ev(7)], epoch: "epoch-a", cursor: 0 }),
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
      read: async () => ({ events: [ev(1)], epoch: "epoch-a", cursor: 0 }),
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

  it("stores the transcript against an epoch the stream moves mid-read", async () => {
    // Found live on 2026-09-27: the copy kept the epoch named at the open
    // while the source's ids stopped being replayable, and a rebuilt source
    // reporting that same epoch resumed five events short.
    g.EventSource = class {
      close(): void {}
      addEventListener(type: string, fn: (ev: { data: string }) => void): void {
        if (type === "ready") fn({ data: JSON.stringify({ cursor: 0, epoch: "epoch-a" }) });
        // After the ready, as the server sends it.
        if (type === "epoch")
          setTimeout(() => fn({ data: JSON.stringify({ epoch: "epoch-a-own" }) }), 0);
      }
      removeEventListener(): void {}
    };
    const saved: string[] = [];
    const cache = fakeCache({
      read: async () => ({ events: [ev(1)], epoch: "epoch-a", cursor: 0 }),
      save: async (_s: string, epoch: string) => void saved.push(epoch),
    });
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      createSessionStore("cached", { cache });
    });
    await new Promise((r) => setTimeout(r, 600));
    expect(saved.at(-1)).toBe("epoch-a-own");
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
      read: async () => ({ events: [ev(9)], epoch: "epoch-old", cursor: 0 }),
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

/**
 * Round 7 (2026-09-28): page earlier once, reopen, and the top row read "Start
 * of session" over a transcript that began at event 212. A resume names no
 * cursor, so the store fell back to the oldest id held, and that was the
 * prompt of a turn split by the window, which rides along from far below it.
 * The cursor is now stored with the events, and a copy stored without one is
 * not trusted to page from.
 */
describe("paging back from a session opened from the cache", () => {
  const OPENED = [
    { ...ev(1), kind: "user" as const, body: "the long first turn" },
    ev(212),
    ev(213),
  ];

  it("keeps the stored cursor, so earlier history is still offered and fetched from it", async () => {
    const urls: string[] = [];
    g.EventSource = class {
      constructor(url: string) {
        urls.push(url);
      }
      close(): void {}
      // A resume's ready names no cursor.
      addEventListener(type: string, fn: (ev: { data: string }) => void): void {
        if (type === "ready") fn({ data: JSON.stringify({ epoch: "epoch-a" }) });
      }
      removeEventListener(): void {}
    };
    const asked: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      asked.push(url);
      return Promise.resolve({ ok: true, json: async () => ({ events: [ev(150)], cursor: 100 }) });
    });
    const cache = fakeCache({
      read: async () => ({ events: OPENED, epoch: "epoch-a", cursor: 200 }),
    });
    let store!: ReturnType<typeof createSessionStore>;
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      store = createSessionStore("cached", { cache });
    });
    await settle();
    expect(store.events.map((e) => e.id)).toEqual([1, 212, 213]);
    expect(store.hasEarlier()).toBe(true);
    await store.loadEarlier();
    expect(asked.at(-1)).toContain("before=200");
    expect(store.hasEarlier()).toBe(true);
    dispose();
  });

  it("says it has reached the start when the stored cursor says so", async () => {
    installEventSource([]);
    g.EventSource = class {
      close(): void {}
      addEventListener(type: string, fn: (ev: { data: string }) => void): void {
        if (type === "ready") fn({ data: JSON.stringify({ epoch: "epoch-a" }) });
      }
      removeEventListener(): void {}
    };
    const cache = fakeCache({
      read: async () => ({ events: [ev(1), ev(2)], epoch: "epoch-a", cursor: 0 }),
    });
    let store!: ReturnType<typeof createSessionStore>;
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      store = createSessionStore("cached", { cache });
    });
    await settle();
    expect(store.hasEarlier()).toBe(false);
    dispose();
  });

  it("opens the ordinary way from a copy stored without a cursor", async () => {
    const urls: string[] = [];
    installEventSource(urls);
    const cache = fakeCache({ read: async () => ({ events: OPENED, epoch: "epoch-a" }) });
    let store!: ReturnType<typeof createSessionStore>;
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      store = createSessionStore("cached", { cache });
    });
    await settle();
    expect(store.events).toHaveLength(0);
    expect(urls.at(-1)).not.toContain("lastEventId");
    dispose();
  });

  it("stores the cursor beside the events, the one paging moved it to included", async () => {
    g.EventSource = class {
      close(): void {}
      addEventListener(type: string, fn: (ev: { data: string }) => void): void {
        if (type === "ready") fn({ data: JSON.stringify({ cursor: 212, epoch: "epoch-a" }) });
      }
      removeEventListener(): void {}
    };
    vi.stubGlobal("fetch", () =>
      Promise.resolve({ ok: true, json: async () => ({ events: [ev(150)], cursor: 100 }) }),
    );
    const saved: Array<{ ids: number[]; cursor: number | undefined }> = [];
    const cache = fakeCache({
      save: async (_s: string, _e: string, events: readonly Event[], cursor?: number) => {
        saved.push({ ids: events.map((e) => e.id), cursor });
      },
    });
    let store!: ReturnType<typeof createSessionStore>;
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      store = createSessionStore("cached", { cache });
    });
    await new Promise((r) => setTimeout(r, 600));
    expect(saved.at(-1)?.cursor).toBe(212);
    await store.loadEarlier();
    await new Promise((r) => setTimeout(r, 600));
    expect(saved.at(-1)).toEqual({ ids: [150], cursor: 100 });
    dispose();
  });
});

/**
 * "The cache works" has to be a measurement, not a claim: one record per open
 * saying what this device supplied against what the server still sent.
 */
describe("what an open reports", () => {
  it("reports a hit with both halves counted", async () => {
    const spy = vi.spyOn(trackMod, "track").mockImplementation(() => {});
    const urls: string[] = [];
    installEventSource(urls);
    const cache = fakeCache({
      read: async () => ({ events: [ev(1), ev(2), ev(3)], epoch: "epoch-a", cursor: 0 }),
    });
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      createSessionStore("cached", { cache });
    });
    await settle();
    const open = spy.mock.calls.find((c) => c[0] === "text.open");
    expect(open, "no text.open record").toBeTruthy();
    expect(open![1]).toMatchObject({ "tl.cache": "hit", "tl.cached": 3 });
    spy.mockRestore();
    dispose();
  });

  it("reports a miss when nothing was held", async () => {
    const spy = vi.spyOn(trackMod, "track").mockImplementation(() => {});
    const urls: string[] = [];
    installEventSource(urls);
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      createSessionStore("cached", { cache: fakeCache() });
    });
    await settle();
    const open = spy.mock.calls.find((c) => c[0] === "text.open");
    expect(open![1]).toMatchObject({ "tl.cache": "miss", "tl.cached": 0 });
    spy.mockRestore();
    dispose();
  });
});
