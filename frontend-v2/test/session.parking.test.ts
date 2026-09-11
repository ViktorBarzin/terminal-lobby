/**
 * A transcript stream nobody is reading is closed, and reopened on return.
 *
 * The stream used to stay open for the life of the view, which is 24 hours
 * (store/keepalive.ts), for every session ever visited — and every event on it
 * re-derives that session's timeline at 10 ms a pass. Parking it is only safe
 * because the resume was already there: SseClient carries its own cursor, so
 * reopening asks for the gap rather than the window, and the server's `ready`
 * frame is what says whether the ids still mean the same thing.
 *
 * What is pinned here is that the park is a real close and the return is a real
 * RESUME: nothing lost, nothing shown twice, and above all not the reset path,
 * which drops the whole transcript and the cache with it.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRoot } from "solid-js";
import { createSessionStore } from "../src/store/session";
import type { TranscriptCache } from "../src/store/transcript-cache";
import type { Event } from "../src/types/events";

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
  send(id: number): void {
    this.onmessage?.({
      data: JSON.stringify({
        id,
        kind: "text",
        session: "park",
        body: `line ${id}`,
      } satisfies Event),
    });
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

const noCache = (over: Partial<TranscriptCache> = {}): TranscriptCache =>
  ({
    enabled: false,
    read: async () => null,
    save: async () => {},
    drop: async () => {},
    ...over,
  }) as TranscriptCache;

afterEach(() => {
  g.EventSource = realES;
  vi.unstubAllGlobals();
});

describe("parking a transcript stream", () => {
  it("closes the socket, and reopens one asking for the gap", () => {
    installEventSource();
    const run = installFrames();
    createRoot((dispose) => {
      const store = createSessionStore("park", { cache: noCache() });
      const src = sources[0]!;
      src.ready({ cursor: 10, epoch: "e1" });
      for (let id = 11; id <= 15; id++) src.send(id);
      run();

      store.park();
      expect(src.closed).toBe(true);
      expect(sources).toHaveLength(1);

      store.unpark();
      expect(sources).toHaveLength(2);
      // The cursor, not a fresh open: the whole point is that the window it
      // already paid for is still on screen.
      expect(sources[1]!.url).toContain("lastEventId=15");
      dispose();
    });
  });

  it("loses nothing and shows nothing twice across the park", () => {
    installEventSource();
    const run = installFrames();
    createRoot((dispose) => {
      const store = createSessionStore("park", { cache: noCache() });
      const first = sources[0]!;
      first.ready({ cursor: 10, epoch: "e1" });
      for (let id = 11; id <= 13; id++) first.send(id);
      run();

      store.park();
      store.unpark();
      const second = sources[1]!;
      second.ready({ epoch: "e1" });
      // The server replays from the cursor, and a replay is allowed to overlap:
      // 12 and 13 come again with what happened while nobody was listening.
      for (const id of [12, 13, 14, 15, 16]) second.send(id);
      run();

      expect(store.events.map((e) => e.id)).toEqual([11, 12, 13, 14, 15, 16]);
      dispose();
    });
  });

  it("delivers what was still buffered rather than dropping it", () => {
    installEventSource();
    installFrames(); // frames are collected and never run
    createRoot((dispose) => {
      const store = createSessionStore("park", { cache: noCache() });
      const src = sources[0]!;
      src.ready({ cursor: 10, epoch: "e1" });
      for (let id = 11; id <= 13; id++) src.send(id);
      // Nothing has landed: the frame has not run.
      expect(store.events).toHaveLength(0);

      store.park();
      expect(store.events.map((e) => e.id)).toEqual([11, 12, 13]);
      dispose();
    });
  });

  it("takes the resume path on return, not the reset path", () => {
    installEventSource();
    const run = installFrames();
    const dropped: string[] = [];
    createRoot((dispose) => {
      const store = createSessionStore("park", {
        cache: noCache({ drop: async (s: string) => void dropped.push(s) }),
      });
      const first = sources[0]!;
      first.ready({ cursor: 10, epoch: "e1" });
      for (let id = 11; id <= 13; id++) first.send(id);
      run();

      store.park();
      store.unpark();
      // The same log, so `foreignLog` says nothing and everything held stands.
      sources[1]!.ready({ epoch: "e1" });
      run();

      expect(store.events.map((e) => e.id)).toEqual([11, 12, 13]);
      expect(dropped).toEqual([]);
      expect(store.opening()).toBe(false);
      dispose();
    });
  });

  it("still resyncs when the server names a different log", () => {
    // The control for the test above: without this, "no reset happened" would
    // pass just as well against a discriminator that never fires.
    installEventSource();
    const run = installFrames();
    const dropped: string[] = [];
    createRoot((dispose) => {
      const store = createSessionStore("park", {
        cache: noCache({ drop: async (s: string) => void dropped.push(s) }),
      });
      const first = sources[0]!;
      first.ready({ cursor: 10, epoch: "e1" });
      for (let id = 11; id <= 13; id++) first.send(id);
      run();

      store.park();
      store.unpark();
      sources[1]!.ready({ epoch: "e2" });
      run();

      expect(store.events).toHaveLength(0);
      expect(dropped).toEqual(["park"]);
      dispose();
    });
  });
});

/**
 * What the [Text] segment's dot may claim while the stream is away.
 *
 * The dot answers "has the timeline moved since you last read it", and it can
 * only answer that while something is listening. A session returning from a
 * park has an event id that is thirty seconds or an hour stale, so "nothing
 * new" there is a guess wearing an answer's clothes.
 */
