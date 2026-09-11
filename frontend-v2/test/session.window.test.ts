/**
 * The transcript window slides.
 *
 * The OPEN was already bounded — lib/config.ts asks for `rev=1&turns=20` — but
 * nothing shed the old end afterwards, so a session left open all day grew its
 * event array all day and deriveRows paid for the whole of it on every frame
 * (10 ms per pass, measured in store/session.ts). What is pinned here is the
 * shedding: that it keeps the same 20 turns the open asks for, that it stops
 * while the reader is up in the history reading it, and that what it drops can
 * be fetched back rather than being gone.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRoot } from "solid-js";
import { createSessionStore, windowStart, TRANSCRIPT_WINDOW_TURNS } from "../src/store/session";
import type { TranscriptCache } from "../src/store/transcript-cache";
import type { Event } from "../src/types/events";
import { readFileSync } from "node:fs";

// ---- fake stream ---------------------------------------------------------

/** One EventSource the test drives by hand: no frame arrives unless it says so. */
class FakeSource {
  onopen: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, Array<(ev: { data: string }) => void>>();
  constructor(readonly url: string) {}
  close(): void {
    this.closed = true;
  }
  addEventListener(type: string, fn: (ev: { data: string }) => void): void {
    const held = this.listeners.get(type) ?? [];
    held.push(fn);
    this.listeners.set(type, held);
  }
  removeEventListener(): void {}
  emit(type: string, data: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ data });
  }
  /** A live event, the way the server puts one on the wire. */
  send(e: Event): void {
    this.onmessage?.({ data: JSON.stringify(e) });
  }
  ready(frame: { cursor?: number; epoch?: string }): void {
    this.emit("ready", JSON.stringify(frame));
  }
}

const sources: FakeSource[] = [];
const g = globalThis as unknown as { EventSource?: unknown };
const realES = g.EventSource;

function installEventSource(): void {
  sources.length = 0;
  g.EventSource = class {
    constructor(url: string) {
      const s = new FakeSource(url);
      sources.push(s);
      return s as unknown as object;
    }
  };
}

/** Frames the test runs itself, so a flush happens exactly when it says. */
function installFrames(): () => void {
  const frames: Array<() => void> = [];
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  return () => {
    const due = frames.splice(0, frames.length);
    for (const f of due) f();
  };
}

/** Disabled, so the store opens its stream synchronously and nothing this test
 *  does has to wait on an IndexedDB read that jsdom does not have anyway. */
const noCache = (over: Partial<TranscriptCache> = {}): TranscriptCache =>
  ({
    enabled: false,
    read: async () => null,
    save: async () => {},
    drop: async () => {},
    ...over,
  }) as TranscriptCache;

// ---- fixtures ------------------------------------------------------------

/** `count` turns, each a user message and one line of answer, ids from `from`. */
function turns(count: number, from = 1): Event[] {
  const out: Event[] = [];
  let id = from;
  for (let t = 0; t < count; t++) {
    out.push({ id: id++, kind: "user", session: "win", body: `ask ${t}` });
    out.push({ id: id++, kind: "text", session: "win", body: `answer ${t}` });
  }
  return out;
}

afterEach(() => {
  g.EventSource = realES;
  vi.unstubAllGlobals();
});

// ---- where the window begins --------------------------------------------