describe("a stream that is on its way back", () => {
  it("says so until it has had its say", () => {
    installEventSource();
    const run = installFrames();
    createRoot((dispose) => {
      const store = createSessionStore("park", { cache: noCache() });
      const first = sources[0]!;
      first.ready({ cursor: 10, epoch: "e1" });
      run();
      // A first open is not a return: there is nothing stale to warn about.
      expect(store.catchingUp()).toBe(false);

      store.park();
      expect(store.catchingUp()).toBe(false);

      store.unpark();
      expect(store.catchingUp()).toBe(true);
      sources[1]!.ready({ epoch: "e1" });
      expect(store.catchingUp()).toBe(false);
      dispose();
    });
  });

  it("gives up waiting when the stream is closed for good", () => {
    // A session with no transcript answers 404 and never sends `ready`, and a
    // view that is going away never hears one either. Neither may leave the dot
    // lit on a promise nothing will keep.
    installEventSource();
    installFrames();
    createRoot((dispose) => {
      const store = createSessionStore("park", { cache: noCache() });
      sources[0]!.ready({ cursor: 10, epoch: "e1" });
      store.park();
      store.unpark();
      expect(store.catchingUp()).toBe(true);

      store.close();
      expect(store.catchingUp()).toBe(false);
      dispose();
    });
  });
});

describe("parking a stream nobody opened", () => {
  it("does nothing, and coming back does not open one", () => {
    installEventSource();
    installFrames();
    createRoot((dispose) => {
      const store = createSessionStore("park", { cache: noCache(), autoStart: false });
      expect(sources).toHaveLength(0);

      store.park();
      store.unpark();
      // A session that never showed its Text view has no stream to park, and
      // coming back on screen must not be what opens its first one.
      expect(sources).toHaveLength(0);
      expect(store.started()).toBe(false);
      dispose();
    });
  });

  it("stays closed once the view is gone", () => {
    installEventSource();
    installFrames();
    createRoot((dispose) => {
      const store = createSessionStore("park", { cache: noCache() });
      expect(sources).toHaveLength(1);
      store.close();
      store.unpark();
      expect(sources).toHaveLength(1);
      dispose();
    });
  });
});