describe("where the last 20 turns begin", () => {
  it("keeps everything when there are exactly 20", () => {
    expect(windowStart(turns(TRANSCRIPT_WINDOW_TURNS), TRANSCRIPT_WINDOW_TURNS)).toBe(0);
  });

  it("drops the first turn when there are 21", () => {
    const events = turns(TRANSCRIPT_WINDOW_TURNS + 1);
    // Two events per turn, so the 21st-from-last turn starts at index 2.
    expect(windowStart(events, TRANSCRIPT_WINDOW_TURNS)).toBe(2);
  });

  it("keeps everything when there are fewer", () => {
    expect(windowStart(turns(3), TRANSCRIPT_WINDOW_TURNS)).toBe(0);
    expect(windowStart([], TRANSCRIPT_WINDOW_TURNS)).toBe(0);
  });

  it("groups by the server's turnId when it sends one", () => {
    // No `user` events at all: without turnIds these would be one synthetic
    // turn, so this pins that the id is what decides.
    const events: Event[] = [];
    for (let t = 1; t <= 4; t++) {
      events.push({ id: t * 2 - 1, kind: "text", session: "win", turnId: `t${t}` });
      events.push({ id: t * 2, kind: "text", session: "win", turnId: `t${t}` });
    }
    expect(windowStart(events, 2)).toBe(4);
    expect(windowStart(events, 4)).toBe(0);
  });
});

// ---- the store slides it -------------------------------------------------

describe("a transcript that keeps growing", () => {
  it("holds the last 20 turns and lets the rest go", () => {
    installEventSource();
    const run = installFrames();
    createRoot((dispose) => {
      const store = createSessionStore("win", { cache: noCache() });
      const src = sources[0]!;
      src.ready({ cursor: 0, epoch: "e1" });
      for (const e of turns(TRANSCRIPT_WINDOW_TURNS + 1)) src.send(e);
      run();

      expect(store.events).toHaveLength(TRANSCRIPT_WINDOW_TURNS * 2);
      // The 21st turn's two events are the ones that went.
      expect(store.events[0]!.id).toBe(3);
      dispose();
    });
  });

  it("says there is earlier history again once it has dropped some", () => {
    installEventSource();
    const run = installFrames();
    createRoot((dispose) => {
      const store = createSessionStore("win", { cache: noCache() });
      const src = sources[0]!;
      // cursor 0 is the server saying "this is the start of the session", which
      // is what clears hasEarlier. Trimming has to put it back, or scroll-up
      // refuses to fetch what was just dropped.
      src.ready({ cursor: 0, epoch: "e1" });
      run();
      expect(store.hasEarlier()).toBe(false);

      for (const e of turns(TRANSCRIPT_WINDOW_TURNS + 1)) src.send(e);
      run();
      expect(store.hasEarlier()).toBe(true);
      dispose();
    });
  });

  it("pages back from the oldest event it still holds, not from the server's cursor", async () => {
    installEventSource();
    const run = installFrames();
    const asked: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      asked.push(url);
      return Promise.resolve({
        ok: true,
        json: async () => ({ events: [], cursor: 0 }),
      });
    });

    let store!: ReturnType<typeof createSessionStore>;
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      store = createSessionStore("win", { cache: noCache() });
    });
    const src = sources[0]!;
    // The server's window began at 1: below everything this open delivered.
    src.ready({ cursor: 1, epoch: "e1" });
    for (const e of turns(TRANSCRIPT_WINDOW_TURNS + 1)) src.send(e);
    run();

    await store.loadEarlier();
    // Paging from the server's cursor would fetch below id 1 and leave the two
    // events the trim dropped unreachable for good.
    expect(asked.at(-1)).toContain(`before=${store.events[0]!.id}`);
    dispose();
  });

  it("can take back what it dropped", async () => {
    installEventSource();
    const run = installFrames();
    const all = turns(TRANSCRIPT_WINDOW_TURNS + 1);
    const dropped = all.slice(0, 2);
    vi.stubGlobal("fetch", () =>
      Promise.resolve({ ok: true, json: async () => ({ events: dropped, cursor: 0 }) }),
    );

    let store!: ReturnType<typeof createSessionStore>;
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      store = createSessionStore("win", { cache: noCache() });
    });
    const src = sources[0]!;
    src.ready({ cursor: 1, epoch: "e1" });
    for (const e of all) src.send(e);
    run();
    expect(store.events).toHaveLength(TRANSCRIPT_WINDOW_TURNS * 2);

    // The dedup set has to let go with the array. Holding those ids would make
    // the refetch arrive and be silently discarded as "already held".
    const back = await store.loadEarlier();
    expect(back).toBe(2);
    expect(store.events.map((e) => e.id)).toEqual(all.map((e) => e.id));
    dispose();
  });
});

// ---- the reader's rule ---------------------------------------------------

describe("a reader who has scrolled up", () => {
  it("keeps everything while they are not at the bottom", () => {
    installEventSource();
    const run = installFrames();
    createRoot((dispose) => {
      const store = createSessionStore("win", { cache: noCache() });
      const src = sources[0]!;
      src.ready({ cursor: 0, epoch: "e1" });
      store.setPinnedToBottom(false);
      for (const e of turns(TRANSCRIPT_WINDOW_TURNS + 5)) src.send(e);
      run();

      expect(store.events).toHaveLength((TRANSCRIPT_WINDOW_TURNS + 5) * 2);
      dispose();
    });
  });

  it("stops trimming the moment they page earlier turns in", async () => {
    installEventSource();
    const run = installFrames();
    const older = turns(3, 1000);
    vi.stubGlobal("fetch", () =>
      Promise.resolve({ ok: true, json: async () => ({ events: older, cursor: 500 }) }),
    );

    let store!: ReturnType<typeof createSessionStore>;
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      store = createSessionStore("win", { cache: noCache() });
    });
    const src = sources[0]!;
    src.ready({ cursor: 2000, epoch: "e1" });
    for (const e of turns(2, 2001)) src.send(e);
    run();

    // Reaching for history is only ever done from the top of what is held, so
    // the store takes it as the reader having left the bottom — without which
    // the next arriving event would throw the fetched turns straight back out.
    await store.loadEarlier();
    const held = store.events.length;
    for (const e of turns(TRANSCRIPT_WINDOW_TURNS, 3001)) src.send(e);
    run();
    expect(store.events.length).toBe(held + TRANSCRIPT_WINDOW_TURNS * 2);
    dispose();
  });

  it("resumes trimming the moment they are told the reader is back at the bottom", () => {
    installEventSource();
    const run = installFrames();
    createRoot((dispose) => {
      const store = createSessionStore("win", { cache: noCache() });
      const src = sources[0]!;
      src.ready({ cursor: 0, epoch: "e1" });
      store.setPinnedToBottom(false);
      for (const e of turns(TRANSCRIPT_WINDOW_TURNS + 5)) src.send(e);
      run();
      expect(store.events).toHaveLength((TRANSCRIPT_WINDOW_TURNS + 5) * 2);

      // Immediately, not at the next arriving event: a session that has gone
      // quiet would otherwise hold everything it accumulated while the reader
      // was up in the history.
      store.setPinnedToBottom(true);
      expect(store.events).toHaveLength(TRANSCRIPT_WINDOW_TURNS * 2);
      dispose();
    });
  });
});

/**
 * The other half of the pin, which the timeline publishes.
 *
 * MessagesTimeline.tsx is the only thing that knows whether the reader is at
 * the bottom — it is the `pinned` signal its own autoscroll reads. Without a
 * way to say so, the store's fallback was all that held the rule up: it starts
 * pinned and unpins itself inside loadEarlier, and nothing ever pinned it back,
 * so one scroll-up stopped the window sliding for the life of that view. That
 * is the all-day session this change exists to fix, so the pin goes up through
 * an `onPinned` prop: MessagesTimeline calls it, TextView forwards it, and
 * SessionView hands it store.setPinnedToBottom.
 *
 * This block was `it.fails` while the wire was missing and was written to turn
 * red the day it landed. It landed, so the same three assertions now stand as
 * the guard against the wire being pulled out again.
 */
describe("the pin the timeline publishes", () => {
  it("the timeline tells the store when the reader is at the bottom", () => {
    const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
    expect(read("../src/components/MessagesTimeline.tsx")).toContain("onPinned");
    expect(read("../src/components/TextView.tsx")).toContain("onPinned");
    expect(read("../src/components/SessionView.tsx")).toContain("setPinnedToBottom");
  });
});
